const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

/**
 * Helper function to find wallet file in both Docker and local development environments
 * @returns {string} The correct path to the wallet file
 */
const getWalletFilePath = () => {
    const walletFile = process.env.WALLET_FILE;
    if (!walletFile) {
        throw new Error('WALLET_FILE environment variable is not set');
    }
    
    // Try Docker absolute path first
    const dockerPath = path.resolve('/usr/src/app', walletFile);
    if (fs.existsSync(dockerPath)) {
        return dockerPath;
    }
    
    // Try local development relative path
    const localPath = path.resolve(process.cwd(), walletFile);
    if (fs.existsSync(localPath)) {
        return localPath;
    }
    
    // Try just the environment variable as-is
    if (fs.existsSync(walletFile)) {
        return walletFile;
    }
    
    throw new Error(`Wallet file not found at any of these locations:\n- ${dockerPath}\n- ${localPath}\n- ${walletFile}`);
};
const { ArweaveSigner } = require('arbundles');
const { TurboFactory } = require('@ardrive/turbo-sdk');
const arweave = require('arweave');
const {crypto, createHash} = require('crypto');
const jwt = require('jsonwebtoken');
const base64url = require('base64url');
const templatesConfig = require('../config/templates.config.js');

// MEMORY LEAK FIX: Import at top level, not inside functions
// Dynamic requires inside functions can cause module cache issues
let searchRecordInDB = null;
const getSearchRecordInDB = () => {
    if (!searchRecordInDB) {
        searchRecordInDB = require('./core/elasticsearch').searchRecordInDB;
    }
    return searchRecordInDB;
};
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key_here';
dotenv.config();

const getTurboArweave = async () => {
    const walletFileLocation = getWalletFilePath();
    const key = JSON.parse(fs.readFileSync(walletFileLocation).toString());
    
    console.log('Initializing Turbo SDK...');
    console.log('Environment check:');
    console.log('- TURBO_API:', process.env.TURBO_API || 'not set');
    console.log('- TURBO_LOGIN:', process.env.TURBO_LOGIN || 'not set'); 
    console.log('- NODE_ENV:', process.env.NODE_ENV || 'not set');
    
    try {
        const turbo = TurboFactory.authenticated({ 
            privateKey: key
            // Let SDK use default endpoints: upload.ardrive.io and payment.ardrive.io
        });
        console.log('Turbo SDK initialized successfully with default endpoints');
        return turbo;
    } catch (error) {
        console.error('Error initializing Turbo SDK:', error);
        throw error;
    }
};

const getFileInfo = () => {
    const filename = path.basename(__filename);
    const directory = path.basename(__dirname);
    return `${directory}/${filename}`;
};

const getLineNumber = () => {
    const e = new Error();
    const stack = e.stack.split('\n');
    const lineInfo = stack[2].trim();
    const lineNumber = lineInfo.split(':')[1];
    return lineNumber;
};

const validateTemplateFields = (fieldsJson) => {
    try {
        const fields = JSON.parse(fieldsJson);
        let lastKeyWasEnum = false;

        for (const key in fields) {
            if (key.startsWith("index_")) {
                continue;
            }

            if (lastKeyWasEnum && key.endsWith("Values")) {
                lastKeyWasEnum = false;
                continue;
            }

            const expectedIndexKey = `index_${key}`;

            if (!(expectedIndexKey in fields)) {
                console.log(`Missing index for: ${key}`);
                return false;
            }

            // Check for enum types (including "repeated enum")
            const fieldType = fields[key];
            lastKeyWasEnum = fieldType === "enum" || fieldType === "repeated enum";
        }

        return true;
    } catch (error) {
        console.error('Error validating template fields:', error);
        return false;
    }
};

const verifySignature = async (message, signatureBase64, publicKey, creatorAddress = null) => {
    // console.log('Verifying signature... for creatorAddress', creatorAddress, 'publicKey', publicKey);
    if (publicKey === null && creatorAddress !== null) {
        const creatorData = await searchCreatorByAddress(creatorAddress);
        if (creatorData) {
            publicKey = creatorData.creatorPublicKey;
        } else {
            return false;
        }
    }

    const messageData = new TextEncoder().encode(message);
    const signature = Buffer.from(signatureBase64, 'base64');
    const isVerified = await ArweaveSigner.verify(publicKey, messageData, signature);
    return isVerified;
};

const signMessage = async (data) => {
    const walletPath = getWalletFilePath();
    const jwk = JSON.parse(fs.readFileSync(walletPath));
    const myPublicKey = jwk.n;
    const myAddress = base64url(createHash('sha256').update(Buffer.from(myPublicKey, 'base64')).digest());
    const signatureObject = await arweave.crypto.sign(jwk, data);
    const signatureBase64 = Buffer.from(signatureObject).toString('base64');
    return signatureBase64;
};

const isValidDid = (did) => {
    // Support multiple DID formats: arweave, irys, ipfs, arfleet, bittorrent, gun
    return /^did:(arweave|irys|ipfs|arfleet|bittorrent|gun):[a-zA-Z0-9_\-\.]+$/.test(did);
};

const isValidTxId = (txid) => {
    return /^[a-zA-Z0-9_-]{43}$/.test(txid);
};

const txidToDid = (txid) => {
    if (!isValidTxId(txid)) {
        throw new Error('Invalid transaction ID format');
    }
    return `did:arweave:${txid}`;
};

const didToTxid = (did) => {
    if (!isValidDid(did)) {
        throw new Error('Invalid DID format');
    }
    return did.split(':')[2];
};

// GUN-specific DID utilities
const didToGunSoul = (did) => {
    if (!did.startsWith('did:gun:')) {
        throw new Error('Invalid GUN DID format');
    }
    return did.split(':')[2];
};

const gunSoulToDid = (soul) => {
    return `did:gun:${soul}`;
};

// Normalize DID parameter for backward compatibility
const normalizeDidParam = (didParam) => {
    // Accept both didTx and did for backward compatibility
    return didParam; // didTx values are already valid DIDs
};

const loadRemapTemplates = async () => {
    const remapTemplates = {};
    const remapTemplatesDir = path.resolve(__dirname, '../remapTemplates');

    const files = fs.readdirSync(remapTemplatesDir);

    for (const file of files) {
        if (path.extname(file) === '.json') {
            const templateName = path.basename(file, '.json');
            const templatePath = path.join(remapTemplatesDir, file);
            const templateContent = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
            remapTemplates[templateName] = templateContent;
        }
    }

    return remapTemplates;
};

const getTemplateTxidByName = (templateName) => {
    const templateConfigTxid = templatesConfig.defaultTemplates[templateName];
    return templateConfigTxid ? templateConfigTxid : null;
};

const resolveRecords = async (record, resolveDepth, recordsInDB, resolveNamesOnly = false, summarizeRecipe = false, addRecipeNutritionalSummary = null, visited = new Set(), resolveFieldNames = null, currentDepth = 0) => {
    // Handle NaN, undefined, or 0 depth - stop recursion
    if (!resolveDepth || resolveDepth === 0 || isNaN(resolveDepth) || !record) {
        return record;
    }

    if (!record.data || typeof record.data !== 'object') {
        console.error(getFileInfo(), getLineNumber(), 'record.data is not an object:', record.data);
        return record;
    }

    // Get searchRecordInDB lazily (avoids circular dependency issues)
    const searchRecordInDB = getSearchRecordInDB();

    // Get the record's DID to track visits
    const recordDid = record.oip?.did || record.oip?.didTx;
    
    // Check if we've already visited this record in the current resolution chain
    if (recordDid && visited.has(recordDid)) {
        // Return a shallow reference instead of recursing
        return {
            oip: record.oip,
            data: {
                basic: record.data?.basic || {}
            },
            _circular: true  // Mark this as a circular reference for debugging
        };
    }
    
    // Add this record to the visited set for this resolution chain
    if (recordDid) {
        visited.add(recordDid);
    }

    // Determine if we're at the deepest level (where resolveNamesOnly should apply)
    const isDeepestLevel = resolveDepth === 1;
    const shouldResolveNamesOnly = resolveNamesOnly && isDeepestLevel;

    // NOTE: The record passed here should already be cloned by getRecords() if resolveDepth > 0
    // This allows us to mutate it safely without polluting the cache

    // Helper function to check if a field path should be resolved
    const shouldResolveField = (category, key) => {
        // If no resolveFieldNames specified, resolve all fields
        if (!resolveFieldNames || resolveFieldNames.length === 0) {
            return true;
        }
        
        // Check if this field matches any of the specified paths
        // Support both "data.category.key" and "category.key" formats
        const fieldPath = `data.${category}.${key}`;
        const shortFieldPath = `${category}.${key}`;
        
        return resolveFieldNames.some(targetPath => 
            targetPath === fieldPath || 
            targetPath === shortFieldPath ||
            targetPath === `data.${shortFieldPath}` ||
            fieldPath.startsWith(targetPath + '.') ||
            shortFieldPath.startsWith(targetPath + '.')
        );
    };

    // First resolve all DIDs to names/records
    for (const category of Object.keys(record.data)) {
        const properties = record.data[category];
        for (const key of Object.keys(properties)) {
            // Check if this field should be resolved based on resolveFieldNames
            if (!shouldResolveField(category, key)) {
                continue; // Skip this field if it's not in the resolveFieldNames list
            }

            if (typeof properties[key] === 'string' && properties[key].startsWith('did:')) {
                let refRecord = recordsInDB.find(record => 
                    (record.oip.did || record.oip.didTx) === properties[key]
                );
                
                // If not found in recordsInDB, fetch from Elasticsearch
                if (!refRecord) {
                    try {
                        refRecord = await searchRecordInDB(properties[key]);
                        // NOTE: Do NOT add to recordsInDB here!
                        // recordsInDB is a reference to the GLOBAL cache (recordsCache)
                        // Adding resolved records to it causes unbounded memory growth
                        // because deeply-resolved objects accumulate in the cache
                    } catch (error) {
                        console.error(`❌ [Resolution] Error fetching record from ES:`, error.message);
                    }
                }
                
                if (refRecord) {
                    if (shouldResolveNamesOnly) {
                        // Only return the name from the basic data (at deepest level)
                        const name = refRecord.data?.basic?.name || properties[key]; // fallback to DID if no name found
                        properties[key] = name;
                    } else {
                        // CRITICAL: Deep copy refRecord before resolving!
                        // refRecord is from the global cache - modifying it pollutes the cache
                        // Use structuredClone (more memory-efficient than JSON.parse/stringify)
                        const refRecordCopy = structuredClone(refRecord);
                        
                        // Create a new visited set for this branch to track the resolution chain
                        const branchVisited = new Set(visited);
                        let resolvedRef = await resolveRecords(refRecordCopy, resolveDepth - 1, recordsInDB, resolveNamesOnly, summarizeRecipe, addRecipeNutritionalSummary, branchVisited, resolveFieldNames, currentDepth + 1);
                        
                        // Apply recipe summary if this is a recipe record and summarizeRecipe is enabled
                        if (summarizeRecipe && addRecipeNutritionalSummary && resolvedRef.oip?.recordType === 'recipe' && resolvedRef.data?.recipe) {
                            resolvedRef = await addRecipeNutritionalSummary(resolvedRef, recordsInDB);
                        }
                        
                        properties[key] = resolvedRef;
                    }
                }
                // Silently skip if record not found - this is normal for orphaned references
            } else if (Array.isArray(properties[key])) {
                for (let i = 0; i < properties[key].length; i++) {
                    if (typeof properties[key][i] === 'string' && properties[key][i].startsWith('did:')) {
                        let refRecord = recordsInDB.find(record => 
                            (record.oip.did || record.oip.didTx) === properties[key][i]
                        );
                        
                        // If not found in recordsInDB, fetch from Elasticsearch
                        if (!refRecord) {
                            try {
                                refRecord = await searchRecordInDB(properties[key][i]);
                                // NOTE: Do NOT add to recordsInDB - it's a global cache reference
                            } catch (error) {
                                console.error(`❌ [Resolution] Error fetching record from ES:`, error.message);
                            }
                        }
                        
                        if (refRecord) {
                            if (shouldResolveNamesOnly) {
                                // Only return the name from the basic data (at deepest level)
                                const name = refRecord.data?.basic?.name || properties[key][i]; // fallback to DID if no name found
                                properties[key][i] = name;
                            } else {
                                // CRITICAL: Deep copy refRecord before resolving!
                                // Use structuredClone (more memory-efficient than JSON.parse/stringify)
                                const refRecordCopy = structuredClone(refRecord);
                                
                                // Create a new visited set for this branch to track the resolution chain
                                const branchVisited = new Set(visited);
                                let resolvedRef = await resolveRecords(refRecordCopy, resolveDepth - 1, recordsInDB, resolveNamesOnly, summarizeRecipe, addRecipeNutritionalSummary, branchVisited, resolveFieldNames, currentDepth + 1);
                                
                                // Apply recipe summary if this is a recipe record and summarizeRecipe is enabled
                                if (summarizeRecipe && addRecipeNutritionalSummary && resolvedRef.oip?.recordType === 'recipe' && resolvedRef.data?.recipe) {
                                    resolvedRef = await addRecipeNutritionalSummary(resolvedRef, recordsInDB);
                                }
                                
                                properties[key][i] = resolvedRef;
                            }
                        }
                        // Silently skip if record not found - this is normal for orphaned references
                    }
                }
            }
        }
    }

    // AFTER DID resolution, handle special recipe merging for resolveNamesOnly
    // Only apply this at the deepest level
    if (shouldResolveNamesOnly && record.data.recipe) {
        const recipeData = record.data.recipe;
        
        // If this is a recipe with ingredient and ingredient_comment fields
        if (Array.isArray(recipeData.ingredient) && Array.isArray(recipeData.ingredient_comment)) {
            // Merge ingredient names with their comments
            const mergedIngredients = recipeData.ingredient.map((ingredient, index) => {
                const comment = recipeData.ingredient_comment[index] || '';
                
                // If there's a comment, merge it with the ingredient name
                if (comment && comment.trim()) {
                    // Handle different comment patterns
                    if (comment.includes('ground') && !ingredient.includes('ground')) {
                        // For "ground" comments, prepend to the ingredient name
                        return `${comment} ${ingredient}`;
                    } else if (comment.includes('virgin') && ingredient.includes('oil')) {
                        // For "extra virgin" comments with oil, prepend and handle "divided"
                        const parts = comment.split(' ');
                        const virginParts = parts.filter(p => p.includes('virgin') || p.includes('extra'));
                        const otherParts = parts.filter(p => !p.includes('virgin') && !p.includes('extra'));
                        
                        let result = `${virginParts.join(' ')} ${ingredient}`;
                        if (otherParts.length > 0) {
                            result += `, ${otherParts.join(' ')}`;
                        }
                        return result;
                    } else if (comment.includes('boneless') || comment.includes('skinless')) {
                        // For meat descriptions, prepend to ingredient name
                        return `${comment} ${ingredient}`;
                    } else {
                        // For other comments (like "minced", "juiced", "halved and thinly sliced"), append with comma
                        return `${ingredient}, ${comment}`;
                    }
                }
                
                // If no comment, return the ingredient as-is
                return ingredient;
            });
            
            // Replace the ingredient array with the merged version
            recipeData.ingredient = mergedIngredients;
        }
    }

    return record;
};

// Middleware to verify the JWT token
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }

    try {
        const verified = jwt.verify(token, process.env.JWT_SECRET);
        
        // Add publisherPubKey to the user object for GUN record verification
        // Only extract if needed (for GUN operations) and wallet file exists
        if (!verified.publisherPubKey && (req.params.soul || req.query.soul)) {
            // Extract publisherPubKey from Arweave wallet only if needed for GUN verification
            try {
                const walletPath = getWalletFilePath();
                const jwk = JSON.parse(fs.readFileSync(walletPath));
                verified.publisherPubKey = jwk.n; // Arweave public key
                
                // Also add the derived address for compatibility
                const myAddress = base64url(createHash('sha256').update(Buffer.from(jwk.n, 'base64')).digest());
                verified.publisherAddress = myAddress;
                verified.didAddress = `did:arweave:${myAddress}`;
            } catch (error) {
                // Don't fail authentication if wallet file doesn't exist - it's only needed for GUN operations
                console.warn('Warning: Could not extract publisher public key (wallet file may not exist):', error.message);
                // Continue without publisherPubKey - it's only needed for GUN record verification
            }
        }
        
        req.user = verified;
        
        // For GUN record requests, verify user owns the record
        if (req.params.soul || req.query.soul) {
            const soul = req.params.soul || req.query.soul;
            const userPubKey = verified.publisherPubKey;

            if (!userPubKey) {
                return res.status(403).json({ error: 'Publisher public key not found' });
            }

            // Create hash of the public key (first 12 chars) to match GUN soul format
            const pubKeyHash = createHash('sha256')
                .update(userPubKey)
                .digest('hex')
                .slice(0, 12);

            // Verify soul belongs to authenticated user
            if (!soul.startsWith(pubKeyHash)) {
                return res.status(403).json({ error: 'Access denied to this record' });
            }
        }

        next();
    } catch (error) {
        console.error('Invalid token:', error);
        return res.status(403).json({ error: 'Invalid token' });
    }
};

/**
 * Optional authentication middleware - allows both authenticated and unauthenticated access
 * Adds user info to req.user if token is valid, otherwise req.user remains undefined
 */
const optionalAuthenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        // No token provided - continue as unauthenticated user
        req.isAuthenticated = false;
        req.user = null;
        return next();
    }

    try {
        const verified = jwt.verify(token, process.env.JWT_SECRET);
        
        // Add server's Arweave wallet info for backward compatibility (only if user doesn't have HD wallet)
        // Modern users have publicKey from their HD wallet in the JWT, so we don't need publisherPubKey
        // Only add publisherPubKey for legacy compatibility if:
        // 1. User doesn't have publicKey (legacy account)
        // 2. publisherPubKey is not already set
        // 3. Server wallet file exists (optional - don't fail if missing)
        if (!verified.publicKey && !verified.publisherPubKey) {
            try {
                const walletPath = getWalletFilePath();
                const jwk = JSON.parse(fs.readFileSync(walletPath));
                verified.publisherPubKey = jwk.n; // Arweave public key
                
                // Also add the derived address for compatibility
                const myAddress = base64url(createHash('sha256').update(Buffer.from(jwk.n, 'base64')).digest());
                verified.publisherAddress = myAddress;
                verified.didAddress = `did:arweave:${myAddress}`;
            } catch (error) {
                // Wallet file not found is OK - this is optional for backward compatibility
                // Modern users have publicKey in JWT, so publisherPubKey is not needed
                // Only log if it's not a "file not found" error
                if (!error.message.includes('not found')) {
                    console.warn('⚠️ [Auth] Could not extract publisher public key (wallet file not found or invalid):', error.message);
                }
                // Don't fail authentication - continue without publisherPubKey
                // User's publicKey from HD wallet is sufficient
            }
        }
        
        req.user = verified;
        req.isAuthenticated = true;
        
        // For GUN record requests, verify user owns the record (only for specific soul requests)
        if (req.params.soul || req.query.soul) {
            const soul = req.params.soul || req.query.soul;
            const userPubKey = verified.publicKey || verified.publisherPubKey; // Prioritize user's HD wallet key
            
            if (!userPubKey) {
                return res.status(403).json({ error: 'User public key not found' });
            }

            // Create hash of the user's public key (first 12 chars) to match GUN soul format
            const pubKeyHash = createHash('sha256')
                .update(userPubKey)
                .digest('hex')
                .slice(0, 12);

            // Verify soul belongs to authenticated user
            if (!soul.startsWith(pubKeyHash)) {
                return res.status(403).json({ error: 'Access denied to this record' });
            }
        }

        next();
    } catch (error) {
        console.error('Invalid token in optional auth:', error);
        // Invalid token - continue as unauthenticated user
        req.isAuthenticated = false;
        req.user = null;
        next();
    }
};

/**
 * Get the server's wallet public key
 * @returns {string|null} - Server's public key or null if unavailable
 */
const getServerPublicKey = () => {
    try {
        const walletPath = getWalletFilePath();
        const jwk = JSON.parse(fs.readFileSync(walletPath));
        return jwk.n;
    } catch (error) {
        console.error('Error getting server public key:', error);
        return null;
    }
};

/**
 * Extract base domain from a hostname (e.g., api.fitnessally.io -> fitnessally.io)
 * @param {string} hostname - The hostname to extract from
 * @returns {string} - The base domain (last two parts)
 */
const extractBaseDomain = (hostname) => {
    const parts = hostname.split('.');
    if (parts.length >= 2) {
        // Return the last two parts (e.g., ['oip', 'fitnessally', 'io'] -> 'fitnessally.io')
        return parts.slice(-2).join('.');
    }
    return hostname;
};

/**
 * Check if user is a server admin based on email domain matching
 * @param {Object} user - The authenticated user
 * @returns {boolean} - True if user's email domain matches server domain
 */
const isServerAdmin = (user) => {
    if (!user || !user.email) {
        console.log('❌ No user or email provided for admin check');
        return false;
    }
    
    // Extract domain from user email (e.g., user@fitnessally.io -> fitnessally.io)
    const emailDomain = user.email.split('@')[1]?.toLowerCase();
    if (!emailDomain) {
        console.log('❌ Could not extract email domain from:', user.email);
        return false;
    }
    
    console.log('🔍 Checking admin status for email domain:', emailDomain);
    
    // Get server domain from PUBLIC_API_BASE_URL
    let serverBaseDomain = null;
    if (process.env.PUBLIC_API_BASE_URL) {
        try {
            const url = new URL(process.env.PUBLIC_API_BASE_URL);
            const hostname = url.hostname.toLowerCase();
            serverBaseDomain = extractBaseDomain(hostname);
            console.log('🔍 Server hostname:', hostname, '-> base domain:', serverBaseDomain);
        } catch (error) {
            console.error('Error parsing PUBLIC_API_BASE_URL:', error);
        }
    } else {
        console.log('⚠️ PUBLIC_API_BASE_URL not set - admin check will fail');
    }
    
    // Check if email domain matches server base domain
    const isMatch = serverBaseDomain && emailDomain === serverBaseDomain;
    
    if (isMatch) {
        console.log('✅ User is server admin - email domain matches:', emailDomain);
    } else {
        console.log('❌ Admin check failed - email domain:', emailDomain, 'vs server domain:', serverBaseDomain);
    }
    
    return isMatch;
};

/**
 * Check if a user owns a record based on various ownership indicators
 * @param {Object} record - The record to check
 * @param {Object} user - The authenticated user
 * @returns {boolean} - True if user owns the record
 */
const userOwnsRecord = (record, user) => {
    if (!record || !user) return false;
    
    const userPubKey = user.publicKey || user.publisherPubKey; // Prioritize user's HD wallet key
    if (!userPubKey) return false;
    
    // Priority 1: Check accessControl ownership (NEW template-based ownership)
    const accessControl = record.data?.accessControl;
    if (accessControl?.owner_public_key === userPubKey || accessControl?.created_by === userPubKey) {
        console.log('Record owned by user (accessControl template):', userPubKey.slice(0, 12));
        return true;
    }
    
    // Priority 2: Check conversation session ownership (NEW user-based ownership)
    const conversationSession = record.data?.conversationSession;
    if (conversationSession?.owner_public_key === userPubKey) {
        console.log('Record owned by user (conversation session):', userPubKey.slice(0, 12));
        return true;
    }
    
    // Note: Shared access and permissions will be implemented when we have the full accessControl template
    // For now, we only support private/public access levels
    
    // Priority 3: Check server admin privilege for server-created records
    // This allows trusted admin users (with matching email domain) to manage server-created content
    if (isServerAdmin(user)) {
        const serverPubKey = getServerPublicKey();
        const creatorPubKey = record.oip?.creator?.publicKey;
        
        if (serverPubKey && creatorPubKey === serverPubKey) {
            console.log('✅ Server admin can manage server-created record:', user.email);
            return true;
        }
    }
    
    // Priority 4: Check DID-based ownership for GUN records (user's key in soul)
    if (record.oip?.did?.startsWith('did:gun:')) {
        const soul = record.oip.did.replace('did:gun:', '');
        const pubKeyHash = createHash('sha256')
            .update(userPubKey)
            .digest('hex')
            .slice(0, 12);
        
        if (soul.startsWith(pubKeyHash)) {
            console.log('Record owned by user (GUN soul):', pubKeyHash);
            return true;
        }
    }
    
    // Priority 5: Check creator ownership (fallback for server-signed records)
    const creatorPubKey = record.oip?.creator?.publicKey;
    if (creatorPubKey === userPubKey) {
        console.log('Record owned by user (creator fallback):', userPubKey.slice(0, 12));
        return true;
    }
    
    console.log('Record not owned by user - filtering out');
    return false;
};

let remapTemplatesPromise = loadRemapTemplates();

module.exports = {
    getTurboArweave,
    verifySignature,
    signMessage,
    txidToDid,
    didToTxid,
    didToGunSoul,
    gunSoulToDid,
    normalizeDidParam,
    resolveRecords,
    validateTemplateFields,
    getTemplateTxidByName,
    getLineNumber,
    getFileInfo,
    loadRemapTemplates,
    authenticateToken,
    optionalAuthenticateToken, // NEW: Add optional authentication
    userOwnsRecord, // NEW: Add ownership check utility
    getServerPublicKey, // NEW: Get server wallet public key
    isServerAdmin, // NEW: Check if user is server admin
    isValidDid,
    isValidTxId,
    getWalletFilePath
};