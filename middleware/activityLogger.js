const { elasticClient } = require('../helpers/core/elasticsearch');

/**
 * Middleware to log API activity for analytics
 * Tracks authenticated user activity, endpoints called, and response status
 * 
 * IMPORTANT: This middleware intercepts res.json() which is called AFTER 
 * authentication middleware runs, so req.user should be populated for 
 * authenticated requests.
 */
async function logAPIActivity(req, res, next) {
    // Capture the original res.json to intercept response
    const originalJson = res.json.bind(res);
    const startTime = Date.now();
    
    res.json = function(body) {
        const endTime = Date.now();
        const duration = endTime - startTime;
        
        // Log activity asynchronously (don't block response)
        logActivity(req, res, duration, body).catch(error => {
            console.error('❌ Error logging API activity:', error);
        });
        
        return originalJson(body);
    };
    
    next();
}

async function logActivity(req, res, duration, responseBody) {
    try {
        // Get full path including base URL (e.g., /api/records instead of just /records)
        const fullPath = req.baseUrl + req.path;
        
        // Skip logging for certain endpoints (to avoid infinite loops or noise)
        const skipEndpoints = [
            '/api/admin/node-analytics', // Don't log the analytics endpoint itself
            '/health',
            '/metrics',
            '/config.js', // Skip config endpoint
            '/favicon' // Skip favicon
        ];
        
        if (skipEndpoints.some(endpoint => fullPath.startsWith(endpoint))) {
            return;
        }
        
        // Extract user info from JWT (if authenticated)
        // Authentication middleware sets req.user for authenticated requests
        // By the time res.json is called, auth middleware has already run
        const user = req.user || null;
        
        // Extract user data with fallbacks for different token types
        const userId = user?.userId || user?.id || null;
        const userEmail = user?.email || null;
        const userPublicKey = user?.publicKey || user?.publisherPubKey || null;
        const isAdmin = user?.isAdmin || false;
        
        // Extract record type with enhanced detection for FitnessAlly funnel tracking
        const recordType = extractRecordType(req);
        
        // Extract localId for GUN records (contains user profile ID)
        const localId = req.query.localId || null;
        
        // Extract GUN soul from response body if present (for newRecord responses)
        const gunSoul = responseBody?.did?.startsWith('did:gun:') ? responseBody.did : null;
        
        const activityLog = {
            timestamp: new Date().toISOString(),
            userId: userId,
            userEmail: userEmail,
            userPublicKey: userPublicKey,
            isAdmin: isAdmin,
            
            // Request details
            method: req.method,
            endpoint: fullPath, // Use full path with /api prefix
            fullUrl: req.originalUrl,
            queryParams: req.query,
            
            // Response details
            statusCode: res.statusCode,
            duration: duration, // milliseconds
            success: res.statusCode >= 200 && res.statusCode < 400,
            
            // Additional context
            ip: req.ip || req.connection?.remoteAddress || null,
            userAgent: req.headers['user-agent'] || null,
            
            // Categorize request type
            requestType: categorizeRequest(fullPath, req.method),
            
            // Record type if publishing/querying records
            recordType: recordType,
            
            // GUN-specific tracking for private records
            localId: localId,
            gunSoul: gunSoul,
            storage: req.query.storage || null,
            
            // Error info if failed
            error: res.statusCode >= 400 ? (responseBody?.error || responseBody?.message) : null
        };
        
        // Only log if we have meaningful data (skip static file requests, etc.)
        if (!fullPath || fullPath === '/') {
            return;
        }
        
        // Ensure activity index exists
        await ensureActivityIndexExists();
        
        // Index the activity log
        await elasticClient.index({
            index: 'user_activity',
            body: activityLog
        });
        
        // Enhanced debug logging for authenticated requests
        if (userEmail) {
            // Log all authenticated requests for now to debug the issue
            if (recordType && ['userFitnessProfile', 'workoutSchedule', 'mealPlanDaily'].includes(recordType)) {
                console.log(`📊 [Activity] ${userEmail} - ${req.method} ${fullPath} - ${activityLog.requestType} - ${recordType}`);
            }
        } else if (Math.random() < 0.02) { // 2% sampling for anonymous requests
            console.log(`📊 [Activity] anonymous - ${req.method} ${fullPath} - ${activityLog.requestType}`);
        }
        
    } catch (error) {
        // Silently fail - don't break the API if logging fails.
        // Avoid spamming logs when ES is in flood-stage read-only mode.
        const isClusterBlock = error?.meta?.body?.error?.type === 'cluster_block_exception'
            || String(error?.message || '').includes('cluster_block_exception');
        if (!isClusterBlock) {
            console.error('Error in logActivity:', error);
        }
    }
}

/**
 * Categorize the request for easier analytics
 * Order matters - check most specific paths first
 */
function categorizeRequest(path, method) {
    // User authentication
    if (path.includes('/login')) return 'user_login';
    if (path.includes('/register')) return 'user_register';
    if (path.includes('/mnemonic')) return 'mnemonic_access';
    if (path.includes('/generate-calendar')) return 'calendar_token';
    
    // Record operations (check specific endpoints first)
    if (path.includes('/deleteRecord')) return 'delete_record';
    if (path.includes('/newRecord')) return 'publish_record';
    if (path.startsWith('/api/records') && method === 'GET') return 'query_records';
    if (path.startsWith('/api/records') && method === 'POST') return 'publish_record';
    if (path.startsWith('/api/records') && method === 'DELETE') return 'delete_record';
    
    // Publishing
    if (path.startsWith('/api/publish')) return 'publish_content';
    
    // Media operations
    if (path.startsWith('/api/media')) return 'media_operation';
    
    // Organizations
    if (path.startsWith('/api/organizations')) return 'organization_operation';
    
    // AI/ALFRED
    if (path.startsWith('/api/alfred') || path.startsWith('/api/voice')) return 'ai_request';
    
    // Admin operations
    if (path.startsWith('/api/admin')) return 'admin_operation';
    
    // GUN relay (cross-node sync)
    if (path.startsWith('/gun-relay')) return 'gun_relay';
    
    // Health checks
    if (path.startsWith('/health') || path.startsWith('/api/health')) return 'health_check';
    
    // Templates
    if (path.startsWith('/api/templates')) return 'template_operation';
    
    // Creators
    if (path.startsWith('/api/creators')) return 'creator_operation';
    
    // Workout/fitness
    if (path.startsWith('/api/workout')) return 'workout_operation';
    
    return 'other';
}

/**
 * Extract record type from request with enhanced FitnessAlly detection
 */
function extractRecordType(req) {
    // Check query params first (most reliable)
    if (req.query.recordType) return req.query.recordType;
    
    // Check URL for record types (for newRecord endpoint)
    const url = req.originalUrl || '';
    
    // Check body for publish requests
    if (req.body) {
        // Check for direct recordType field
        if (req.body.recordType) return req.body.recordType;
        
        // Check for template names in body (post, recipe, exercise, etc.)
        const commonTemplates = [
            'post', 'recipe', 'exercise', 'video', 'image', 
            'conversationSession', 'organization',
            // FitnessAlly-specific record types
            'userFitnessProfile', 'workoutSchedule', 'mealPlanDaily',
            'workout', 'fitnessEquipment'
        ];
        for (const template of commonTemplates) {
            if (req.body[template]) return template;
        }
    }
    
    return null;
}

/**
 * Ensure the user_activity index exists with proper mapping
 */
async function ensureActivityIndexExists() {
    try {
        const indexExists = await elasticClient.indices.exists({ index: 'user_activity' });
        
        if (!indexExists) {
            console.log('📊 Creating user_activity index...');
            await elasticClient.indices.create({
                index: 'user_activity',
                body: {
                    mappings: {
                        properties: {
                            timestamp: { type: 'date' },
                            userId: { type: 'keyword' },
                            userEmail: { type: 'keyword' },
                            userPublicKey: { type: 'keyword' },
                            isAdmin: { type: 'boolean' },
                            method: { type: 'keyword' },
                            endpoint: { type: 'keyword' },
                            fullUrl: { type: 'text' },
                            queryParams: { type: 'object', enabled: false },
                            statusCode: { type: 'integer' },
                            duration: { type: 'integer' },
                            success: { type: 'boolean' },
                            ip: { type: 'ip' },
                            userAgent: { type: 'text' },
                            requestType: { type: 'keyword' },
                            recordType: { type: 'keyword' },
                            localId: { type: 'keyword' },
                            gunSoul: { type: 'keyword' },
                            storage: { type: 'keyword' },
                            error: { type: 'text' }
                        }
                    }
                }
            });
            console.log('✅ user_activity index created successfully');
        }
    } catch (error) {
        console.error('Error ensuring activity index exists:', error);
    }
}

module.exports = { logAPIActivity };
