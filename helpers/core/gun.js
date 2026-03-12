/**
 * GUN Integration Helper
 * Provides GUN database functionality for OIP records via HTTP API
 */

const crypto = require('crypto');
const axios = require('axios');

class GunHelper {
    constructor() {
        // Use HTTP API instead of GUN peer protocol
        const gunApiUrl = process.env.GUN_PEERS || 'http://gun-relay:8765';
        this.apiUrl = gunApiUrl.split(',')[0]; // Use first peer as API endpoint
        
        this.encryptionEnabled = process.env.GUN_ENABLE_ENCRYPTION === 'true';
        this.defaultPrivacy = process.env.GUN_DEFAULT_PRIVACY === 'true';
        
        // CRITICAL FIX: Initialize 404 cache to prevent redundant retries
        this.missing404Cache = new Map();
        this.cache404Stats = { hits: 0, total: 0 };
        
        // CRITICAL FIX: Initialize deletion failure cache to prevent repeated 500 errors
        this.deletionFailureCache = new Map(); // soul -> { count, lastAttempt, error }
        this.deletionStats = { totalAttempts: 0, cachedSkips: 0, failures: 0 };
        
        // Periodic cache cleanup to prevent memory growth (every hour)
        this.cacheCleanupInterval = setInterval(() => {
            const now = Date.now();
            const maxAge = 3600000; // 1 hour
            let cleanedCount = 0;
            
            for (const [soul, timestamp] of this.missing404Cache.entries()) {
                if (now - timestamp > maxAge) {
                    this.missing404Cache.delete(soul);
                    cleanedCount++;
                }
            }
            
            // Clean deletion failure cache
            for (const [soul, data] of this.deletionFailureCache.entries()) {
                if (now - data.lastAttempt > maxAge) {
                    this.deletionFailureCache.delete(soul);
                    cleanedCount++;
                }
            }
            
            if (cleanedCount > 0) {
                console.log(`🧹 [GUN Cache] Cleaned ${cleanedCount} expired entries (404: ${this.missing404Cache.size}, Del: ${this.deletionFailureCache.size})`);
            }
        }, 3600000); // Run every hour
    }

    /**
     * Put simple data directly to GUN (for registry entries, indexes, etc.)
     * Bypasses the data/oip/meta structure wrapper
     * @param {Object} data - The data to store (flat object)
     * @param {string} soul - The GUN soul (unique identifier)
     * @returns {Promise<Object>} - Result with soul
     */
    async putSimple(data, soul) {
        try {
            const response = await axios.post(`${this.apiUrl}/put`, {
                soul: soul,
                data: data
            }, {
                timeout: parseInt(process.env.GUN_REGISTRY_TIMEOUT_MS) || 30000, // 30 seconds for high-load operations
                headers: { 'Content-Type': 'application/json' }
            });

            if (response.data && response.data.success) {
                // MEMORY LEAK FIX: Clean up response buffer
                response.data = null;
                return { soul, success: true };
            } else {
                throw new Error(response.data.error || 'Failed to store data');
            }
        } catch (error) {
            // MEMORY LEAK FIX: Aggressively clean up error response buffers
            if (error.response) {
                error.response.data = null;
                error.response = null;
            }
            console.error(`[Axios Error] ${error.message} from ${this.apiUrl}/put`);
            console.error(`Failed to put simple data to GUN (${soul}):`, error.message);
            
            // MEMORY LEAK FIX: Force GC after failed GUN operations
            if (global.gc) {
                setImmediate(() => global.gc());
            }
            
            throw error;
        }
    }

    /**
     * Generate deterministic soul for record (shortened format)
     * @param {string} publisherPubKey - Publisher's public key
     * @param {string|null} localId - Optional local identifier
     * @param {Object|null} recordData - Record data for content hash fallback
     * @returns {string} - Deterministic soul string (much shorter)
     */
    computeSoul(publisherPubKey, localId = null, recordData = null) {
        // Create a shorter hash of the public key (first 12 chars)
        const pubKeyHash = crypto.createHash('sha256')
            .update(publisherPubKey)
            .digest('hex')
            .slice(0, 12);
            
        if (localId) {
            // User-provided local ID: pubKeyHash:localId
            return `${pubKeyHash}:${localId}`;
        }
        
        // Fallback: content hash for deterministic soul generation
        if (recordData) {
            // Create a more unique hash by including timestamp and random component
            const timestamp = Date.now();
            const randomComponent = Math.random().toString(36).slice(2, 8);
            
            // Include key identifying fields for better uniqueness
            const keyFields = {
                name: recordData.basic?.name || recordData.name,
                date: recordData.basic?.date || recordData.date,
                recordType: recordData.oip?.recordType || recordData.recordType,
                timestamp: timestamp,
                random: randomComponent
            };
            
            const canonicalString = JSON.stringify(keyFields, Object.keys(keyFields).sort());
            const contentHash = crypto.createHash('sha256')
                .update(canonicalString)
                .digest('hex')
                .slice(0, 12); // Longer hash for better uniqueness
            return `${pubKeyHash}:h:${contentHash}`;
        }
        
        // Last resort: timestamp-based (not deterministic, but unique)
        const timestamp = Date.now().toString(36); // Base36 for shorter format
        return `${pubKeyHash}:t:${timestamp}`;
    }

    /**
     * Put record to GUN database
     * @param {Object} recordData - The record data to store
     * @param {string} soul - The GUN soul (unique identifier)
     * @param {Object} options - Storage options
     * @param {boolean} options.encrypt - Whether to encrypt the data
     * @param {Array} options.readerPubKeys - Public keys of authorized readers
     * @param {Object} options.writerKeys - Writer's key pair for encryption
     * @param {string} options.localId - Local identifier for the record
     * @returns {Promise<Object>} - Result with soul and DID
     */
    async putRecord(recordData, soul, options = {}) {
        try {
            // IMPORTANT: Store data and oip as JSON strings to avoid GUN nested node references
            // GUN creates separate nodes for nested objects, which breaks HTTP sync
            const gunRecord = {
                data: JSON.stringify(recordData.data),
                oip: JSON.stringify(recordData.oip),
                meta: {
                    created: Date.now(),
                    localId: options.localId || null,
                    encrypted: false
                }
            };

            // Handle encryption for private records with smart encryption strategy
            if (options.encrypt) {
                const userPublicKey = options.userPublicKey || options.publisherPubKey;
                const userPassword = options.userPassword;
                const accessControl = options.accessControl;
                
                if (!userPublicKey) {
                    throw new Error('User public key required for encryption');
                }
                
                // Determine encryption strategy based on access control
                const { OrganizationEncryption } = require('./organizationEncryption');
                const orgEncryption = new OrganizationEncryption();
                
                const encryptionStrategy = await orgEncryption.determineEncryptionStrategy(accessControl, userPublicKey);
                
                if (!encryptionStrategy.encrypt) {
                    return; // Don't encrypt public records
                }
                
                let encryptionKey;
                let encryptionMetadata = {
                    encrypted: true,
                    encryptionMethod: 'aes-256-gcm'
                };
                
                if (encryptionStrategy.encryptionType === 'organization') {
                    // Use organization encryption key
                    encryptionKey = encryptionStrategy.encryptionKey;
                    encryptionMetadata.encryptionType = 'organization';
                    encryptionMetadata.encryptedForOrganization = encryptionStrategy.organizationDid;
                    encryptionMetadata.sharedWith = encryptionStrategy.sharedWith;
                    
                } else {
                    // Use per-user encryption (default for private records)
                    if (userPassword) {
                        try {
                            const { getUserGunEncryptionSalt, generateUserEncryptionKey } = require('../../routes/daemon/user');
                            const userSalt = await getUserGunEncryptionSalt(userPublicKey, userPassword);
                            encryptionKey = generateUserEncryptionKey(userPublicKey, userSalt);
                        } catch (error) {
                            encryptionKey = crypto.pbkdf2Sync(userPublicKey, 'oip-gun-fallback', 100000, 32, 'sha256');
                        }
                    } else {
                        encryptionKey = crypto.pbkdf2Sync(userPublicKey, 'oip-gun-fallback', 100000, 32, 'sha256');
                    }
                    
                    encryptionMetadata.encryptionType = 'per-user';
                    encryptionMetadata.encryptedBy = userPublicKey;
                }
                
                // Perform AES-256-GCM encryption
                const algorithm = 'aes-256-gcm';
                const iv = crypto.randomBytes(12);
                const cipher = crypto.createCipheriv(algorithm, encryptionKey, iv);

                const plaintext = Buffer.from(JSON.stringify(gunRecord.data), 'utf8');
                const encryptedBuf = Buffer.concat([cipher.update(plaintext), cipher.final()]);
                const authTag = cipher.getAuthTag();

                gunRecord.data = {
                    encrypted: encryptedBuf.toString('base64'),
                    iv: iv.toString('base64'),
                    tag: authTag.toString('base64')
                };
                
                // Apply encryption metadata
                Object.assign(gunRecord.meta, encryptionMetadata);
            }

            // console.log('📡 Sending HTTP PUT request to GUN API...');
            
            // Use HTTP API instead of GUN peer protocol
            const response = await axios.post(`${this.apiUrl}/put`, {
                soul: soul,
                data: gunRecord
            }, {
                timeout: 30000, // 30 second HTTP timeout (increased due to GUN radisk JSON parsing slowdowns)
                headers: {
                    'Content-Type': 'application/json'
                },
                // Explicitly use global agents (don't create new ones per request)
                httpAgent: axios.defaults.httpAgent,
                httpsAgent: axios.defaults.httpsAgent
            });

            if (response.data.success) {
                // MEMORY LEAK FIX: Clean up response buffer
                response.data = null;
                // console.log('✅ GUN record stored successfully via HTTP API');
                return { 
                    soul, 
                    did: `did:gun:${soul}`,
                    encrypted: gunRecord.meta.encrypted
                };
            } else {
                throw new Error(`GUN API error: ${response.data.error}`);
            }

        } catch (error) {
            // MEMORY LEAK FIX: Aggressively clean up error response buffers
            if (error.response) {
                error.response.data = null;
                error.response = null;
            }
            
            // MEMORY LEAK FIX: Force GC after failed GUN operations
            if (global.gc) {
                setImmediate(() => global.gc());
            }
            
            if (error.code === 'ECONNREFUSED') {
                throw new Error('GUN relay not accessible - check if gun-relay service is running');
            } else if (error.code === 'ETIMEDOUT') {
                throw new Error('GUN relay timeout - service may be overloaded');
            } else {
                // Only log concise error message, full stack trace not needed
                throw error;
            }
        }
    }

    /**
     * Get record from GUN database
     * @param {string} soul - The GUN soul to retrieve
     * @param {Object} options - Retrieval options
     * @param {Object} options.decryptKeys - Keys for decryption if needed
     * @returns {Promise<Object|null>} - The record data or null if not found
     */
    async getRecord(soul, options = {}) {
        try {
            // CRITICAL FIX: Check 404 cache before attempting fetch
            this.cache404Stats.total++;
            if (this.missing404Cache.has(soul)) {
                this.cache404Stats.hits++;
                
                // Log stats periodically (every 100 requests)
                if (this.cache404Stats.total % 100 === 0) {
                    const hitRate = ((this.cache404Stats.hits / this.cache404Stats.total) * 100).toFixed(1);
                    console.log(`📊 [GUN 404 Cache] ${this.cache404Stats.hits}/${this.cache404Stats.total} hits (${hitRate}% cache hit rate, ${this.missing404Cache.size} cached souls)`);
                }
                
                return null; // Skip fetch for known-missing soul
            }
            
            // console.log('📡 Sending HTTP GET request to GUN API...'); // Commented out - too verbose
            
            // MEMORY LEAK FIX: Add retry with exponential backoff and socket cleanup for failed requests
            let lastError = null;
            let retryCount = 0;
            const maxRetries = 2;
            
            while (retryCount < maxRetries) {
                try {
                    const response = await axios.get(`${this.apiUrl}/get`, {
                        params: { soul },
                        timeout: 20000, // 20 second timeout (increased due to GUN radisk JSON parsing slowdowns)
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        // Explicitly use global agents (don't create new ones per request)
                        httpAgent: axios.defaults.httpAgent,
                        httpsAgent: axios.defaults.httpsAgent
                    });

            if (response.data.success) {
                let data = response.data.data;
                
                // Handle encrypted data with smart decryption strategy
                if (data.meta && data.meta.encrypted && data.meta.encryptionMethod === 'aes-256-gcm') {
                    const userPublicKey = options.userPublicKey;
                    const userPassword = options.userPassword;
                    const encryptionType = data.meta.encryptionType;
                    
                    if (!userPublicKey) {
                        throw new Error('User public key required for decryption');
                    }
                    
                    let decryptionResult;
                    
                    if (encryptionType === 'organization') {
                        // Use organization decryption
                        const { OrganizationEncryption } = require('./organizationEncryption');
                        const orgEncryption = new OrganizationEncryption();
                        
                        try {
                            // For organization decryption, we need to pass request info for membership validation
                            decryptionResult = await orgEncryption.decryptWithOrganizationKey(data, userPublicKey);
                        } catch (orgError) {
                            throw new Error(`Organization decryption failed: ${orgError.message}`);
                        }
                        
                    } else if (encryptionType === 'per-user' || data.meta.encryptedBy) {
                        // Use per-user decryption
                        const encryptedBy = data.meta.encryptedBy;
                        
                        if (encryptedBy && encryptedBy !== userPublicKey) {
                            throw new Error(`Cannot decrypt record: encrypted by ${encryptedBy.slice(0, 12)}..., but you are ${userPublicKey.slice(0, 12)}...`);
                        }
                        
                        let decryptionKey;
                        
                        if (userPassword) {
                            try {
                                const { getUserGunEncryptionSalt, generateUserEncryptionKey } = require('../../routes/daemon/user');
                                const userSalt = await getUserGunEncryptionSalt(userPublicKey, userPassword);
                                decryptionKey = generateUserEncryptionKey(userPublicKey, userSalt);
                            } catch (error) {
                                decryptionKey = crypto.pbkdf2Sync(userPublicKey, 'oip-gun-fallback', 100000, 32, 'sha256');
                            }
                        } else {
                            decryptionKey = crypto.pbkdf2Sync(userPublicKey, 'oip-gun-fallback', 100000, 32, 'sha256');
                        }

                        const iv = Buffer.from(data.data.iv, 'base64');
                        const tag = Buffer.from(data.data.tag, 'base64');
                        const encryptedBuf = Buffer.from(data.data.encrypted, 'base64');
                        const decipher = crypto.createDecipheriv('aes-256-gcm', decryptionKey, iv);
                        decipher.setAuthTag(tag);

                        const dec = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
                        const decryptedData = JSON.parse(dec.toString('utf8'));
                        
                        decryptionResult = {
                            data: decryptedData,
                            meta: {
                                ...data.meta,
                                encrypted: false,
                                wasEncrypted: true,
                                decryptedBy: userPublicKey
                            },
                            oip: data.oip
                        };
                        
                    } else {
                        // Legacy encryption without type metadata
                        const legacyKey = crypto.pbkdf2Sync('gun-encryption-key', 'salt', 100000, 32, 'sha256');
                        
                        const iv = Buffer.from(data.data.iv, 'base64');
                        const tag = Buffer.from(data.data.tag, 'base64');
                        const encryptedBuf = Buffer.from(data.data.encrypted, 'base64');
                        const decipher = crypto.createDecipheriv('aes-256-gcm', legacyKey, iv);
                        decipher.setAuthTag(tag);

                        const dec = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
                        const decryptedData = JSON.parse(dec.toString('utf8'));
                        
                        decryptionResult = {
                            data: decryptedData,
                            meta: {
                                ...data.meta,
                                encrypted: false,
                                wasEncrypted: true,
                                isLegacyEncryption: true
                            },
                            oip: data.oip
                        };
                    }

                    // Return the decrypted data with metadata
                    return {
                        ...decryptionResult,
                        _: data._ // Keep any other GUN metadata if needed
                    };
                }

                // console.log('✅ GUN record retrieved successfully via HTTP API');

                // Parse JSON strings back to objects (data and oip are stored as strings to avoid nested nodes)
                if (typeof data.data === 'string') {
                    try {
                        data.data = JSON.parse(data.data);
                    } catch (e) {
                        console.warn('⚠️ Failed to parse data JSON string, keeping as-is');
                    }
                }
                if (typeof data.oip === 'string') {
                    try {
                        data.oip = JSON.parse(data.oip);
                    } catch (e) {
                        console.warn('⚠️ Failed to parse oip JSON string, keeping as-is');
                    }
                }
                // Note: oip.creator is already an object after parsing oip (single serialization)

                // Handle GUN reference objects - GUN sometimes returns { '#': 'path' } instead of actual data
                // This can happen with nested data structures or when data isn't fully loaded
                if (data.data && typeof data.data === 'object' && data.data['#'] && !data.meta?.wasEncrypted) {
                    // For now, return the data as-is since we can't easily resolve references via HTTP API
                    // The frontend will need to handle this case
                    return data;
                }

                return data;
            } else {
                return null; // Record not found
            }

                    // Success - exit retry loop
                    return response.data.success ? response.data.data : null;
                } catch (error) {
                    lastError = error;
                    retryCount++;
                    
                    // CRITICAL FIX: Check status code BEFORE nulling response
                    const is404 = error.response && error.response.status === 404;
                    const statusCode = error.response?.status;
                    
                    // MEMORY LEAK FIX: Clean up error response buffers immediately
                    if (error.response) {
                        error.response.data = null;
                        error.response = null;
                    }
                    
                    // If 404, don't retry - record doesn't exist
                    if (is404) {
                        // Track this 404 to avoid future retries
                        if (!this.missing404Cache) {
                            this.missing404Cache = new Map();
                        }
                        this.missing404Cache.set(soul, Date.now());
                        
                        // Limit cache size to prevent memory growth
                        if (this.missing404Cache.size > 10000) {
                            const oldestKey = this.missing404Cache.keys().next().value;
                            this.missing404Cache.delete(oldestKey);
                        }
                        
                        return null;
                    }
                    
                    // For other errors, retry with backoff
                    if (retryCount < maxRetries) {
                        const backoffMs = Math.pow(2, retryCount) * 100; // 200ms, 400ms
                        await new Promise(resolve => setTimeout(resolve, backoffMs));
                    }
                }
            }
            
            // If we exhausted retries, log but don't crash
            if (lastError) {
                console.error(`⚠️  Error in getRecord after ${maxRetries} retries:`, lastError.message);
                
                // MEMORY LEAK FIX: Force GC after repeated failures
                if (global.gc) {
                    setImmediate(() => global.gc());
                }
                
                return null; // Return null instead of throwing
            }
            
        } catch (error) {
            console.error('❌ Unexpected error in getRecord:', error.message);
            
            // MEMORY LEAK FIX: Clean up any remaining buffers
            if (error.response) {
                error.response.data = null;
                error.response = null;
            }
            
            return null; // Return null instead of throwing
        }
    }

    /**
     * List user records (alias for listRecordsByPublisher for API compatibility)
     * @param {string} publisherPubKey - Publisher's public key
     * @param {Object} options - Query options
     * @param {number} options.limit - Maximum number of records to return
     * @param {number} options.offset - Offset for pagination
     * @param {string} options.recordType - Filter by record type
     * @returns {Promise<Array>} - Array of records
     */
    async listUserRecords(publisherPubKey, options = {}) {
        return this.listRecordsByPublisher(publisherPubKey, options);
    }

    /**
     * List records by publisher
     * @param {string} publisherPubKey - Publisher's public key
     * @param {Object} options - Query options
     * @param {number} options.limit - Maximum number of records to return
     * @param {number} options.offset - Offset for pagination
     * @param {string} options.recordType - Filter by record type
     * @returns {Promise<Array>} - Array of records
     */
    async listRecordsByPublisher(publisherPubKey, options = {}) {
        const { limit = 50, offset = 0, recordType } = options;
        
        try {
            // Create hash of the public key (first 12 chars) to match GUN soul format
            const pubKeyHash = crypto.createHash('sha256')
                .update(publisherPubKey)
                .digest('hex')
                .slice(0, 12);

            const response = await axios.get(`${this.apiUrl}/list`, {
                params: { 
                    publisherHash: pubKeyHash,
                    limit,
                    offset,
                    recordType
                },
                timeout: 10000,
                headers: {
                    'Content-Type': 'application/json'
                },
                // Explicitly use global agents (don't create new ones per request)
                httpAgent: axios.defaults.httpAgent,
                httpsAgent: axios.defaults.httpsAgent
            });

            if (response.data.success) {
                const records = response.data.records || [];
                
                // Process and decrypt records as needed
                const processedRecords = await Promise.all(records.map(async (record) => {
                    // Handle encrypted data if present
                    if (record.meta && record.meta.encrypted && record.meta.encryptionMethod === 'aes-256-gcm') {
                        const key = crypto.scryptSync('gun-encryption-key', 'salt', 32);
                        const iv = Buffer.from(record.data.iv, 'hex');
                        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
                        
                        let decrypted = decipher.update(record.data.encrypted, 'hex', 'utf8');
                        decrypted += decipher.final('utf8');
                        
                        record.data = JSON.parse(decrypted);
                        record.meta.encrypted = false;
                    }
                    
                    return {
                        soul: record.soul,
                        did: `did:gun:${record.soul}`,
                        ...record
                    };
                }));

                return processedRecords;
            } else {
                return [];
            }

        } catch (error) {
            if (error.code === 'ECONNREFUSED') {
                console.error('GUN relay not accessible - check if gun-relay service is running');
                return [];
            } else if (error.code === 'ETIMEDOUT') {
                console.error('GUN relay timeout - service may be overloaded');
                return [];
            } else {
                console.error('❌ Error listing records by publisher:', error.message);
                return [];
            }
        }
    }

    /**
     * Delete record from GUN
     * @param {string} soul - The GUN soul to delete
     * @returns {Promise<boolean>} - Success status
     */
    async deleteRecord(soul) {
        this.deletionStats.totalAttempts++;
        
        // CRITICAL FIX: Check deletion failure cache - skip if failed multiple times
        const cachedFailure = this.deletionFailureCache.get(soul);
        if (cachedFailure) {
            // If it's failed 3+ times, skip silently to prevent log spam and buffer accumulation
            if (cachedFailure.count >= 3) {
                this.deletionStats.cachedSkips++;
                
                // Log stats every 10 skips
                if (this.deletionStats.cachedSkips % 10 === 0) {
                    console.log(`📊 [GUN Delete Stats] Attempts: ${this.deletionStats.totalAttempts}, Skipped (cached failures): ${this.deletionStats.cachedSkips}`);
                }
                
                // Return true to indicate "handled" (not actually deleted, but prevents retry loop)
                return true;
            }
        }
        
        try {
            // Use HTTP API to delete (put null to the soul)
            const response = await axios.post(`${this.apiUrl}/put`, {
                soul: soul,
                data: null  // Setting to null deletes the record in GUN
            }, {
                timeout: 10000,
                headers: { 'Content-Type': 'application/json' }
            });

            if (response.data && response.data.success) {
                // Success! Remove from failure cache if it was there
                this.deletionFailureCache.delete(soul);
                return true;
            } else {
                throw new Error(response.data.error || 'Failed to delete record');
            }
        } catch (error) {
            // MEMORY LEAK FIX: Clean up error response buffers immediately
            if (error.response) {
                error.response.data = null;
                error.response = null;
            }
            
            // If record doesn't exist (404), that's fine - already deleted
            if (error.response && error.response.status === 404) {
                this.deletionFailureCache.delete(soul);
                return true;
            }
            
            // Track the failure
            const failureRecord = cachedFailure || { count: 0, lastAttempt: 0, error: '' };
            failureRecord.count++;
            failureRecord.lastAttempt = Date.now();
            failureRecord.error = error.message;
            this.deletionFailureCache.set(soul, failureRecord);
            this.deletionStats.failures++;
            
            // Only log the FIRST failure, then cache prevents log spam
            if (failureRecord.count === 1) {
                console.error(`Error in deleteRecord (${soul}):`, error.message);
            }
            
            throw error;
        }
    }

    /**
     * Check if GUN relay is accessible
     * @returns {Promise<boolean>} - Connection status
     */
    async checkConnection() {
        try {
            // Test basic GUN functionality
            const testSoul = `test:connection:${Date.now()}`;
            const testData = { test: true, timestamp: Date.now() };
            
            const result = await new Promise((resolve) => {
                const timeout = setTimeout(() => resolve(false), 3000);
                
                this.gun.get(testSoul).put(testData, (ack) => {
                    clearTimeout(timeout);
                    resolve(!ack.err);
                });
            });
            
            if (result) {
                // Clean up test data
                this.gun.get(testSoul).put(null);
            }
            
            return result;
        } catch (error) {
            console.error('GUN connection check failed:', error);
            return false;
        }
    }
}

module.exports = { GunHelper };
