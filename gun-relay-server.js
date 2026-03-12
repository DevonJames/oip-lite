#!/usr/bin/env node

/**
 * GUN HTTP API Server
 * HTTP API wrapper around GUN database for OIP integration
 */

const Gun = require('gun');
require('gun/sea');
const http = require('http');
const url = require('url');

// In-memory index for simple listing by publisher hash
// Structure: { [publisherHash: string]: Array<{ soul: string, data: any, storedAt: number }> }
const publisherIndex = new Map();

console.log('Starting GUN HTTP API server...');

try {
    // Create HTTP API server first
    const server = http.createServer(async (req, res) => {
        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Content-Type', 'application/json');
        
        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }
        
        const parsedUrl = url.parse(req.url, true);
        const path = parsedUrl.pathname;
        
        try {
            if (req.method === 'POST' && path === '/put') {
                // Handle PUT operations
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    try {
                        const { soul, data } = JSON.parse(body);
                        
                        // Store data and ensure all nested properties are properly saved
                        const gunNode = gun.get(soul);

                        // Put the main data structure
                        gunNode.put(data, (ack) => {
                            if (ack.err) {
                                console.error('❌ GUN put error:', ack.err);
                                res.writeHead(500);
                                res.end(JSON.stringify({ error: ack.err }));
                            } else {

                                // REMOVED: Nested property puts were causing GUN radisk conflicts
                                // The bulk put above (line 53) is sufficient for most cases
                                // Nested puts can cause silent failures with complex/circular data structures

                                try {
                                    // Maintain a simple in-memory index by publisher hash prefix
                                    // Expected soul format: "<publisherHash>:<rest>"
                                    const prefix = String(soul).split(':')[0];
                                    if (prefix && prefix.length > 0) {
                                        const list = publisherIndex.get(prefix) || [];
                                        // Upsert by soul
                                        const existingIndex = list.findIndex(r => r.soul === soul);
                                        const recordType = data?.oip?.recordType || data?.data?.oip?.recordType || null;
                                        const record = { soul, data, recordType, storedAt: Date.now() };
                                        if (existingIndex >= 0) list[existingIndex] = record; else list.push(record);
                                        publisherIndex.set(prefix, list);

                                        // Persist minimal index into GUN for restart durability
                                        // Layout: index:<publisherHash> is a map of soul -> { recordType, storedAt }
                                        gun.get(`index:${prefix}`).get(soul).put({ recordType, storedAt: record.storedAt });
                                    }
                                } catch (e) {
                                    console.warn('⚠️ Failed to update in-memory index:', e.message);
                                }

                                // Add a small delay to ensure GUN has time to propagate changes
                                setTimeout(() => {
                                    res.writeHead(200);
                                    res.end(JSON.stringify({ success: true, soul }));
                                }, 100);
                            }
                        });
                    } catch (parseError) {
                        console.error('❌ JSON parse error:', parseError);
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'Invalid JSON' }));
                    }
                });
                
            } else if (req.method === 'POST' && path === '/media/manifest') {
                // Handle media manifest publishing
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    try {
                        const manifest = JSON.parse(body);
                        const mediaId = manifest.media?.id;
                        
                        if (!mediaId) {
                            res.writeHead(400);
                            res.end(JSON.stringify({ error: 'mediaId required in manifest' }));
                            return;
                        }
                        
                        // Store manifest in GUN
                        const manifestSoul = `media:${mediaId}`;
                        gun.get(manifestSoul).put(manifest, (ack) => {
                            if (ack.err) {
                                console.error('❌ Failed to store manifest:', ack.err);
                                res.writeHead(500);
                                res.end(JSON.stringify({ error: ack.err }));
                            } else {
                                res.writeHead(200);
                                res.end(JSON.stringify({ 
                                    success: true, 
                                    mediaId,
                                    soul: manifestSoul 
                                }));
                            }
                        });
                        
                    } catch (error) {
                        console.error('❌ Error parsing manifest:', error);
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'Invalid JSON' }));
                    }
                });
                
            } else if (req.method === 'GET' && path === '/media/manifest') {
                // Handle media manifest retrieval
                const mediaId = parsedUrl.query.id;
                if (!mediaId) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'mediaId parameter required' }));
                    return;
                }
                
                const manifestSoul = `media:${mediaId}`;
                
                gun.get(manifestSoul).once((data) => {
                    if (data) {
                        res.writeHead(200);
                        res.end(JSON.stringify(data));
                    } else {
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: 'Manifest not found' }));
                    }
                });
                
            } else if (req.method === 'POST' && path === '/media/presence') {
                // Handle peer presence heartbeat
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    try {
                        const { mediaId, peerId, protocols, endpoints } = JSON.parse(body);
                        
                        if (!mediaId || !peerId) {
                            res.writeHead(400);
                            res.end(JSON.stringify({ error: 'mediaId and peerId required' }));
                            return;
                        }
                        
                        const presenceData = {
                            peerId,
                            protocols: protocols || {},
                            endpoints: endpoints || {},
                            lastSeen: Date.now(),
                            timestamp: new Date().toISOString()
                        };
                        
                        const presenceSoul = `media:${mediaId}:peers:${peerId}`;
                        gun.get(presenceSoul).put(presenceData, (ack) => {
                            if (ack.err) {
                                console.error('❌ Failed to update presence:', ack.err);
                                res.writeHead(500);
                                res.end(JSON.stringify({ error: ack.err }));
                            } else {
                                res.writeHead(200);
                                res.end(JSON.stringify({ success: true }));
                            }
                        });
                        
                    } catch (error) {
                        console.error('❌ Error parsing presence data:', error);
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'Invalid JSON' }));
                    }
                });
                
            } else if (req.method === 'GET' && path === '/get') {
                // Handle GET operations
                const soul = parsedUrl.query.soul;
                if (!soul) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Soul parameter required' }));
                    return;
                }
                
                // Retrieve the complete data structure
                const gunNode = gun.get(soul);
                const result = {};

                // Use a flag to track completion (no more nested fetches needed)
                let completed = false;
                let hasChildren = false;

                const checkComplete = () => {
                    if (!completed) {
                        completed = true;
                        
                        // Remove GUN internal properties
                        const gunInternalProps = ['_', '#', '>', '<'];
                        const cleanResult = {};
                        Object.keys(result).forEach(key => {
                            if (!gunInternalProps.includes(key)) {
                                cleanResult[key] = result[key];
                            }
                        });
                        
                        if (Object.keys(cleanResult).length > 0) {
                            res.writeHead(200);
                            res.end(JSON.stringify({ success: true, data: cleanResult }));
                        } else {
                            res.writeHead(404);
                            res.end(JSON.stringify({ error: 'Not found' }));
                        }
                    }
                };

                // Retrieve main data
                // IMPORTANT: Use .on() instead of .once() to trigger peer synchronization
                // .once() only reads local data, .on() actively requests from peers
                let onceReceived = false;
                let gunSubscription = null;
                gunSubscription = gunNode.on((mainData) => {
                    if (onceReceived || !mainData) return;
                    onceReceived = true;
                    
                    // Unsubscribe after first data to prevent memory leaks
                    if (gunSubscription && gunSubscription.off) {
                        gunSubscription.off();
                    }
                    
                    result._ = mainData._;
                    // Remove GUN internal properties
                    const gunInternalProps = ['_', '#', '>', '<'];
                    
                    // Collect all properties - data/oip should be JSON strings
                    Object.keys(mainData).forEach(key => {
                        if (!gunInternalProps.includes(key)) {
                            const value = mainData[key];
                            
                            // Parse JSON strings for data/oip (NEW FORMAT)
                            if (key === 'data' && typeof value === 'string') {
                                try {
                                    result.data = JSON.parse(value);
                                } catch (e) {
                                    result.data = value;
                                }
                            } else if (key === 'oip' && typeof value === 'string') {
                                try {
                                    result.oip = JSON.parse(value);
                                } catch (e) {
                                    result.oip = value;
                                }
                            } else if (typeof value === 'object' && value !== null && value['#']) {
                                // Handle GUN node references for registry indexes
                                hasChildren = true;
                                result[key] = value;
                            } else if (value !== null && value !== undefined) {
                                // Direct property value (meta, etc.)
                                result[key] = value;
                            }
                        }
                    });
                    
                    checkComplete();
                });
                
                // Set timeout for main data fetch (in case no data exists or peers are slow)
                setTimeout(() => {
                    if (!onceReceived) {
                        onceReceived = true;
                        if (gunSubscription && gunSubscription.off) {
                            gunSubscription.off();
                        }
                        checkComplete();
                    }
                }, 3000); // 3 second timeout to allow peer sync
                
            } else if (req.method === 'GET' && path === '/peers/status') {
                // SECURITY: Endpoint to verify peer connections and network isolation
                try {
                    const peerStatus = {
                        configuredPeers: validatedPeers || [],
                        peerCount: validatedPeers ? validatedPeers.length : 0,
                        allowedDomains: allowedDomains,
                        isolationMode: validatedPeers && validatedPeers.length > 0 ? 'multi-node' : 'isolated',
                        multicastDisabled: true,
                        axeDisabled: true,
                        timestamp: new Date().toISOString()
                    };
                    
                    res.writeHead(200);
                    res.end(JSON.stringify(peerStatus, null, 2));
                } catch (error) {
                    console.error('❌ Error getting peer status:', error);
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: error.message }));
                }
                
            } else if (req.method === 'GET' && path === '/list') {
                // List records by publisher hash prefix
                const publisherHash = parsedUrl.query.publisherHash;
                const limit = Math.max(0, parseInt(parsedUrl.query.limit || '50', 10) || 50);
                const offset = Math.max(0, parseInt(parsedUrl.query.offset || '0', 10) || 0);
                const recordType = parsedUrl.query.recordType;

                if (!publisherHash) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'publisherHash parameter required' }));
                    return;
                }

                const respond = (records) => {
                    let filtered = records;
                    if (recordType) {
                        filtered = filtered.filter(r => (r?.recordType || r?.data?.oip?.recordType) === recordType);
                    }
                    const paged = filtered.slice(offset, offset + limit);
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: true, records: paged }));
                };

                const mem = publisherIndex.get(publisherHash) || [];
                if (mem.length > 0) {
                    return respond(mem);
                }

                // Fallback: hydrate from GUN persistent index
                try {
                    gun.get(`index:${publisherHash}`).once((idx) => {
                        if (!idx || typeof idx !== 'object') {
                            return respond([]);
                        }
                        const souls = Object.keys(idx).filter(k => k && k !== '_' );
                        if (souls.length === 0) {
                            return respond([]);
                        }
                        const collected = [];
                        let pending = souls.length;
                        souls.forEach((soul) => {
                            gun.get(soul).once((data) => {
                                if (data) {
                                    collected.push({ soul, data, recordType: data?.oip?.recordType || null, storedAt: idx[soul]?.storedAt || Date.now() });
                                }
                                if (--pending === 0) {
                                    // Cache hydrated results in memory
                                    publisherIndex.set(publisherHash, collected);
                                    respond(collected);
                                }
                            });
                        });
                    });
                } catch (e) {
                    console.warn('⚠️ Failed to hydrate index from GUN:', e.message);
                    respond([]);
                }

            } else {
                // Handle unknown endpoints
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Endpoint not found' }));
            }
            
        } catch (error) {
            console.error('❌ Request handling error:', error);
            res.writeHead(500);
            res.end(JSON.stringify({ error: error.message }));
        }
    });
    
    // Initialize GUN database after server is created
    // Configure peers from environment variable (for multi-node sync)
    const gunPeers = process.env.GUN_PEERS ? process.env.GUN_PEERS.split(',').map(p => p.trim()).filter(p => p) : [];
    
    // SECURITY: Whitelist of allowed peer domains (only sync with controlled nodes)
    const allowedDomains = [
        'rockhoppersgame.com',
        'api.oip.onl',
        'oip.fitnessally.io',
        'localhost',
        '127.0.0.1',
        'gun-relay'  // Docker internal service name
    ];
    
    // Validate peers against whitelist
    const validatedPeers = gunPeers.filter(peer => {
        const isValid = allowedDomains.some(domain => peer.includes(domain));
        if (!isValid) {
            console.error(`🚨 SECURITY WARNING: Rejected unauthorized GUN peer: ${peer}`);
            console.error(`🚨 Only peers from controlled domains are allowed: ${allowedDomains.join(', ')}`);
        }
        return isValid;
    });
    
    if (validatedPeers.length !== gunPeers.length) {
        console.error(`🚨 SECURITY: Blocked ${gunPeers.length - validatedPeers.length} unauthorized peer(s)`);
        console.error(`🚨 Rejected peers: ${gunPeers.filter(p => !validatedPeers.includes(p)).join(', ')}`);
    }
    
    const gunConfig = {
        web: server,
        radisk: true,
        file: 'data',
        localStorage: false,
        multicast: false,  // Disable multicast peer discovery
        // SECURITY: Explicitly disable other automatic discovery mechanisms
        axe: false  // Disable GUN's automatic peer exchange/discovery
    };
    
    // Add peers if configured (for cross-node synchronization)
    if (validatedPeers.length > 0) {
        gunConfig.peers = validatedPeers;
        console.log(`🔒 GUN peers configured (validated): ${validatedPeers.join(', ')}`);
        console.log(`🔒 GUN network isolated to ${validatedPeers.length} controlled node(s)`);
    } else {
        console.log(`🔒 GUN running in isolated mode (no external peers)`);
    }
    
    const gun = Gun(gunConfig);
    
    // Monitor peer connections (silent test - errors only)
    if (gunPeers.length > 0) {
        gunPeers.forEach((peerUrl, index) => {
            setTimeout(() => {
                gun.get('test:peer:connectivity').once((data) => {
                    // Silent test - no logging unless there's an error
                });
            }, 2000 + (index * 1000));
        });
    }
    
    server.listen(8765, '0.0.0.0', () => {
        console.log('✅ GUN relay server ready on port 8765');
        
        // Test the local GUN database (silent unless error)
        setTimeout(() => {
            gun.get('test:startup').put({ test: true, timestamp: Date.now() }, (ack) => {
                if (ack.err) {
                    console.error('❌ Local GUN test failed:', ack.err);
                }
            });
        }, 1000);
    });
    
    // Keep the process alive
    process.on('uncaughtException', (error) => {
        console.error('❌ Uncaught exception:', error);
        // Don't exit - keep the server running
    });
    
    process.on('unhandledRejection', (reason, promise) => {
        console.error('❌ Unhandled rejection at:', promise, 'reason:', reason);
        // Don't exit - keep the server running
    });
    
    // Handle graceful shutdown
    const shutdown = (signal) => {
        console.log(`🛑 Received ${signal}, shutting down gracefully`);
        server.close(() => {
            console.log('✅ GUN HTTP API server stopped');
            process.exit(0);
        });
    };
    
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    
} catch (error) {
    console.error('❌ Error starting GUN HTTP API server:', error);
    console.error('Stack trace:', error.stack);
    process.exit(1);
}
