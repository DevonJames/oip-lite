const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class MediaSeeder {
  constructor() {
    this.client = null;
    this.WebTorrent = null; // Will be loaded when needed
    this.mediaDir = process.env.MEDIA_DIR || path.join(__dirname, '../data/media');
    this.stateFile = path.join(this.mediaDir, 'seeder.json');
    this.seedingState = new Map(); // mediaId -> { infoHash, magnetURI, filePath }
    this.trackers = (process.env.WEBTORRENT_TRACKERS || 
      'wss://tracker.openwebtorrent.com,wss://tracker.btorrent.xyz')
      .split(',').map(t => t.trim());
    
    console.log('🌱 MediaSeeder initialized');
    console.log('📁 Media directory:', this.mediaDir);
    console.log('🔗 Trackers:', this.trackers);
  }

  async loadWebTorrent() {
    if (!this.WebTorrent) {
      try {
        // Use dynamic import for ESM module
        const WebTorrentModule = await import('webtorrent');
        this.WebTorrent = WebTorrentModule.default;
      } catch (error) {
        console.warn('⚠️ WebTorrent not available:', error.message);
        throw error;
      }
    }
    return this.WebTorrent;
  }

  async initialize() {
    try {
      console.log('🔄 Initializing MediaSeeder...');
      
      // Load WebTorrent when needed
      const WebTorrent = await this.loadWebTorrent();
      
      if (!WebTorrent) {
        throw new Error('WebTorrent module could not be loaded');
      }
      
      // Initialize WebTorrent client
      this.client = new WebTorrent({
        tracker: {
          announce: this.trackers
        }
      });

      if (!this.client) {
        throw new Error('WebTorrent client creation failed');
      }

      console.log('✅ WebTorrent client created successfully');

      // Ensure media directory exists
      if (!fs.existsSync(this.mediaDir)) {
        fs.mkdirSync(this.mediaDir, { recursive: true });
        console.log('📁 Created media directory:', this.mediaDir);
      }

      // Load existing seeding state
      await this.loadSeedingState();

      // Resume seeding existing files
      await this.resumeSeeding();

      console.log('✅ MediaSeeder initialized successfully');
      console.log(`🌱 Currently seeding ${this.seedingState.size} files`);

      return true;
    } catch (error) {
      console.error('❌ MediaSeeder initialization failed:', error.message);
      console.error('📝 Full error:', error);
      this.client = null; // Ensure client is null on failure
      return false;
    }
  }

  async loadSeedingState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const stateData = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        
        // Convert array back to Map
        if (Array.isArray(stateData)) {
          this.seedingState = new Map(stateData);
        } else if (stateData && typeof stateData === 'object') {
          this.seedingState = new Map(Object.entries(stateData));
        }
        
        console.log(`📋 Loaded seeding state: ${this.seedingState.size} entries`);
      }
    } catch (error) {
      console.warn('⚠️ Failed to load seeding state, starting fresh:', error.message);
      this.seedingState = new Map();
    }
  }

  async saveSeedingState() {
    try {
      // Convert Map to array for JSON serialization
      const stateData = Array.from(this.seedingState.entries());
      fs.writeFileSync(this.stateFile, JSON.stringify(stateData, null, 2));
    } catch (error) {
      console.error('❌ Failed to save seeding state:', error);
    }
  }

  async resumeSeeding() {
    const resumed = [];
    const failed = [];

    for (const [mediaId, seedInfo] of this.seedingState.entries()) {
      try {
        if (fs.existsSync(seedInfo.filePath)) {
          // Resume seeding existing file
          const torrent = this.client.add(seedInfo.magnetURI, {
            path: path.dirname(seedInfo.filePath)
          });

          await new Promise((resolve, reject) => {
            torrent.on('ready', () => {
              console.log(`🔄 Resumed seeding: ${mediaId} (${seedInfo.infoHash.slice(0, 8)}...)`);
              resumed.push(mediaId);
              resolve();
            });
            
            torrent.on('error', (err) => {
              console.warn(`⚠️ Failed to resume seeding ${mediaId}:`, err.message);
              failed.push(mediaId);
              reject(err);
            });

            // Timeout after 30 seconds
            setTimeout(() => {
              reject(new Error('Resume timeout'));
            }, 30000);
          }).catch(() => {
            // Continue with other files even if one fails
          });
        } else {
          console.warn(`⚠️ File not found for ${mediaId}: ${seedInfo.filePath}`);
          failed.push(mediaId);
        }
      } catch (error) {
        console.warn(`⚠️ Error resuming ${mediaId}:`, error.message);
        failed.push(mediaId);
      }
    }

    // Clean up failed entries
    for (const mediaId of failed) {
      this.seedingState.delete(mediaId);
    }

    if (failed.length > 0) {
      await this.saveSeedingState();
    }

    console.log(`🔄 Resumed seeding: ${resumed.length} files, ${failed.length} failed`);
  }

  async seedFile(filePath, mediaId = null) {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      // Generate mediaId if not provided
      if (!mediaId) {
        const fileBuffer = fs.readFileSync(filePath);
        mediaId = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      }

      // Check if already seeding
      if (this.seedingState.has(mediaId)) {
        const existing = this.seedingState.get(mediaId);
        console.log(`📦 Already seeding ${mediaId}: ${existing.magnetURI}`);
        return existing;
      }

      // Ensure client is initialized
      if (!this.client) {
        console.log('⚠️ MediaSeeder client not initialized, attempting to initialize now...');
        const initialized = await this.initialize();
        if (!initialized || !this.client) {
          throw new Error('MediaSeeder client is not initialized and initialization failed. WebTorrent may not be available.');
        }
      }

      // Create torrent and start seeding
      const torrent = await new Promise((resolve, reject) => {
        this.client.seed(filePath, {
          announceList: [this.trackers]
        }, (torrent) => {
          resolve(torrent);
        });

        // Timeout after 60 seconds
        setTimeout(() => {
          reject(new Error('Torrent creation timeout'));
        }, 60000);
      });

      const seedInfo = {
        mediaId,
        infoHash: torrent.infoHash,
        magnetURI: torrent.magnetURI,
        filePath: path.resolve(filePath),
        createdAt: new Date().toISOString(),
        fileSize: torrent.length
      };

      // Store seeding info
      this.seedingState.set(mediaId, seedInfo);
      await this.saveSeedingState();

      console.log(`🌱 Started seeding: ${mediaId}`);
      console.log(`🧲 Magnet URI: ${torrent.magnetURI}`);
      console.log(`📊 File size: ${(torrent.length / 1024 / 1024).toFixed(2)} MB`);

      return seedInfo;
    } catch (error) {
      console.error(`❌ Failed to seed file ${filePath}:`, error);
      throw error;
    }
  }

  getSeedingInfo(mediaId) {
    return this.seedingState.get(mediaId);
  }

  getAllSeeding() {
    return Array.from(this.seedingState.values());
  }

  getStats() {
    const torrents = this.client ? this.client.torrents : [];
    return {
      seedingCount: this.seedingState.size,
      activeTorrents: torrents.length,
      totalUploaded: torrents.reduce((total, t) => total + t.uploaded, 0),
      totalDownloaded: torrents.reduce((total, t) => total + t.downloaded, 0),
      peers: torrents.reduce((total, t) => total + t.numPeers, 0)
    };
  }

  async shutdown() {
    if (this.client) {
      await new Promise((resolve) => {
        this.client.destroy(resolve);
      });
      console.log('🛑 MediaSeeder shut down');
    }
  }
}

// Singleton instance
let mediaSeederInstance = null;

function getMediaSeeder() {
  if (!mediaSeederInstance) {
    mediaSeederInstance = new MediaSeeder();
  }
  return mediaSeederInstance;
}

module.exports = {
  MediaSeeder,
  getMediaSeeder
};
