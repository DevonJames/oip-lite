const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const publisherManager = require('../publisher-manager');
const { create } = require('ipfs-http-client');
const axios = require('axios');

class MediaManager {
    constructor() {
        this.supportedNetworks = ['arweave', 'irys', 'ipfs', 'bittorrent', 'arfleet'];
    }

    /**
     * Process media from various sources and publish to specified networks
     * @param {Object} mediaConfig - Configuration for media processing
     * @param {string} mediaConfig.source - 'url', 'file', or 'base64'
     * @param {string} mediaConfig.data - URL, file path, or base64 data
     * @param {string} mediaConfig.contentType - MIME type
     * @param {Object} mediaConfig.publishTo - Networks to publish to
     * @param {boolean} mediaConfig.publishTo.arweave - Publish to Arweave
     * @param {boolean} mediaConfig.publishTo.irys - Publish to Irys
     * @param {boolean} mediaConfig.publishTo.ipfs - Publish to IPFS
     * @param {boolean} mediaConfig.publishTo.bittorrent - Publish to BitTorrent
     * @param {boolean} mediaConfig.publishTo.arfleet - Publish to ArFleet
     * @param {string} mediaConfig.blockchain - Primary blockchain for metadata ('arweave' or 'irys')
     * @returns {Promise<Object>} - Media addresses and DIDs
     */
    async processMedia(mediaConfig) {
        const {
            source,
            data,
            contentType,
            publishTo = { arweave: true }, // Default to Arweave only
            blockchain = 'arweave'
        } = mediaConfig;

        console.log('Processing media:', { source, contentType, publishTo, blockchain });

        try {
            // Step 1: Handle YouTube videos specially (returns both video and thumbnail)
            if (source === 'youtube') {
                const youtubeData = await this.downloadFromYouTube(data);
                
                // Process video file
                const videoPublishResults = await this.publishToNetworks(youtubeData.video, 'video/mp4', publishTo, blockchain);
                
                // Add BitTorrent for video if enabled
                if (publishTo.bittorrent !== false) {
                    videoPublishResults.bittorrent = await this.createTorrent(youtubeData.video);
                }
                
                const videoMediaAddresses = this.formatMediaAddresses(videoPublishResults);
                videoMediaAddresses.originalUrl = youtubeData.originalUrl;
                videoMediaAddresses.videoId = youtubeData.videoId;
                
                // Process thumbnail if available
                let thumbnailMediaAddresses = null;
                if (youtubeData.thumbnail) {
                    const thumbnailPublishResults = await this.publishToNetworks(youtubeData.thumbnail, 'image/jpeg', publishTo, blockchain);
                    
                    // Add BitTorrent for thumbnail if enabled
                    if (publishTo.bittorrent !== false) {
                        thumbnailPublishResults.bittorrent = await this.createTorrent(youtubeData.thumbnail);
                    }
                    
                    thumbnailMediaAddresses = this.formatMediaAddresses(thumbnailPublishResults);
                    thumbnailMediaAddresses.originalUrl = `${youtubeData.originalUrl}#thumbnail`;
                }
                
                console.log('YouTube video and thumbnail processed successfully:', { videoMediaAddresses, thumbnailMediaAddresses });
                
                return {
                    video: videoMediaAddresses,
                    thumbnail: thumbnailMediaAddresses,
                    originalUrl: youtubeData.originalUrl,
                    videoId: youtubeData.videoId
                };
            }
            
            // Step 2: Handle other media types (single file)
            const mediaBuffer = await this.getMediaBuffer(source, data);
            
            // Step 3: Publish to requested networks
            const publishResults = await this.publishToNetworks(mediaBuffer, contentType, publishTo, blockchain);
            
            // Step 4: Generate BitTorrent magnet URI (always done for distribution)
            if (publishTo.bittorrent !== false) { // Default to true unless explicitly disabled
                publishResults.bittorrent = await this.createTorrent(mediaBuffer);
            }

            // Step 5: Format results with template-compatible addresses
            const mediaAddresses = this.formatMediaAddresses(publishResults);
            
            console.log('Media processed successfully:', mediaAddresses);
            return mediaAddresses;

        } catch (error) {
            console.error('Error processing media:', error);
            throw error;
        }
    }

    /**
     * Get media buffer from various sources
     */
    async getMediaBuffer(source, data) {
        switch (source) {
            case 'url':
                return await this.downloadFromUrl(data);
            case 'file':
                return await fs.readFile(data);
            case 'base64':
                return Buffer.from(data, 'base64');
            case 'youtube':
                return await this.downloadFromYouTube(data);
            default:
                throw new Error(`Unsupported media source: ${source}`);
        }
    }

    /**
     * Download media from URL
     */
    async downloadFromUrl(url) {
        console.log('Downloading media from URL:', url);
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        // Handle Proxy-wrapped arraybuffer from axios interceptor - use slice() to copy
        const buffer = response.data.slice ? response.data.slice() : Buffer.from(response.data);
        
        // MEMORY CLEANUP: Immediately release the arraybuffer
        response.data = null;
        if (global.gc && buffer.length > 1024 * 1024) { // > 1MB
            global.gc();
            console.log(`🧹 [MediaManager] Released ${Math.round(buffer.length / 1024 / 1024)}MB buffer`);
        }
        
        return buffer;
    }

    /**
     * Download and process YouTube video and thumbnail
     */
    async downloadFromYouTube(youtubeUrl) {
        console.log('Downloading from YouTube:', youtubeUrl);
        
        // Create temp directory for downloads
        const tempDir = path.join(__dirname, '../downloads/temp');
        await fs.mkdir(tempDir, { recursive: true });
        
        const videoId = this.extractYouTubeId(youtubeUrl);
        const videoOutputPath = path.join(tempDir, `${videoId}.mp4`);
        const thumbnailOutputPath = path.join(tempDir, `${videoId}_thumbnail.jpg`);
        
        try {
            // Download video using yt-dlp
            const videoCommand = `yt-dlp -f "best[ext=mp4]" -o "${videoOutputPath}" "${youtubeUrl}"`;
            await execAsync(videoCommand);
            
            // Download thumbnail using yt-dlp
            const thumbnailCommand = `yt-dlp --write-thumbnail --skip-download --convert-thumbnails jpg -o "${path.join(tempDir, videoId)}" "${youtubeUrl}"`;
            await execAsync(thumbnailCommand);
            
            // Read the downloaded files
            const videoBuffer = await fs.readFile(videoOutputPath);
            let thumbnailBuffer = null;
            
            // Try to read thumbnail (yt-dlp might name it differently)
            try {
                const possibleThumbnailPaths = [
                    path.join(tempDir, `${videoId}.jpg`),
                    path.join(tempDir, `${videoId}.webp.jpg`),
                    thumbnailOutputPath
                ];
                
                for (const thumbnailPath of possibleThumbnailPaths) {
                    try {
                        await fs.access(thumbnailPath);
                        thumbnailBuffer = await fs.readFile(thumbnailPath);
                        console.log('Thumbnail found at:', thumbnailPath);
                        break;
                    } catch (e) {
                        // Continue to next path
                    }
                }
            } catch (thumbnailError) {
                console.warn('Could not download thumbnail:', thumbnailError.message);
            }
            
            // Clean up temp files
            try {
                await fs.unlink(videoOutputPath);
                if (thumbnailBuffer) {
                    // Clean up any thumbnail files
                    for (const thumbnailPath of [
                        path.join(tempDir, `${videoId}.jpg`),
                        path.join(tempDir, `${videoId}.webp.jpg`),
                        thumbnailOutputPath
                    ]) {
                        try {
                            await fs.unlink(thumbnailPath);
                        } catch (e) {
                            // Ignore cleanup errors
                        }
                    }
                }
            } catch (cleanupError) {
                console.warn('Cleanup error:', cleanupError.message);
            }
            
            return {
                video: videoBuffer,
                thumbnail: thumbnailBuffer,
                videoId: videoId,
                originalUrl: youtubeUrl
            };
            
        } catch (error) {
            console.error('Error downloading from YouTube:', error);
            // Cleanup on error
            try {
                await fs.unlink(videoOutputPath);
                await fs.unlink(thumbnailOutputPath);
            } catch (e) {
                // Ignore cleanup errors
            }
            throw error;
        }
    }

    /**
     * Extract YouTube video ID from URL
     */
    extractYouTubeId(url) {
        const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]+)/;
        const match = url.match(regex);
        return match ? match[1] : 'unknown';
    }

    /**
     * Publish media to multiple networks
     */
    async publishToNetworks(mediaBuffer, contentType, publishTo, blockchain) {
        const results = {};
        
        // Publish to Arweave
        if (publishTo.arweave) {
            console.log('Publishing to Arweave...');
            try {
                const result = await publisherManager.publish(mediaBuffer, {
                    blockchain: 'arweave',
                    tags: [
                        { name: 'Content-Type', value: contentType },
                        { name: 'App-Name', value: 'OIPArweave' }
                    ]
                });
                results.arweave = result;
            } catch (error) {
                console.error('Error publishing to Arweave:', error);
                results.arweave = { error: error.message };
            }
        }

        // Publish to Irys
        if (publishTo.irys) {
            console.log('Publishing to Irys...');
            try {
                const result = await publisherManager.publish(mediaBuffer, {
                    blockchain: 'irys',
                    tags: [
                        { name: 'Content-Type', value: contentType },
                        { name: 'App-Name', value: 'OIPArweave' }
                    ]
                });
                results.irys = result;
            } catch (error) {
                console.error('Error publishing to Irys:', error);
                results.irys = { error: error.message };
            }
        }

        // Publish to IPFS
        if (publishTo.ipfs) {
            console.log('Publishing to IPFS...');
            try {
                const ipfsHash = await this.uploadToIPFS(mediaBuffer);
                results.ipfs = {
                    id: ipfsHash,
                    blockchain: 'ipfs',
                    provider: 'ipfs',
                    url: `https://ipfs.io/ipfs/${ipfsHash}`
                };
            } catch (error) {
                console.error('Error publishing to IPFS:', error);
                results.ipfs = { error: error.message };
            }
        }

        // Publish to ArFleet
        if (publishTo.arfleet) {
            console.log('Publishing to ArFleet...');
            try {
                // Write to temp file for ArFleet upload
                const tempPath = path.join(__dirname, '../downloads/temp', `arfleet_${Date.now()}`);
                await fs.writeFile(tempPath, mediaBuffer);
                
                const arfleetResult = await this.uploadToArFleet(tempPath);
                results.arfleet = {
                    id: arfleetResult.arfleetId,
                    blockchain: 'arfleet',
                    provider: 'arfleet',
                    url: arfleetResult.arfleetUrl
                };
                
                // Clean up temp file
                await fs.unlink(tempPath);
            } catch (error) {
                console.error('Error publishing to ArFleet:', error);
                results.arfleet = { error: error.message };
            }
        }

        return results;
    }

    /**
     * Upload to IPFS
     */
    async uploadToIPFS(buffer) {
        const ipfs = create({
            host: 'localhost',
            port: '5001',
            protocol: 'http'
        });

        const result = await ipfs.add(buffer);
        return result.cid.toString();
    }

    /**
     * Upload to ArFleet
     */
    async uploadToArFleet(filePath, storageDuration = 30) {
        // Check if ArFleet client is running
        try {
            const { stdout } = await execAsync('ps aux | grep "arfleet client" | grep -v grep');
            if (!stdout.trim()) {
                console.log('Starting ArFleet client...');
                await execAsync('./arfleet client &');
                // Wait a moment for client to start
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (error) {
            console.warn('Error checking/starting ArFleet client:', error.message);
        }

        // Upload to ArFleet (assuming CLI interface)
        const command = `arfleet upload ${filePath} --days ${storageDuration}`;
        const { stdout } = await execAsync(command);
        
        // Parse ArFleet response (adjust based on actual API response)
        const arfleetId = stdout.match(/ID: ([a-zA-Z0-9]+)/)?.[1] || 'unknown';
        const arfleetUrl = `https://arfleet.io/${arfleetId}`;
        
        return { arfleetId, arfleetUrl };
    }

    /**
     * Create BitTorrent magnet URI
     */
    async createTorrent(buffer) {
        try {
            // Initialize WebTorrent
            const WebTorrent = (await import('webtorrent')).default;
            const client = new WebTorrent();
            let isDestroyed = false;
            
            return new Promise((resolve, reject) => {
                client.seed(buffer, (torrent) => {
                    resolve({
                        magnetURI: torrent.magnetURI,
                        infoHash: torrent.infoHash,
                        provider: 'bittorrent'
                    });
                    
                    // Clean up immediately after getting the result
                    if (!isDestroyed) {
                        isDestroyed = true;
                        client.destroy();
                    }
                });
                
                // Timeout after 30 seconds
                const timeoutId = setTimeout(() => {
                    if (!isDestroyed) {
                        isDestroyed = true;
                        client.destroy();
                        reject(new Error('Torrent creation timeout'));
                    }
                }, 30000);
                
                // Clear timeout if resolved normally
                client.on('torrent', () => {
                    clearTimeout(timeoutId);
                });
            });
        } catch (error) {
            console.error('Error creating torrent:', error);
            return { error: error.message };
        }
    }

    /**
     * Format results into template-compatible address fields
     */
    formatMediaAddresses(publishResults) {
        const mediaAddresses = {
            originalUrl: null
        };

        Object.entries(publishResults).forEach(([network, result]) => {
            if (result.error) {
                console.warn(`${network} publishing failed:`, result.error);
                return;
            }

            // Map network results to template-compatible field names
            switch (network) {
                case 'arweave':
                case 'irys':
                    mediaAddresses.arweaveAddress = result.url || `https://arweave.net/${result.id}`;
                    break;
                case 'ipfs':
                    mediaAddresses.ipfsAddress = result.url || `https://ipfs.io/ipfs/${result.id}`;
                    break;
                case 'arfleet':
                    mediaAddresses.arfleetAddress = result.url;
                    break;
                case 'bittorrent':
                    mediaAddresses.bittorrentAddress = result.magnetURI;
                    break;
            }
        });

        return mediaAddresses;
    }

    /**
     * Format results into DID format (legacy support)
     */
    formatMediaDIDs(publishResults) {
        const mediaDIDs = {
            originalUrl: null,
            storageNetworks: []
        };

        Object.entries(publishResults).forEach(([network, result]) => {
            if (result.error) {
                console.warn(`${network} publishing failed:`, result.error);
                return;
            }

            let did;
            switch (network) {
                case 'arweave':
                case 'irys':
                    did = `did:${network}:${result.id}`;
                    break;
                case 'ipfs':
                    did = `did:ipfs:${result.id}`;
                    break;
                case 'arfleet':
                    did = `did:arfleet:${result.id}`;
                    break;
                case 'bittorrent':
                    did = `did:bittorrent:${result.infoHash}`;
                    break;
                default:
                    did = `did:${network}:${result.id || result.hash}`;
            }

            mediaDIDs.storageNetworks.push({
                network,
                did,
                url: result.url || result.magnetURI,
                provider: result.provider
            });
        });

        return mediaDIDs;
    }

    /**
     * Update record metadata with media DIDs
     */
    updateRecordWithMediaDIDs(record, mediaDIDs, mediaField = 'media') {
        if (!record[mediaField]) {
            record[mediaField] = {};
        }

        // Add storage network DIDs
        record[mediaField].storageNetworks = mediaDIDs.storageNetworks;
        
        // Keep original URL if it existed
        if (mediaDIDs.originalUrl) {
            record[mediaField].originalUrl = mediaDIDs.originalUrl;
        }

        return record;
    }

    /**
     * Update record metadata with template-compatible media addresses
     */
    updateRecordWithMediaAddresses(record, mediaAddresses, mediaField = 'media') {
        // Handle nested paths like 'post.featuredImage'
        const pathParts = mediaField.split('.');
        let current = record;
        
        // Navigate to the parent object
        for (let i = 0; i < pathParts.length - 1; i++) {
            if (!current[pathParts[i]]) {
                current[pathParts[i]] = {};
            }
            current = current[pathParts[i]];
        }
        
        // Get the final field name
        const finalField = pathParts[pathParts.length - 1];
        
        // Ensure the final object exists
        if (!current[finalField]) {
            current[finalField] = {};
        }

        // Add addresses to the media field using template-compatible names
        if (mediaAddresses.arweaveAddress) {
            current[finalField].arweaveAddress = mediaAddresses.arweaveAddress;
        }
        if (mediaAddresses.ipfsAddress) {
            current[finalField].ipfsAddress = mediaAddresses.ipfsAddress;
        }
        if (mediaAddresses.bittorrentAddress) {
            current[finalField].bittorrentAddress = mediaAddresses.bittorrentAddress;
        }
        if (mediaAddresses.arfleetAddress) {
            current[finalField].arfleetAddress = mediaAddresses.arfleetAddress;
        }
        
        // Keep original URL and webUrl if they exist
        if (mediaAddresses.originalUrl) {
            current[finalField].originalUrl = mediaAddresses.originalUrl;
        }
        
        // Preserve existing webUrl for backward compatibility
        if (!current[finalField].webUrl && mediaAddresses.originalUrl) {
            current[finalField].webUrl = mediaAddresses.originalUrl;
        }

        return record;
    }
}

module.exports = new MediaManager(); 