const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { authenticateToken } = require('../../helpers/utils');
const { optionalAuth } = require('../../middleware/auth');
const { getMediaSeeder } = require('../../services/mediaSeeder');
const { publishToGun, publishNewRecord } = require('../../helpers/core/templateHelper');
const { indexRecord } = require('../../helpers/core/elasticsearch');
const { getBaseUrl, getMediaFileUrl } = require('../../helpers/core/urlHelper');

const router = express.Router();

// Media directory configuration
// Note: __dirname is routes/daemon/, so we need ../../ to reach project root
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, '../../data/media');

// MEMORY OPTIMIZATION: Simple LRU cache for manifest files
// Prevents repeated disk reads for frequently accessed media
const manifestCache = new Map();
const MANIFEST_CACHE_MAX_SIZE = 1000;  // Max cached manifests
const MANIFEST_CACHE_TTL = 300000;     // 5 minutes TTL

function getCachedManifest(mediaId, manifestPath) {
  const cached = manifestCache.get(mediaId);
  if (cached && Date.now() - cached.timestamp < MANIFEST_CACHE_TTL) {
    return cached.data;
  }
  
  // Read from disk
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    
    // Evict oldest entries if cache is full
    if (manifestCache.size >= MANIFEST_CACHE_MAX_SIZE) {
      const oldestKey = manifestCache.keys().next().value;
      manifestCache.delete(oldestKey);
    }
    
    // Cache the manifest
    manifestCache.set(mediaId, { data: manifest, timestamp: Date.now() });
    return manifest;
  } catch (error) {
    console.warn('⚠️ Failed to load manifest:', error.message);
    return null;
  }
}

function invalidateManifestCache(mediaId) {
  manifestCache.delete(mediaId);
}

// Function to ensure media directory exists (called when needed)
function ensureMediaDir() {
  if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    console.log('📁 Created media directory:', MEDIA_DIR);
  }
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureMediaDir();
    const tempDir = ensureTempDir();
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    // Generate temporary filename
    const tempName = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    cb(null, tempName);
  }
});

const upload = multer({ 
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB limit
  }
});

// Function to ensure temp directory exists (called when needed)
function ensureTempDir() {
  const tempDir = path.join(MEDIA_DIR, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  return tempDir;
}

/**
 * POST /api/media/upload
 * Upload media file, create torrent, and return file info for OIP record creation
 * This endpoint only handles file storage and BitTorrent creation.
 * The actual OIP record creation is handled by /api/records/newRecord
 */
router.post('/upload', authenticateToken, upload.single('file'), async (req, res) => {
  let tempFilePath = null;
  
  try {
    // Ensure media directory exists
    ensureMediaDir();
    console.log('📤 Media upload request:', {
      user: req.user.email,
      file: req.file ? req.file.originalname : 'none',
      body: Object.keys(req.body)
    });

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    tempFilePath = req.file.path;
    const originalName = req.file.originalname;
    const fileSize = req.file.size;

    // Compute file hash (mediaId)
    const fileBuffer = fs.readFileSync(tempFilePath);
    const mediaId = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    console.log('🔢 Generated mediaId:', mediaId);

    // Create final directory structure
    const mediaIdDir = path.join(MEDIA_DIR, mediaId);
    if (!fs.existsSync(mediaIdDir)) {
      fs.mkdirSync(mediaIdDir, { recursive: true });
    }

    // Move file to final location
    const finalFilePath = path.join(mediaIdDir, 'original');
    fs.renameSync(tempFilePath, finalFilePath);
    tempFilePath = null; // Prevent cleanup

    console.log('📁 Moved file to:', finalFilePath);

    // Get file metadata
    const stats = fs.statSync(finalFilePath);
    const mimeType = req.file.mimetype || 'application/octet-stream';

    // Start seeding with MediaSeeder (with graceful fallback)
    let seedInfo = null;
    let magnetURI = '';
    let infoHash = '';
    
    try {
      const mediaSeeder = getMediaSeeder();
      seedInfo = await mediaSeeder.seedFile(finalFilePath, mediaId);
      magnetURI = seedInfo.magnetURI;
      infoHash = seedInfo.infoHash;
      console.log('🌱 Seeding started:', seedInfo.magnetURI);
    } catch (seedError) {
      console.warn('⚠️ Failed to seed file with MediaSeeder:', seedError.message);
      console.warn('⚠️ File uploaded successfully but BitTorrent seeding is unavailable');
      console.warn('⚠️ The file can still be accessed via HTTP, but P2P distribution will not work');
      // Continue without BitTorrent - file is still accessible via HTTP
    }

    // Prepare access control
    const accessLevel = req.body.access_level || 'private';
    const userPublicKey = req.user.publicKey || req.user.publisherPubKey;

    if (!userPublicKey) {
      throw new Error('User public key not available');
    }

    // Create basic manifest for file tracking (not the final OIP record)
    const mediaManifest = {
      mediaId: mediaId,
      originalName: originalName,
      mimeType: mimeType,
      fileSize: fileSize,
      magnetURI: magnetURI,
      infoHash: infoHash,
      httpUrl: getMediaFileUrl(mediaId, req),
      createdAt: new Date().toISOString(),
      userPublicKey: userPublicKey,
      accessLevel: accessLevel
    };

    // Save manifest to disk for file tracking
    const manifestPath = path.join(mediaIdDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(mediaManifest, null, 2));

    console.log('💾 Saved file manifest:', manifestPath);

    // Return response with BitTorrent info for OIP record creation
    res.json({
      success: true,
      mediaId,
      magnetURI: magnetURI,
      infoHash: infoHash,
      httpUrl: getMediaFileUrl(mediaId, req),
      size: fileSize,
      mime: mimeType,
      originalName: originalName,
      access_level: accessLevel,
      owner: userPublicKey,
      message: seedInfo ? 
        'File uploaded and BitTorrent created. Use /api/records/newRecord to create proper OIP record.' :
        'File uploaded successfully (BitTorrent unavailable - HTTP streaming only). Use /api/records/newRecord to create proper OIP record.',
      torrentAvailable: !!seedInfo
    });

  } catch (error) {
    console.error('❌ Media upload failed:', error);

    // Cleanup temp file if it still exists
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (cleanupError) {
        console.warn('⚠️ Failed to cleanup temp file:', cleanupError.message);
      }
    }

    res.status(500).json({ 
      error: 'Media upload failed',
      details: error.message 
    });
  }
});

/**
 * GET /api/media/:mediaId
 * Serve media file with authentication and range support
 */
router.get('/:mediaId', optionalAuth, async (req, res) => {
  try {
    const { mediaId } = req.params;
    const mediaIdDir = path.join(MEDIA_DIR, mediaId);
    const filePath = path.join(mediaIdDir, 'original');
    const manifestPath = path.join(mediaIdDir, 'manifest.json');

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Media not found' });
    }

    // Load manifest for access control (with caching to reduce disk I/O)
    const manifest = getCachedManifest(mediaId, manifestPath);

    // Check access control
    if (manifest) {
      const accessLevel = manifest.accessLevel || 'private';
      
      if (accessLevel === 'private') {
        if (!req.user) {
          return res.status(401).json({ error: 'Authentication required for private media' });
        }

        // Check ownership
        const userPublicKey = req.user.publicKey || req.user.publisherPubKey;
        const ownerPublicKey = manifest.userPublicKey;

        if (userPublicKey !== ownerPublicKey) {
          return res.status(403).json({ error: 'Access denied: not the owner' });
        }
      }
    }

    // Get file stats
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const mimeType = manifest?.mimeType || 'application/octet-stream';

    // CACHE OPTIMIZATION: Media files are content-addressed by SHA256 hash
    // The same mediaId will ALWAYS return the same content, making aggressive caching safe
    const etag = `"${mediaId}"`;
    
    // Handle conditional requests (If-None-Match)
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();  // Not Modified - no body sent, saves bandwidth
    }
    
    // Set caching headers for all responses
    res.set({
      'Cache-Control': 'public, max-age=31536000, immutable',  // 1 year cache (content-addressed = immutable)
      'ETag': etag,
      'Last-Modified': stats.mtime.toUTCString()
    });

    // Handle range requests for video streaming
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;

      res.status(206);
      res.set({
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType
      });

      const stream = fs.createReadStream(filePath, { start, end });
      
      // CRITICAL FIX: Add stream cleanup handlers to prevent buffer leaks
      stream.on('error', (err) => {
        console.error('❌ Stream error for', mediaId, err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Stream error' });
        }
        stream.destroy();
      });
      
      stream.on('end', () => {
        // Force GC for large files (> 100KB) to prevent buffer accumulation
        if (chunksize > 102400 && global.gc) {
          setImmediate(() => global.gc());
        }
      });
      
      // Clean up on client disconnect
      res.on('close', () => {
        if (!stream.destroyed) {
          stream.destroy();
        }
      });
      
      stream.pipe(res);
    } else {
      // Serve entire file
      res.set({
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes'
      });

      const stream = fs.createReadStream(filePath);
      
      // CRITICAL FIX: Add stream cleanup handlers to prevent buffer leaks
      stream.on('error', (err) => {
        console.error('❌ Stream error for', mediaId, err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Stream error' });
        }
        stream.destroy();
      });
      
      stream.on('end', () => {
        // Force GC for large files (> 100KB) to prevent buffer accumulation
        if (fileSize > 102400 && global.gc) {
          setImmediate(() => global.gc());
        }
      });
      
      // Clean up on client disconnect
      res.on('close', () => {
        if (!stream.destroyed) {
          stream.destroy();
        }
      });
      
      stream.pipe(res);
    }

  } catch (error) {
    console.error('❌ Failed to serve media:', error);
    res.status(500).json({ 
      error: 'Failed to serve media',
      details: error.message 
    });
  }
});

/**
 * GET /api/media/:mediaId/info
 * Get media information and manifest
 */
router.get('/:mediaId/info', optionalAuth, async (req, res) => {
  try {
    const { mediaId } = req.params;
    const mediaIdDir = path.join(MEDIA_DIR, mediaId);
    const manifestPath = path.join(mediaIdDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      return res.status(404).json({ error: 'Media not found' });
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    // Check access control
    if (manifest && manifest.accessLevel === 'private') {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const userPublicKey = req.user.publicKey || req.user.publisherPubKey;
      const ownerPublicKey = manifest.userPublicKey;

      if (userPublicKey !== ownerPublicKey) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    // Get seeding info
    const mediaSeeder = getMediaSeeder();
    const seedInfo = mediaSeeder.getSeedingInfo(mediaId);

    res.json({
      ...manifest,
      seeding: !!seedInfo,
      seedingInfo: seedInfo
    });

  } catch (error) {
    console.error('❌ Failed to get media info:', error);
    res.status(500).json({ 
      error: 'Failed to get media info',
      details: error.message 
    });
  }
});

/**
 * POST /api/media/createRecord
 * Create proper OIP record (image/video/audio) from uploaded media file
 */
router.post('/createRecord', authenticateToken, async (req, res) => {
  try {
    const { 
      mediaId, 
      recordType, 
      basicInfo, 
      mediaInfo, 
      accessControl,
      width,
      height,
      duration 
    } = req.body;

    console.log('📋 Creating OIP record for media:', {
      mediaId,
      recordType,
      user: req.user.email
    });

    if (!mediaId || !recordType) {
      return res.status(400).json({ error: 'mediaId and recordType are required' });
    }

    // Validate record type
    if (!['image', 'video', 'audio'].includes(recordType)) {
      return res.status(400).json({ error: 'recordType must be image, video, or audio' });
    }

    // Check if media file exists
    const mediaIdDir = path.join(MEDIA_DIR, mediaId);
    const manifestPath = path.join(mediaIdDir, 'manifest.json');
    
    if (!fs.existsSync(manifestPath)) {
      return res.status(404).json({ error: 'Media file not found. Upload file first.' });
    }

    // Load media manifest
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    
    // Verify ownership
    const userPublicKey = req.user.publicKey || req.user.publisherPubKey;
    if (manifest.userPublicKey !== userPublicKey) {
      return res.status(403).json({ error: 'Access denied: not the owner of this media file' });
    }

    // Build proper OIP record structure
    const oipRecord = {
      basic: {
        name: basicInfo.name || manifest.originalName,
        description: basicInfo.description || `${recordType.charAt(0).toUpperCase() + recordType.slice(1)} file: ${manifest.originalName}`,
        language: basicInfo.language || 'en',
        date: Math.floor(Date.now() / 1000),
        nsfw: basicInfo.nsfw || false,
        tagItems: basicInfo.tagItems || []
      },
      accessControl: {
        access_level: accessControl.access_level || manifest.accessLevel || 'private',
        owner_public_key: userPublicKey
      }
    };

    // Add shared_with field if organization access level is selected
    if (accessControl.access_level === 'organization' && accessControl.shared_with) {
      oipRecord.accessControl.shared_with = accessControl.shared_with;
      console.log('📋 Added organization DID to shared_with field:', accessControl.shared_with);
    }

    // Add type-specific fields with BitTorrent address
    if (recordType === 'image') {
      oipRecord.image = {
        bittorrentAddress: manifest.magnetURI,
        filename: manifest.originalName,
        width: width || 0,
        height: height || 0,
        size: manifest.fileSize,
        contentType: manifest.mimeType
      };
    } else if (recordType === 'video') {
      oipRecord.video = {
        bittorrentAddress: manifest.magnetURI,
        filename: manifest.originalName,
        width: width || 0,
        height: height || 0,
        size: manifest.fileSize,
        duration: duration || 0,
        contentType: manifest.mimeType,
        thumbnails: [] // Could be populated later
      };
    } else if (recordType === 'audio') {
      oipRecord.audio = {
        bittorrentAddress: manifest.magnetURI,
        filename: manifest.originalName,
        size: manifest.fileSize,
        duration: duration || 0,
        contentType: manifest.mimeType
      };
    }

    // Publish to GUN with proper options
    const result = await publishNewRecord(
      oipRecord,
      recordType,
      false, // publishFiles
      false, // addMediaToArweave
      false, // addMediaToIPFS
      null,  // youtubeUrl
      'gun', // blockchain (will be treated as storage type)
      false, // addMediaToArFleet
      {
        storage: 'gun',
        localId: `media_${mediaId}`,
        accessControl: oipRecord.accessControl
      }
    );

    console.log('✅ Created OIP media record:', result.did);

    res.json({
      success: true,
      did: result.did,
      recordType: recordType,
      mediaId: mediaId,
      storage: 'gun',
      encrypted: result.encrypted,
      message: `${recordType.charAt(0).toUpperCase() + recordType.slice(1)} record created successfully`
    });

  } catch (error) {
    console.error('❌ Failed to create media record:', error);
    res.status(500).json({
      error: 'Failed to create media record',
      details: error.message
    });
  }
});

/**
 * POST /api/media/ipfs-upload
 * Upload media file to IPFS and return hash
 */
router.post('/ipfs-upload', authenticateToken, async (req, res) => {
  try {
    const { mediaId } = req.body;
    
    if (!mediaId) {
      return res.status(400).json({ error: 'mediaId is required' });
    }

    // Check if media file exists
    const mediaIdDir = path.join(MEDIA_DIR, mediaId);
    const filePath = path.join(mediaIdDir, 'original');
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Media file not found' });
    }

    // Verify ownership
    const manifestPath = path.join(mediaIdDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const userPublicKey = req.user.publicKey || req.user.publisherPubKey;
    
    if (manifest.userPublicKey !== userPublicKey) {
      return res.status(403).json({ error: 'Access denied: not the owner of this media file' });
    }

    console.log('📤 Uploading to IPFS:', mediaId);

    // Upload to IPFS using the IPFS API
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));

    const ipfsResponse = await fetch('http://ipfs:5001/api/v0/add', {
      method: 'POST',
      body: form
    });

    const ipfsResult = await ipfsResponse.json();
    
    if (!ipfsResponse.ok) {
      throw new Error('IPFS upload failed');
    }

    const ipfsHash = ipfsResult.Hash;
    console.log('✅ IPFS upload complete:', ipfsHash);

    // Update manifest with IPFS hash
    manifest.ipfsHash = ipfsHash;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    invalidateManifestCache(mediaId);  // Clear cache after update

    res.json({
      success: true,
      ipfsHash: ipfsHash,
      ipfsUrl: `https://ipfs.io/ipfs/${ipfsHash}`,
      message: 'File uploaded to IPFS successfully'
    });

  } catch (error) {
    console.error('❌ IPFS upload failed:', error);
    res.status(500).json({
      error: 'IPFS upload failed',
      details: error.message
    });
  }
});

/**
 * POST /api/media/web-setup
 * Set up web server access for media file
 */
router.post('/web-setup', authenticateToken, async (req, res) => {
  try {
    const { mediaId, filename } = req.body;
    
    if (!mediaId || !filename) {
      return res.status(400).json({ error: 'mediaId and filename are required' });
    }

    // Check if media file exists
    const mediaIdDir = path.join(MEDIA_DIR, mediaId);
    const originalPath = path.join(mediaIdDir, 'original');
    
    if (!fs.existsSync(originalPath)) {
      return res.status(404).json({ error: 'Media file not found' });
    }

    // Verify ownership
    const manifestPath = path.join(mediaIdDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const userPublicKey = req.user.publicKey || req.user.publisherPubKey;
    
    if (manifest.userPublicKey !== userPublicKey) {
      return res.status(403).json({ error: 'Access denied: not the owner of this media file' });
    }

    console.log('🌍 Setting up web access:', mediaId, filename);

    // Create web-accessible directory structure
    const composeProjectName = process.env.COMPOSE_PROJECT_NAME || 'oip-arweave-indexer';
    const webMediaDir = path.join(MEDIA_DIR, 'web', composeProjectName);
    
    if (!fs.existsSync(webMediaDir)) {
      fs.mkdirSync(webMediaDir, { recursive: true });
      console.log('📁 Created web media directory:', webMediaDir);
    }

    // Copy file to web-accessible location with original filename
    const webFilePath = path.join(webMediaDir, filename);
    fs.copyFileSync(originalPath, webFilePath);

    // Build web URL with proper protocol detection (handle reverse proxy)
    const ngrokDomain = process.env.NGROK_DOMAIN || req.get('x-forwarded-host') || req.get('host');
    const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
    const webUrl = `${protocol}://${ngrokDomain}/media/${composeProjectName}/${filename}`;

    console.log('✅ Web access setup complete:', webUrl);

    // Update manifest with web URL
    manifest.webUrl = webUrl;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    invalidateManifestCache(mediaId);  // Clear cache after update

    res.json({
      success: true,
      webUrl: webUrl,
      filename: filename,
      message: 'Web access setup successfully'
    });

  } catch (error) {
    console.error('❌ Web setup failed:', error);
    res.status(500).json({
      error: 'Web setup failed',
      details: error.message
    });
  }
});

/**
 * POST /api/media/arweave-upload
 * Upload media file to Arweave and return transaction ID
 */
router.post('/arweave-upload', authenticateToken, async (req, res) => {
  try {
    const { mediaId } = req.body;
    
    if (!mediaId) {
      return res.status(400).json({ error: 'mediaId is required' });
    }

    // Check if media file exists
    const mediaIdDir = path.join(MEDIA_DIR, mediaId);
    const filePath = path.join(mediaIdDir, 'original');
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Media file not found' });
    }

    // Verify ownership
    const manifestPath = path.join(mediaIdDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const userPublicKey = req.user.publicKey || req.user.publisherPubKey;
    
    if (manifest.userPublicKey !== userPublicKey) {
      return res.status(403).json({ error: 'Access denied: not the owner of this media file' });
    }

    console.log('⛓️ Uploading to Arweave:', mediaId);

    // Use the existing Arweave upload functionality
    const { uploadToArweave } = require('../../helpers/core/arweave');
    
    const fileBuffer = fs.readFileSync(filePath);
    const arweaveResult = await uploadToArweave(fileBuffer, manifest.mimeType, manifest.originalName);

    console.log('✅ Arweave upload complete:', arweaveResult.transactionId);

    // Update manifest with Arweave transaction ID
    manifest.arweaveTransactionId = arweaveResult.transactionId;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    invalidateManifestCache(mediaId);  // Clear cache after update

    res.json({
      success: true,
      transactionId: arweaveResult.transactionId,
      arweaveUrl: `https://arweave.net/${arweaveResult.transactionId}`,
      message: 'File uploaded to Arweave successfully'
    });

  } catch (error) {
    console.error('❌ Arweave upload failed:', error);
    res.status(500).json({
      error: 'Arweave upload failed',
      details: error.message
    });
  }
});

module.exports = router;
