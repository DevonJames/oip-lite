/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * OIP DAEMON SERVICE - Entry Point
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Purpose: Core OIP infrastructure - indexing, storage, media distribution
 * Analogy: The Library Infrastructure (card catalog, shelves, access control)
 * 
 * This service handles:
 *   - Arweave blockchain indexing
 *   - GUN network for private records
 *   - Elasticsearch search/indexing
 *   - BitTorrent/WebTorrent media seeding
 *   - IPFS integration
 *   - HD wallet authentication
 *   - Organization management
 *   - Media upload/streaming
 * 
 * MEMORY LEAK PREVENTION:
 *   - All HTTP agents configured with keepAlive: false
 *   - Axios interceptors clean up response buffers
 *   - Bounded caches with TTL
 *   - Proper stream cleanup handlers
 *   - Periodic GC during heavy operations
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

'use strict';

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const socketIo = require('socket.io');
const dotenv = require('dotenv');
const minimist = require('minimist');
const axios = require('axios');
const { execSync } = require('child_process');

// Load environment variables first
dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY LEAK FIX: Configure HTTP agents to prevent socket leak
// ═══════════════════════════════════════════════════════════════════════════════
const httpAgent = new http.Agent({
    keepAlive: false,       // CRITICAL: Disable keep-alive to close sockets
    maxSockets: 50,         // Limit concurrent connections
    maxFreeSockets: 10,     // Limit cached sockets
    timeout: 30000          // Socket timeout
});

const httpsAgent = new https.Agent({
    keepAlive: false,
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 30000
});

// Set default agents for all axios requests
axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY LEAK FIX: Axios response interceptor for buffer cleanup
// ═══════════════════════════════════════════════════════════════════════════════
axios.interceptors.response.use(
    (response) => {
        // Handle arraybuffer responses (media, images)
        if (response.config.responseType === 'arraybuffer' && response.data) {
            const bufferSize = response.data.byteLength || response.data.length || 0;
            
            // Schedule aggressive cleanup
            const cleanupTimer = setTimeout(() => {
                if (response._originalBuffer) {
                    response._originalBuffer = null;
                    response.data = null;
                    
                    // Force GC for buffers > 1MB
                    if (global.gc && bufferSize > 1024 * 1024) {
                        setImmediate(() => global.gc());
                    }
                }
            }, 500);
            
            response._originalBuffer = response.data;
            response._bufferSize = bufferSize;
            response._cleanupTimer = cleanupTimer;
        }
        // Handle JSON responses (especially GUN sync)
        else if (response.data && typeof response.data === 'object') {
            const url = response.config.url || '';
            const isGunRequest = url.includes('gun-relay') || url.includes(':8765');
            
            if (isGunRequest) {
                // AGGRESSIVE cleanup for GUN relay responses
                setImmediate(() => {
                    response.data = null;
                    if (global.gc) {
                        setImmediate(() => global.gc());
                    }
                });
            } else {
                // Standard cleanup for other JSON
                setTimeout(() => {
                    if (response.data) {
                        response.data = null;
                    }
                }, 500);
            }
        }
        return response;
    },
    (error) => {
        // Clean up error response buffers
        if (error.response) {
            const isGunRelay404 = error.response.status === 404 && 
                                  error.response.config?.url?.includes('gun-relay');
            if (!isGunRelay404) {
                console.error(`[Axios Error] ${error.message} from ${error.response.config?.url}`);
            }
            error.response.data = null;
            error.response = null;
        }
        return Promise.reject(error);
    }
);

// ═══════════════════════════════════════════════════════════════════════════════
// Import Configuration and Middleware
// ═══════════════════════════════════════════════════════════════════════════════
const { validateEnvironment } = require('./config/checkEnvironment');
const { initializeIndices } = require('./config/createIndices');
const apiLogger = require('./middleware/apiLogger');
const { logAPIActivity } = require('./middleware/activityLogger');
const { trackRequestMemory } = require('./middleware/memoryTrackingMiddleware');

// ═══════════════════════════════════════════════════════════════════════════════
// Import Daemon Routes
// ═══════════════════════════════════════════════════════════════════════════════
const rootRoute = require('./routes/daemon/api');
const recordRoutes = require('./routes/daemon/records');
const templateRoutes = require('./routes/daemon/templates');
const creatorRoutes = require('./routes/daemon/creators');
const organizationRoutes = require('./routes/daemon/organizations');
const healthRoutes = require('./routes/daemon/health');
const { router: userRoutes } = require('./routes/daemon/user');
const walletRoutes = require('./routes/daemon/wallet');
const publishRoutes = require('./routes/daemon/publish');
const mediaRoutes = require('./routes/daemon/media');
const cleanupRoutes = require('./routes/daemon/cleanup');
const adminRoutes = require('./routes/daemon/admin');
const didRoutes = require('./routes/daemon/did');
const debugV09Routes = require('./routes/daemon/debug');

// ═══════════════════════════════════════════════════════════════════════════════
// Import Daemon Helpers
// ═══════════════════════════════════════════════════════════════════════════════
const { getIsProcessing, setIsProcessing } = require('./helpers/core/processingState');
const { keepDBUpToDate, deleteRecordsByBlock, deleteRecordsByDID, 
        deleteRecordsByIndexedAt, deleteRecordsByIndex, deleteIndex,
        remapExistingRecords } = require('./helpers/core/elasticsearch');
const { getMediaSeeder } = require('./services/mediaSeeder');
// Note: memoryTracker removed - was disabled and just adding log noise
// Memory monitoring now handled by /debug/memory endpoints and MEMORY_RESTART_THRESHOLD_GB
const socket = require('./socket');

// Validate environment
validateEnvironment();

// ═══════════════════════════════════════════════════════════════════════════════
// Initialize GUN Sync Service
// ═══════════════════════════════════════════════════════════════════════════════
let gunSyncService = null;
if (process.env.GUN_SYNC_ENABLED !== 'false') {
    const { GunSyncService } = require('./helpers/core/gunSyncService');
    gunSyncService = new GunSyncService();
    global.gunSyncService = gunSyncService;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Request Counter for Leak Diagnostics
// ═══════════════════════════════════════════════════════════════════════════════
let requestStats = {
    total: 0,
    byPath: {},
    lastReset: Date.now()
};

// ═══════════════════════════════════════════════════════════════════════════════
// Create Express App
// ═══════════════════════════════════════════════════════════════════════════════
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// Initialize socket.io
socket.init(server);

// ═══════════════════════════════════════════════════════════════════════════════
// Express Configuration
// ═══════════════════════════════════════════════════════════════════════════════
// Body size limits
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Logging middleware
app.use(apiLogger);
app.use(trackRequestMemory);
app.use(logAPIActivity);

// CORS configuration
const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, curl)
        if (!origin) return callback(null, true);
        
        // Allow browser extensions
        if (origin.startsWith('chrome-extension://') ||
            origin.startsWith('moz-extension://') ||
            origin.startsWith('safari-web-extension://')) {
            return callback(null, true);
        }
        
        // Allowed origins
        const allowedOrigins = [
            'http://localhost:3000',
            'http://localhost:3001',
            'http://localhost:3005',
            'http://localhost:3006',  // Alexandria service
            `http://localhost:${process.env.PORT || 3005}`,
            'https://alexandria.io',
            'http://alexandria.io',
            'https://api.oip.onl',
            'http://api.oip.onl',
            'https://oip.fitnessally.io',
            'http://oip.fitnessally.io',
            'https://app.fitnessally.io',
            'https://mobile.fitnessally.io',
            'https://rockhoppersgame.com',
            'https://lyra.ninja',
            'https://onionpress.net',
            'http://onionpress.net',
            // Add additional production domains to ALLOWED_ORIGINS env var
            ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) : []),
        ];
        
        // Development mode allows any localhost
        if (process.env.NODE_ENV === 'development' && origin.includes('localhost')) {
            return callback(null, true);
        }
        
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.log(`[CORS] Blocked origin: ${origin}`);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    maxAge: 86400
};

app.use(cors(corsOptions));
app.use(bodyParser.json());

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

const port = process.env.PORT || 3005;

// ═══════════════════════════════════════════════════════════════════════════════
// GUN Relay Proxy Routes
// ═══════════════════════════════════════════════════════════════════════════════
const disableGunRelayProxy = process.env.DISABLE_GUN_RELAY_PROXY === 'true';

if (disableGunRelayProxy) {
    console.log('⚠️  GUN relay proxy routes DISABLED');
    app.get('/gun-relay/get', (req, res) => {
        res.status(503).json({ error: 'GUN relay proxy disabled', success: false });
    });
    app.post('/gun-relay/put', (req, res) => {
        res.status(503).json({ error: 'GUN relay proxy disabled', success: false });
    });
} else {
    // GUN relay GET with memory-safe patterns
    app.get('/gun-relay/get', async (req, res) => {
        let response = null;
        try {
            const soul = req.query.soul;
            if (!soul) {
                return res.status(400).json({ error: 'soul parameter required' });
            }
            
            const gunRelayUrl = process.env.GUN_PEERS || 'http://gun-relay:8765';
            
            // Use responseType 'text' to avoid JSON parsing overhead
            response = await axios.get(`${gunRelayUrl}/get?soul=${encodeURIComponent(soul)}`, {
                timeout: 10000,
                responseType: 'text',
                httpAgent: httpAgent,
                httpsAgent: httpsAgent
            });
            
            // Extract raw text and null response immediately
            const rawText = response.data;
            response.data = null;
            response = null;
            
            // Send raw JSON directly
            res.setHeader('Content-Type', 'application/json');
            res.send(rawText);
            
            // Force GC after response
            res.on('finish', () => {
                if (global.gc) setImmediate(() => global.gc());
            });
            
        } catch (error) {
            // Clean up references
            if (response) {
                response.data = null;
                response = null;
            }
            if (error.response) {
                error.response.data = null;
                error.response = null;
            }
            
            const statusCode = error.response?.status || 500;
            res.status(statusCode).json({ error: error.message, success: false });
            
            if (global.gc) setImmediate(() => global.gc());
        }
    });

    // GUN relay PUT with memory-safe patterns
    app.post('/gun-relay/put', async (req, res) => {
        let response = null;
        try {
            const { soul, data } = req.body;
            if (!soul || !data) {
                return res.status(400).json({ error: 'soul and data required' });
            }
            
            const gunRelayUrl = process.env.GUN_PEERS || 'http://gun-relay:8765';
            
            response = await axios.post(`${gunRelayUrl}/put`, req.body, {
                timeout: 30000,
                responseType: 'text',
                headers: { 'Content-Type': 'application/json' },
                httpAgent: httpAgent,
                httpsAgent: httpsAgent
            });
            
            const rawText = response.data;
            response.data = null;
            response = null;
            
            res.setHeader('Content-Type', 'application/json');
            res.send(rawText);
            
            res.on('finish', () => {
                if (global.gc) setImmediate(() => global.gc());
            });
            
        } catch (error) {
            if (response) {
                response.data = null;
                response = null;
            }
            if (error.response) {
                error.response.data = null;
                error.response = null;
            }
            
            const statusCode = error.response?.status || 500;
            if (statusCode !== 404) {
                console.error('GUN relay PUT error:', error.message);
            }
            res.status(statusCode).json({ error: error.message, success: false });
        }
    });
    
    console.log('🔄 GUN relay proxy routes enabled');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Mount Daemon API Routes
// ═══════════════════════════════════════════════════════════════════════════════
app.use('/api', rootRoute);
app.use('/api/records', recordRoutes);
app.use('/api/publish', publishRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/creators', creatorRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/user', userRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/cleanup', cleanupRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/did', didRoutes);
app.use('/api/debug/v09', debugV09Routes);
// Alias /api/debug/* to /api/debug/v09/* for convenience
app.use('/api/debug', debugV09Routes);

// ═══════════════════════════════════════════════════════════════════════════════
// Backward Compatibility: Direct /api/* routes that redirect to /api/user/*
// This allows clients to use either /api/register or /api/user/register
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/register', (req, res, next) => {
    req.url = '/register';
    userRoutes(req, res, next);
});
app.post('/api/login', (req, res, next) => {
    req.url = '/login';
    userRoutes(req, res, next);
});
app.post('/api/joinWaitlist', (req, res, next) => {
    req.url = '/joinWaitlist';
    userRoutes(req, res, next);
});
app.post('/api/reset-password', (req, res, next) => {
    req.url = '/reset-password';
    userRoutes(req, res, next);
});
app.post('/api/import-wallet', (req, res, next) => {
    req.url = '/import-wallet';
    userRoutes(req, res, next);
});
app.get('/api/mnemonic', (req, res, next) => {
    req.url = '/mnemonic';
    userRoutes(req, res, next);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Alexandria Service Proxy Routes
// ═══════════════════════════════════════════════════════════════════════════════
// When running in full alexandria profile, proxy AI/voice requests to Alexandria service
// When running in oip-only mode, return 503

const ALEXANDRIA_URL = process.env.ALEXANDRIA_URL || 'http://alexandria-service:3006';
const ALEXANDRIA_ENABLED = process.env.ALEXANDRIA_ENABLED !== 'false';

const alexandriaProxy = async (req, res) => {
    if (!ALEXANDRIA_ENABLED) {
        return res.status(503).json({
            error: 'Alexandria service not available',
            message: 'This endpoint requires the alexandria profile. Current deployment: oip-only',
            hint: 'Deploy with: make alexandria',
            endpoint: req.originalUrl
        });
    }

    try {
        const targetUrl = `${ALEXANDRIA_URL}${req.originalUrl}`;
        
        // Forward the request to Alexandria
        const axiosConfig = {
            method: req.method,
            url: targetUrl,
            headers: {
                ...req.headers,
                host: new URL(ALEXANDRIA_URL).host,
            },
            timeout: 300000, // 5 minute timeout for voice/AI operations
            responseType: 'stream',
            validateStatus: () => true, // Don't throw on any status
        };

        // Add body for POST/PUT/PATCH
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            axiosConfig.data = req.body;
            // For multipart/form-data, we need to pipe the raw request
            if (req.headers['content-type']?.includes('multipart/form-data')) {
                axiosConfig.data = req;
                axiosConfig.headers['content-type'] = req.headers['content-type'];
            }
        }

        const response = await axios(axiosConfig);

        // Forward status and headers
        res.status(response.status);
        Object.entries(response.headers).forEach(([key, value]) => {
            if (key.toLowerCase() !== 'transfer-encoding') {
                res.setHeader(key, value);
            }
        });

        // Pipe the response
        response.data.pipe(res);

    } catch (error) {
        console.error(`[Alexandria Proxy] Error proxying to ${req.originalUrl}:`, error.message);
        
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            return res.status(503).json({
                error: 'Alexandria service unavailable',
                message: 'Could not connect to Alexandria service',
                endpoint: req.originalUrl
            });
        }
        
        res.status(502).json({
            error: 'Proxy error',
            message: error.message,
            endpoint: req.originalUrl
        });
    }
};

// Proxy all Alexandria routes
app.use('/api/alfred', alexandriaProxy);
app.use('/api/voice', alexandriaProxy);
app.use('/api/scrape', alexandriaProxy);
app.use('/api/generate', alexandriaProxy);
app.use('/api/photo', alexandriaProxy);
app.use('/api/recipes', alexandriaProxy);
app.use('/api/narration', alexandriaProxy);
app.use('/api/workout', alexandriaProxy);
app.use('/api/notes', alexandriaProxy);

// ═══════════════════════════════════════════════════════════════════════════════
// Onion Press Routes (browse handled locally, other APIs proxy to onion-press-service)
// ═══════════════════════════════════════════════════════════════════════════════
const ONION_PRESS_URL = process.env.ONION_PRESS_URL || `http://onion-press-service:${process.env.ONION_PRESS_PORT || 3007}`;
const ONION_PRESS_ENABLED = process.env.ONION_PRESS_ENABLED !== 'false';

// Import Elasticsearch helper for browse routes
const { getRecords: getRecordsFromES } = require('./helpers/core/elasticsearch');

if (ONION_PRESS_ENABLED) {
    // ─────────────────────────────────────────────────────────────────────────
    // Browse API - handled locally (no need for onion-press-service)
    // ─────────────────────────────────────────────────────────────────────────
    
    // GET /onion-press/api/browse/records - Browse records
    app.get('/onion-press/api/browse/records', async (req, res) => {
        try {
            const {
                recordType = 'post',
                search,
                tags,
                tagsMatchMode,
                creator,
                limit = 20,
                page = 1,
                sortBy = 'inArweaveBlock:desc',
                resolveDepth = 1,
                noDuplicates = true,
            } = req.query;
            
            const params = {
                limit: Math.min(parseInt(limit) || 20, 100),
                page: parseInt(page) || 1,
                sortBy,
                resolveDepth: parseInt(resolveDepth) || 0,
                noDuplicates: noDuplicates === 'true' || noDuplicates === true
            };
            
            if (recordType) params.recordType = recordType;
            if (search) params.search = search;
            if (tags) params.tags = tags;
            if (tagsMatchMode) params.tagsMatchMode = tagsMatchMode;
            if (creator) params.creator = creator;
            
            const data = await getRecordsFromES(params);
            res.status(200).json(data);
            
        } catch (error) {
            console.error('Onion Press browse error:', error.message);
            res.status(500).json({
                error: 'Failed to browse records',
                message: error.message
            });
        }
    });
    
    // GET /onion-press/api/browse/record/:did - Get single record (WordPress post or OIP record)
    app.get('/onion-press/api/browse/record/:did', async (req, res) => {
        try {
            const { did } = req.params;
            
            // Check if this is a WordPress post ID (starts with 'wp-' or is numeric)
            if (did.startsWith('wp-') || /^\d+$/.test(did)) {
                const postId = did.replace('wp-', '');
                
                // Fetch WordPress post
                try {
                    const WORDPRESS_URL = process.env.WORDPRESS_URL || 'http://wordpress:80';
                    const response = await axios.get(`${WORDPRESS_URL}/wp-json/wp/v2/posts/${postId}`, {
                        params: {
                            _embed: true
                        },
                        timeout: 10000,
                        validateStatus: () => true
                    });
                    
                    if (response.status === 404 || !response.data) {
                        return res.status(404).json({
                            error: 'WordPress post not found',
                            postId
                        });
                    }
                    
                    const post = response.data;
                    const baseUrl = process.env.PUBLIC_API_BASE_URL || `${req.protocol}://${req.get('host')}`;
                    const wordpressPath = process.env.WORDPRESS_PROXY_PATH || '/wordpress';
                    
                    let permalink = post.link;
                    if (!permalink && post.id) {
                        permalink = `${baseUrl}${wordpressPath}/?p=${post.id}`;
                    }
                    
                    // Get author from WordPress post (fallback)
                    let author = post._embedded?.author?.[0]?.name || '';
                    let displayAuthor = author;
                    
                    // Fetch meta fields via wp-cli to get DID/byline
                    try {
                        const { execSync } = require('child_process');
                        const projectName = process.env.COMPOSE_PROJECT_NAME || 'onionpress';
                        const wpContainerName = `${projectName}-wordpress-1`;
                        
                        // Get publishing mode
                        let publisherMode = '';
                        try {
                            const publisherModeCmd = `docker exec ${wpContainerName} wp post meta get ${post.id} op_publisher_mode --allow-root 2>/dev/null || true`;
                            publisherMode = execSync(publisherModeCmd, { encoding: 'utf-8', timeout: 5000, shell: '/bin/bash' }).trim();
                        } catch (e) {
                            publisherMode = '';
                        }
                        const isDidMode = (publisherMode === 'did');
                        
                        if (isDidMode) {
                            // For DID mode, prioritize the DID from op_publisher_creator_did
                            let creatorDid = '';
                            try {
                                const creatorDidCmd = `docker exec ${wpContainerName} wp post meta get ${post.id} op_publisher_creator_did --allow-root 2>/dev/null || true`;
                                creatorDid = execSync(creatorDidCmd, { encoding: 'utf-8', timeout: 5000, shell: '/bin/bash' }).trim();
                            } catch (e) {
                                creatorDid = '';
                            }
                            if (creatorDid) {
                                displayAuthor = creatorDid;
                            } else {
                                // Fallback to byline meta fields
                                let byline = '';
                                try {
                                    const bylineCmd1 = `docker exec ${wpContainerName} wp post meta get ${post.id} _op_byline --allow-root 2>/dev/null || true`;
                                    byline = execSync(bylineCmd1, { encoding: 'utf-8', timeout: 5000, shell: '/bin/bash' }).trim();
                                    if (!byline) {
                                        const bylineCmd2 = `docker exec ${wpContainerName} wp post meta get ${post.id} op_publisher_byline --allow-root 2>/dev/null || true`;
                                        byline = execSync(bylineCmd2, { encoding: 'utf-8', timeout: 5000, shell: '/bin/bash' }).trim();
                                    }
                                } catch (e) {
                                    byline = '';
                                }
                                displayAuthor = byline || author;
                            }
                        } else {
                            // For non-DID modes, use byline if available
                            let byline = '';
                            try {
                                const bylineCmd1 = `docker exec ${wpContainerName} wp post meta get ${post.id} _op_byline --allow-root 2>/dev/null || true`;
                                byline = execSync(bylineCmd1, { encoding: 'utf-8', timeout: 5000, shell: '/bin/bash' }).trim();
                                if (!byline) {
                                    const bylineCmd2 = `docker exec ${wpContainerName} wp post meta get ${post.id} op_publisher_byline --allow-root 2>/dev/null || true`;
                                    byline = execSync(bylineCmd2, { encoding: 'utf-8', timeout: 5000, shell: '/bin/bash' }).trim();
                                }
                            } catch (e) {
                                byline = '';
                            }
                            if (byline) {
                                displayAuthor = byline;
                            }
                        }
                    } catch (metaError) {
                        console.warn(`⚠️ [BrowseRecord] Could not fetch meta for post ${post.id}:`, metaError.message);
                        displayAuthor = author;
                    }
                    
                    const record = {
                        wordpress: {
                            postId: post.id,
                            title: post.title?.rendered || '',
                            excerpt: post.excerpt?.rendered || '',
                            content: post.content?.rendered || '',
                            postDate: post.date,
                            permalink: permalink,
                            tags: post._embedded?.['wp:term']?.[0]?.map(t => t.name) || [],
                            author: displayAuthor
                        },
                        id: `wp-${post.id}`,
                        oip: {
                            indexedAt: post.date
                        }
                    };
                    
                    console.log(`✅ [BrowseRecord] Returning WordPress post ${post.id} with author="${displayAuthor}"`);
                    return res.status(200).json(record);
                } catch (wpError) {
                    console.error('Get WordPress post error:', wpError.message);
                    return res.status(404).json({
                        error: 'WordPress post not found',
                        postId,
                        message: wpError.message
                    });
                }
            }
            
            // Otherwise, treat as OIP DID - proxy to onion-press-service
            const targetUrl = `${ONION_PRESS_URL}/onion-press/api/browse/record/${encodeURIComponent(did)}`;
            const response = await axios.get(targetUrl, {
                timeout: 30000,
                validateStatus: () => true
            });
            res.status(response.status).json(response.data);
            
        } catch (error) {
            console.error('Get record error:', error.message);
            res.status(error.response?.status || 500).json({
                error: 'Failed to get record',
                message: error.message
            });
        }
    });
    
    // GET /onion-press/api/host-info - Get host information
    app.get('/onion-press/api/host-info', (req, res) => {
        const hostName = process.env.COMPOSE_PROJECT_NAME || 'Onion Press';
        const hostUrl = process.env.PUBLIC_API_BASE_URL || `${req.protocol}://${req.get('host')}`;
        
        res.json({
            name: hostName,
            url: hostUrl
        });
    });
    
    // GET /onion-press/api/destinations/defaults - Get default destination settings (from .env)
    app.get('/onion-press/api/destinations/defaults', (req, res) => {
        try {
            const defaults = {
                arweave: process.env.PUBLISH_TO_ARWEAVE !== 'false',
                gun: process.env.PUBLISH_TO_GUN !== 'false',
                thisHost: process.env.PUBLISH_TO_THIS_HOST === 'true'
            };
            
            res.json({
                destinations: defaults
            });
        } catch (error) {
            console.error('Error getting default destinations:', error);
            // Fallback to environment variables on error
            res.json({
                destinations: {
                    arweave: process.env.PUBLISH_TO_ARWEAVE !== 'false',
                    gun: process.env.PUBLISH_TO_GUN !== 'false',
                    thisHost: process.env.PUBLISH_TO_THIS_HOST === 'true'
                }
            });
        }
    });
    
    // Proxy /onion-press/api/user/admin-status to /api/user/admin-status
    // Use a simpler approach - just forward the request
    app.get('/onion-press/api/user/admin-status', async (req, res, next) => {
        // Manually authenticate token without requiring wallet file
        const jwt = require('jsonwebtoken');
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.json({
                isWordPressAdmin: false,
                isAdmin: false,
                isOnionPressAdmin: false
            });
        }
        
        try {
            const token = authHeader.substring(7);
            const verified = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret_key_here');
            req.user = verified;
            
            // Now call the actual handler
            const user = req.user;
            
            // Check if user email matches ONIONPRESS_ADMIN
            const ONIONPRESS_ADMIN = process.env.ONIONPRESS_ADMIN || '';
            const isEmailAdmin = ONIONPRESS_ADMIN && user.email && 
                                user.email.toLowerCase() === ONIONPRESS_ADMIN.toLowerCase();
            
            if (isEmailAdmin) {
                console.log(`✅ [AdminStatus] User email matches ONIONPRESS_ADMIN: ${user.email}`);
                return res.json({
                    isWordPressAdmin: true, // Return true so settings button shows
                    isAdmin: true,
                    isOnionPressAdmin: true,
                    wordpressUserId: user.wordpressUserId || null
                });
            }
            
            // Fallback to WordPress admin check
            if (!user || !user.wordpressUserId) {
                return res.json({
                    isWordPressAdmin: false,
                    isAdmin: user?.isAdmin || false,
                    isOnionPressAdmin: false
                });
            }
            
            const { isWordPressAdmin: checkWordPressAdmin } = require('./helpers/core/wordpressUserSync');
            const wpAdmin = await checkWordPressAdmin(user.wordpressUserId);
            res.json({
                isWordPressAdmin: wpAdmin,
                isAdmin: user.isAdmin || false,
                isOnionPressAdmin: false,
                wordpressUserId: user.wordpressUserId
            });
        } catch (error) {
            console.error('Admin status auth error:', error.message);
            res.json({
                isWordPressAdmin: false,
                isAdmin: false,
                isOnionPressAdmin: false
            });
        }
    });
    
    // GET /onion-press/api/wordpress/posts - Get WordPress posts
    app.get('/onion-press/api/wordpress/posts', async (req, res) => {
        try {
            const WORDPRESS_PROXY_ENABLED = process.env.WORDPRESS_PROXY_ENABLED === 'true';
            console.log(`🔍 [WordPressPosts] Request received. WordPress proxy enabled: ${WORDPRESS_PROXY_ENABLED}`);
            
            if (!WORDPRESS_PROXY_ENABLED) {
                console.log(`⚠️ [WordPressPosts] WordPress proxy not enabled`);
                return res.status(503).json({
                    error: 'WordPress not available',
                    message: 'WordPress proxy is not enabled'
                });
            }
            
            const { limit = 20, offset = 0, search, type, author } = req.query;
            console.log(`🔍 [WordPressPosts] Query params: limit=${limit}, offset=${offset}, search=${search || 'none'}, type=${type || 'none'}, author=${author || 'none'}`);
            
            if (type && type !== 'post') {
                // WordPress only has 'post' type by default
                console.log(`ℹ️ [WordPressPosts] Type filter '${type}' is not 'post', returning empty results`);
                return res.json({ records: [] });
            }
            
            // Use wp-cli to get posts (more reliable than REST API)
            const projectName = process.env.COMPOSE_PROJECT_NAME || 'onionpress';
            const wpContainerName = `${projectName}-wordpress-1`;
            
            // Build wp-cli command to list posts
            let wpCommand = `docker exec ${wpContainerName} wp post list `;
            wpCommand += `--format=json `;
            wpCommand += `--posts_per_page=${Math.min(parseInt(limit) || 20, 100)} `;
            wpCommand += `--offset=${parseInt(offset) || 0} `;
            wpCommand += `--post_status=publish `;
            wpCommand += `--orderby=date `;
            wpCommand += `--order=DESC `;
            wpCommand += `--allow-root`;
            
            if (search) {
                // wp-cli doesn't have a direct search param, so we'll filter in code
                // But we can use --s parameter for basic search
                wpCommand += ` --s='${search.replace(/'/g, "'\\''")}'`;
            }
            
            // Note: Author filtering will be done in code after fetching posts
            // because wp-cli doesn't support filtering by custom meta fields directly
            
            console.log(`🔧 [WordPressPosts] Executing wp-cli command: ${wpCommand}`);
            
            let wpPosts;
            try {
                const wpOutput = execSync(wpCommand, { encoding: 'utf-8', timeout: 10000 });
                wpPosts = JSON.parse(wpOutput.trim() || '[]');
                
                if (!Array.isArray(wpPosts)) {
                    console.error(`❌ [WordPressPosts] wp-cli returned non-array:`, typeof wpPosts);
                    wpPosts = [];
                }
            } catch (wpError) {
                console.error(`❌ [WordPressPosts] wp-cli error:`, wpError.message);
                // If container doesn't exist or wp-cli fails, return empty array
                if (wpError.message.includes('No such container') || wpError.message.includes('Cannot connect')) {
                    console.warn(`⚠️ [WordPressPosts] WordPress container not found, returning empty results`);
                    return res.json({ records: [] });
                }
                throw wpError;
            }
            
            console.log(`✅ [WordPressPosts] Retrieved ${wpPosts.length} posts from WordPress via wp-cli`);
            
            // Get full post details for each post (wp post list doesn't include content/excerpt)
            const postsWithDetails = [];
            for (const post of wpPosts) {
                try {
                    // Get full post details
                    const detailCommand = `docker exec ${wpContainerName} wp post get ${post.ID} --format=json --allow-root`;
                    const detailOutput = execSync(detailCommand, { encoding: 'utf-8', timeout: 5000 });
                    const postDetail = JSON.parse(detailOutput.trim());
                    
                    // Get author name (fallback)
                    let authorName = '';
                    if (postDetail.post_author) {
                        try {
                            const authorCommand = `docker exec ${wpContainerName} wp user get ${postDetail.post_author} --field=display_name --allow-root`;
                            authorName = execSync(authorCommand, { encoding: 'utf-8', timeout: 3000 }).trim();
                        } catch (e) {
                            // Ignore author fetch errors
                        }
                    }
                    
                    // Fetch meta fields to get DID/byline
                    let displayAuthor = authorName;
                    try {
                        // Get publishing mode
                        let publisherMode = '';
                        try {
                            const publisherModeCmd = `docker exec ${wpContainerName} wp post meta get ${postDetail.ID} op_publisher_mode --allow-root 2>/dev/null || true`;
                            const output = execSync(publisherModeCmd, { encoding: 'utf-8', timeout: 5000, shell: '/bin/bash' });
                            publisherMode = output.trim();
                        } catch (e) {
                            // Meta field might not exist, that's OK - wp-cli returns error code 1
                            publisherMode = '';
                        }
                        const isDidMode = (publisherMode === 'did');
                        console.log(`🔍 [WordPressPosts] Post ${postDetail.ID}: mode="${publisherMode}", isDidMode=${isDidMode}, authorName="${authorName}"`);
                        
                        if (isDidMode) {
                            // For DID mode, prioritize the DID from op_publisher_creator_did
                            let creatorDid = '';
                            try {
                                const creatorDidCmd = `docker exec ${wpContainerName} wp post meta get ${postDetail.ID} op_publisher_creator_did --allow-root 2>/dev/null || true`;
                                const output = execSync(creatorDidCmd, { encoding: 'utf-8', timeout: 5000, shell: '/bin/bash' });
                                creatorDid = output.trim();
                            } catch (e) {
                                // Meta field might not exist
                                creatorDid = '';
                            }
                            console.log(`🔍 [WordPressPosts] Post ${postDetail.ID}: creatorDid="${creatorDid}"`);
                            if (creatorDid) {
                                displayAuthor = creatorDid;
                                console.log(`✅ [WordPressPosts] Post ${postDetail.ID}: Using DID "${creatorDid}"`);
                            } else {
                                // Fallback to byline meta fields
                                let byline = '';
                                try {
                                    const bylineCmd1 = `docker exec ${wpContainerName} wp post meta get ${postDetail.ID} _op_byline --allow-root 2>/dev/null || true`;
                                    const output1 = execSync(bylineCmd1, { encoding: 'utf-8', timeout: 5000, shell: '/bin/bash' });
                                    byline = output1.trim();
                                    if (!byline) {
                                        const bylineCmd2 = `docker exec ${wpContainerName} wp post meta get ${postDetail.ID} op_publisher_byline --allow-root 2>/dev/null || true`;
                                        const output2 = execSync(bylineCmd2, { encoding: 'utf-8', timeout: 5000, shell: '/bin/bash' });
                                        byline = output2.trim();
                                    }
                                } catch (e) {
                                    byline = '';
                                }
                                console.log(`🔍 [WordPressPosts] Post ${postDetail.ID}: byline="${byline}"`);
                                displayAuthor = byline || authorName;
                                console.log(`⚠️ [WordPressPosts] Post ${postDetail.ID}: DID not found, using "${displayAuthor}"`);
                            }
                        } else {
                            // For non-DID modes, use byline if available
                            let byline = '';
                            try {
                                const bylineCmd1 = `docker exec ${wpContainerName} wp post meta get ${postDetail.ID} _op_byline --allow-root 2>/dev/null || true`;
                                const output1 = execSync(bylineCmd1, { encoding: 'utf-8', timeout: 5000, shell: '/bin/bash' });
                                byline = output1.trim();
                                if (!byline) {
                                    const bylineCmd2 = `docker exec ${wpContainerName} wp post meta get ${postDetail.ID} op_publisher_byline --allow-root 2>/dev/null || true`;
                                    const output2 = execSync(bylineCmd2, { encoding: 'utf-8', timeout: 5000, shell: '/bin/bash' });
                                    byline = output2.trim();
                                }
                            } catch (e) {
                                byline = '';
                            }
                            if (byline) {
                                displayAuthor = byline;
                            }
                        }
                        console.log(`✅ [WordPressPosts] Post ${postDetail.ID}: Final displayAuthor="${displayAuthor}"`);
                    } catch (metaError) {
                        // Ignore meta fetch errors - fallback to author name
                        console.warn(`⚠️ [WordPressPosts] Could not fetch meta for post ${postDetail.ID}:`, metaError.message);
                        displayAuthor = authorName;
                    }
                    
                    postsWithDetails.push({
                        id: postDetail.ID,
                        title: postDetail.post_title || '',
                        content: postDetail.post_content || '',
                        excerpt: postDetail.post_excerpt || '',
                        date: postDetail.post_date || postDetail.post_date_gmt,
                        author: displayAuthor,
                        link: postDetail.guid || ''
                    });
                } catch (detailError) {
                    console.warn(`⚠️ [WordPressPosts] Failed to get details for post ${post.ID}: ${detailError.message}`);
                    // Fallback to basic info from list
                    postsWithDetails.push({
                        id: post.ID,
                        title: post.post_title || '',
                        content: '',
                        excerpt: '',
                        date: post.post_date || '',
                        author: '',
                        link: ''
                    });
                }
            }
            
            // Filter by search term if provided (wp-cli --s might not work perfectly)
            let filteredPosts = postsWithDetails;
            if (search) {
                const searchLower = search.toLowerCase();
                filteredPosts = postsWithDetails.filter(post => 
                    (post.title && post.title.toLowerCase().includes(searchLower)) ||
                    (post.content && post.content.toLowerCase().includes(searchLower)) ||
                    (post.excerpt && post.excerpt.toLowerCase().includes(searchLower))
                );
            }
            
            // Filter by author if provided (exact match for DIDs and emails)
            if (author) {
                console.log(`🔍 [WordPressPosts] Filtering by author: "${author}"`);
                const authorFiltered = filteredPosts.filter(post => {
                    // Exact match (case-sensitive for DIDs, case-insensitive for emails)
                    const postAuthor = post.author || '';
                    if (author.startsWith('did:arweave:')) {
                        // DIDs must match exactly (case-sensitive)
                        return postAuthor === author;
                    } else {
                        // Emails match case-insensitively
                        return postAuthor.toLowerCase() === author.toLowerCase();
                    }
                });
                console.log(`🔍 [WordPressPosts] Author filter: ${filteredPosts.length} -> ${authorFiltered.length} posts`);
                filteredPosts = authorFiltered;
            }
            
            // Build base URL for permalinks
            const baseUrl = process.env.PUBLIC_API_BASE_URL || `${req.protocol}://${req.get('host')}`;
            const wordpressPath = process.env.WORDPRESS_PROXY_PATH || '/wordpress';
            
            // Transform WordPress posts to OIP-like format
            const records = filteredPosts.map(post => {
                // Build permalink
                let permalink = post.link;
                if (!permalink && post.id) {
                    permalink = `${baseUrl}${wordpressPath}/?p=${post.id}`;
                }
                
                const record = {
                    wordpress: {
                        postId: post.id,
                        title: post.title,
                        excerpt: post.excerpt,
                        content: post.content,
                        postDate: post.date,
                        permalink: permalink,
                        tags: [], // wp-cli doesn't easily provide tags in list format
                        author: post.author
                    },
                    id: `wp-${post.id}`,
                    oip: {
                        indexedAt: post.date
                    }
                };
                
                // Debug log for DID posts
                if (post.id >= 29 && post.id <= 33) {
                    console.log(`🔍 [WordPressPosts] Building record for post ${post.id}: author="${post.author}"`);
                }
                
                return record;
            });
            
            console.log(`✅ [WordPressPosts] Returning ${records.length} transformed records`);
            // Log first few records to verify author field
            if (records.length > 0) {
                console.log(`🔍 [WordPressPosts] Sample record (post ${records[0].wordpress.postId}): author="${records[0].wordpress.author}"`);
                // Log the actual JSON being sent for the first DID post
                const didPost = records.find(r => r.wordpress.postId >= 29 && r.wordpress.postId <= 34);
                if (didPost) {
                    console.log(`🔍 [WordPressPosts] DID post ${didPost.wordpress.postId} full record:`, JSON.stringify(didPost, null, 2));
                }
            }
            const responseData = { records };
            console.log(`🔍 [WordPressPosts] Sending response with ${responseData.records.length} records`);
            res.json(responseData);
            
        } catch (error) {
            console.error('❌ [WordPressPosts] Error:', error.message);
            if (error.response) {
                console.error('❌ [WordPressPosts] WordPress response:', error.response.status, error.response.data);
            }
            res.status(500).json({
                error: 'Failed to fetch WordPress posts',
                message: error.message,
                details: error.response?.data
            });
        }
    });
    
    // GET /onion-press/api/browse/types - Get record types
    app.get('/onion-press/api/browse/types', async (req, res) => {
        try {
            // Get unique record types with counts
            const data = await getRecordsFromES({ limit: 0 });
            res.status(200).json({ 
                recordTypes: data.recordTypes || {},
                total: data.total || 0
            });
        } catch (error) {
            console.error('Onion Press types error:', error.message);
            res.status(500).json({
                error: 'Failed to get record types',
                message: error.message
            });
        }
    });
    
    // GET /onion-press/api/browse/templates - Get templates (proxy to local /api/templates)
    app.get('/onion-press/api/browse/templates', async (req, res) => {
        try {
            // Redirect internally to templates route
            const response = await axios.get(`http://localhost:${port}/api/templates`, {
                timeout: 10000
            });
            res.status(200).json(response.data);
        } catch (error) {
            res.status(500).json({ error: 'Failed to get templates', message: error.message });
        }
    });
    
    // GET /onion-press/api/tor/status - Get TOR status (proxy to onion-press-service)
    app.get('/onion-press/api/tor/status', async (req, res) => {
        try {
            const targetUrl = `${ONION_PRESS_URL}/api/tor/status`;
            
            const response = await axios.get(targetUrl, {
                timeout: 10000,
                httpAgent,
                httpsAgent,
                validateStatus: () => true // Don't throw on non-2xx
            });
            
            res.status(response.status).json(response.data);
        } catch (error) {
            // Handle DNS/connection errors gracefully (service may not be in this profile)
            const isServiceUnavailable = error.code === 'EAI_AGAIN' || 
                                         error.code === 'ECONNREFUSED' || 
                                         error.code === 'ENOTFOUND';
            
            if (isServiceUnavailable) {
                // Silently return disconnected status - this is expected when onion-press-service isn't in the profile
                res.status(200).json({
                    connected: false,
                    error: 'Onion Press service unavailable',
                    message: 'TOR service requires onion-press-server profile',
                    timestamp: new Date().toISOString()
                });
            } else {
                // Log unexpected errors
                console.error('[TOR Status] Proxy error:', error.message);
                console.error('[TOR Status] Error code:', error.code);
                
                res.status(200).json({
                    connected: false,
                    error: 'Onion Press service unavailable',
                    message: error.message,
                    code: error.code,
                    timestamp: new Date().toISOString()
                });
            }
        }
    });
    
    // POST /onion-press/api/records/publishSigned - Proxy to daemon's publishSigned endpoint
    app.post('/onion-press/api/records/publishSigned', async (req, res) => {
        try {
            const response = await axios.post(`http://localhost:${port}/api/records/publishSigned`, req.body, {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 120000,
                httpAgent,
                httpsAgent
            });
            res.status(response.status).json(response.data);
        } catch (error) {
            console.error('PublishSigned proxy error:', error.message);
            res.status(error.response?.status || 500).json({
                error: 'Publishing failed',
                message: error.response?.data?.message || error.message
            });
        }
    });
    
    // POST /onion-press/api/records/publishAnonymous - Proxy to daemon's publishAnonymous endpoint
    app.post('/onion-press/api/records/publishAnonymous', async (req, res) => {
        try {
            // Forward Authorization header so daemon can authenticate the user
            const headers = {
                'Content-Type': 'application/json'
            };
            if (req.headers.authorization) {
                headers['Authorization'] = req.headers.authorization;
                console.log(`🔍 [PublishAnonymous Proxy] Forwarding Authorization header to daemon`);
            }
            
            const response = await axios.post(`http://localhost:${port}/api/records/publishAnonymous`, req.body, {
                headers: headers,
                timeout: 120000,
                httpAgent,
                httpsAgent
            });
            res.status(response.status).json(response.data);
        } catch (error) {
            console.error('PublishAnonymous proxy error:', error.message);
            res.status(error.response?.status || 500).json({
                error: 'Publishing failed',
                message: error.response?.data?.message || error.message
            });
        }
    });
    
    // POST /onion-press/api/records/publishAccount - Proxy to daemon's publishAccount endpoint
    app.post('/onion-press/api/records/publishAccount', async (req, res) => {
        try {
            // Forward Authorization header for authentication
            const headers = {
                'Content-Type': 'application/json'
            };
            if (req.headers.authorization) {
                headers['Authorization'] = req.headers.authorization;
            }
            
            const response = await axios.post(`http://localhost:${port}/api/records/publishAccount`, req.body, {
                headers: headers,
                timeout: 120000,
                httpAgent,
                httpsAgent
            });
            res.status(response.status).json(response.data);
        } catch (error) {
            console.error('PublishAccount proxy error:', error.message);
            res.status(error.response?.status || 500).json({
                error: 'Publishing failed',
                message: error.response?.data?.message || error.message
            });
        }
    });
    
    // GET /onion-press/api/host-info - Get host information
    app.get('/onion-press/api/host-info', (req, res) => {
        const hostName = process.env.COMPOSE_PROJECT_NAME || 'Onion Press';
        const hostUrl = process.env.PUBLIC_API_BASE_URL || `${req.protocol}://${req.get('host')}`;
        
        res.json({
            name: hostName,
            url: hostUrl
        });
    });
    
    // GET /onion-press/api/wordpress/posts - Get WordPress posts
    app.get('/onion-press/api/wordpress/posts', async (req, res) => {
        try {
            const WORDPRESS_PROXY_ENABLED = process.env.WORDPRESS_PROXY_ENABLED === 'true';
            
            if (!WORDPRESS_PROXY_ENABLED) {
                return res.status(503).json({
                    error: 'WordPress not available',
                    message: 'WordPress proxy is not enabled'
                });
            }
            
            const { limit = 20, offset = 0, search, type } = req.query;
            
            // Query WordPress REST API
            const wordpressUrl = process.env.WORDPRESS_URL || 'http://wordpress:80';
            const wpApiUrl = `${wordpressUrl}/wp-json/wp/v2/posts`;
            
            const params = new URLSearchParams({
                per_page: Math.min(parseInt(limit) || 20, 100),
                offset: parseInt(offset) || 0,
                _embed: 'true'
            });
            
            if (search) {
                params.append('search', search);
            }
            
            if (type && type !== 'post') {
                // WordPress only has 'post' type by default
                return res.json({ records: [] });
            }
            
            const response = await axios.get(`${wpApiUrl}?${params.toString()}`, {
                httpAgent,
                httpsAgent,
                timeout: 10000
            });
            
            const wpPosts = response.data || [];
            
            // Transform WordPress posts to OIP-like format
            // Fetch meta fields for each post to get byline information (for anonymous posts)
            const records = await Promise.all(wpPosts.map(async (post) => {
                // Get author from WordPress post
                let author = post._embedded?.author?.[0]?.name || '';
                let displayAuthor = author;
                
                // Fetch meta fields via wp-cli (WordPress REST API doesn't reliably return custom meta)
                try {
                    const { execSync } = require('child_process');
                    const projectName = process.env.COMPOSE_PROJECT_NAME || 'onionpress';
                    const wpContainerName = `${projectName}-wordpress-1`;
                    
                    // Get publishing mode
                    let publisherMode = '';
                    try {
                        const publisherModeCmd = `docker exec ${wpContainerName} wp post meta get ${post.id} op_publisher_mode --allow-root 2>/dev/null || true`;
                        publisherMode = execSync(publisherModeCmd, { encoding: 'utf-8', timeout: 5000, shell: '/bin/bash' }).trim();
                    } catch (e) {
                        publisherMode = '';
                    }
                    const isDidMode = (publisherMode === 'did');
                    console.log(`🔍 [WordPressPosts-REST] Post ${post.id}: mode="${publisherMode}", isDidMode=${isDidMode}`);
                    
                    if (isDidMode) {
                        // For DID mode, prioritize the DID from op_publisher_creator_did
                        let creatorDid = '';
                        try {
                            const creatorDidCmd = `docker exec ${wpContainerName} wp post meta get ${post.id} op_publisher_creator_did --allow-root 2>/dev/null || true`;
                            creatorDid = execSync(creatorDidCmd, { encoding: 'utf-8', timeout: 5000, shell: '/bin/bash' }).trim();
                        } catch (e) {
                            creatorDid = '';
                        }
                        console.log(`🔍 [WordPressPosts-REST] Post ${post.id}: creatorDid="${creatorDid}"`);
                        if (creatorDid) {
                            displayAuthor = creatorDid;
                            console.log(`✅ [WordPressPosts-REST] Post ${post.id}: Using DID "${creatorDid}"`);
                        } else {
                            // Fallback to byline meta fields
                            let byline = '';
                            try {
                                const bylineCmd1 = `docker exec ${wpContainerName} wp post meta get ${post.id} _op_byline --allow-root 2>/dev/null || true`;
                                byline = execSync(bylineCmd1, { encoding: 'utf-8', timeout: 5000, shell: '/bin/bash' }).trim();
                                if (!byline) {
                                    const bylineCmd2 = `docker exec ${wpContainerName} wp post meta get ${post.id} op_publisher_byline --allow-root 2>/dev/null || true`;
                                    byline = execSync(bylineCmd2, { encoding: 'utf-8', timeout: 5000, shell: '/bin/bash' }).trim();
                                }
                            } catch (e) {
                                byline = '';
                            }
                            displayAuthor = byline || author;
                        }
                    } else {
                        // For non-DID modes, use byline if available
                        let byline = '';
                        try {
                            const bylineCmd1 = `docker exec ${wpContainerName} wp post meta get ${post.id} _op_byline --allow-root 2>/dev/null || true`;
                            byline = execSync(bylineCmd1, { encoding: 'utf-8', timeout: 5000, shell: '/bin/bash' }).trim();
                            if (!byline) {
                                const bylineCmd2 = `docker exec ${wpContainerName} wp post meta get ${post.id} op_publisher_byline --allow-root 2>/dev/null || true`;
                                byline = execSync(bylineCmd2, { encoding: 'utf-8', timeout: 5000, shell: '/bin/bash' }).trim();
                            }
                        } catch (e) {
                            byline = '';
                        }
                        if (byline) {
                            displayAuthor = byline;
                        }
                    }
                    console.log(`✅ [WordPressPosts-REST] Post ${post.id}: Final displayAuthor="${displayAuthor}"`);
                } catch (metaError) {
                    // Ignore meta fetch errors - fallback to author name
                    console.warn(`⚠️ [WordPressPosts] Could not fetch meta for post ${post.id}:`, metaError.message);
                    displayAuthor = author;
                }
                
                return {
                    wordpress: {
                        postId: post.id,
                        title: post.title?.rendered || '',
                        excerpt: post.excerpt?.rendered || '',
                        content: post.content?.rendered || '',
                        postDate: post.date,
                        permalink: post.link,
                        tags: post._embedded?.['wp:term']?.[0]?.map(t => t.name) || [],
                        author: displayAuthor
                    },
                    id: `wp-${post.id}`,
                    oip: {
                        indexedAt: post.date
                    }
                };
            }));
            
            console.log(`✅ [WordPressPosts-REST] Returning ${records.length} transformed records`);
            // Log the actual response being sent
            const didPostRecord = records.find(r => r.wordpress && r.wordpress.postId >= 29 && r.wordpress.postId <= 34);
            if (didPostRecord) {
                console.log(`🔍 [WordPressPosts-REST] DID post ${didPostRecord.wordpress.postId} in response:`, JSON.stringify({
                    postId: didPostRecord.wordpress.postId,
                    author: didPostRecord.wordpress.author
                }, null, 2));
            }
            res.json({ records });
            
        } catch (error) {
            console.error('WordPress posts API error:', error.message);
            res.status(500).json({
                error: 'Failed to fetch WordPress posts',
                message: error.message
            });
        }
    });
    
    // ─────────────────────────────────────────────────────────────────────────
    // Publish/Admin/TOR API - proxy to onion-press-service (if available)
    // ─────────────────────────────────────────────────────────────────────────
    app.use('/onion-press/api', async (req, res) => {
        let response = null;
        try {
            // req.url is the path after /onion-press/api, so we need to reconstruct the full path
            const targetUrl = `${ONION_PRESS_URL}/onion-press/api${req.url}`;
            
            // Forward all relevant headers, especially Authorization
            const headers = {
                'Content-Type': req.headers['content-type'] || 'application/json'
            };
            if (req.headers.authorization) {
                headers['Authorization'] = req.headers.authorization;
            }
            // Forward other headers that might be needed
            if (req.headers['x-requested-with']) {
                headers['X-Requested-With'] = req.headers['x-requested-with'];
            }
            
            response = await axios({
                method: req.method,
                url: targetUrl,
                data: req.body,
                headers: headers,
                timeout: 30000,
                validateStatus: () => true
            });
            
            const data = response.data;
            const status = response.status;
            response.data = null;
            response = null;
            
            res.status(status).json(data);
            
        } catch (error) {
            if (response) {
                response.data = null;
                response = null;
            }
            
            // If onion-press-service is not available, return stub response
            // Handle DNS resolution failures (EAI_AGAIN) and connection errors
            if (error.code === 'EAI_AGAIN' || error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
                // For publish destinations endpoint, return local settings
                if (req.url.startsWith('/publish/destinations')) {
                    return res.status(200).json({
                        destinations: {
                            arweave: { enabled: true, description: 'Permanent blockchain storage' },
                            gun: { enabled: true, description: 'Real-time peer sync' },
                            thisHost: { enabled: false, description: 'Requires onion-press-service' }
                        },
                        enabledDestinations: ['arweave', 'gun'],
                        note: 'Full publishing requires onion-press-server profile'
                    });
                }
                // For TOR status, return disconnected (but don't fail - let specific route handle it)
                if (req.url.startsWith('/tor/')) {
                    return res.status(200).json({
                        connected: false,
                        onionAddress: null,
                        message: 'TOR requires onion-press-server profile'
                    });
                }
                res.status(503).json({
                    error: 'Onion Press service not available',
                    message: 'Publishing and TOR features require the onion-press-server profile',
                    hint: 'Deploy with: make -f Makefile.split onion-press-server'
                });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    });
    
    // ─────────────────────────────────────────────────────────────────────────
    // Static files and SPA routing
    // ─────────────────────────────────────────────────────────────────────────
    
    // Check if Onion Press should be the default interface
    const ONION_PRESS_DEFAULT = process.env.ONION_PRESS_DEFAULT === 'true';
    
    if (ONION_PRESS_DEFAULT) {
        // Serve Onion Press as the default interface at root
        app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'onion-press', 'index.html'));
        });
        
        // Serve other public files (alfreds-notes.html, reference-client.html, etc.) at /public
        app.use('/public', express.static(path.join(__dirname, 'public')));
    } else {
        // Serve root public directory (alfreds-notes.html, reference-client.html, etc.)
        app.use(express.static(path.join(__dirname, 'public')));
    }
    
    // Serve debug interfaces
    app.get('/debug/v09', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'debug', 'v09.html'));
    });
    
    // Serve onion-press subdirectory (always available at /onion-press)
    app.use('/onion-press', express.static(path.join(__dirname, 'public', 'onion-press'), {
        index: 'index.html',
        etag: true,
        lastModified: true
    }));
    
    // Serve anonymous publisher page
    app.get('/publish', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'onion-press', 'publish.html'));
    });
    
    // Fallback for SPA routing
    app.get('/onion-press/*', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'onion-press', 'index.html'));
    });
    
    console.log(`🧅 Onion Press enabled (browse: local, publish/tor: ${ONION_PRESS_URL})`);
} else {
    app.use('/onion-press', (req, res) => {
        res.status(503).json({
            error: 'Onion Press service disabled',
            message: 'Set ONION_PRESS_ENABLED=true to enable'
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// WordPress Proxy (for remote server access)
// ═══════════════════════════════════════════════════════════════════════════════
const WORDPRESS_URL = process.env.WORDPRESS_URL || `http://wordpress:${process.env.WORDPRESS_PORT || 80}`;
const WORDPRESS_PROXY_ENABLED = process.env.WORDPRESS_PROXY_ENABLED === 'true';

if (WORDPRESS_PROXY_ENABLED) {
    const { createProxyMiddleware } = require('http-proxy-middleware');
    const { Transform } = require('stream');
    
    // Create a transform stream to rewrite HTML content
    const createHtmlRewriter = (originalHost, protocol) => {
        return new Transform({
            decodeStrings: false,
            transform(chunk, encoding, callback) {
                let html = chunk.toString('utf8');
                
                // Fix redirect_to parameters in URLs and form hidden fields
                // Pattern: redirect_to=https://domain.com/wp-admin/ or redirect_to=/wp-admin/
                html = html.replace(
                    /(redirect_to=)([^"&' ]*)(\/wp-(admin|login)[^"&' ]*)/gi,
                    (match, prefix, url, path) => {
                        // If URL doesn't include /wordpress/wp-, add it
                        if (!match.includes('/wordpress/wp-')) {
                            if (url.startsWith('http')) {
                                // Full URL - insert /wordpress before /wp-admin or /wp-login
                                const fixed = url.replace(/(\/wp-(admin|login))/, '/wordpress$1');
                                console.log(`🔧 [WordPress Proxy] Fixed redirect_to in HTML: ${url} → ${fixed}`);
                                return prefix + fixed + path;
                            } else {
                                // Relative URL - prepend /wordpress
                                return prefix + '/wordpress' + path;
                            }
                        }
                        return match;
                    }
                );
                
                // Also fix redirect_to in hidden input fields (more specific pattern)
                html = html.replace(
                    /(<input[^>]*name=["']redirect_to["'][^>]*value=["'])([^"']*\/wp-(admin|login)[^"']*)(["'])/gi,
                    (match, prefix, url, wpPath, suffix) => {
                        if (!url.includes('/wordpress/wp-')) {
                            const fixed = url.includes('://') 
                                ? url.replace(/(\/wp-(admin|login))/, '/wordpress$1')
                                : `/wordpress${url}`;
                            console.log(`🔧 [WordPress Proxy] Fixed redirect_to input field: ${url} → ${fixed}`);
                            return prefix + fixed + suffix;
                        }
                        return match;
                    }
                );
                
                // Fix form action URLs
                html = html.replace(
                    /(<form[^>]*action=["'])(\/wp-(admin|login)[^"']*)/gi,
                    (match, prefix, path) => {
                        if (!path.includes('/wordpress/wp-')) {
                            return prefix + '/wordpress' + path;
                        }
                        return match;
                    }
                );
                
                // Fix JavaScript redirect URLs
                html = html.replace(
                    /(window\.location|location\.href)\s*=\s*["']([^"']*\/wp-(admin|login)[^"']*)/gi,
                    (match, js, url) => {
                        if (!url.includes('/wordpress/wp-')) {
                            if (url.startsWith('http')) {
                                return js + ' = "' + url.replace(/(\/wp-(admin|login))/, '/wordpress$1') + '"';
                            } else {
                                return js + ' = "/wordpress' + url + '"';
                            }
                        }
                        return match;
                    }
                );
                
                callback(null, html);
            }
        });
    };
    
    const wordpressProxy = createProxyMiddleware({
        target: WORDPRESS_URL,
        changeOrigin: false,  // Keep original Host header to prevent WordPress redirects
        pathRewrite: { '^/wordpress': '' },
        onProxyReq: (proxyReq, req, res) => {
            // Preserve the original host header so WordPress knows the real domain
            const originalHost = req.headers.host;
            proxyReq.setHeader('Host', originalHost);
            proxyReq.setHeader('X-Forwarded-Host', originalHost);
            proxyReq.setHeader('X-Forwarded-Proto', req.protocol || 'https');
            proxyReq.setHeader('X-Forwarded-For', req.ip || req.connection.remoteAddress);
            proxyReq.setHeader('X-Real-IP', req.ip || req.connection.remoteAddress);
            
            // Fix redirect_to parameter in query string before it reaches WordPress
            if (req.url && req.url.includes('redirect_to=')) {
                const originalUrl = req.url;
                req.url = req.url.replace(
                    /redirect_to=([^&]*)/gi,
                    (match, encodedUrl) => {
                        try {
                            const decoded = decodeURIComponent(encodedUrl);
                            // Fix URLs that point to wp-admin or wp-login but are missing /wordpress prefix
                            if (decoded.includes('/wp-admin') || decoded.includes('/wp-login')) {
                                // Check if it's a full URL with the host but missing /wordpress
                                if (decoded.includes(originalHost) && !decoded.includes('/wordpress/wp-')) {
                                    const fixed = decoded.replace(
                                        new RegExp(`(https?://${originalHost.replace(/\./g, '\\.')})(/wp-(admin|login))`, 'g'),
                                        `$1/wordpress$2`
                                    );
                                    if (fixed !== decoded) {
                                        const newMatch = 'redirect_to=' + encodeURIComponent(fixed);
                                        console.log(`🔧 [WordPress Proxy] Fixed redirect_to query: ${decoded} → ${fixed}`);
                                        return newMatch;
                                    }
                                }
                                // Check if it's a relative URL starting with /wp-admin or /wp-login
                                else if (decoded.match(/^\/wp-(admin|login)/) && !decoded.startsWith('/wordpress/wp-')) {
                                    const fixed = `${req.protocol || 'https'}://${originalHost}/wordpress${decoded}`;
                                    const newMatch = 'redirect_to=' + encodeURIComponent(fixed);
                                    console.log(`🔧 [WordPress Proxy] Fixed redirect_to query (relative): ${decoded} → ${fixed}`);
                                    return newMatch;
                                }
                            }
                        } catch (e) {
                            console.warn(`⚠️ [WordPress Proxy] Error fixing redirect_to: ${e.message}`);
                        }
                        return match;
                    }
                );
                // Update the proxy request path
                if (req.url !== originalUrl) {
                    proxyReq.path = req.url;
                    console.log(`🔧 [WordPress Proxy] Updated request path: ${originalUrl} → ${req.url}`);
                }
            }
        },
        onProxyRes: (proxyRes, req, res) => {
            const originalHost = req.headers.host;
            const protocol = req.protocol || 'https';
            
            // Fix any Location headers in redirects
            if (proxyRes.headers.location) {
                const location = proxyRes.headers.location;
                let fixedLocation = location;
                
                // Fix URLs that point to WordPress admin/login but are missing /wordpress prefix
                if (fixedLocation.includes('/wp-admin') || fixedLocation.includes('/wp-login')) {
                    // If it's a full URL with the correct host but missing /wordpress
                    if (fixedLocation.includes(originalHost) && !fixedLocation.includes('/wordpress/wp-')) {
                        fixedLocation = fixedLocation.replace(
                            new RegExp(`(https?://${originalHost.replace(/\./g, '\\.')})(/wp-(admin|login))`, 'g'),
                            `$1/wordpress$2`
                        );
                    }
                    // If it's a relative URL starting with /wp-admin or /wp-login
                    else if (fixedLocation.match(/^\/wp-(admin|login)/) && !fixedLocation.startsWith('/wordpress/wp-')) {
                        fixedLocation = `${protocol}://${originalHost}/wordpress${fixedLocation}`;
                    }
                }
                
                // Fix any redirect to the root domain that should include /wordpress
                // Pattern: https://alexandria.io/ -> https://alexandria.io/wordpress/
                if (fixedLocation === `${protocol}://${originalHost}/` || fixedLocation === `${protocol}://${originalHost}`) {
                    fixedLocation = `${protocol}://${originalHost}/wordpress/`;
                }
                
                // Fix internal WordPress hostname references
                if (fixedLocation.includes('wordpress:') || fixedLocation.includes('wordpress/')) {
                    fixedLocation = fixedLocation
                        .replace(/https?:\/\/wordpress[:\/]/g, `${protocol}://${originalHost}/wordpress`)
                        .replace(/^\/wordpress/, `${protocol}://${originalHost}/wordpress`);
                }
                
                if (fixedLocation !== location) {
                    console.log(`🔧 [WordPress Proxy] Fixed redirect: ${location} → ${fixedLocation}`);
                    proxyRes.headers.location = fixedLocation;
                }
            }
            
        },
        onError: (err, req, res) => {
            console.error('[WordPress Proxy] Error:', err.message);
            res.status(503).json({
                error: 'WordPress service not available',
                message: 'WordPress requires the onion-press-server profile',
                hint: 'Deploy with: make -f Makefile.split onion-press-server'
            });
        }
    });
    
    app.use('/wordpress', wordpressProxy);
    console.log(`📝 WordPress proxy enabled at /wordpress → ${WORDPRESS_URL}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Static File Serving with Memory-Safe Patterns
// ═══════════════════════════════════════════════════════════════════════════════
const mediaStaticOptions = {
    etag: true,
    lastModified: true,
    maxAge: '1y',
    immutable: true,
    setHeaders: (res, filePath) => {
        if (filePath.match(/\.(gif|jpg|png|svg)$/i)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
};

// MEMORY LEAK FIX: Semaphore to limit concurrent file streams
const MAX_CONCURRENT_STREAMS = 20;
let activeStreams = 0;
const streamQueue = [];

const acquireStream = () => {
    return new Promise((resolve) => {
        if (activeStreams < MAX_CONCURRENT_STREAMS) {
            activeStreams++;
            resolve();
        } else {
            streamQueue.push(resolve);
        }
    });
};

const releaseStream = () => {
    activeStreams--;
    if (streamQueue.length > 0) {
        const next = streamQueue.shift();
        activeStreams++;
        next();
    }
};

// Media static middleware with stream management
const forceStaticCleanup = (req, res, next) => {
    const originalEnd = res.end;
    const isMedia = req.path && /\.(gif|jpg|png|mp4|webm)$/i.test(req.path);
    let streamAcquired = false;
    
    if (isMedia) {
        acquireStream().then(() => {
            streamAcquired = true;
        });
    }
    
    res.end = function(...args) {
        const result = originalEnd.apply(this, args);
        
        if (isMedia && streamAcquired) {
            releaseStream();
        }
        
        // Force GC for media responses
        if (global.gc && isMedia) {
            process.nextTick(() => {
                global.gc();
            });
        }
        
        return result;
    };
    
    next();
};

app.use('/media', forceStaticCleanup, express.static(
    path.join(__dirname, 'data', 'media', 'web'), 
    mediaStaticOptions
));

// ═══════════════════════════════════════════════════════════════════════════════
// Basic Health Check
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK',
        service: 'oip-daemon-service',
        timestamp: new Date().toISOString()
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OIP JSON-LD Namespace Context
// Provides the JSON-LD context schema for OIP DID documents
// Referenced by @context in DID documents as: ["https://www.w3.org/ns/did/v1", "{baseUrl}/ns/v1"]
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/ns/v1', (req, res) => {
    const { getBaseUrlFromRequest } = require('./helpers/core/urlHelper');
    const baseUrl = getBaseUrlFromRequest(req);
    
    res.setHeader('Content-Type', 'application/ld+json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
        '@context': {
            '@version': 1.1,
            'oip': `${baseUrl}/ns/v1#`,
            'xpub': { '@id': 'oip:xpub', '@type': '@id' },
            'derivationPathPrefix': 'oip:derivationPathPrefix',
            'leafIndexPolicy': 'oip:leafIndexPolicy',
            'validFromBlock': { '@id': 'oip:validFromBlock', '@type': 'http://www.w3.org/2001/XMLSchema#unsignedLong' },
            'revokedFromBlock': { '@id': 'oip:revokedFromBlock', '@type': 'http://www.w3.org/2001/XMLSchema#unsignedLong' },
            'isActive': { '@id': 'oip:isActive', '@type': 'http://www.w3.org/2001/XMLSchema#boolean' },
            'profile': 'oip:profile',
            'handle': 'oip:handle',
            'handleRaw': 'oip:handleRaw',
            'name': 'oip:name',
            'surname': 'oip:surname',
            'language': 'oip:language',
            'social': 'oip:social',
            'x': 'oip:socialX',
            'youtube': 'oip:socialYoutube',
            'instagram': 'oip:socialInstagram',
            'tiktok': 'oip:socialTiktok',
            'keyBindingPolicy': 'oip:keyBindingPolicy',
            'isBootstrap': { '@id': 'oip:isBootstrap', '@type': 'http://www.w3.org/2001/XMLSchema#boolean' },
            'isLegacy': { '@id': 'oip:isLegacy', '@type': 'http://www.w3.org/2001/XMLSchema#boolean' },
            'signingXpub': 'oip:signingXpub',
            'XpubDerivation2025': 'oip:XpubDerivation2025'
        },
        '@id': `${baseUrl}/ns/v1`,
        'name': 'OIP DID Document Extension',
        'version': '1.0.0',
        'description': 'JSON-LD context for Open Index Protocol DID documents with xpub-based verification methods'
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Track memory growth between samples to identify leak sources
let lastMemorySample = null;
let memorySamples = [];
const MAX_SAMPLES = 20;

// DEBUG ENDPOINT - Shows exactly what's consuming memory
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/debug/memory', async (req, res) => {
    try {
        const v8 = require('v8');
        
        // Force GC first to see what's actually retained (not just garbage)
        if (global.gc) {
            global.gc();
            console.log('🧹 Forced GC before memory snapshot');
        }
        
        const heapStats = v8.getHeapStatistics();
        const memUsage = process.memoryUsage();
        
        // Track memory growth over time
        const currentSample = {
            timestamp: new Date().toISOString(),
            heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
            rssMB: Math.round(memUsage.rss / 1024 / 1024)
        };
        
        let growthInfo = null;
        if (lastMemorySample) {
            const timeDiffMin = (Date.now() - new Date(lastMemorySample.timestamp).getTime()) / 60000;
            const heapGrowth = currentSample.heapUsedMB - lastMemorySample.heapUsedMB;
            growthInfo = {
                sinceLast: {
                    minutes: Math.round(timeDiffMin),
                    heapGrowthMB: heapGrowth,
                    growthPerMinute: timeDiffMin > 0 ? (heapGrowth / timeDiffMin).toFixed(2) + ' MB/min' : 'N/A'
                }
            };
        }
        
        // Store sample for history
        memorySamples.push(currentSample);
        if (memorySamples.length > MAX_SAMPLES) {
            memorySamples.shift();
        }
        lastMemorySample = currentSample;
        
        // Calculate overall trend
        let trendInfo = null;
        if (memorySamples.length >= 3) {
            const oldest = memorySamples[0];
            const newest = memorySamples[memorySamples.length - 1];
            const totalMinutes = (new Date(newest.timestamp) - new Date(oldest.timestamp)) / 60000;
            const totalGrowth = newest.heapUsedMB - oldest.heapUsedMB;
            trendInfo = {
                sampleCount: memorySamples.length,
                periodMinutes: Math.round(totalMinutes),
                totalGrowthMB: totalGrowth,
                avgGrowthPerMinute: totalMinutes > 0 ? (totalGrowth / totalMinutes).toFixed(2) + ' MB/min' : 'N/A',
                projectedDailyGrowthGB: totalMinutes > 0 ? ((totalGrowth / totalMinutes) * 60 * 24 / 1024).toFixed(2) + ' GB/day' : 'N/A'
            };
        }
        
        const cacheInfo = {
            note: 'Use /debug/clear-cache to manually clear caches',
            growthTracking: growthInfo,
            trend: trendInfo
        };
        
        // Get heap space breakdown
        const heapSpaces = v8.getHeapSpaceStatistics();
        const heapBreakdown = heapSpaces.map(space => ({
            name: space.space_name,
            sizeMB: Math.round(space.space_size / 1024 / 1024),
            usedMB: Math.round(space.space_used_size / 1024 / 1024),
            availableMB: Math.round(space.space_available_size / 1024 / 1024)
        }));
        
        const result = {
            timestamp: new Date().toISOString(),
            uptime: Math.round(process.uptime()),
            memory: {
                rss: Math.round(memUsage.rss / 1024 / 1024) + ' MB',
                heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB',
                heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
                external: Math.round(memUsage.external / 1024 / 1024) + ' MB',
                arrayBuffers: Math.round(memUsage.arrayBuffers / 1024 / 1024) + ' MB'
            },
            heapStats: {
                totalHeapSize: Math.round(heapStats.total_heap_size / 1024 / 1024) + ' MB',
                usedHeapSize: Math.round(heapStats.used_heap_size / 1024 / 1024) + ' MB',
                heapSizeLimit: Math.round(heapStats.heap_size_limit / 1024 / 1024) + ' MB',
                mallocedMemory: Math.round(heapStats.malloced_memory / 1024 / 1024) + ' MB',
                peakMallocedMemory: Math.round(heapStats.peak_malloced_memory / 1024 / 1024) + ' MB',
                numberOfNativeContexts: heapStats.number_of_native_contexts,
                numberOfDetachedContexts: heapStats.number_of_detached_contexts
            },
            heapSpaces: heapBreakdown,
            caches: cacheInfo,
            gcAvailable: typeof global.gc === 'function'
        };
        
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

// Trigger a heap snapshot (save to file for Chrome DevTools analysis)
app.get('/debug/heap-snapshot', async (req, res) => {
    try {
        const v8 = require('v8');
        const fs = require('fs').promises;
        const path = require('path');
        
        // Force GC first
        if (global.gc) global.gc();
        
        const snapshotDir = path.join(__dirname, 'logs', 'heap-dumps');
        await fs.mkdir(snapshotDir, { recursive: true });
        
        const filename = `heap-${Date.now()}.heapsnapshot`;
        const filepath = path.join(snapshotDir, filename);
        
        v8.writeHeapSnapshot(filepath);
        
        res.json({
            success: true,
            message: 'Heap snapshot saved',
            path: filepath,
            instructions: 'Download this file and open it in Chrome DevTools -> Memory tab'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DEBUG ENDPOINT - Show potential leak sources
app.get('/debug/leak-sources', (req, res) => {
    try {
        // Count modules in require cache
        const moduleCount = Object.keys(require.cache).length;
        
        // Check for accumulated timers/intervals
        const activeHandles = process._getActiveHandles?.() || [];
        const activeRequests = process._getActiveRequests?.() || [];
        
        // Categorize active handles
        const handleTypes = {};
        for (const handle of activeHandles) {
            const type = handle.constructor?.name || 'Unknown';
            handleTypes[type] = (handleTypes[type] || 0) + 1;
        }
        
        // Get event emitter listener counts for common emitters
        const listenerCounts = {};
        try {
            if (process.listenerCount) {
                listenerCounts.process = {
                    uncaughtException: process.listenerCount('uncaughtException'),
                    unhandledRejection: process.listenerCount('unhandledRejection'),
                    warning: process.listenerCount('warning')
                };
            }
        } catch (e) { /* ignore */ }
        
        // Check socket.io connections
        const io = app.get('io');
        const socketCount = io?.sockets?.sockets?.size || 0;
        
        res.json({
            timestamp: new Date().toISOString(),
            potentialSources: {
                requireCacheModules: moduleCount,
                activeHandles: activeHandles.length,
                handleTypes: handleTypes,
                activeRequests: activeRequests.length,
                socketIOConnections: socketCount,
                eventListeners: listenerCounts
            },
            suggestions: [
                moduleCount > 500 ? '⚠️ High module count - possible dynamic require() leak' : '✅ Module count normal',
                activeHandles.length > 100 ? '⚠️ Many active handles - check for unclosed connections' : '✅ Active handles normal',
                socketCount > 50 ? '⚠️ Many socket.io connections - possible connection leak' : '✅ Socket.io connections normal'
            ]
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DEBUG ENDPOINT - Request statistics
app.get('/debug/request-stats', (req, res) => {
    const uptimeSeconds = Math.round((Date.now() - requestStats.lastReset) / 1000);
    const requestsPerMinute = uptimeSeconds > 0 ? Math.round((requestStats.total / uptimeSeconds) * 60) : 0;
    
    // Sort paths by count
    const topPaths = Object.entries(requestStats.byPath)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);
    
    res.json({
        totalRequests: requestStats.total,
        uptimeSeconds,
        requestsPerMinute,
        topPaths: Object.fromEntries(topPaths),
        note: 'High request counts that don\'t match client usage may indicate a leak'
    });
});

// Middleware to count requests
app.use((req, res, next) => {
    requestStats.total++;
    const path = req.path.split('?')[0]; // Remove query string
    requestStats.byPath[path] = (requestStats.byPath[path] || 0) + 1;
    next();
});

// DEBUG ENDPOINT - Deep memory analysis
app.get('/debug/memory-deep', (req, res) => {
    try {
        const v8 = require('v8');
        
        // Get globals that might be leaking
        const globalKeys = Object.keys(global).filter(k => 
            k !== 'global' && k !== 'process' && k !== 'console' && 
            k !== 'Buffer' && k !== 'clearImmediate' && k !== 'clearInterval' &&
            k !== 'clearTimeout' && k !== 'setImmediate' && k !== 'setInterval' &&
            k !== 'setTimeout' && k !== 'queueMicrotask' && k !== 'structuredClone' &&
            k !== 'atob' && k !== 'btoa' && k !== 'performance' && k !== 'fetch' &&
            k !== 'crypto' && k !== 'navigator' && k !== 'WebAssembly'
        );
        
        const globalInfo = {};
        for (const key of globalKeys) {
            const val = global[key];
            if (val === null) {
                globalInfo[key] = 'null';
            } else if (val === undefined) {
                globalInfo[key] = 'undefined';
            } else if (typeof val === 'function') {
                globalInfo[key] = 'function';
            } else if (typeof val === 'object') {
                if (Array.isArray(val)) {
                    globalInfo[key] = `Array(${val.length})`;
                } else if (val instanceof Map) {
                    globalInfo[key] = `Map(${val.size})`;
                } else if (val instanceof Set) {
                    globalInfo[key] = `Set(${val.size})`;
                } else {
                    globalInfo[key] = `Object(${Object.keys(val).length} keys)`;
                }
            } else {
                globalInfo[key] = typeof val;
            }
        }
        
        // Get V8 heap statistics
        const heapStats = v8.getHeapStatistics();
        const heapSpaceStats = v8.getHeapSpaceStatistics();
        
        // Find old_space usage
        const oldSpace = heapSpaceStats.find(s => s.space_name === 'old_space');
        
        res.json({
            timestamp: new Date().toISOString(),
            uptime: Math.round(process.uptime()),
            heapUsedMB: Math.round(heapStats.used_heap_size / 1024 / 1024),
            oldSpaceMB: oldSpace ? Math.round(oldSpace.space_used_size / 1024 / 1024) : 'N/A',
            globalVariables: globalInfo,
            requireCacheCount: Object.keys(require.cache).length,
            note: 'If old_space keeps growing, objects are being retained by references'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Memory growth tracking for leak detection
let memorySnapshots = [];
const MAX_SNAPSHOTS = 60; // Keep 60 samples (1 hour at 1 per minute)

// DEBUG ENDPOINT - Track memory growth over time
app.get('/debug/memory-growth', (req, res) => {
    try {
        const v8 = require('v8');
        const heapStats = v8.getHeapStatistics();
        const heapSpaceStats = v8.getHeapSpaceStatistics();
        const oldSpace = heapSpaceStats.find(s => s.space_name === 'old_space');
        
        // Take a new snapshot
        const snapshot = {
            timestamp: Date.now(),
            heapUsedMB: Math.round(heapStats.used_heap_size / 1024 / 1024),
            oldSpaceMB: oldSpace ? Math.round(oldSpace.space_used_size / 1024 / 1024) : 0,
            externalMB: Math.round(process.memoryUsage().external / 1024 / 1024),
            requireCacheCount: Object.keys(require.cache).length,
            activeHandles: process._getActiveHandles().length,
            activeRequests: process._getActiveRequests().length
        };
        
        memorySnapshots.push(snapshot);
        if (memorySnapshots.length > MAX_SNAPSHOTS) {
            memorySnapshots.shift();
        }
        
        // Calculate growth rates if we have enough data
        let growthAnalysis = null;
        if (memorySnapshots.length >= 5) {
            const oldest = memorySnapshots[0];
            const newest = memorySnapshots[memorySnapshots.length - 1];
            const timeDiffMinutes = (newest.timestamp - oldest.timestamp) / 1000 / 60;
            
            if (timeDiffMinutes > 0) {
                growthAnalysis = {
                    periodMinutes: Math.round(timeDiffMinutes),
                    heapGrowthPerMin: ((newest.heapUsedMB - oldest.heapUsedMB) / timeDiffMinutes).toFixed(2),
                    oldSpaceGrowthPerMin: ((newest.oldSpaceMB - oldest.oldSpaceMB) / timeDiffMinutes).toFixed(2),
                    requireCacheGrowth: newest.requireCacheCount - oldest.requireCacheCount,
                    handleGrowth: newest.activeHandles - oldest.activeHandles
                };
            }
        }
        
        res.json({
            current: snapshot,
            growthAnalysis,
            snapshotCount: memorySnapshots.length,
            suggestion: growthAnalysis && parseFloat(growthAnalysis.oldSpaceGrowthPerMin) > 5 
                ? '⚠️ Significant old_space growth - objects being retained'
                : '✅ Memory growth within normal range'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DEBUG ENDPOINT - Clear caches to free memory
app.get('/debug/clear-cache', (req, res) => {
    try {
        const { clearRecordsCache } = require('./helpers/core/elasticsearch');
        
        const beforeMem = process.memoryUsage();
        
        // Clear the records cache
        clearRecordsCache();
        
        // Force GC if available
        if (global.gc) {
            global.gc();
        }
        
        const afterMem = process.memoryUsage();
        
        res.json({
            success: true,
            message: 'Cache cleared and GC triggered',
            memoryFreed: {
                heapMB: Math.round((beforeMem.heapUsed - afterMem.heapUsed) / 1024 / 1024),
                rssMB: Math.round((beforeMem.rss - afterMem.rss) / 1024 / 1024)
            },
            currentMemory: {
                heapUsedMB: Math.round(afterMem.heapUsed / 1024 / 1024),
                rssMB: Math.round(afterMem.rss / 1024 / 1024)
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DEBUG ENDPOINT - Aggressive cleanup (clears more internal state)
app.get('/debug/aggressive-cleanup', async (req, res) => {
    try {
        const beforeMem = process.memoryUsage();
        
        // 1. Clear records cache
        const { clearRecordsCache } = require('./helpers/core/elasticsearch');
        clearRecordsCache();
        
        // 2. Clear memory sample history
        memorySamples.length = 0;
        lastMemorySample = null;
        
        // 3. Force multiple GC passes
        if (global.gc) {
            global.gc();
            await new Promise(r => setTimeout(r, 100));
            global.gc();
            await new Promise(r => setTimeout(r, 100));
            global.gc();
        }
        
        const afterMem = process.memoryUsage();
        
        res.json({
            success: true,
            message: 'Aggressive cleanup completed (3x GC passes)',
            memoryFreed: {
                heapMB: Math.round((beforeMem.heapUsed - afterMem.heapUsed) / 1024 / 1024),
                rssMB: Math.round((beforeMem.rss - afterMem.rss) / 1024 / 1024)
            },
            currentMemory: {
                heapUsedMB: Math.round(afterMem.heapUsed / 1024 / 1024),
                rssMB: Math.round(afterMem.rss / 1024 / 1024)
            },
            note: 'If heap is still high, the leak is in retained objects not caches'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Make io available to routes
app.set('io', io);

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Error Handler
// ═══════════════════════════════════════════════════════════════════════════════
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Server error', message: err.message });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Server Initialization
// ═══════════════════════════════════════════════════════════════════════════════
initializeIndices()
    .then(async () => {
        const args = minimist(process.argv.slice(2));
        
        // CLI functionality for record deletion (same as original)
        if (args.deleteRecords && args.index && args.blockThreshold) {
            const index = args.index;
            const blockThreshold = parseInt(args.blockThreshold, 10);
            if (isNaN(blockThreshold)) {
                console.error('Invalid blockThreshold');
                process.exit(1);
            }
            try {
                console.log(`Deleting records from '${index}' with inArweaveBlock >= ${blockThreshold}...`);
                await deleteRecordsByBlock(index, blockThreshold);
                process.exit(0);
            } catch (error) {
                console.error('Deletion error:', error);
                process.exit(1);
            }
        }

        if (args.deleteRecords && args.index && args.did) {
            try {
                console.log(`Deleting records with DID '${args.did}'...`);
                await deleteRecordsByDID(args.index, args.did);
                process.exit(0);
            } catch (error) {
                console.error('Deletion error:', error);
                process.exit(1);
            }
        }

        if (args.deleteAllRecords && args.index) {
            try {
                console.log(`Deleting all records from '${args.index}'...`);
                await deleteRecordsByIndex(args.index);
                process.exit(0);
            } catch (error) {
                console.error('Deletion error:', error);
                process.exit(1);
            }
        }

        if (args.deleteIndex && args.index) {
            try {
                console.log(`Deleting index '${args.index}'...`);
                await deleteIndex(args.index);
                process.exit(0);
            } catch (error) {
                console.error('Index deletion error:', error);
                process.exit(1);
            }
        }

        // Start server
        server.listen(port, async () => {
            console.log(`\n═══════════════════════════════════════════════════════════════`);
            console.log(`  OIP DAEMON SERVICE`);
            console.log(`  Port: ${port}`);
            console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`═══════════════════════════════════════════════════════════════\n`);

            // Initialize MediaSeeder (non-blocking)
            const mediaSeeder = getMediaSeeder();
            mediaSeeder.initialize()
                .then(() => console.log('🌱 MediaSeeder initialized'))
                .catch((err) => console.error('❌ MediaSeeder error:', err));

            // Start GUN sync service (non-blocking)
            if (gunSyncService) {
                gunSyncService.start()
                    .then(() => console.log('🔄 GUN Sync Service started'))
                    .catch((err) => console.error('❌ GUN Sync error:', err));
            }

            // ═══════════════════════════════════════════════════════════════════
            // Memory Monitor
            // ═══════════════════════════════════════════════════════════════════
            const memoryMonitorInterval = parseInt(process.env.MEMORY_MONITOR_INTERVAL) || 300000;
            const memoryWarningThreshold = parseInt(process.env.MEMORY_WARNING_THRESHOLD) || 80;
            
            setInterval(() => {
                const memUsage = process.memoryUsage();
                const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
                const rssMB = Math.round(memUsage.rss / 1024 / 1024);
                const externalMB = Math.round(memUsage.external / 1024 / 1024);
                
                const v8 = require('v8');
                const heapStats = v8.getHeapStatistics();
                const heapUtilization = ((heapStats.used_heap_size / heapStats.heap_size_limit) * 100).toFixed(2);
                
                console.log(`[Memory] Heap: ${heapUsedMB}MB (${heapUtilization}%), RSS: ${rssMB}MB, External: ${externalMB}MB`);
                
                // Critical warning
                if (rssMB > 10240) {
                    console.warn(`🚨 MEMORY CRITICAL: RSS at ${rssMB}MB`);
                    if (global.gc) {
                        console.log('🧹 Emergency GC...');
                        global.gc();
                    }
                }
                
                // High utilization warning
                if (parseFloat(heapUtilization) > memoryWarningThreshold) {
                    console.warn(`⚠️  HIGH MEMORY: ${heapUtilization}% heap utilization`);
                    if (global.gc && parseFloat(heapUtilization) > 90) {
                        global.gc();
                    }
                }
            }, memoryMonitorInterval);
            
            console.log(`✅ Memory monitor started (${memoryMonitorInterval/1000}s interval)`);

            // ═══════════════════════════════════════════════════════════════════
            // Periodic Memory Cleanup (configurable, default 6 hours)
            // Clears caches and forces GC to prevent slow memory accumulation
            // Set MEMORY_CLEANUP_INTERVAL_HOURS=0 to disable
            // ═══════════════════════════════════════════════════════════════════
            const cleanupHours = parseFloat(process.env.MEMORY_CLEANUP_INTERVAL_HOURS ?? 6);
            
            if (cleanupHours > 0) {
                const CLEANUP_INTERVAL = cleanupHours * 60 * 60 * 1000;
                setInterval(() => {
                    try {
                        const beforeMem = process.memoryUsage();
                        
                        // Clear the records cache
                        const { clearRecordsCache } = require('./helpers/core/elasticsearch');
                        clearRecordsCache();
                        
                        // Force garbage collection
                        if (global.gc) {
                            global.gc();
                        }
                        
                        const afterMem = process.memoryUsage();
                        const freedMB = Math.round((beforeMem.heapUsed - afterMem.heapUsed) / 1024 / 1024);
                        
                        console.log(`🧹 [Periodic Cleanup] Cache cleared, GC run. Freed: ${freedMB}MB, Current heap: ${Math.round(afterMem.heapUsed / 1024 / 1024)}MB`);
                    } catch (error) {
                        console.error('❌ [Periodic Cleanup] Error:', error.message);
                    }
                }, CLEANUP_INTERVAL);
                
                console.log(`✅ Periodic memory cleanup scheduled (every ${cleanupHours} hours)`);
            } else {
                console.log(`ℹ️  Periodic memory cleanup disabled (MEMORY_CLEANUP_INTERVAL_HOURS=0)`);
            }
            
            // ═══════════════════════════════════════════════════════════════════
            // MEMORY LEAK FIX: Periodic Socket Cleanup (every 30 minutes)
            // Destroys accumulated sockets from HTTP agents to prevent socket leak
            // ═══════════════════════════════════════════════════════════════════
            const SOCKET_CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutes
            setInterval(() => {
                try {
                    const beforeHandles = process._getActiveHandles().filter(h => h.constructor.name === 'Socket').length;
                    
                    // Destroy and recreate HTTP agents
                    httpAgent.destroy();
                    httpsAgent.destroy();
                    
                    // Log socket count
                    const afterHandles = process._getActiveHandles().filter(h => h.constructor.name === 'Socket').length;
                    console.log(`🔌 [Socket Cleanup] Destroyed agents. Sockets: ${beforeHandles} → ${afterHandles}`);
                } catch (error) {
                    console.error('❌ [Socket Cleanup] Error:', error.message);
                }
            }, SOCKET_CLEANUP_INTERVAL);
            console.log(`✅ Periodic socket cleanup scheduled (every 30 minutes)`);
            
            // ═══════════════════════════════════════════════════════════════════
            // MEMORY SAFETY: Scheduled restart check at configured time
            // Checks memory once per day at MEMORY_RESTART_TIME (default 02:00)
            // Only restarts if heap exceeds MEMORY_RESTART_THRESHOLD_GB
            // Set MEMORY_RESTART_THRESHOLD_GB to 0 to disable
            // ═══════════════════════════════════════════════════════════════════
            const memoryRestartThresholdGB = parseFloat(process.env.MEMORY_RESTART_THRESHOLD_GB ?? 12);
            const memoryRestartTime = process.env.MEMORY_RESTART_TIME || '02:00'; // 24-hour format, local time
            const memoryRestartTZ = process.env.MEMORY_RESTART_TIMEZONE || 'America/Los_Angeles';
            
            if (memoryRestartThresholdGB > 0) {
                // Parse the configured time
                const [targetHour, targetMinute] = memoryRestartTime.split(':').map(Number);
                
                // Check every minute if we've reached the target time
                let lastCheckDate = null;
                
                setInterval(() => {
                    try {
                        // Get current time in the configured timezone
                        const now = new Date();
                        const localTime = new Date(now.toLocaleString('en-US', { timeZone: memoryRestartTZ }));
                        const currentHour = localTime.getHours();
                        const currentMinute = localTime.getMinutes();
                        const todayDate = localTime.toDateString();
                        
                        // Only check once per day at the target time (within a 1-minute window)
                        if (currentHour === targetHour && 
                            currentMinute === targetMinute && 
                            lastCheckDate !== todayDate) {
                            
                            lastCheckDate = todayDate;
                            
                            const memUsage = process.memoryUsage();
                            const heapUsedGB = memUsage.heapUsed / 1024 / 1024 / 1024;
                            const rssGB = memUsage.rss / 1024 / 1024 / 1024;
                            
                            console.log(`\n🕐 [Scheduled Check] ${memoryRestartTime} ${memoryRestartTZ}`);
                            console.log(`   Heap: ${heapUsedGB.toFixed(2)}GB | Threshold: ${memoryRestartThresholdGB}GB`);
                            
                            if (heapUsedGB > memoryRestartThresholdGB) {
                                console.log(`\n⚠️  ════════════════════════════════════════════════════════`);
                                console.log(`⚠️  MEMORY THRESHOLD EXCEEDED: ${heapUsedGB.toFixed(2)}GB > ${memoryRestartThresholdGB}GB`);
                                console.log(`⚠️  RSS: ${rssGB.toFixed(2)}GB | Initiating graceful restart...`);
                                console.log(`⚠️  ════════════════════════════════════════════════════════\n`);
                                
                                // Graceful shutdown - allow Docker to restart
                                process.exit(0);
                            } else {
                                console.log(`   ✅ Memory OK, no restart needed\n`);
                            }
                        }
                    } catch (error) {
                        console.error('❌ [Scheduled Check] Error:', error.message);
                    }
                }, 60 * 1000); // Check every minute
                
                console.log(`✅ Scheduled memory check: ${memoryRestartTime} ${memoryRestartTZ} (threshold: ${memoryRestartThresholdGB}GB)`);
            } else {
                console.log(`ℹ️  Scheduled memory restart disabled (MEMORY_RESTART_THRESHOLD_GB=0)`);
            }

            // ═══════════════════════════════════════════════════════════════════
            // keepDBUpToDate (Arweave indexing)
            // ═══════════════════════════════════════════════════════════════════
            let remapTemplates = [];
            if (args.remapTemplates) {
                remapTemplates = args.remapTemplates.split(',');
                console.log(`Remap templates: ${remapTemplates.join(', ')}`);
                await remapExistingRecords(remapTemplates);
            }

            if (args.keepDBUpToDate) {
                const wait = parseInt(args.keepDBUpToDate, 10);
                const interval = args._[0] ? parseInt(args._[0], 10) : 600;
                
                if (isNaN(wait) || isNaN(interval)) {
                    console.error('Invalid --keepDBUpToDate arguments');
                    process.exit(1);
                }
                
                const minutes = interval > 120 ? Math.floor(interval / 60) : interval;
                const unit = interval > 120 ? 'minutes' : 'seconds';
                console.log(`📡 Will sync from Arweave every ${minutes} ${unit}`);

                // Note: Old memory tracker removed - was disabled and just adding log noise
                // Memory monitoring now handled by /debug/memory endpoints and MEMORY_RESTART_THRESHOLD_GB

                setTimeout(async () => {
                    console.log('🚀 Starting first keepDBUpToDate cycle...');
                    try {
                        setIsProcessing(true);
                        await keepDBUpToDate(remapTemplates);
                        console.log('✅ First sync complete');
                    } catch (error) {
                        console.error('❌ Sync error:', error);
                    } finally {
                        setIsProcessing(false);
                    }
                    
                    setInterval(async () => {
                        if (!getIsProcessing()) {
                            try {
                                setIsProcessing(true);
                                await keepDBUpToDate(remapTemplates);
                            } catch (error) {
                                console.error('❌ Sync error:', error);
                            } finally {
                                setIsProcessing(false);
                            }
                        }
                    }, interval * 1000);
                }, wait * 1000);
            }
        });
    })
    .catch(error => {
        console.error('Failed to initialize:', error);
        server.listen(port, () => {
            console.log(`Server running on port ${port} (init failed)`);
        });
    });

// ═══════════════════════════════════════════════════════════════════════════════
// Graceful Shutdown
// ═══════════════════════════════════════════════════════════════════════════════
process.on('uncaughtException', (error) => {
    console.error('\n🚨 UNCAUGHT EXCEPTION 🚨');
    console.error('Time:', new Date().toISOString());
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error('Memory:', process.memoryUsage());
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('\n⚠️  UNHANDLED REJECTION');
    console.error('Time:', new Date().toISOString());
    console.error('Reason:', reason);
    // Don't exit - log and continue
});

process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down...');
    console.log('Memory at shutdown:', process.memoryUsage());
    if (gunSyncService) {
        gunSyncService.stop();
    }
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('🛑 SIGINT received, shutting down...');
    if (gunSyncService) {
        gunSyncService.stop();
    }
    process.exit(0);
});

