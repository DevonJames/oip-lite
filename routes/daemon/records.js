const express = require('express');
const router = express.Router();
const { authenticateToken, optionalAuthenticateToken, userOwnsRecord, isServerAdmin, getServerPublicKey } = require('../../helpers/utils'); // Import authentication middleware
const { enforceCalendarScope } = require('../../middleware/auth'); // Import scope enforcement
const { findUserByEmail } = require('./user'); // Import user lookup function

// const path = require('path');
const { getRecords, searchRecordInDB, getRecordTypesSummary, deleteRecordsByDID, indexRecord, searchCreatorByAddress } = require('../../helpers/core/elasticsearch');
// const { resolveRecords } = require('../../helpers/utils');
const { publishNewRecord} = require('../../helpers/core/templateHelper');
// const paymentManager = require('../../helpers/payment-manager');
// Lit Protocol is optional - lazy load only if needed
let decryptContent;
try {
    decryptContent = require('../../helpers/lit-protocol').decryptContent;
} catch (e) {
    decryptContent = async () => { throw new Error('Lit Protocol not available'); };
}
const arweaveWallet = require('../../helpers/core/arweave-wallet');
const { GunHelper } = require('../../helpers/core/gun');
const axios = require('axios');

// TODO: Implement these payment verification functions
async function verifyBitcoinPayment(txid, expectedAmount, address) {
    console.warn('Bitcoin payment verification not yet implemented');
    // Placeholder - should verify the transaction on the Bitcoin blockchain
    return false;
}

async function verifyLightningPayment(paymentProof) {
    console.warn('Lightning payment verification not yet implemented');
    // Placeholder - should verify the Lightning payment proof
    return false;
}

async function verifyZcashPayment(txid, expectedAmount, address) {
    console.warn('Zcash payment verification not yet implemented');
    // Placeholder - should verify the transaction on the Zcash blockchain
    return false;
}

async function handleSubscriptionNFT(walletAddress, nftContract) {
    console.warn('Subscription NFT handling not yet implemented');
    // Placeholder - should mint or verify NFT ownership
    return { valid: false };
}

async function getRecordByDidTx(didTx) {
    // Use the existing searchRecordInDB function
    const records = await getRecords({ didTx, limit: 1 });
    return records.records && records.records.length > 0 ? records.records[0] : null;
}

router.get('/', optionalAuthenticateToken, enforceCalendarScope, async (req, res) => {
    // MEMORY LEAK FIX: Track large responses for cleanup
    let records = null;
    let response = null;
    
    try {
        // DEBUG: Log user info for calendar token debugging
        if (req.user) {
            console.log(`👤 [API Request] User: ${req.user.email || req.user.userId}, tokenType: ${req.user.tokenType}, scope: ${req.user.scope}, publicKey: ${req.user.publicKey?.slice(0,20)}...`);
        }
        
        const queryParams = { 
            ...req.query,
            user: req.user,                    // NEW: Pass user info
            isAuthenticated: req.isAuthenticated, // NEW: Pass auth status
            requestInfo: {                     // NEW: Pass request info for domain validation
                origin: req.headers.origin,
                referer: req.headers.referer,
                host: req.headers.host,
                headers: req.headers
            }
        };
        
        // Normalize DID parameter (backward compatibility)
        if (queryParams.didTx && !queryParams.did) {
            queryParams.did = queryParams.didTx;
        }
        // Also support legacy didTx parameter
        if (queryParams.did && !queryParams.didTx) {
            queryParams.didTx = queryParams.did;
        }
        
        // Add storage filtering if source parameter provided
        if (queryParams.source && queryParams.source !== 'all') {
            queryParams.storage = queryParams.source; // maps to oip.storage field
        }
        
        // CACHE BYPASS: Check for forceRefresh parameter
        const forceRefresh = queryParams.forceRefresh === 'true' || queryParams.forceRefresh === true;
        if (forceRefresh) {
            console.log('🔄 [Records API] Force refresh requested - bypassing cache');
            queryParams.forceRefresh = true;
        }
        
        records = await getRecords(queryParams);
        
        // NEW: Add authentication status to response for client awareness
        response = {
            ...records,
            auth: {
                authenticated: req.isAuthenticated,
                user: req.isAuthenticated ? {
                    email: req.user.email,
                    userId: req.user.userId,
                    publicKey: req.user.publicKey || req.user.publisherPubKey, // Include user's public key
                    scope: req.user?.scope || 'full', // Include scope information
                    tokenType: req.user?.tokenType || 'standard'
                } : null
            }
        };
        
        res.status(200).json(response);
        
        // MEMORY LEAK FIX: Explicitly null large objects after response is sent
        // This allows V8 to garbage collect the deeply-resolved records sooner
        // Without this, userFitnessProfile with deep resolution can hold 100+ MB
        records = null;
        response = null;
        
        // Hint to GC if response was large (deeply resolved records)
        if (queryParams.resolveDepth && parseInt(queryParams.resolveDepth) > 0) {
            setImmediate(() => {
                if (global.gc) {
                    global.gc();
                }
            });
        }
    } catch (error) {
        console.error('Error at /api/records:', error);
        res.status(500).json({ error: 'Failed to retrieve and process records' });
    } finally {
        // MEMORY LEAK FIX: Ensure cleanup happens even on error paths
        records = null;
        response = null;
    }
});

router.get('/recordTypes', async (req, res) => {
    try {
        const recordTypesSummary = await getRecordTypesSummary();
        res.status(200).json(recordTypesSummary);
    } catch (error) {
        console.error('Error at /api/records/recordTypes:', error);
        res.status(500).json({ error: 'Failed to retrieve record types summary' });
    }
});

// Cache management endpoints
router.post('/clear-cache', async (req, res) => {
    try {
        const { clearRecordsCache } = require('../../helpers/core/elasticsearch');
        clearRecordsCache();
        console.log('🧹 [Records API] Cache cleared manually');
        res.status(200).json({ 
            status: 'success', 
            message: 'Records cache cleared successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error clearing records cache:', error);
        res.status(500).json({ error: 'Failed to clear records cache' });
    }
});

/**
 * Index a record directly to Elasticsearch
 * POST /api/records/index
 * 
 * This endpoint allows Alexandria service to index records via the daemon.
 * Used for scenarios where Alexandria creates records that need to be indexed.
 * 
 * @body {object} record - The record to index (must have oip.did or oip.didTx)
 */
router.post('/index', authenticateToken, async (req, res) => {
    try {
        const record = req.body;
        
        if (!record || (!record.oip?.did && !record.oip?.didTx)) {
            return res.status(400).json({ 
                success: false,
                error: 'Record must have oip.did or oip.didTx field' 
            });
        }
        
        const recordId = record.oip.did || record.oip.didTx;
        console.log(`[Records API] Indexing record: ${recordId}`);
        
        await indexRecord(record);
        
        res.status(200).json({ 
            success: true,
            message: 'Record indexed successfully',
            recordId
        });
        
    } catch (error) {
        console.error('[Records API] Error indexing record:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to index record',
            details: error.message 
        });
    }
});

/**
 * Search for a creator by DID address
 * GET /api/records/creator/:didAddress
 * 
 * This endpoint allows Alexandria service to look up creators via the daemon.
 * 
 * @param {string} didAddress - The creator's DID address (e.g., did:arweave:xxx)
 */
router.get('/creator/:didAddress', async (req, res) => {
    try {
        const { didAddress } = req.params;
        
        if (!didAddress) {
            return res.status(400).json({ 
                success: false,
                error: 'didAddress parameter is required' 
            });
        }
        
        console.log(`[Records API] Looking up creator: ${didAddress}`);
        
        const creatorData = await searchCreatorByAddress(didAddress);
        
        if (!creatorData) {
            return res.status(404).json({ 
                success: false,
                error: 'Creator not found' 
            });
        }
        
        res.status(200).json({ 
            success: true,
            creator: creatorData
        });
        
    } catch (error) {
        console.error('[Records API] Error searching for creator:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to search for creator',
            details: error.message 
        });
    }
});

router.post('/newRecord', authenticateToken, async (req, res) => {
    try {
        const record = req.body;
        const blockchain = req.body.blockchain || req.query.blockchain || 'arweave'; // Accept blockchain from body or query
        const storage = req.body.storage || req.query.storage || blockchain; // Support storage parameter
        let recordType = req.query.recordType;
        const publishFiles = req.query.publishFiles === 'true';
        const addMediaToArweave = req.query.addMediaToArweave !== 'false'; // Default to true
        const addMediaToIPFS = req.query.addMediaToIPFS === 'true';
        const addMediaToArFleet = req.query.addMediaToArFleet === 'true'; // Default to false
        const youtubeUrl = req.query.youtubeUrl || null;
        
        // GUN-specific options
        const gunOptions = {
            storage: storage,
            localId: req.query.localId || req.body.localId,
            accessControl: req.body.accessControl || req.query.accessControl
        };
        
        const newRecord = await publishNewRecord(
            record, 
            recordType, 
            publishFiles, 
            addMediaToArweave, 
            addMediaToIPFS, 
            youtubeUrl, 
            blockchain, 
            addMediaToArFleet,
            gunOptions
        );
        
        const responseData = {
            recordToIndex: newRecord.recordToIndex,
            storage: storage
        };
        
        // Use appropriate ID field based on storage type
        if (storage === 'gun') {
            responseData.did = newRecord.did;
            responseData.soul = newRecord.soul;
            responseData.encrypted = newRecord.encrypted;
        } else {
            responseData.transactionId = newRecord.transactionId;
            responseData.blockchain = blockchain;
        }
        
        res.status(200).json(responseData);
    } catch (error) {
        console.error('Error publishing record:', error);
        res.status(500).json({ error: 'Failed to publish record' });
    }
});

/**
 * POST /api/records/publishAnonymous
 * 
 * Anonymous publishing endpoint for unsigned records.
 * 
 * Behavior depends on destination settings:
 * - Local-only mode (Arweave/GUN off, local node on): Creates unsigned WordPress post
 * - Arweave mode (Arweave on): Creates OIP record signed only by server's creator key
 * 
 * This enables completely anonymous publishing with no cryptographic identity.
 */
router.post('/publishAnonymous', async (req, res) => {
    try {
        const { payload, destinations } = req.body;
        
        if (!payload) {
            return res.status(400).json({
                error: 'Missing payload',
                message: 'Request body must include a "payload" object'
            });
        }
        
        // Check if user is logged in (optional authentication)
        let loggedInUser = null;
        
        // Debug: Check for Authorization header
        const authHeader = req.headers.authorization;
        console.log(`🔍 [PublishAnonymous] Authorization header: ${authHeader ? `${authHeader.substring(0, 20)}...` : 'none'}`);
        
        // Use optionalAuthenticateToken middleware to check for auth without failing
        await new Promise((resolve) => {
            optionalAuthenticateToken(req, res, () => {
                if (req.user) {
                    loggedInUser = req.user;
                    console.log(`✅ [PublishAnonymous] User authenticated: ${req.user.email}`);
                } else {
                    console.log(`⚠️ [PublishAnonymous] No user in req.user after optionalAuthenticateToken`);
                }
                resolve();
            });
        });
        
        const isLoggedIn = loggedInUser !== null;
        console.log(`📝 [PublishAnonymous] Received ${isLoggedIn ? 'authenticated' : 'anonymous'} payload${isLoggedIn ? ` from user: ${loggedInUser.email} (WP ID: ${loggedInUser.wordpressUserId || 'none'})` : ''}`);
        
        // Validate payload structure
        if (!payload.tags || !Array.isArray(payload.tags)) {
            return res.status(400).json({
                error: 'Invalid payload',
                message: 'Payload must include a "tags" array'
            });
        }
        
        // Determine publishing mode
        const { getPublishingMode } = require('../../helpers/core/publishingMode');
        const mode = getPublishingMode(destinations);
        
        // Only add Anonymous tag if user is NOT logged in
        // If user is logged in, they might be publishing with their account (not anonymous)
        const hasAnonymousTag = payload.tags.some(t => t.name === 'Anonymous' && t.value === 'true');
        if (!isLoggedIn && !hasAnonymousTag) {
            payload.tags.push({ name: 'Anonymous', value: 'true' });
        }
        // If logged in and no Anonymous tag, assume account-based publishing
        
        // Initialize publish results
        const publishResults = {
            arweave: null,
            gun: null,
            thisHost: null
        };
        
        // LOCAL-ONLY MODE: WordPress-only publishing (unsigned)
        if (mode.localOnly) {
            console.log(`📝 [PublishAnonymous] Local-only mode: Publishing to WordPress only`);
            
            if (destinations?.thisHost === true) {
                try {
                    console.log(`📝 [PublishAnonymous] Local-only mode: Publishing to WordPress only`);
                    console.log(`🔍 [PublishAnonymous] Destinations object:`, JSON.stringify(destinations, null, 2));
                    
                    // Determine if this should be anonymous or account-based
                    // If user explicitly chose anonymous publishing, use Anonymous user
                    // Otherwise, use logged-in user's account if available
                    const isAnonymousPublish = !isLoggedIn || payload.tags?.some(t => t.name === 'Anonymous' && t.value === 'true');
                    
                    // If logged in but WordPress user sync failed, try to sync now
                    let wpUserId = null;
                    if (isLoggedIn && !isAnonymousPublish) {
                        wpUserId = loggedInUser?.wordpressUserId || null;
                        console.log(`🔍 [PublishAnonymous] Logged in user: ${loggedInUser.email}, existing wpUserId: ${wpUserId || 'none'}`);
                        
                        // Always try to verify/find WordPress user ID (even if one exists, verify it's correct)
                        // If WordPress user ID is missing, try to sync/create it now
                        if (!wpUserId) {
                            console.log(`🔍 [PublishAnonymous] No WordPress user ID found, attempting sync...`);
                            try {
                                const { syncWordPressUser, getWordPressUserId } = require('../../helpers/core/wordpressUserSync');
                                
                                // First, try to find existing WordPress user by email
                                console.log(`🔍 [PublishAnonymous] Looking for WordPress user with email: ${loggedInUser.email}`);
                                const existingWpUserId = await getWordPressUserId(loggedInUser.email);
                                if (existingWpUserId) {
                                    wpUserId = existingWpUserId;
                                    console.log(`✅ [PublishAnonymous] Found existing WordPress user for ${loggedInUser.email}: ${wpUserId}`);
                                    
                                    // Update the user record in Elasticsearch with the WordPress user ID
                                    try {
                                        await elasticClient.update({
                                            index: 'users',
                                            id: loggedInUser.userId,
                                            body: {
                                                doc: {
                                                    wordpressUserId: wpUserId
                                                }
                                            }
                                        });
                                        console.log(`✅ [PublishAnonymous] Updated user record with WordPress user ID: ${wpUserId}`);
                                    } catch (updateError) {
                                        console.warn(`⚠️ [PublishAnonymous] Failed to update user record with WordPress ID:`, updateError.message);
                                    }
                                } else {
                                    // If not found, try to create it
                                    console.log(`🔍 [PublishAnonymous] WordPress user not found, attempting to create for ${loggedInUser.email}`);
                                    console.log(`🔍 [PublishAnonymous] This requires WordPress admin authentication to work`);
                                    console.log(`🔍 [PublishAnonymous] Using WP_APP_PASSWORD or WP_ADMIN_PASSWORD for authentication`);
                                    const wpUser = await syncWordPressUser(loggedInUser.email, null, loggedInUser.email.split('@')[0]);
                                    if (wpUser && wpUser.id) {
                                        wpUserId = wpUser.id;
                                        console.log(`✅ [PublishAnonymous] Created WordPress user for ${loggedInUser.email}: ${wpUserId}`);
                                        
                                        // Update the user record in Elasticsearch with the WordPress user ID
                                        try {
                                            await elasticClient.update({
                                                index: 'users',
                                                id: loggedInUser.userId,
                                                body: {
                                                    doc: {
                                                        wordpressUserId: wpUserId
                                                    }
                                                }
                                            });
                                            console.log(`✅ [PublishAnonymous] Updated user record with WordPress user ID: ${wpUserId}`);
                                        } catch (updateError) {
                                            console.warn(`⚠️ [PublishAnonymous] Failed to update user record with WordPress ID:`, updateError.message);
                                        }
                                    } else {
                                        console.error(`❌ [PublishAnonymous] WordPress user sync returned null/undefined for ${loggedInUser.email}`);
                                        console.error(`❌ [PublishAnonymous] This means WordPress authentication failed (likely 401 error)`);
                                        console.error(`❌ [PublishAnonymous] Check WordPress logs for authentication errors`);
                                        console.error(`❌ [PublishAnonymous] Post will be attributed to admin user instead of ${loggedInUser.email}`);
                                    }
                                }
                            } catch (syncError) {
                                console.error(`❌ [PublishAnonymous] WordPress user sync failed for ${loggedInUser.email}:`, syncError.message);
                                if (syncError.response) {
                                    console.error(`❌ [PublishAnonymous] Response status: ${syncError.response.status}`);
                                    console.error(`❌ [PublishAnonymous] Response data:`, JSON.stringify(syncError.response.data, null, 2));
                                } else {
                                    console.error(`❌ [PublishAnonymous] Error stack:`, syncError.stack);
                                }
                                console.error(`❌ [PublishAnonymous] WordPress user sync is failing with 401. This means:`);
                                console.error(`   1. WP_APP_PASSWORD might be incorrect or expired`);
                                console.error(`   2. WP_ADMIN_PASSWORD might be incorrect`);
                                console.error(`   3. The Application Password might be for a different username`);
                                console.error(`   4. WordPress REST API might be returning HTML instead of JSON (permalink issue)`);
                                console.error(`   Post will be attributed to admin user instead of ${loggedInUser.email}`);
                                console.error(`   To fix: Verify WordPress authentication credentials in .env file`);
                                // Don't throw - we'll fall back to admin if sync fails
                            }
                        }
                        
                        // Log final WordPress user ID status
                        if (wpUserId) {
                            console.log(`✅ [PublishAnonymous] WordPress user ID for ${loggedInUser.email}: ${wpUserId}`);
                        } else {
                            console.error(`❌ [PublishAnonymous] No WordPress user ID available for ${loggedInUser.email} - post will be attributed to admin`);
                        }
                    }
                    
                    const wpOptions = {
                        anonymous: isAnonymousPublish, // Anonymous if not logged in OR if Anonymous tag is present
                        wordpressUserId: isAnonymousPublish ? null : wpUserId
                    };
                    
                    console.log(`🔍 [PublishAnonymous] Publishing with options:`, JSON.stringify({
                        anonymous: wpOptions.anonymous,
                        wordpressUserId: wpOptions.wordpressUserId,
                        userEmail: isLoggedIn ? loggedInUser.email : 'anonymous'
                    }, null, 2));
                    
                    const wpResult = await publishToWordPress(payload, null, wpOptions);
                    publishResults.thisHost = wpResult;
                    console.log(`✅ [PublishAnonymous] Published to WordPress! Post ID: ${wpResult.postId}, Permalink: ${wpResult.permalink || wpResult.postUrl}`);
                } catch (error) {
                    console.error(`❌ [PublishAnonymous] WordPress publish failed:`, error.message);
                    console.error(`❌ [PublishAnonymous] Error stack:`, error.stack);
                    publishResults.thisHost = {
                        success: false,
                        error: error.message
                    };
                }
            } else {
                console.log(`ℹ️ [PublishAnonymous] WordPress publishing disabled (destinations.thisHost = ${destinations?.thisHost})`);
            }
            
            return res.status(200).json({
                success: true,
                destinations: publishResults
            });
        }
        
        // ARWEAVE MODE: Sign with server's creator key and publish to Arweave
        if (mode.arweaveMode) {
            console.log(`🚀 [PublishAnonymous] Arweave mode: Signing with server creator key`);
            
            // Get server identity for signing
            const { getServerOipIdentity, canSign } = require('../../helpers/core/serverOipIdentity');
            const serverIdentity = await getServerOipIdentity();
            const { getBootstrapCreator } = require('../../helpers/core/sync-verification');
            const serverCreator = getBootstrapCreator();
            
            let signedPayload = payload;
            
            // Sign with server creator key if available
            if (serverIdentity && canSign(serverIdentity) && serverCreator) {
                try {
                    
                    // Prepare payload with server creator DID
                    const payloadWithCreator = JSON.parse(JSON.stringify(payload));
                    if (!payloadWithCreator['@context']) {
                        payloadWithCreator['@context'] = serverCreator.did;
                    }
                    if (!payloadWithCreator.tags) payloadWithCreator.tags = [];
                    
                    const hasTag = (name) => payloadWithCreator.tags.some(t => t.name === name);
                    if (!hasTag('Index-Method')) {
                        payloadWithCreator.tags.unshift({ name: 'Index-Method', value: 'OIP' });
                    }
                    if (!hasTag('Ver')) {
                        payloadWithCreator.tags.push({ name: 'Ver', value: '0.9.0' });
                    }
                    if (!hasTag('Content-Type')) {
                        payloadWithCreator.tags.push({ name: 'Content-Type', value: 'application/json' });
                    }
                    if (!hasTag('Creator')) {
                        payloadWithCreator.tags.push({ name: 'Creator', value: serverCreator.did });
                    }
                    
                    // Sign with server key
                    const { signPayload } = require('../../helpers/core/oip-signing');
                    signedPayload = signPayload(payloadWithCreator, serverIdentity.signingKey);
                    console.log(`✅ [PublishAnonymous] Signed with server creator key: ${serverCreator.did}`);
                } catch (error) {
                    console.warn(`⚠️ [PublishAnonymous] Failed to sign with server key: ${error.message}`);
                    console.warn(`⚠️ [PublishAnonymous] Publishing unsigned (anonymous mode)`);
                }
            } else {
                console.log(`ℹ️ [PublishAnonymous] Server signing identity not available, publishing unsigned`);
                if (!serverIdentity) {
                    console.log(`ℹ️ [PublishAnonymous] No server identity found (check Arweave wallet or SERVER_CREATOR_MNEMONIC)`);
                } else if (!canSign(serverIdentity)) {
                    console.log(`ℹ️ [PublishAnonymous] Server identity is read-only (bootstrap creator)`);
                }
            }
            
            const dataToPublish = signedPayload.fragments ? signedPayload : { fragments: [signedPayload] };
            const arweaveTags = signedPayload.tags.map(tag => ({
                name: tag.name,
                value: tag.value
            }));
            
            if (destinations?.arweave !== false) {
                try {
                    console.log(`🚀 [PublishAnonymous] Submitting to Arweave...`);
                    const result = await arweaveWallet.uploadFile(
                        JSON.stringify(dataToPublish),
                        'application/json',
                        arweaveTags
                    );
                    
                    publishResults.arweave = {
                        success: true,
                        transactionId: result.id,
                        explorerUrl: `https://viewblock.io/arweave/tx/${result.id}`
                    };
                    console.log(`✅ [PublishAnonymous] Published to Arweave! TxID: ${result.id}`);
                } catch (error) {
                    console.error(`❌ [PublishAnonymous] Arweave publish failed:`, error.message);
                    publishResults.arweave = {
                        success: false,
                        error: error.message
                    };
                }
            }
            
            // Also publish to WordPress if requested
            if (destinations?.thisHost === true) {
                try {
                    console.log(`📝 [PublishAnonymous] Arweave mode: Also publishing to WordPress`);
                    console.log(`🔍 [PublishAnonymous] Destinations object:`, JSON.stringify(destinations, null, 2));
                    const wpResult = await publishToWordPress(payload, publishResults.arweave, { 
                        anonymous: true,
                        creatorDid: null // Anonymous mode
                    });
                    publishResults.thisHost = wpResult;
                    console.log(`✅ [PublishAnonymous] Published to WordPress! Post ID: ${wpResult.postId}, Permalink: ${wpResult.permalink || wpResult.postUrl}`);
                } catch (error) {
                    console.error(`❌ [PublishAnonymous] WordPress publish failed:`, error.message);
                    console.error(`❌ [PublishAnonymous] Error stack:`, error.stack);
                    publishResults.thisHost = {
                        success: false,
                        error: error.message
                    };
                }
            } else {
                console.log(`ℹ️ [PublishAnonymous] WordPress publishing disabled (destinations.thisHost = ${destinations?.thisHost})`);
            }
        }
        
        // Return results
        res.status(200).json({
            success: true,
            transactionId: publishResults.arweave?.transactionId,
            explorerUrl: publishResults.arweave?.explorerUrl,
            destinations: publishResults
        });
        
    } catch (error) {
        console.error('[PublishAnonymous] Error:', error);
        res.status(500).json({ 
            error: 'Failed to publish anonymous record',
            message: error.message 
        });
    }
});

/**
 * POST /api/records/publishSigned
 * 
 * Login-less publishing endpoint for v0.9 pre-signed records.
 * Accepts a payload that has already been signed client-side (with CreatorSig, KeyIndex, PayloadDigest tags).
 * Server verifies the signature, wraps in Arweave transaction, and pays the fee.
 * 
 * This enables anonymous publishing without user accounts - users sign with their mnemonic client-side.
 */
router.post('/publishSigned', async (req, res) => {
    try {
        const { payload, verifySignature = true, destinations } = req.body;
        
        if (!payload) {
            return res.status(400).json({
                error: 'Missing payload',
                message: 'Request body must include a signed "payload" object with CreatorSig tag'
            });
        }
        
        // Extract signature data from payload tags
        const tags = payload.tags || [];
        const getTag = (name) => tags.find(t => t.name === name)?.value;
        
        const creatorSig = getTag('CreatorSig');
        const payloadDigest = getTag('PayloadDigest');
        const keyIndex = getTag('KeyIndex');
        const creator = getTag('Creator');
        const version = getTag('Ver') || '0.9.0';
        
        // Validate required v0.9 signature tags
        if (!creatorSig || !payloadDigest || !keyIndex) {
            return res.status(400).json({
                error: 'Invalid v0.9 payload',
                message: 'Payload must include CreatorSig, PayloadDigest, and KeyIndex tags. Use the OIP SDK to sign your payload client-side.',
                receivedTags: tags.map(t => t.name)
            });
        }
        
        if (!creator) {
            return res.status(400).json({
                error: 'Missing Creator',
                message: 'Payload must include a Creator tag with the signer\'s DID'
            });
        }
        
        console.log(`📝 [PublishSigned] Received v${version} payload from ${creator}`);
        console.log(`   PayloadDigest: ${payloadDigest.substring(0, 20)}...`);
        console.log(`   KeyIndex: ${keyIndex}`);
        
        // Optionally verify signature before accepting
        if (verifySignature) {
            try {
                const { verifyBeforeIndex } = require('../../helpers/core/sync-verification');
                const { shouldIndex, verificationResult } = await verifyBeforeIndex(payload, 0);
                
                if (!shouldIndex) {
                    console.log(`❌ [PublishSigned] Signature verification failed: ${verificationResult.error}`);
                    return res.status(400).json({
                        error: 'Signature verification failed',
                        message: verificationResult.error || 'The signature could not be verified against the creator\'s published xpub',
                        creator,
                        keyIndex
                    });
                }
                
                console.log(`✅ [PublishSigned] Signature verified (mode: ${verificationResult.mode})`);
            } catch (verifyError) {
                console.warn(`⚠️ [PublishSigned] Verification error (proceeding anyway): ${verifyError.message}`);
                // If verification fails due to missing creator DID doc, still allow publishing
                // The signature will be verified again during indexing
            }
        }
        
        // Prepare the data for Arweave
        // For v0.9, the payload structure is the Arweave transaction data
        const dataToPublish = payload.fragments ? payload : { fragments: [payload] };
        
        // Build tags for Arweave transaction
        const arweaveTags = [
            { name: 'Index-Method', value: 'OIP' },
            { name: 'Ver', value: version },
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Creator', value: creator },
            { name: 'CreatorSig', value: creatorSig },
            { name: 'PayloadDigest', value: payloadDigest },
            { name: 'KeyIndex', value: keyIndex },
            { name: 'App-Name', value: 'OIP-OnionPress' }
        ];
        
        // Add any additional tags from payload (except signature tags which we already added)
        const sigTags = ['Index-Method', 'Ver', 'Content-Type', 'Creator', 'CreatorSig', 'PayloadDigest', 'KeyIndex'];
        for (const tag of tags) {
            if (!sigTags.includes(tag.name)) {
                arweaveTags.push(tag);
            }
        }
        
        // Handle destinations
        const publishResults = {
            arweave: null,
            gun: null,
            thisHost: null
        };
        
        // Publish to Arweave if requested
        if (destinations?.arweave !== false) {
            try {
                console.log(`🚀 [PublishSigned] Submitting to Arweave...`);
                const result = await arweaveWallet.uploadFile(
                    JSON.stringify(dataToPublish),
                    'application/json',
                    arweaveTags
                );
                
                publishResults.arweave = {
                    success: true,
                    transactionId: result.id,
                    did: `did:arweave:${result.id}`,
                    explorerUrl: `https://viewblock.io/arweave/tx/${result.id}`
                };
                console.log(`✅ [PublishSigned] Published to Arweave! TxID: ${result.id}`);
            } catch (error) {
                console.error(`❌ [PublishSigned] Arweave publish failed:`, error.message);
                publishResults.arweave = {
                    success: false,
                    error: error.message
                };
            }
        }
        
        // Determine publishing mode
        const { getPublishingMode } = require('../../helpers/core/publishingMode');
        const mode = getPublishingMode(destinations);
        
        // Publish to WordPress (This Host) if requested
        if (destinations?.thisHost === true) {
            try {
                const WORDPRESS_PROXY_ENABLED = process.env.WORDPRESS_PROXY_ENABLED === 'true';
                if (WORDPRESS_PROXY_ENABLED || mode.localOnly) {
                    console.log(`📝 [PublishSigned] Publishing to WordPress...`);
                    
                    // Extract creator DID from payload
                    const creatorDid = getTag('Creator');
                    console.log(`🔍 [PublishSigned] Extracted Creator DID: ${creatorDid || 'NOT FOUND'}`);
                    
                    // In local-only mode, publish with DID identification
                    // In Arweave mode, also publish to WordPress with DID identification
                    const wpResult = await publishToWordPress(payload, publishResults.arweave, {
                        anonymous: false,
                        creatorDid: creatorDid || null
                    });
                    publishResults.thisHost = wpResult;
                    console.log(`✅ [PublishSigned] Published to WordPress! Post ID: ${wpResult.postId}`);
                } else {
                    publishResults.thisHost = {
                        success: false,
                        error: 'WordPress proxy is not enabled'
                    };
                }
            } catch (error) {
                console.error(`❌ [PublishSigned] WordPress publish failed:`, error.message);
                publishResults.thisHost = {
                    success: false,
                    error: error.message
                };
            }
        }
        
        // In Arweave mode, the payload already has writer's signature
        // Optionally add server signature for dual signatures
        const { getServerOipIdentity, canSign } = require('../../helpers/core/serverOipIdentity');
        const serverIdentity = await getServerOipIdentity();
        const { getBootstrapCreator } = require('../../helpers/core/sync-verification');
        const serverCreator = getBootstrapCreator();
        
        if (mode.arweaveMode && serverIdentity && canSign(serverIdentity) && serverCreator) {
            try {
                // Add server signature to already user-signed payload
                
                const { canonicalJson } = require('../../helpers/core/oip-crypto');
                const { sha256 } = require('@noble/hashes/sha256');
                const { secp256k1 } = require('@noble/curves/secp256k1');
                const base64url = require('base64url');
                
                const payloadBytes = canonicalJson(payload);
                const messageHash = sha256(new TextEncoder().encode(payloadBytes));
                
                // Derive server key index from payload digest
                const { deriveIndexFromPayloadDigest } = require('../../helpers/core/oip-crypto');
                const userPayloadDigest = payload.tags.find(t => t.name === 'PayloadDigest')?.value;
                const serverKeyIndex = deriveIndexFromPayloadDigest(userPayloadDigest);
                const serverChildKey = serverIdentity.signingKey.deriveChild(serverKeyIndex);
                
                // Sign with server key
                const serverSignature = secp256k1.sign(messageHash, serverChildKey.privateKey);
                const serverSignatureBase64 = base64url.encode(Buffer.from(serverSignature.toCompactRawBytes()));
                
                // Add server signature tags
                payload.tags.push({ name: 'ServerCreator', value: serverCreator.did });
                payload.tags.push({ name: 'ServerCreatorSig', value: serverSignatureBase64 });
                payload.tags.push({ name: 'ServerKeyIndex', value: serverKeyIndex.toString() });
                
                console.log(`✅ [PublishSigned] Added server signature: ${serverCreator.did}`);
            } catch (error) {
                console.warn(`⚠️ [PublishSigned] Failed to add server signature: ${error.message}`);
            }
        } else if (mode.arweaveMode && (!serverIdentity || !canSign(serverIdentity))) {
            console.log(`ℹ️ [PublishSigned] Server signing not available (check Arweave wallet or SERVER_CREATOR_MNEMONIC)`);
        }
        
        // Determine overall success
        const hasSuccess = Object.values(publishResults).some(r => r?.success === true);
        
        res.status(hasSuccess ? 200 : 500).json({
            success: hasSuccess,
            transactionId: publishResults.arweave?.transactionId || null,
            did: publishResults.arweave?.did || null,
            creator,
            version,
            blockchain: 'arweave',
            destinations: publishResults,
            message: hasSuccess 
                ? 'Record published successfully. It will be indexed after Arweave confirmation.'
                : 'Publishing failed for all destinations.',
            explorerUrl: publishResults.arweave?.explorerUrl || null
        });
        
    } catch (error) {
        console.error('❌ [PublishSigned] Error:', error);
        res.status(500).json({
            error: 'Publishing failed',
            message: error.message
        });
    }
});

/**
 * POST /api/records/publishAccount
 * 
 * Account-based publishing endpoint for authenticated users.
 * 
 * Behavior depends on destination settings:
 * - Local-only mode (Arweave/GUN off, local node on): Creates WordPress post identified by account name
 * - Arweave mode (Arweave on): Creates OIP record signed by server's creator key AND account's wallet
 * 
 * Requires authentication (JWT token) and user password to decrypt wallet.
 */
router.post('/publishAccount', authenticateToken, async (req, res) => {
    try {
        const { payload, destinations, password } = req.body;
        
        if (!payload) {
            return res.status(400).json({
                error: 'Missing payload',
                message: 'Request body must include a "payload" object'
            });
        }
        
        if (!password) {
            return res.status(400).json({
                error: 'Missing password',
                message: 'Password required to decrypt user wallet for signing'
            });
        }
        
        console.log(`📝 [PublishAccount] Received account-based payload from user: ${req.user.email}`);
        
        // Validate payload structure
        if (!payload.tags || !Array.isArray(payload.tags)) {
            return res.status(400).json({
                error: 'Invalid payload',
                message: 'Payload must include a "tags" array'
            });
        }
        
        // Determine publishing mode
        const { getPublishingMode } = require('../../helpers/core/publishingMode');
        const mode = getPublishingMode(destinations);
        
        // Get user's OIP identity from their account
        const { getUserOipIdentityFromRequest } = require('../../helpers/core/userOipIdentity');
        let userIdentity = null;
        let userDid = null;
        
        try {
            userIdentity = await getUserOipIdentityFromRequest(req, password);
            userDid = userIdentity.did;
            console.log(`🔑 [PublishAccount] User DID: ${userDid}`);
        } catch (error) {
            console.error(`❌ [PublishAccount] Failed to get user identity:`, error.message);
            return res.status(400).json({
                error: 'Failed to get user identity',
                message: error.message
            });
        }
        
        // Prepare payload with user's DID
        const payloadWithCreator = JSON.parse(JSON.stringify(payload));
        if (!payloadWithCreator['@context']) {
            payloadWithCreator['@context'] = userDid;
        }
        
        // Ensure required tags
        if (!payloadWithCreator.tags) payloadWithCreator.tags = [];
        const hasTag = (name) => payloadWithCreator.tags.some(t => t.name === name);
        
        if (!hasTag('Index-Method')) {
            payloadWithCreator.tags.unshift({ name: 'Index-Method', value: 'OIP' });
        }
        if (!hasTag('Ver')) {
            payloadWithCreator.tags.push({ name: 'Ver', value: '0.9.0' });
        }
        if (!hasTag('Content-Type')) {
            payloadWithCreator.tags.push({ name: 'Content-Type', value: 'application/json' });
        }
        if (!hasTag('Creator')) {
            payloadWithCreator.tags.push({ name: 'Creator', value: userDid });
        }
        
        // Initialize publish results
        const publishResults = {
            arweave: null,
            gun: null,
            thisHost: null
        };
        
        // LOCAL-ONLY MODE: WordPress-only publishing (identified by account)
        if (mode.localOnly) {
            console.log(`📝 [PublishAccount] Local-only mode: Publishing to WordPress with account identification`);
            
            if (destinations?.thisHost === true) {
                try {
                    const { getWordPressUserId } = require('../../helpers/core/wordpressUserSync');
                    const wpUserId = await getWordPressUserId(req.user.email);
                    
                    const wpResult = await publishToWordPress(payloadWithCreator, null, {
                        anonymous: false,
                        creatorDid: null,
                        wordpressUserId: wpUserId
                    });
                    publishResults.thisHost = wpResult;
                    console.log(`✅ [PublishAccount] Published to WordPress! Post ID: ${wpResult.postId}`);
                } catch (error) {
                    console.error(`❌ [PublishAccount] WordPress publish failed:`, error.message);
                    publishResults.thisHost = {
                        success: false,
                        error: error.message
                    };
                }
            }
            
            return res.status(200).json({
                success: true,
                destinations: publishResults,
                userDid: userDid
            });
        }
        
        // ARWEAVE MODE: Sign with both server creator key AND user's wallet
        if (mode.arweaveMode) {
            console.log(`🚀 [PublishAccount] Arweave mode: Signing with user wallet and server creator key`);
            
            // Sign with user's wallet first
            const { signPayload } = require('../../helpers/core/oip-signing');
            const userSignedPayload = signPayload(payloadWithCreator, userIdentity.signingKey);
            console.log(`✅ [PublishAccount] Signed with user wallet: ${userDid}`);
            
            // Get server creator for additional signature
            const { getBootstrapCreator } = require('../../helpers/core/sync-verification');
            const serverCreator = getBootstrapCreator();
            
            let finalPayload = userSignedPayload;
            let serverCreatorDid = null;
            
            // Get server identity for signing
            const { getServerOipIdentity, canSign } = require('../../helpers/core/serverOipIdentity');
            const serverIdentity = await getServerOipIdentity();
            
            if (serverIdentity && canSign(serverIdentity) && serverCreator) {
                try {
                    
                    // Sign with server key (on the already user-signed payload)
                    // Note: We sign the canonical JSON of the user-signed payload
                    const { canonicalJson } = require('../../helpers/core/oip-crypto');
                    const { sha256 } = require('@noble/hashes/sha256');
                    const { secp256k1 } = require('@noble/curves/secp256k1');
                    const base64url = require('base64url');
                    
                    const payloadBytes = canonicalJson(userSignedPayload);
                    const messageHash = sha256(new TextEncoder().encode(payloadBytes));
                    
                    // Derive server key index from payload digest
                    const { deriveIndexFromPayloadDigest } = require('../../helpers/core/oip-crypto');
                    const userPayloadDigest = userSignedPayload.tags.find(t => t.name === 'PayloadDigest')?.value;
                    const serverKeyIndex = deriveIndexFromPayloadDigest(userPayloadDigest);
                    const serverChildKey = serverIdentity.signingKey.deriveChild(serverKeyIndex);
                    
                    // Sign with server key
                    const serverSignature = secp256k1.sign(messageHash, serverChildKey.privateKey);
                    const serverSignatureBase64 = base64url.encode(Buffer.from(serverSignature.toCompactRawBytes()));
                    
                    // Add server signature tags
                    finalPayload = JSON.parse(JSON.stringify(userSignedPayload));
                    finalPayload.tags.push({ name: 'ServerCreator', value: serverCreator.did });
                    finalPayload.tags.push({ name: 'ServerCreatorSig', value: serverSignatureBase64 });
                    finalPayload.tags.push({ name: 'ServerKeyIndex', value: serverKeyIndex.toString() });
                    
                    serverCreatorDid = serverCreator.did;
                    console.log(`✅ [PublishAccount] Added server signature: ${serverCreatorDid}`);
                } catch (error) {
                    console.warn(`⚠️ [PublishAccount] Failed to add server signature: ${error.message}`);
                    console.warn(`⚠️ [PublishAccount] Continuing with user signature only`);
                    // Continue without server signature
                }
            } else {
                console.log(`ℹ️ [PublishAccount] Server creator mnemonic not configured, skipping server signature`);
                console.log(`ℹ️ [PublishAccount] Set SERVER_CREATOR_MNEMONIC env var to enable dual signatures`);
            }
            
            // Prepare data for Arweave
            const dataToPublish = finalPayload.fragments ? finalPayload : { fragments: [finalPayload] };
            
            // Build tags for Arweave transaction
            const arweaveTags = finalPayload.tags.map(tag => ({
                name: tag.name,
                value: tag.value
            }));
            
            if (destinations?.arweave !== false) {
                try {
                    console.log(`🚀 [PublishAccount] Submitting to Arweave...`);
                    const result = await arweaveWallet.uploadFile(
                        JSON.stringify(dataToPublish),
                        'application/json',
                        arweaveTags
                    );
                    
                    publishResults.arweave = {
                        success: true,
                        transactionId: result.id,
                        did: `did:arweave:${result.id}`,
                        explorerUrl: `https://viewblock.io/arweave/tx/${result.id}`,
                        userDid: userDid,
                        serverCreatorDid: serverCreatorDid
                    };
                    console.log(`✅ [PublishAccount] Published to Arweave! TxID: ${result.id}`);
                } catch (error) {
                    console.error(`❌ [PublishAccount] Arweave publish failed:`, error.message);
                    publishResults.arweave = {
                        success: false,
                        error: error.message
                    };
                }
            }
            
            // Also publish to WordPress if requested
            if (destinations?.thisHost === true) {
                try {
                    const { getWordPressUserId } = require('../../helpers/core/wordpressUserSync');
                    const wpUserId = await getWordPressUserId(req.user.email);
                    
                    const wpResult = await publishToWordPress(finalPayload, publishResults.arweave, {
                        anonymous: false,
                        creatorDid: userDid,
                        wordpressUserId: wpUserId
                    });
                    publishResults.thisHost = wpResult;
                } catch (error) {
                    console.error(`❌ [PublishAccount] WordPress publish failed:`, error.message);
                    publishResults.thisHost = {
                        success: false,
                        error: error.message
                    };
                }
            }
        }
        
        // Return results
        res.status(200).json({
            success: true,
            transactionId: publishResults.arweave?.transactionId,
            explorerUrl: publishResults.arweave?.explorerUrl,
            userDid: userDid,
            serverCreatorDid: publishResults.arweave?.serverCreatorDid || null,
            destinations: publishResults
        });
        
    } catch (error) {
        console.error('[PublishAccount] Error:', error);
        res.status(500).json({ 
            error: 'Failed to publish account-based record',
            message: error.message 
        });
    }
});

/**
 * Publish OIP record to WordPress
 * @param {object} payload - Signed OIP payload
 * @param {object} arweaveResult - Arweave publishing result (if available)
 * @param {object} options - Publishing options
 * @param {boolean} options.anonymous - If true, post is anonymous
 * @param {string} options.creatorDid - Creator DID for DID-based identification
 * @param {number} options.wordpressUserId - WordPress user ID for account-based identification
 * @returns {Promise<object>} WordPress post creation result
 */
// Cache for WordPress Application Password (to avoid creating multiple)
let wpAppPasswordCache = null;

/**
 * Get or create WordPress Application Password for admin user
 * WordPress REST API requires Application Passwords for Basic Auth
 */
async function getWordPressAppPassword() {
    if (wpAppPasswordCache) {
        return wpAppPasswordCache;
    }
    
    const WORDPRESS_URL = process.env.WORDPRESS_URL || 'http://wordpress:80';
    const WORDPRESS_ADMIN_USER = process.env.WP_ADMIN_USER || 'admin';
    const WORDPRESS_ADMIN_PASSWORD = process.env.WP_ADMIN_PASSWORD || '';
    
    if (!WORDPRESS_ADMIN_PASSWORD) {
        throw new Error('WordPress admin password not configured (WP_ADMIN_PASSWORD). WordPress requires server credentials to create posts, even for anonymous content. The post content will be anonymous, but WordPress needs server authentication to allow post creation.');
    }
    
    // Check if Application Password is provided via env var
    if (process.env.WP_APP_PASSWORD) {
        // WordPress Application Passwords MUST be used WITH SPACES for Basic Auth
        // WordPress displays them as "xxxx xxxx xxxx xxxx xxxx xxxx" and expects that exact format
        wpAppPasswordCache = process.env.WP_APP_PASSWORD; // Keep spaces!
        console.log(`✅ [WordPress Auth] Using Application Password from WP_APP_PASSWORD env var`);
        console.log(`🔍 [WordPress Auth] Application Password length: ${wpAppPasswordCache.length} chars (WITH spaces)`);
        return wpAppPasswordCache;
    }
    
    
    try {
        // First, verify we can authenticate with WordPress REST API
        // Try to get the current user to verify credentials
        // Try both endpoint formats in case WordPress permalinks are misconfigured
        let meResponse = null;
        let authSuccess = false;
        
        for (const endpoint of [
            `${WORDPRESS_URL}/wp-json/wp/v2/users/me/`,  // Try with trailing slash first (WordPress redirects to this)
            `${WORDPRESS_URL}/wp-json/wp/v2/users/me`,
            `${WORDPRESS_URL}/index.php?rest_route=/wp/v2/users/me`
        ]) {
            try {
                console.log(`🔍 [WordPress Auth] Trying endpoint: ${endpoint}`);
                console.log(`🔍 [WordPress Auth] Using credentials: user="${WORDPRESS_ADMIN_USER}", password length=${WORDPRESS_ADMIN_PASSWORD.length}`);
                
                meResponse = await axios.get(endpoint, {
                    auth: {
                        username: WORDPRESS_ADMIN_USER,
                        password: WORDPRESS_ADMIN_PASSWORD
                    },
                    timeout: 10000,
                    validateStatus: () => true,
                    maxRedirects: 5, // Allow redirects (WordPress might redirect)
                    transformResponse: [(data) => {
                        // Keep response as-is to detect HTML
                        return data;
                    }]
                });
                
                console.log(`🔍 [WordPress Auth] Response status: ${meResponse.status}`);
                console.log(`🔍 [WordPress Auth] Response Content-Type: ${meResponse.headers['content-type'] || 'unknown'}`);
                console.log(`🔍 [WordPress Auth] Response data type: ${typeof meResponse.data}`);
                
                // Check if we got HTML instead of JSON (redirect to login page or error page)
                if (typeof meResponse.data === 'string') {
                    const isHtml = meResponse.data.trim().startsWith('<!DOCTYPE') ||
                                   meResponse.data.trim().startsWith('<html') ||
                                   meResponse.data.includes('<body') ||
                                   (meResponse.headers['content-type'] && meResponse.headers['content-type'].includes('text/html'));
                    
                    if (isHtml) {
                        console.warn(`⚠️ [WordPress Auth] ${endpoint} returned HTML (likely login page or error)`);
                        console.warn(`⚠️ [WordPress Auth] HTML preview: ${meResponse.data.substring(0, 200)}`);
                        // If we got 401 with HTML, it's definitely an auth failure
                        if (meResponse.status === 401) {
                            throw new Error(`WordPress authentication failed: Invalid credentials for user "${WORDPRESS_ADMIN_USER}". WordPress returned HTML login page (401). Please verify WP_ADMIN_USER and WP_ADMIN_PASSWORD in your .env file.`);
                        }
                        continue;
                    }
                    
                    // Try to parse as JSON if it's a string
                    try {
                        meResponse.data = JSON.parse(meResponse.data);
                    } catch (parseError) {
                        console.warn(`⚠️ [WordPress Auth] Failed to parse response as JSON: ${parseError.message}`);
                        continue;
                    }
                }
                
                // Check if we got a valid JSON response
                if (meResponse.status === 200 && typeof meResponse.data === 'object' && meResponse.data?.id) {
                    authSuccess = true;
                    break;
                }
                
                // Handle 401/403 explicitly
                if (meResponse.status === 401 || meResponse.status === 403) {
                    const errorMsg = meResponse.data?.message || meResponse.data?.code || 'Authentication failed';
                    throw new Error(`WordPress authentication failed: Invalid credentials for user "${WORDPRESS_ADMIN_USER}". Status: ${meResponse.status}, Error: ${errorMsg}. Please verify WP_ADMIN_USER and WP_ADMIN_PASSWORD in your .env file.`);
                }
                
                // If we got a redirect (301, 302), try following it
                if (meResponse.status === 301 || meResponse.status === 302) {
                    const location = meResponse.headers.location;
                    console.log(`🔄 [WordPress Auth] Got redirect ${meResponse.status} to: ${location}`);
                    // Try the redirected URL
                    try {
                        const redirectUrl = location.startsWith('http') ? location : `${WORDPRESS_URL}${location}`;
                        meResponse = await axios.get(redirectUrl, {
                            auth: {
                                username: WORDPRESS_ADMIN_USER,
                                password: WORDPRESS_ADMIN_PASSWORD
                            },
                            timeout: 10000,
                            validateStatus: () => true,
                            maxRedirects: 5
                        });
                        if (meResponse.status === 200 && typeof meResponse.data === 'object' && meResponse.data?.id) {
                            authSuccess = true;
                            break;
                        }
                    } catch (redirectError) {
                        console.warn(`⚠️ [WordPress Auth] Failed to follow redirect: ${redirectError.message}`);
                        continue;
                    }
                }
            } catch (endpointError) {
                // If it's an auth error, throw it immediately
                if (endpointError.message.includes('authentication failed') || endpointError.message.includes('Invalid credentials')) {
                    throw endpointError;
                }
                console.warn(`⚠️ [WordPress Auth] Error with endpoint ${endpoint}: ${endpointError.message}`);
                continue;
            }
        }
        
        if (!authSuccess || !meResponse) {
            // If we got HTML responses, WordPress is likely rejecting the authentication
            const lastResponseWasHtml = typeof meResponse?.data === 'string' && (
                meResponse.data.trim().startsWith('<!DOCTYPE') ||
                meResponse.data.trim().startsWith('<html')
            );
            
            if (lastResponseWasHtml || meResponse?.status === 401) {
                throw new Error(`WordPress server authentication failed: Invalid credentials for user "${WORDPRESS_ADMIN_USER}". WordPress requires server credentials to create posts, even for anonymous content. The post content will be anonymous, but WordPress needs server authentication.\n\nWordPress returned HTML login page (status ${meResponse?.status || 'unknown'}). This usually means:\n1. The password is incorrect (you set it to "mypassword" - verify it matches)\n2. WordPress REST API requires Application Passwords (not regular passwords)\n3. The user doesn't have REST API access\n\nTo fix:\n1. Verify password: docker exec -it onionpress-wordpress-1 wp user check-password ${WORDPRESS_ADMIN_USER} mypassword --allow-root\n2. Or create Application Password in WordPress admin (Profile → Application Passwords) and set WP_APP_PASSWORD in .env\n3. Make sure WP_ADMIN_USER=${WORDPRESS_ADMIN_USER} and WP_ADMIN_PASSWORD match your WordPress admin credentials`);
            }
            
            throw new Error(`WordPress authentication failed: Could not authenticate with any endpoint. Last status: ${meResponse?.status || 'unknown'}. Response type: ${typeof meResponse?.data}`);
        }
        
        // If authentication fails, the password is wrong or user doesn't exist
        if (meResponse.status === 401 || meResponse.status === 403) {
            const errorMsg = meResponse.data?.message || meResponse.data?.code || 'Authentication failed';
            throw new Error(`WordPress authentication failed: Invalid credentials for user "${WORDPRESS_ADMIN_USER}". Status: ${meResponse.status}, Error: ${errorMsg}. Please verify WP_ADMIN_USER and WP_ADMIN_PASSWORD in your .env file.`);
        }
        
        if (meResponse.status !== 200 || !meResponse.data?.id) {
            throw new Error(`WordPress authentication failed: Unexpected response status ${meResponse.status}`);
        }
        
        const adminUserId = meResponse.data.id;
        const adminCapabilities = meResponse.data.capabilities || {};
        
        console.log(`✅ [WordPress Auth] Authenticated as user ID: ${adminUserId}`);
        console.log(`🔍 [WordPress Auth] User capabilities:`, Object.keys(adminCapabilities).filter(cap => adminCapabilities[cap]));
        
        // Check if user has publish_posts capability
        if (!adminCapabilities.publish_posts && !adminCapabilities.administrator) {
            throw new Error(`WordPress user "${WORDPRESS_ADMIN_USER}" does not have publish_posts capability. User needs administrator role.`);
        }
        
        // Try to create an Application Password
        // Try both endpoint formats
        let appPasswordResponse = null;
        let appPasswordCreated = false;
        
        try {
            for (const endpoint of [
                `${WORDPRESS_URL}/wp-json/wp/v2/users/${adminUserId}/application-passwords`,
                `${WORDPRESS_URL}/index.php?rest_route=/wp/v2/users/${adminUserId}/application-passwords`
            ]) {
                try {
                    appPasswordResponse = await axios.post(
                        endpoint,
                        {
                            name: 'OIP Daemon Integration',
                            app_id: 'oip-daemon'
                        },
                        {
                            auth: {
                                username: WORDPRESS_ADMIN_USER,
                                password: WORDPRESS_ADMIN_PASSWORD
                            },
                            timeout: 10000,
                            validateStatus: () => true,
                            maxRedirects: 5 // Allow redirects
                        }
                    );
                    
                    if (appPasswordResponse.status === 201 && appPasswordResponse.data?.password) {
                        appPasswordCreated = true;
                        break;
                    }
                } catch (createError) {
                    console.warn(`⚠️ [WordPress Auth] Error creating app password at ${endpoint}: ${createError.message}`);
                    continue;
                }
            }
            
            if (appPasswordCreated && appPasswordResponse) {
                wpAppPasswordCache = appPasswordResponse.data.password; // Keep spaces - WordPress requires them!
                console.log(`✅ [WordPress Auth] Created Application Password successfully`);
                console.log(`💡 [WordPress Auth] Tip: Set WP_APP_PASSWORD="${wpAppPasswordCache}" in your .env to reuse this password (WITH SPACES!)`);
                return wpAppPasswordCache;
            } else if (appPasswordResponse && appPasswordResponse.status === 400 && appPasswordResponse.data?.code === 'application_passwords_disabled') {
                console.warn(`⚠️ [WordPress Auth] Application Passwords are disabled in WordPress. Using regular password.`);
                wpAppPasswordCache = WORDPRESS_ADMIN_PASSWORD;
                return wpAppPasswordCache;
            } else {
                console.warn(`⚠️ [WordPress Auth] Could not create Application Password (status ${appPasswordResponse?.status || 'unknown'}). Using regular password.`);
                wpAppPasswordCache = WORDPRESS_ADMIN_PASSWORD;
                return wpAppPasswordCache;
            }
        } catch (createError) {
            // If creation fails, check if it's because Application Passwords are disabled
            if (createError.response?.status === 400 && createError.response?.data?.code === 'application_passwords_disabled') {
                console.warn(`⚠️ [WordPress Auth] Application Passwords are disabled in WordPress. Using regular password.`);
                wpAppPasswordCache = WORDPRESS_ADMIN_PASSWORD;
                return wpAppPasswordCache;
            }
            
            // If creation fails for other reasons, try using regular password
            console.warn(`⚠️ [WordPress Auth] Could not create Application Password: ${createError.message}`);
            console.warn(`⚠️ [WordPress Auth] Will try using regular password. If this fails, you may need to manually create an Application Password in WordPress admin.`);
            wpAppPasswordCache = WORDPRESS_ADMIN_PASSWORD;
            return wpAppPasswordCache;
        }
        
    } catch (error) {
        // If it's an authentication error, throw it (don't fallback)
        if (error.message.includes('authentication failed') || error.message.includes('Invalid credentials')) {
            throw error;
        }
        
        console.error(`❌ [WordPress Auth] Error getting Application Password: ${error.message}`);
        console.error(`❌ [WordPress Auth] Stack:`, error.stack);
        // Fallback to regular password as last resort
        console.warn(`⚠️ [WordPress Auth] Falling back to regular password (may not work if WordPress requires Application Passwords)`);
        return WORDPRESS_ADMIN_PASSWORD;
    }
}

async function publishToWordPress(payload, arweaveResult = null, options = {}) {
    console.log(`🔍 [PublishToWordPress] Starting WordPress publish`);
    console.log(`🔍 [PublishToWordPress] Options:`, JSON.stringify(options, null, 2));
    
    const WORDPRESS_URL = process.env.WORDPRESS_URL || 'http://wordpress:80';
    const WORDPRESS_ADMIN_USER = process.env.WP_ADMIN_USER || 'admin';
    
    console.log(`🔍 [PublishToWordPress] WordPress URL: ${WORDPRESS_URL}`);
    console.log(`🔍 [PublishToWordPress] WordPress Admin User: ${WORDPRESS_ADMIN_USER}`);
    
    // Get Application Password (or fallback to regular password)
    // Note: WordPress REST API requires server authentication to create posts,
    // even for anonymous content. The post content is anonymous, but WordPress
    // needs server credentials to allow post creation.
    let authPassword;
    try {
        authPassword = await getWordPressAppPassword();
    } catch (authError) {
        // If authentication fails, provide a clearer error message
        throw new Error(`WordPress server authentication failed: ${authError.message}. WordPress requires server credentials (WP_ADMIN_USER/WP_ADMIN_PASSWORD) to create posts, even for anonymous content. The post content will be anonymous, but the server needs to authenticate to create it.`);
    }
    
    // Get admin user ID to ensure we have permission to create posts
    // Try with Application Password first, fallback to regular password if needed
    let adminUserId = null;
    const WORDPRESS_ADMIN_PASSWORD = process.env.WP_ADMIN_PASSWORD || '';
    
    // Try regular password first (might work better with REST API), then Application Password
    const authMethods = [
        { username: WORDPRESS_ADMIN_USER, password: WORDPRESS_ADMIN_PASSWORD, method: 'Regular Password' },
        { username: WORDPRESS_ADMIN_USER, password: authPassword, method: 'Application Password' }
    ];
    
    for (const authMethod of authMethods) {
        if (!authMethod.password) {
            continue; // Skip if password not available
        }
        
        try {
            console.log(`🔍 [PublishToWordPress] Trying authentication with ${authMethod.method}...`);
            const userResponse = await axios.get(`${WORDPRESS_URL}/wp-json/wp/v2/users/me/`, {
                auth: {
                    username: authMethod.username,
                    password: authMethod.password
                },
                timeout: 10000,
                validateStatus: () => true,
                maxRedirects: 5,
                headers: {
                    'Accept': 'application/json'
                }
            });
            
            // Handle string response (might be HTML or JSON string)
            let userData = userResponse.data;
            if (typeof userData === 'string') {
                // Check if it's HTML
                if (userData.trim().startsWith('<!DOCTYPE') || userData.trim().startsWith('<html')) {
                    console.warn(`⚠️ [PublishToWordPress] ${authMethod.method} returned HTML, trying next method...`);
                    continue; // Try next auth method
                }
                try {
                    userData = JSON.parse(userData);
                } catch (parseError) {
                    console.warn(`⚠️ [PublishToWordPress] Failed to parse user response as JSON with ${authMethod.method}: ${parseError.message}`);
                    continue; // Try next auth method
                }
            }
            
            if (userResponse.status === 200 && userData && (userData.id || userData.ID)) {
                adminUserId = userData.id || userData.ID;
                console.log(`✅ [PublishToWordPress] Authenticated as WordPress user ID: ${adminUserId} using ${authMethod.method}`);
                console.log(`🔍 [PublishToWordPress] User name: ${userData.name || userData.user_nicename || userData.username || 'unknown'}`);
                console.log(`🔍 [PublishToWordPress] User roles: ${userData.roles ? (Array.isArray(userData.roles) ? userData.roles.join(', ') : userData.roles) : 'unknown'}`);
                
                // Verify user has publish_posts capability
                const capabilities = userData.capabilities || {};
                const hasPublishPosts = capabilities.publish_posts || capabilities.administrator;
                const capabilityKeys = Object.keys(capabilities).filter(cap => capabilities[cap]);
                console.log(`🔍 [PublishToWordPress] User capabilities (${capabilityKeys.length}):`, capabilityKeys.slice(0, 10).join(', '));
                
                if (!hasPublishPosts) {
                    console.error(`❌ [PublishToWordPress] User does not have publish_posts or administrator capability!`);
                    throw new Error(`WordPress user "${WORDPRESS_ADMIN_USER}" (ID: ${adminUserId}) does not have publish_posts capability. User needs administrator role.`);
                } else {
                    console.log(`✅ [PublishToWordPress] User has publish_posts capability`);
                }
                
                // Update authPassword to the one that worked
                authPassword = authMethod.password;
                break; // Success, stop trying other methods
            } else {
                console.warn(`⚠️ [PublishToWordPress] ${authMethod.method} authentication failed, status: ${userResponse.status}`);
                continue; // Try next auth method
            }
        } catch (userError) {
            console.warn(`⚠️ [PublishToWordPress] Error with ${authMethod.method}: ${userError.message}`);
            continue; // Try next auth method
        }
    }
    
    if (!adminUserId) {
        console.warn(`⚠️ [PublishToWordPress] Could not authenticate with any method, WordPress will use default user`);
    }
    
    // Extract record data from payload
    const fragments = payload.fragments || [payload];
    const firstFragment = fragments[0];
    const records = firstFragment.records || [];
    
    console.log(`🔍 [PublishToWordPress] Found ${fragments.length} fragment(s), ${records.length} record(s)`);
    
    if (records.length === 0) {
        throw new Error('No records found in payload');
    }
    
    const record = records[0];
    const basic = record.basic || {};
    const postData = record.post || {};
    
    console.log(`🔍 [PublishToWordPress] Record data - title: ${basic.name || 'none'}, description: ${basic.description ? basic.description.substring(0, 50) + '...' : 'none'}`);
    
    // Determine identification mode
    let identificationMode = 'anonymous';
    if (options.creatorDid) {
        identificationMode = 'did';
    } else if (options.wordpressUserId && !options.anonymous) {
        // Only use account mode if not anonymous
        identificationMode = 'account';
    } else if (options.anonymous) {
        identificationMode = 'anonymous';
    }
    
    console.log(`🔍 [PublishToWordPress] Identification mode: ${identificationMode}`);
    console.log(`🔍 [PublishToWordPress] Options.creatorDid: ${options.creatorDid || 'NOT PROVIDED'}`);
    console.log(`🔍 [PublishToWordPress] Options.anonymous: ${options.anonymous}`);
    
    // Build WordPress post data
    const wpPostData = {
        title: basic.name || 'Untitled',
        content: postData.articleText || basic.description || '',
        excerpt: basic.description || '',
        status: 'publish',
        meta: {
            op_publisher_did: options.creatorDid || arweaveResult?.did || null,
            op_publisher_tx_id: arweaveResult?.transactionId || null,
            op_publisher_status: 'published',
            op_publisher_mode: identificationMode,
            op_publisher_published_at: new Date().toISOString(),
            op_publisher_anonymous: options.anonymous || false
        }
    };
    
    // Set WordPress author based on identification mode
    console.log(`🔍 [PublishToWordPress] Setting author - identificationMode: ${identificationMode}, wordpressUserId: ${options.wordpressUserId || 'none'}, anonymous: ${options.anonymous}`);
    
    if (identificationMode === 'account') {
        if (options.wordpressUserId) {
            // Use logged-in user's WordPress account as author
            wpPostData.author = options.wordpressUserId;
            console.log(`✅ [PublishToWordPress] Setting post author to logged-in user ID: ${options.wordpressUserId}`);
        } else {
            // Account mode but no WordPress user ID - WordPress user sync must have failed
            console.error(`❌ [PublishToWordPress] Account mode but no WordPress user ID provided!`);
            console.error(`❌ [PublishToWordPress] This means WordPress user sync failed (likely 401 authentication error)`);
            console.error(`❌ [PublishToWordPress] Post will be attributed to admin user instead of logged-in user`);
            console.error(`❌ [PublishToWordPress] To fix: Check WP_APP_PASSWORD or WP_ADMIN_PASSWORD in .env`);
            // Don't set author - let WordPress use the authenticated user (which will be admin)
            // This is a fallback, but it's not ideal
        }
    } else if (options.anonymous) {
        // For anonymous posts, use "Anonymous" WordPress user as author
        // This ensures WordPress displays "Anonymous" instead of admin name
        const { getAnonymousWordPressUser } = require('../../helpers/core/wordpressUserSync');
        const anonymousUserId = await getAnonymousWordPressUser();
        
        if (anonymousUserId) {
            wpPostData.author = anonymousUserId;
            console.log(`🔍 [PublishToWordPress] Anonymous post - using Anonymous user (ID: ${anonymousUserId})`);
        } else if (adminUserId) {
            // Fallback to admin if Anonymous user creation fails
            wpPostData.author = adminUserId;
            console.log(`⚠️ [PublishToWordPress] Anonymous post - fallback to admin (ID: ${adminUserId})`);
        }
    } else if (identificationMode === 'did') {
        // For DID modes, use Anonymous user (or admin as fallback) but display DID as byline
        // The DID will be displayed via the byline meta field, not the WordPress author
        const { getAnonymousWordPressUser } = require('../../helpers/core/wordpressUserSync');
        const anonymousUserId = await getAnonymousWordPressUser();
        
        if (anonymousUserId) {
            wpPostData.author = anonymousUserId;
            console.log(`🔍 [PublishToWordPress] DID mode - using Anonymous user (ID: ${anonymousUserId}) for permissions, DID will be displayed as byline`);
        } else if (adminUserId) {
            // Fallback to admin if Anonymous user creation fails
            wpPostData.author = adminUserId;
            console.log(`⚠️ [PublishToWordPress] DID mode - fallback to admin (ID: ${adminUserId}) for permissions, DID will be displayed as byline`);
        }
    } else if (adminUserId) {
        // For other modes (shouldn't reach here, but fallback)
        wpPostData.author = adminUserId;
        console.log(`🔍 [PublishToWordPress] Setting post author to admin user ID: ${adminUserId}`);
    } else {
        // If we couldn't get adminUserId, try to get it from WordPress user list
        // This is a fallback in case /users/me doesn't work
        console.warn(`⚠️ [PublishToWordPress] Could not get admin user ID, WordPress will use authenticated user`);
        // Don't set author - let WordPress use the authenticated user
    }
    
    // Add tags if available
    if (basic.tagItems && Array.isArray(basic.tagItems) && basic.tagItems.length > 0) {
        wpPostData.tags = basic.tagItems;
    }
    
    // Add author byline if available (for anonymous posts, this will be displayed instead of author name)
    // For DID-based posts, use the DID as the byline
    let bylineValue = postData.bylineWriter || postData.byline;
    
    // For DID mode, always use the DID as the author name (unless a custom byline is provided)
    if (identificationMode === 'did' && options.creatorDid) {
        // Use DID as byline if no custom byline is provided, or append DID to custom byline
        if (!bylineValue) {
            bylineValue = options.creatorDid;
        } else {
            // If custom byline exists, still store DID separately but prioritize DID for display
            // Store custom byline in a separate meta field
            wpPostData.meta.op_publisher_custom_byline = bylineValue;
            // Use DID as the primary byline for DID-based posts
            bylineValue = options.creatorDid;
        }
        wpPostData.meta.op_publisher_creator_did = options.creatorDid;
        console.log(`🔍 [PublishToWordPress] DID mode - using DID as byline: "${bylineValue}"`);
    }
    
    if (bylineValue) {
        wpPostData.meta.op_publisher_byline = bylineValue;
        // Also set it in a standard WordPress meta field that themes can use
        wpPostData.meta._op_byline = bylineValue;
        console.log(`✅ [PublishToWordPress] Setting byline meta fields:`);
        console.log(`   - op_publisher_byline: "${bylineValue}"`);
        console.log(`   - _op_byline: "${bylineValue}"`);
        console.log(`   - op_publisher_creator_did: "${options.creatorDid || 'none'}"`);
    } else {
        console.warn(`⚠️ [PublishToWordPress] No byline value to set!`);
    }
    
    // Create post via WordPress REST API
    // Use internal Docker URL for direct access (bypasses proxy)
    // Try both endpoint formats in case WordPress permalinks are misconfigured
    const wpApiUrl1 = `${WORDPRESS_URL}/wp-json/wp/v2/posts/`;  // Try with trailing slash first
    const wpApiUrl2 = `${WORDPRESS_URL}/wp-json/wp/v2/posts`;
    const wpApiUrl3 = `${WORDPRESS_URL}/index.php?rest_route=/wp/v2/posts`;
    
    // Use the password that worked for authentication (Application Password or regular password)
    // For logged-in users, we still use admin credentials to authenticate with WordPress REST API
    // but set the author to their WordPress user ID
    // Basic Auth format: username:password (base64 encoded)
    const auth = Buffer.from(`${WORDPRESS_ADMIN_USER}:${authPassword}`).toString('base64');
    console.log(`🔍 [PublishToWordPress] Using admin credentials for API auth${options.wordpressUserId ? `, but post will be authored by user ID: ${options.wordpressUserId}` : ''}`);
    console.log(`🔍 [PublishToWordPress] Password length: ${authPassword.length}`);
    
    console.log(`🔍 [PublishToWordPress] WordPress API URL (primary): ${wpApiUrl1}`);
    console.log(`🔍 [PublishToWordPress] WordPress API URL (fallback): ${wpApiUrl2}`);
    console.log(`🔍 [PublishToWordPress] WordPress Admin User: ${WORDPRESS_ADMIN_USER}`);
    console.log(`🔍 [PublishToWordPress] Using Application Password: ${authPassword ? 'yes' : 'no'}`);
    console.log(`🔍 [PublishToWordPress] Post data:`, JSON.stringify({
        title: wpPostData.title,
        content_length: wpPostData.content?.length || 0,
        excerpt_length: wpPostData.excerpt?.length || 0,
        status: wpPostData.status,
        identificationMode: identificationMode,
        meta_keys: Object.keys(wpPostData.meta || {})
    }, null, 2));
    
    // Try REST API first, fallback to wp-cli if REST API fails
    let response;
    let wpApiUrl = wpApiUrl1;
    let lastError = null;
    let useWpCli = false;
    
    try {
        for (const url of [wpApiUrl1, wpApiUrl2, wpApiUrl3]) {
            try {
                wpApiUrl = url;
                console.log(`🔍 [PublishToWordPress] Attempting: ${url}`);
                response = await axios.post(url, wpPostData, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Basic ${auth}`,
                        'Accept': 'application/json',
                        'X-Requested-With': 'XMLHttpRequest' // Helps WordPress identify API requests
                    },
                    timeout: 30000,
                    validateStatus: () => true, // Don't throw on non-2xx
                    maxRedirects: 5, // Allow redirects (WordPress might redirect due to permalink settings)
                    // Force axios to not transform response
                    transformResponse: [(data) => {
                        // Keep response as-is to detect HTML
                        return data;
                    }]
                });
                
                // Check if we got JSON (object) or HTML (string)
                if (typeof response.data === 'object' && response.data !== null && !Array.isArray(response.data)) {
                    // Got JSON object - success!
                    break;
                }
                
                // If we got HTML, try next URL
                if (typeof response.data === 'string' && (
                    response.data.trim().startsWith('<!DOCTYPE') ||
                    response.data.trim().startsWith('<html')
                )) {
                    console.warn(`⚠️ [PublishToWordPress] ${url} returned HTML, trying fallback...`);
                    lastError = new Error(`WordPress returned HTML instead of JSON from ${url}`);
                    continue;
                }
                
                // If we got a valid response, break
                break;
            } catch (error) {
                console.warn(`⚠️ [PublishToWordPress] Error with ${url}:`, error.message);
                lastError = error;
                continue;
            }
        }
        
        if (!response) {
            throw lastError || new Error('Failed to connect to WordPress REST API');
        }
        
        // Check if WordPress returned HTML instead of JSON (even with 200 status)
        const contentType = response.headers['content-type'] || '';
        const responseSize = typeof response.data === 'string' ? response.data.length : JSON.stringify(response.data).length;
        const isHtmlResponse = typeof response.data === 'string' && (
            response.data.trim().startsWith('<!DOCTYPE') ||
            response.data.trim().startsWith('<html') ||
            response.data.includes('<body') ||
            contentType.includes('text/html')
        );
        
        // Check if we need to use wp-cli fallback
        if (isHtmlResponse || (!contentType.includes('application/json') && !contentType.includes('application/vnd.api+json'))) {
            console.error(`❌ [PublishToWordPress] WordPress REST API returned HTML instead of JSON`);
            console.error(`❌ [PublishToWordPress] Content-Type: ${contentType}`);
            console.error(`❌ [PublishToWordPress] Response status: ${response.status}`);
            console.error(`❌ [PublishToWordPress] Response size: ${responseSize} bytes (expected < 5000 for JSON)`);
            throw new Error('REST_API_FAILED_USE_WPCLI'); // Trigger wp-cli fallback
        }
        
        if (response.status !== 201 && response.status !== 200) {
            console.error(`❌ [PublishToWordPress] WordPress REST API returned status ${response.status}`);
            console.error(`❌ [PublishToWordPress] Response data:`, typeof response.data === 'string' ? response.data.substring(0, 500) : JSON.stringify(response.data, null, 2));
            
            // If REST API fails with 401, try wp-cli as fallback
            if (response.status === 401) {
                throw new Error('REST_API_FAILED_USE_WPCLI'); // Trigger wp-cli fallback
            } else {
                throw new Error(`WordPress API error: ${response.status} - ${typeof response.data === 'string' ? response.data.substring(0, 200) : JSON.stringify(response.data)}`);
            }
        }
        
        // Check if response.data is actually an object (JSON) or a string (needs parsing)
        let wpPost = response.data;
        if (typeof response.data === 'string') {
            // WordPress might return JSON as a string - try to parse it
            try {
                wpPost = JSON.parse(response.data);
                console.log(`✅ [PublishToWordPress] Parsed JSON string response`);
            } catch (parseError) {
                console.error(`❌ [PublishToWordPress] WordPress returned string instead of JSON object`);
                console.error(`❌ [PublishToWordPress] Response preview: ${response.data.substring(0, 500)}`);
                throw new Error('REST_API_FAILED_USE_WPCLI'); // Trigger wp-cli fallback
            }
        }
        console.log(`✅ [PublishToWordPress] WordPress post created successfully!`);
        console.log(`🔍 [PublishToWordPress] WordPress response status: ${response.status}`);
        console.log(`🔍 [PublishToWordPress] WordPress response data type:`, typeof wpPost);
        console.log(`🔍 [PublishToWordPress] WordPress response keys:`, Object.keys(wpPost || {}));
        
        // Extract post ID and link - WordPress REST API uses different field names
        const postId = wpPost.id || wpPost.ID || null;
        let permalink = wpPost.link || (typeof wpPost.link === 'string' ? wpPost.link : null) || wpPost.guid?.rendered || null;
        
        if (!postId) {
            console.error(`❌ [PublishToWordPress] WordPress response missing post ID.`);
            console.error(`❌ [PublishToWordPress] Response keys:`, Object.keys(wpPost || {}));
            console.error(`❌ [PublishToWordPress] Response preview:`, JSON.stringify(wpPost, null, 2).substring(0, 1000));
            throw new Error('WordPress API did not return a post ID');
        }
        
        // Build permalink if WordPress didn't provide it
        if (!permalink || typeof permalink !== 'string') {
            const baseUrl = process.env.PUBLIC_API_BASE_URL || 'http://localhost:3005';
            const wordpressPath = process.env.WORDPRESS_PROXY_PATH || '/wordpress';
            permalink = `${baseUrl}${wordpressPath}/?p=${postId}`;
            console.log(`⚠️ [PublishToWordPress] WordPress didn't provide link, constructed: ${permalink}`);
        }
        
        // WordPress REST API may not save custom meta fields unless they're registered
        // Always set meta fields via wp-cli to ensure they're saved
        if (wpPostData.meta && Object.keys(wpPostData.meta).length > 0) {
            try {
                const { execSync } = require('child_process');
                const projectName = process.env.COMPOSE_PROJECT_NAME || 'onionpress';
                const wpContainerName = `${projectName}-wordpress-1`;
                
                console.log(`🔧 [PublishToWordPress] Setting meta fields via wp-cli for post ${postId}...`);
                for (const [key, value] of Object.entries(wpPostData.meta)) {
                    if (value !== null && value !== undefined) {
                        try {
                            const metaValue = typeof value === 'string' ? value : JSON.stringify(value);
                            const escapedMetaValue = metaValue.replace(/'/g, "'\\''");
                            const metaCommand = `docker exec ${wpContainerName} wp post meta set ${postId} '${key}' '${escapedMetaValue}' --allow-root`;
                            execSync(metaCommand, { encoding: 'utf-8', timeout: 10000 });
                            console.log(`✅ [PublishToWordPress] Set meta field: ${key} = ${typeof value === 'string' ? value.substring(0, 50) + (value.length > 50 ? '...' : '') : JSON.stringify(value)}`);
                        } catch (metaError) {
                            console.warn(`⚠️ [PublishToWordPress] Failed to set meta field ${key}:`, metaError.message);
                        }
                    }
                }
                console.log(`✅ [PublishToWordPress] All meta fields set successfully`);
            } catch (metaError) {
                console.warn(`⚠️ [PublishToWordPress] Error setting meta fields via wp-cli:`, metaError.message);
                // Don't fail the whole operation if meta fields fail
            }
        }
        
        console.log(`✅ [PublishToWordPress] Returning success with postId: ${postId}, permalink: ${permalink}`);
        return {
            success: true,
            postId: postId,
            postUrl: permalink,
            permalink: permalink
        };
    } catch (error) {
        // If REST API failed, try wp-cli as fallback
        const shouldUseWpCli = error.message === 'REST_API_FAILED_USE_WPCLI' ||
                               error.message.includes('HTML') || 
                               error.message.includes('401') || 
                               (error.response && error.response.status === 401);
        
        if (shouldUseWpCli) {
            console.warn(`⚠️ [PublishToWordPress] REST API failed, trying wp-cli fallback...`);
            try {
                const { execSync } = require('child_process');
                console.log(`🔧 [PublishToWordPress] Using wp-cli to create post (REST API authentication failed)...`);
                
                // Get WordPress container name from COMPOSE_PROJECT_NAME or use default
                const projectName = process.env.COMPOSE_PROJECT_NAME || 'onionpress';
                const wpContainerName = `${projectName}-wordpress-1`;
                
                // Escape the content for shell - use single quotes and escape properly
                const escapedTitle = wpPostData.title.replace(/'/g, "'\\''");
                const escapedContent = (wpPostData.content || '').replace(/'/g, "'\\''");
                const escapedExcerpt = (wpPostData.excerpt || '').replace(/'/g, "'\\''");
                
                // Build wp-cli command
                let wpCommand = `docker exec ${wpContainerName} wp post create `;
                wpCommand += `--post_title='${escapedTitle}' `;
                if (escapedContent) {
                    wpCommand += `--post_content='${escapedContent}' `;
                }
                if (escapedExcerpt) {
                    wpCommand += `--post_excerpt='${escapedExcerpt}' `;
                }
                wpCommand += `--post_status=publish `;
                // Use the correct author based on identification mode
                let postAuthor;
                if (identificationMode === 'account' && options.wordpressUserId) {
                    postAuthor = options.wordpressUserId;
                    console.log(`🔍 [PublishToWordPress] wp-cli fallback: Using logged-in user ID ${postAuthor}`);
                } else if (identificationMode === 'did' || identificationMode === 'anonymous') {
                    // For DID and anonymous modes, use Anonymous user (or admin as fallback)
                    const { getAnonymousWordPressUser } = require('../../helpers/core/wordpressUserSync');
                    const anonymousUserId = await getAnonymousWordPressUser();
                    postAuthor = anonymousUserId || adminUserId;
                    console.log(`🔍 [PublishToWordPress] wp-cli fallback: Using ${anonymousUserId ? 'Anonymous' : 'admin'} user ID ${postAuthor} for ${identificationMode} mode`);
                } else {
                    postAuthor = adminUserId;
                    console.log(`🔍 [PublishToWordPress] wp-cli fallback: Using admin user ID ${postAuthor}`);
                }
                if (postAuthor) {
                    wpCommand += `--post_author=${postAuthor} `;
                }
                wpCommand += `--user=${WORDPRESS_ADMIN_USER} `;
                wpCommand += `--allow-root `;
                wpCommand += `--porcelain`;
                
                console.log(`🔧 [PublishToWordPress] Executing wp-cli command: ${wpCommand.replace(/--post_content='[^']*'/, "--post_content='...'")}`);
                const wpOutput = execSync(wpCommand, { encoding: 'utf-8', timeout: 30000 });
                const postId = parseInt(wpOutput.trim());
                
                if (isNaN(postId)) {
                    throw new Error(`wp-cli returned invalid post ID: ${wpOutput}`);
                }
                
                console.log(`✅ [PublishToWordPress] WordPress post created via wp-cli! Post ID: ${postId}`);
                
                // Add meta fields via wp-cli
                if (wpPostData.meta) {
                    for (const [key, value] of Object.entries(wpPostData.meta)) {
                        if (value !== null && value !== undefined) {
                            try {
                                const metaValue = typeof value === 'string' ? value : JSON.stringify(value);
                                const escapedMetaValue = metaValue.replace(/'/g, "'\\''");
                                const metaCommand = `docker exec ${wpContainerName} wp post meta update ${postId} '${key}' '${escapedMetaValue}' --allow-root`;
                                execSync(metaCommand, { encoding: 'utf-8', timeout: 10000 });
                            } catch (metaError) {
                                console.warn(`⚠️ [PublishToWordPress] Failed to set meta ${key}: ${metaError.message}`);
                            }
                        }
                    }
                }
                
                // Build permalink
                const baseUrl = process.env.PUBLIC_API_BASE_URL || 'http://localhost:3005';
                const wordpressPath = process.env.WORDPRESS_PROXY_PATH || '/wordpress';
                const permalink = `${baseUrl}${wordpressPath}/?p=${postId}`;
                
                return {
                    success: true,
                    postId: postId,
                    postUrl: permalink,
                    permalink: permalink
                };
            } catch (wpCliError) {
                console.error(`❌ [PublishToWordPress] wp-cli fallback also failed: ${wpCliError.message}`);
                if (wpCliError.stdout) {
                    console.error(`❌ [PublishToWordPress] wp-cli stdout: ${wpCliError.stdout}`);
                }
                if (wpCliError.stderr) {
                    console.error(`❌ [PublishToWordPress] wp-cli stderr: ${wpCliError.stderr}`);
                }
                throw new Error(`WordPress publishing failed via both REST API and wp-cli: ${error.message}. wp-cli error: ${wpCliError.message}`);
            }
        }
        
        if (error.response) {
            throw new Error(`WordPress API error: ${error.response.status} - ${error.response.data?.message || JSON.stringify(error.response.data)}`);
        }
        throw new Error(`WordPress connection error: ${error.message}`);
    }
}

// Moved decrypt route from access.js
router.post('/decrypt', async (req, res) => {
    try {
        const { contentId } = req.body;
        
        // 1. Fetch the content record from Arweave
        const recordTxId = contentId.replace('did:arweave:', '');
        const recordData = await arweaveWallet.getTransaction(recordTxId);
        const record = JSON.parse(recordData.toString());
        
        // 2. Fetch the encrypted content
        const encryptedContentTxId = record.accessControl.encryptedContent;
        const encryptedContent = await arweaveWallet.getTransaction(encryptedContentTxId);
        
        // 3. Parse the Lit conditions
        const litConditions = JSON.parse(record.accessControl.litConditions);
        
        // 4. Attempt to decrypt with Lit Protocol
        // Lit Protocol will automatically verify the access conditions
        const decryptedContent = await decryptContent(
            encryptedContent.toString(),
            record.accessControl.encryptedSymmetricKey,
            litConditions
        );
        
        // 5. Return the decrypted content
        res.json({
            status: 'success',
            data: {
                content: decryptedContent,
                metadata: record.basic
            }
        });
    } catch (error) {
        console.error('Error decrypting content:', error);
        res.status(403).json({
            error: 'Access denied or content not found',
            details: error.message
        });
    }
});

// New endpoint for unlocking content
// router.post('/unlock/:didTx', async (req, res) => {
//     try {
//         const { didTx } = req.params;
//         const { mediaType, paymentProof, walletAddress } = req.body;
        
//         // 1. Fetch the record
//         const record = await getRecordByDidTx(didTx);
//         if (!record) {
//             return res.status(404).json({ error: 'Record not found' });
//         }

//         const accessControl = record.accessControl;
        
//         // 2. Convert price to appropriate currency
//         const expectedAmount = await paymentManager.convertPrice(
//             accessControl.price,
//             accessControl.units,
//             accessControl.magnitude,
//             accessControl.currency.toUpperCase()
//         );

//         // 3. Verify payment
//         let isValid = false;
//         switch(accessControl.currency) {
//             case 'btc':
//                 isValid = await verifyBitcoinPayment(
//                     paymentProof.txid,
//                     expectedAmount,
//                     paymentProof.address
//                 );
//                 break;
//             case 'lightning':
//                 isValid = await verifyLightningPayment(paymentProof);
//                 break;
//             case 'zcash':
//                 isValid = await verifyZcashPayment(
//                     paymentProof.txid,
//                     expectedAmount,
//                     paymentProof.address
//                 );
//                 break;
//         }

//         if (!isValid) {
//             return res.status(400).json({ error: 'Invalid payment' });
//         }

//         // 4. For subscriptions, mint/verify NFT
//         if (accessControl.paymentType === 'subscription') {
//             const nftStatus = await handleSubscriptionNFT(walletAddress, accessControl.subscriptionNFTContract);
//             if (!nftStatus.valid) {
//                 return res.status(400).json({ error: 'Subscription NFT creation failed' });
//             }
//         }

//         // 5. Decrypt content
//         const decryptedContent = await decryptContent(
//             accessControl.encryptedContent,
//             accessControl.iv,
//             // We'd need a secure way to store/retrieve encryption keys
//             process.env.CONTENT_ENCRYPTION_KEY
//         );

//         // 6. Return decrypted content based on type
//         const response = {
//             contentType: accessControl.contentType,
//             content: decryptedContent
//         };

//         res.json(response);

//     } catch (error) {
//         console.error('Error unlocking content:', error);
//         res.status(500).json({ error: 'Failed to unlock content' });
//     }
// });

// // disabling /gun routes for now while we work on adding optionalAuthentication to the main get route
// // GET /api/records/gun/:soul - Get specific GUN record
// router.get('/gun/:soul', authenticateToken, async (req, res) => {
//     try {
//         const { soul } = req.params;
//         const { decrypt = true } = req.query;

//         const gunHelper = new GunHelper();
//         const record = await gunHelper.getRecord(soul, { decrypt });

//         if (!record) {
//             return res.status(404).json({ error: 'Record not found' });
//         }

//         console.log('🔍 Backend returning GUN record:', {
//             recordStructure: record,
//             dataStructure: record.data,
//             metaStructure: record.meta,
//             hasConversationSession: !!record.data?.conversationSession,
//             messageCount: record.data?.conversationSession?.message_count || 0,
//             messagesLength: record.data?.conversationSession?.messages?.length || 0
//         });

//         // The getRecord method should now return the actual decrypted data directly
//         console.log('🔍 Record data to return:', record.data);
//         console.log('🔍 Record meta.wasEncrypted:', record.meta?.wasEncrypted);

//         res.status(200).json({
//             message: 'GUN record retrieved successfully',
//             record: {
//                 data: record.data,
//                 meta: record.meta,
//                 oip: {
//                     ...record.oip,
//                     did: `did:gun:${soul}`,
//                     storage: 'gun'
//                 }
//             }
//         });
//     } catch (error) {
//         console.error('Error retrieving GUN record:', error);
//         res.status(500).json({ error: 'Failed to retrieve GUN record' });
//     }
// });

// // GET /api/records/gun - List user's GUN records
// router.get('/gun', authenticateToken, async (req, res) => {
//     try {
//         const { limit = 20, offset = 0, recordType } = req.query;
//         const userPubKey = req.user.publisherPubKey;

//         if (!userPubKey) {
//             return res.status(400).json({ error: 'Publisher public key not found in token' });
//         }

//         const gunHelper = new GunHelper();
//         const records = await gunHelper.listUserRecords(userPubKey, { limit, offset, recordType });

//         res.status(200).json({
//             message: 'GUN records retrieved successfully',
//             records: records.map(record => ({
//                 ...record,
//                 oip: {
//                     ...record.oip,
//                     did: `did:gun:${record.soul}`,
//                     storage: 'gun'
//                 }
//             })),
//             pagination: { limit, offset, total: records.length }
//         });
//     } catch (error) {
//         console.error('Error retrieving GUN records:', error);
//         res.status(500).json({ error: 'Failed to retrieve GUN records' });
//     }
// });

// Delete record endpoint - allows authenticated users to delete their own records
// Also publishes blockchain delete messages for Arweave records to propagate deletion across all nodes
router.post('/deleteRecord', authenticateToken, async (req, res) => {
    try {
        console.log('POST /api/records/deleteRecord', req.body);
        
        // Validate request format
        if (!req.body.delete || !req.body.delete.did) {
            return res.status(400).json({ 
                error: 'Invalid request format. Expected: {"delete": {"did": "did:gun:..."}}' 
            });
        }
        
        const didToDelete = req.body.delete.did;
        const user = req.user;
        
        // Validate DID format
        if (!didToDelete || typeof didToDelete !== 'string') {
            return res.status(400).json({ 
                error: 'Invalid DID format. DID must be a non-empty string.' 
            });
        }
        
        console.log('Attempting to delete record:', didToDelete, 'for user:', user.publicKey?.slice(0, 12));
        
        // First, find the record to verify ownership
        const recordToDelete = await searchRecordInDB(didToDelete);
        
        if (!recordToDelete) {
            return res.status(404).json({ 
                error: 'Record not found',
                did: didToDelete
            });
        }
        
        // Verify that the authenticated user owns this record
        const ownsRecord = userOwnsRecord(recordToDelete, user);
        
        if (!ownsRecord) {
            console.log('User does not own record. User:', user.publicKey?.slice(0, 12), 'Record owner checks failed');
            return res.status(403).json({ 
                error: 'Access denied. You can only delete records that you own.',
                did: didToDelete
            });
        }
        
        console.log('Ownership verified. Proceeding with deletion.');
        
        // For Arweave records, publish a blockchain delete message first
        // For GUN records, add to distributed deletion registry
        // This ensures deletion propagates to all nodes in the network
        // NOTE: Publishing the delete message also deletes the record locally via deleteRecordFromDB
        let deleteMessageTxId = null;
        let alreadyDeleted = false;
        let gunRegistryDeletion = false;
        const recordStatus = recordToDelete.oip?.recordStatus;
        const isPendingRecord = recordStatus === "pending confirmation in Arweave";
        
        if (didToDelete.startsWith('did:arweave:')) {
            // For pending records, skip blockchain delete message and just delete locally
            // since the record hasn't been confirmed on the blockchain yet
            if (isPendingRecord) {
                console.log('⚠️ Record has pending status - skipping blockchain delete message');
                console.log('ℹ️ Will delete locally only (record not yet confirmed on blockchain)');
            } else {
                try {
                    console.log('📝 Publishing blockchain delete message for Arweave record...');
                    
                    // Check if this is a server admin deleting a server-created record
                    const isAdmin = isServerAdmin(user);
                    const serverPubKey = getServerPublicKey();
                    const creatorPubKey = recordToDelete.oip?.creator?.publicKey;
                    const isServerCreated = serverPubKey && creatorPubKey === serverPubKey;
                    
                    if (isAdmin && isServerCreated) {
                        console.log('✅ Admin deleting server-created record - using server wallet for delete message');
                    }
                    
                    // Publish delete message (will be signed by server wallet automatically via publishNewRecord)
                    // This also triggers deleteRecordFromDB which deletes the target record immediately
                    const deleteMessage = {
                        delete: {
                            // didTx: didToDelete,
                            did: didToDelete
                        }
                    };
                    
                    const publishResult = await publishNewRecord(
                        deleteMessage,
                        'deleteMessage', // recordType
                        false, // publishFiles
                        true,  // addMediaToArweave
                        false, // addMediaToIPFS
                        null,  // youtubeUrl
                        'arweave', // blockchain
                        false  // addMediaToArFleet
                    );
                    
                    deleteMessageTxId = publishResult.transactionId;
                    alreadyDeleted = true; // The record was deleted by deleteRecordFromDB during publishing
                    console.log('✅ Delete message published to blockchain:', deleteMessageTxId);
                    console.log('✅ Record deleted locally via deleteRecordFromDB during message publishing');
                } catch (error) {
                    console.error('⚠️ Failed to publish blockchain delete message:', error);
                    // Continue with local deletion even if blockchain message fails
                }
            }
        } else if (didToDelete.startsWith('did:gun:')) {
            // For GUN records, add to distributed deletion registry
            // This ensures deletion propagates across all nodes during sync
            try {
                console.log('📝 Marking GUN record as deleted in distributed deletion registry...');
                
                const { GunDeletionRegistry } = require('../../helpers/core/gunDeletionRegistry');
                const gunHelper = new GunHelper();
                const deletionRegistry = new GunDeletionRegistry(gunHelper);
                
                const marked = await deletionRegistry.markDeleted(didToDelete, user.publicKey);
                
                if (marked) {
                    gunRegistryDeletion = true;
                    console.log('✅ GUN record marked as deleted in registry');
                    console.log('✅ Deletion will propagate to all nodes during sync');
                } else {
                    console.warn('⚠️ Failed to mark record in deletion registry, will still delete locally');
                }
            } catch (error) {
                console.error('⚠️ Failed to mark record in deletion registry:', error);
                // Continue with local deletion even if registry update fails
            }
        }
        
        // Only try to delete from local index if not already deleted during blockchain message publishing
        let deleteResponse = { deleted: 0 };
        if (!alreadyDeleted) {
            // Try deleting from records index first
            deleteResponse = await deleteRecordsByDID('records', didToDelete);
            
            // If not found in records, try organizations index
            if (deleteResponse.deleted === 0) {
                console.log('Record not found in records index, trying organizations index...');
                deleteResponse = await deleteRecordsByDID('organizations', didToDelete);
                
                if (deleteResponse.deleted > 0) {
                    console.log('✅ Record deleted from organizations index');
                }
            }
        } else {
            // Mark as deleted since it was already handled
            deleteResponse = { deleted: 1 };
        }
        
        if (deleteResponse.deleted > 0 || alreadyDeleted) {
            console.log(`Successfully deleted record with DID: ${didToDelete}`);
            
            const response = {
                success: true,
                message: 'Record deleted successfully',
                did: didToDelete,
                deletedCount: 1,
                recordStatus: recordStatus
            };
            
            if (gunRegistryDeletion) {
                response.blockchainDeletion = false;
                response.gunRegistryDeletion = true;
                response.propagationNote = 'GUN deletion registry updated. Deletion will propagate to all nodes during sync.';
            } else if (deleteMessageTxId) {
                response.deleteMessageTxId = deleteMessageTxId;
                response.blockchainDeletion = true;
                response.propagationNote = 'Delete message published to blockchain. Deletion will propagate to all nodes during sync.';
            } else if (isPendingRecord) {
                response.blockchainDeletion = false;
                response.propagationNote = 'Record was pending confirmation - deleted locally without blockchain message (record not yet confirmed on chain).';
            } else {
                response.blockchainDeletion = false;
                response.propagationNote = 'Local deletion only. To delete from all nodes, ensure blockchain delete message is published.';
            }
            
            res.status(200).json(response);
        } else {
            console.log('No records were deleted. Record may not exist in index.');
            res.status(404).json({
                error: 'Record not found in index or already deleted',
                did: didToDelete
            });
        }
        
    } catch (error) {
        console.error('Error deleting record:', error);
        res.status(500).json({ 
            error: 'Failed to delete record',
            details: error.message
        });
    }
});

module.exports = router;