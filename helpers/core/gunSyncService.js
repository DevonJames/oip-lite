/**
 * GUN Record Synchronization Service
 * Handles discovery, format conversion, and indexing of GUN records from other OIP nodes
 * Supports both public and private (encrypted) records
 */

const { OIPGunRegistry } = require('./oipGunRegistry');
const { PrivateRecordHandler } = require('./privateRecordHandler');
const { GunDeletionRegistry } = require('./gunDeletionRegistry');
const { processRecordForElasticsearch, indexRecord, elasticClient } = require('./elasticsearch');
const { defaultTemplates } = require('../../config/templates.config');
const memoryDiagnostics = require('./memoryDiagnostics');

class GunSyncService {
    constructor() {
        this.registry = new OIPGunRegistry();
        this.privateHandler = new PrivateRecordHandler();
        this.deletionRegistry = new GunDeletionRegistry(this.registry.gunHelper);
        this.isRunning = false;
        this.syncInterval = parseInt(process.env.GUN_SYNC_INTERVAL) || 900000; // 15 minutes default (was 5 min - testing memory correlation)
        this.processedRecords = new Set(); // Track processed records to avoid duplicates
        this.healthMonitor = new SyncHealthMonitor();
        
        // MEMORY LEAK FIX: Track permanently failed records to prevent infinite retry loops
        this.permanentlyFailedRecords = new Set();
        
        // Memory management: Clear cache every hour to prevent memory leaks
        this.cacheMaxAge = parseInt(process.env.GUN_CACHE_MAX_AGE) || 3600000; // 1 hour default
        this.lastCacheClear = Date.now();
        
        // HTTP-based peer sync configuration (since WebSocket sync doesn't work reliably)
        this.peerNodes = this.parsePeerNodes();
        this.httpSyncEnabled = this.peerNodes.length > 0;
        
        console.log('🚀 GUN Sync Service initialized:', {
            syncInterval: this.syncInterval,
            cacheMaxAge: this.cacheMaxAge,
            nodeId: this.registry.nodeId,
            httpSyncEnabled: this.httpSyncEnabled,
            peerCount: this.peerNodes.length,
            deletionRegistryEnabled: true
        });
    }
    
    /**
     * Get record types to sync based on configuration
     * Uses RECORD_TYPE_INDEX_MODE and RECORD_TYPE_INDEX_WHITELIST/BLACKLIST from .env
     */
    getRecordTypesToSync() {
        const mode = process.env.RECORD_TYPE_INDEX_MODE || 'all';
        const allTypes = Object.keys(defaultTemplates);
        
        if (mode === 'all') {
            return allTypes;
        } else if (mode === 'whitelist') {
            const whitelist = process.env.RECORD_TYPE_INDEX_WHITELIST || '';
            const types = whitelist.split(',').map(t => t.trim()).filter(t => t);
            return types.length > 0 ? types : allTypes;
        } else if (mode === 'blacklist') {
            const blacklist = process.env.RECORD_TYPE_INDEX_BLACKLIST || '';
            const excludeTypes = new Set(blacklist.split(',').map(t => t.trim()).filter(t => t));
            return allTypes.filter(t => !excludeTypes.has(t));
        }
        
        return allTypes;
    }
    
    /**
     * Parse peer nodes from environment variables for HTTP-based sync
     * Converts WebSocket URLs to HTTP URLs
     */
    parsePeerNodes() {
        const gunPeers = process.env.GUN_EXTERNAL_PEERS || process.env.GUN_PEERS || '';
        if (!gunPeers) {
            return [];
        }
        
        return gunPeers.split(',')
            .map(peer => peer.trim())
            .filter(peer => peer)
            .map(peer => {
                // If peer already has /gun-relay path (for public API proxy), use as-is
                if (peer.includes('/gun-relay')) {
                    return peer
                        .replace('ws://', 'http://')
                        .replace('wss://', 'https://');
                }
                
                // Convert ws://host:port/gun to http://host:port/gun-relay (for proxy)
                const httpUrl = peer
                    .replace('ws://', 'http://')
                    .replace('wss://', 'https://')
                    .replace('/gun', '/gun-relay');
                return httpUrl;
            });
    }
    
    /**
     * Start the sync service
     */
    async start() {
        if (this.isRunning) {
            return;
        }
        
        this.isRunning = true;
        
        try {
            // Initial discovery and migration of existing records
            await this.migrateExistingRecords();
            
            // Perform initial sync
            await this.performSync();
            
            // Set up periodic sync
            this.syncTimer = setInterval(async () => {
                await this.performSync();
            }, this.syncInterval);
            
        } catch (error) {
            this.isRunning = false;
            throw error;
        }
    }
    
    /**
     * Stop the sync service
     */
    stop() {
        if (!this.isRunning) {
            return;
        }
        
        this.isRunning = false;
        
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }
    }
    
    /**
     * Perform a sync cycle
     */
    async performSync() {
        const startTime = Date.now();
        const endTracking = memoryDiagnostics.trackOperation('gun_sync', 'Full sync cycle');
        
        try {
            // Memory management: Periodically clear the cache to prevent memory leaks
            const timeSinceLastClear = Date.now() - this.lastCacheClear;
            if (timeSinceLastClear >= this.cacheMaxAge) {
                this.clearProcessedCache();
                this.lastCacheClear = Date.now();
            }
            
            let discoveredRecords = [];
            
            // Try HTTP-based sync first if enabled (more reliable than WebSocket)
            if (this.httpSyncEnabled) {
                const httpRecords = await this.syncFromPeersViaHTTP();
                discoveredRecords = discoveredRecords.concat(httpRecords);
            }
            
            // Also try WebSocket-based discovery (fallback)
            const wsRecords = await this.privateHandler.discoverPrivateRecords();
            discoveredRecords = discoveredRecords.concat(wsRecords);
            
            // Deduplicate by soul
            const seenSouls = new Set();
            discoveredRecords = discoveredRecords.filter(record => {
                if (seenSouls.has(record.soul)) {
                    return false;
                }
                seenSouls.add(record.soul);
                return true;
            });
            
            // Filter out records that are marked as deleted in the deletion registry
            const filteredRecords = [];
            let deletedCount = 0;
            
            for (const record of discoveredRecords) {
                const did = `did:gun:${record.soul}`;
                
                // MEMORY LEAK FIX: Skip permanently failed records to prevent infinite retry loops
                if (this.permanentlyFailedRecords.has(did)) {
                    continue;
                }
                
                const isDeleted = await this.deletionRegistry.isDeleted(did);
                
                if (isDeleted) {
                    deletedCount++;
                    
                    // If we have it locally, remove it (in case it was synced before deletion)
                    await this.deletionRegistry.processLocalDeletion(did);
                    continue;
                }
                
                filteredRecords.push(record);
            }
            
            if (deletedCount > 0) {
                console.log(`✅ Filtered ${deletedCount} deleted records`);
            }
            
            discoveredRecords = filteredRecords;
            
            let syncedCount = 0;
            let errorCount = 0;
            
            for (const discoveredRecord of discoveredRecords) {
                try {
                    const success = await this.processDiscoveredRecord(discoveredRecord);
                    if (success) {
                        syncedCount++;
                    } else {
                        errorCount++;
                        const did = `did:gun:${discoveredRecord.soul}`;
                        
                        // MEMORY LEAK FIX: Mark as permanently failed after first attempt
                        // These are usually schema mismatch errors that will never resolve
                        this.permanentlyFailedRecords.add(did);
                        console.error(`❌ GUN sync failed for ${did} - marked as permanently failed (will not retry)`);
                        
                        // Force GC to clean up any buffers from this failed attempt
                        if (global.gc) {
                            setImmediate(() => global.gc());
                        }
                    }
                } catch (error) {
                    errorCount++;
                    const did = `did:gun:${discoveredRecord.soul}`;
                    
                    // MEMORY LEAK FIX: Mark as permanently failed
                    this.permanentlyFailedRecords.add(did);
                    console.error(`❌ GUN sync error for ${did}:`, error.message, '- marked as permanently failed');
                    
                    // Force GC to clean up any buffers from this failed attempt
                    if (global.gc) {
                        setImmediate(() => global.gc());
                    }
                }
            }
            
            const duration = Date.now() - startTime;
            this.healthMonitor.recordSyncCycle(discoveredRecords.length, syncedCount, errorCount, duration);
            
            // Only log if there was activity
            if (syncedCount > 0 || errorCount > 0) {
                console.log(`✅ GUN sync: ${syncedCount} synced, ${errorCount} errors (${Math.round(duration/1000)}s)`);
            }
            
            // MEMORY LEAK FIX: Aggressive cleanup after sync completes
            discoveredRecords = null;
            
            // Force garbage collection if available and sync took >1 minute
            if (global.gc && duration > 60000) {
                setImmediate(() => global.gc());
            }
            
        } catch (error) {
            console.error('❌ GUN sync error:', error.message);
            this.healthMonitor.recordSyncCycle(0, 0, 1, Date.now() - startTime);
        } finally {
            // Track memory at the end of the sync cycle (success or failure)
            await endTracking();
        }
    }
    
    /**
     * Sync records from peer nodes via HTTP (bypassing unreliable WebSocket sync)
     * @returns {Array} Array of discovered records
     */
    async syncFromPeersViaHTTP() {
        const axios = require('axios');
        const discoveredRecords = [];
        
        // Get all record types to sync from peers
        const recordTypes = this.getRecordTypesToSync();
        
        // MEMORY LEAK FIX: Track and limit concurrent requests to prevent buffer accumulation
        let requestCount = 0;
        const MAX_CONCURRENT_REQUESTS = 5;
        
        for (const peerUrl of this.peerNodes) {
            try {
                for (const recordType of recordTypes) {
                    try {
                        // Fetch registry index for this record type from peer
                        const indexSoul = `oip:registry:index:${recordType}`;
                        const response = await axios.get(`${peerUrl}/get`, {
                            params: { soul: indexSoul },
                            timeout: 5000,
                            // MEMORY LEAK FIX: Explicitly use global HTTP agents
                            httpAgent: axios.defaults.httpAgent,
                            httpsAgent: axios.defaults.httpsAgent
                        });
                        
                        requestCount++;
                        
                        if (response.data && response.data.success && response.data.data) {
                            // MEMORY LEAK FIX: Extract only what we need, don't deep clone large objects
                            const peerIndex = response.data.data;
                            
                            // Process each entry in the peer's registry index
                            for (const [soul, entry] of Object.entries(peerIndex)) {
                                // Skip GUN metadata properties
                                if (soul.startsWith('_') || soul.startsWith('#')) {
                                    continue;
                                }
                                
                                // Handle both direct entries and GUN node references
                                let recordSoul = soul; // Default: use the key as the soul
                                
                                if (entry && typeof entry === 'object') {
                                    if (entry.soul) {
                                        // Direct entry with soul property
                                        recordSoul = entry.soul;
                                    } else if (entry['#']) {
                                        // GUN node reference - the soul is the key itself
                                        // We'll fetch the actual record, not the registry entry
                                        recordSoul = soul;
                                    } else {
                                        // Unknown structure, skip
                                        console.warn(`⚠️ Unknown registry entry structure for ${soul}`);
                                        continue;
                                    }
                                }
                                
                                const did = `did:gun:${recordSoul}`;
                                
                                // Skip if we already have this record
                                if (this.processedRecords.has(did)) {
                                    continue;
                                }
                                
                                // Check if we already have this record in Elasticsearch
                                const exists = await this.checkRecordExists(did);
                                if (exists) {
                                    this.processedRecords.add(did);
                                    continue;
                                }
                                
                                // Fetch the actual record from peer
                                const recordResponse = await axios.get(`${peerUrl}/get`, {
                                    params: { soul: recordSoul },
                                    timeout: 10000,
                                    // MEMORY LEAK FIX: Explicitly use global HTTP agents
                                    httpAgent: axios.defaults.httpAgent,
                                    httpsAgent: axios.defaults.httpsAgent
                                });
                                
                                requestCount++;
                                
                                if (recordResponse.data && recordResponse.data.success && recordResponse.data.data) {
                                    // MEMORY LEAK FIX: Extract only what we need
                                    const fetchedData = recordResponse.data.data;
                                    
                                    // Parse JSON strings back to objects (data and oip are stored as strings in GUN)
                                    if (typeof fetchedData.data === 'string') {
                                        try {
                                            fetchedData.data = JSON.parse(fetchedData.data);
                                        } catch (e) {
                                            console.warn(`⚠️ Failed to parse data JSON for ${did}`);
                                        }
                                    }
                                    if (typeof fetchedData.oip === 'string') {
                                        try {
                                            fetchedData.oip = JSON.parse(fetchedData.oip);
                                        } catch (e) {
                                            console.warn(`⚠️ Failed to parse oip JSON for ${did}`);
                                        }
                                    }
                                    // Note: oip.creator is already an object after parsing oip (single serialization)
                                    
                                    discoveredRecords.push({
                                        soul: recordSoul,
                                        data: fetchedData,
                                        sourceNodeId: entry.nodeId || 'unknown',
                                        wasEncrypted: false // HTTP sync is for public records
                                    });
                                }
                                
                                // MEMORY LEAK FIX: Force GC every MAX_CONCURRENT_REQUESTS to prevent buffer accumulation
                                if (global.gc && requestCount % MAX_CONCURRENT_REQUESTS === 0) {
                                    setImmediate(() => global.gc());
                                }
                            }
                        }
                    } catch (typeError) {
                        // Silently skip record types that don't exist on peer or timeout
                        if (typeError.response && typeError.response.status === 404) {
                            continue;
                        }
                        // Skip timeout and network errors (common and not critical)
                        if (typeError.code === 'ECONNABORTED' || typeError.code === 'ETIMEDOUT' || 
                            typeError.code === 'EAI_AGAIN' || typeError.message.includes('timeout')) {
                            continue;
                        }
                        // Only log unexpected errors
                        console.error(`❌ Error syncing ${recordType} from ${peerUrl}:`, typeError.message);
                    }
                }
            } catch (peerError) {
                // Only log non-network errors
                if (peerError.code !== 'ECONNABORTED' && peerError.code !== 'ETIMEDOUT' && 
                    peerError.code !== 'EAI_AGAIN' && !peerError.message.includes('timeout')) {
                    console.error(`❌ Error syncing from peer ${peerUrl}:`, peerError.message);
                }
            }
        }
        
        // MEMORY LEAK FIX: Always force GC after HTTP sync to clean up request buffers
        if (global.gc && requestCount > 10) {
            setImmediate(() => global.gc());
        }
        
        return discoveredRecords;
    }
    
    /**
     * Check if a record already exists in Elasticsearch
     */
    async checkRecordExists(did) {
        try {
            const result = await elasticClient.exists({
                index: 'records',
                id: did
            });
            return result;
        } catch (error) {
            return false;
        }
    }
    
    /**
     * Process a discovered record: convert format and index to Elasticsearch
     * @param {Object} discoveredRecord - The discovered record with metadata
     * @returns {boolean} True if successfully processed
     */
    async processDiscoveredRecord(discoveredRecord) {
        try {
            const { soul, data, sourceNodeId, wasEncrypted } = discoveredRecord;
            const did = `did:gun:${soul}`;
            
            // Skip if already processed in this session
            if (this.processedRecords.has(did)) {
                return false;
            }
            
            // Validate the record structure
            if (!this.registry.isValidOIPRecord(data)) {
                console.warn(`⚠️ Invalid OIP record structure for ${did}, skipping`);
                return false;
            }
            
            // Convert GUN record format to Elasticsearch format
            const elasticsearchRecord = this.convertGunRecordForElasticsearch(data, did, wasEncrypted, sourceNodeId);
            
            // Check if record already exists (avoid duplicates)
            const exists = await elasticClient.exists({
                index: 'records',
                id: did
            });
            
            if (exists.body) {
                this.processedRecords.add(did);
                return false;
            }
            
            // Store to local GUN database (so it can be queried and synced to other nodes)
            try {
                await this.registry.gunHelper.putRecord(data, soul, {
                    localId: soul.split(':')[1] || null,
                    encrypt: wasEncrypted
                });
            } catch (gunError) {
                // Continue with Elasticsearch even if GUN storage fails
            }
            
            // Index to Elasticsearch using existing indexRecord function
            await indexRecord(elasticsearchRecord);
            
            // Register in local registry (so other nodes can discover it)
            try {
                const recordType = data.oip?.recordType;
                const creatorPubKey = data.oip?.creator?.publicKey;
                if (recordType && creatorPubKey) {
                    await this.registry.registerOIPRecord(did, soul, recordType, creatorPubKey);
                }
            } catch (registryError) {
                // Ignore registry errors
            }
            
            // Mark as processed
            this.processedRecords.add(did);
            return true;
            
        } catch (error) {
            return false;
        }
    }
    
    /**
     * Convert GUN record format to Elasticsearch-compatible format
     * This handles the critical array conversion: JSON strings → actual arrays
     * @param {Object} gunRecord - The GUN record data
     * @param {string} did - The record DID
     * @param {boolean} wasEncrypted - Whether the record was encrypted
     * @param {string} sourceNodeId - Source node identifier
     * @returns {Object} Elasticsearch-compatible record
     */
    convertGunRecordForElasticsearch(gunRecord, did, wasEncrypted = false, sourceNodeId = null) {
        // Extract only the data and oip fields (strip GUN metadata)
        const elasticsearchRecord = {
            data: JSON.parse(JSON.stringify(gunRecord.data)),
            oip: JSON.parse(JSON.stringify(gunRecord.oip))
        };
        
        // Set the unified DID and storage metadata
        elasticsearchRecord.oip.did = did;
        elasticsearchRecord.oip.didTx = did; // Backward compatibility
        elasticsearchRecord.oip.storage = 'gun';
        
        // Note: GUN data/oip are already parsed from strings by the time they reach here
        // (either by gunHelper.getRecord() or by peer sync parsing)
        
        // Handle flattened creator format for backward compatibility
        if (elasticsearchRecord.oip.creator_publicKey && elasticsearchRecord.oip.creator_didAddress) {
            elasticsearchRecord.oip.creator = {
                publicKey: elasticsearchRecord.oip.creator_publicKey,
                didAddress: elasticsearchRecord.oip.creator_didAddress
            };
            // Clean up flattened fields
            delete elasticsearchRecord.oip.creator_publicKey;
            delete elasticsearchRecord.oip.creator_didAddress;
        }
        
        // Add sync metadata
        if (wasEncrypted) {
            elasticsearchRecord.oip.wasEncrypted = true;
            elasticsearchRecord.oip.syncedFromNode = sourceNodeId;
            elasticsearchRecord.oip.syncedAt = new Date().toISOString();
        }
        
        // Convert JSON string arrays back to actual arrays using existing function
        // This is critical for maintaining data format consistency
        return processRecordForElasticsearch(elasticsearchRecord);
    }
    
    /**
     * Register a locally created record in the registry
     * @param {string} recordDid - The record DID
     * @param {string} soul - The GUN soul
     * @param {string} recordType - The record type
     * @param {string} creatorPubKey - Creator's public key
     */
    async registerLocalRecord(recordDid, soul, recordType, creatorPubKey) {
        try {
            await this.registry.registerOIPRecord(recordDid, soul, recordType, creatorPubKey);
        } catch (error) {
            // Ignore registration errors
        }
    }
    
    /**
     * Migrate existing GUN records to the registry system
     */
    async migrateExistingRecords() {
        try {
            // Wait for gun-relay to be ready before attempting migration
            let gunReady = false;
            let attempts = 0;
            const maxAttempts = 30; // 30 seconds max wait
            
            while (!gunReady && attempts < maxAttempts) {
                try {
                    await this.registry.gunHelper.getRecord('test:startup');
                    gunReady = true;
                } catch (error) {
                    attempts++;
                    if (attempts < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
                    } else {
                        return;
                    }
                }
            }
            
            // Get all existing GUN records from local Elasticsearch
            const existingGunRecords = await elasticClient.search({
                index: 'records',
                body: {
                    query: {
                        bool: {
                            should: [
                                { prefix: { "oip.did": "did:gun:" } },
                                { prefix: { "oip.didTx": "did:gun:" } }
                            ]
                        }
                    }
                },
                size: 10000
            });
            
            let registeredCount = 0;
            let skippedCount = 0;
            const records = existingGunRecords.hits.hits;
            
            for (const hit of records) {
                const record = hit._source;
                
                // Validate record structure before attempting to register
                // Skip records with missing or invalid OIP metadata
                if (!record.oip || !record.oip.recordType || !record.oip.creator || !record.oip.creator.publicKey) {
                    skippedCount++;
                    continue;
                }
                
                const did = record.oip.did || record.oip.didTx;
                if (!did || !did.startsWith('did:gun:')) {
                    skippedCount++;
                    continue;
                }
                
                const soul = did.replace('did:gun:', '');
                if (!soul || soul.length === 0) {
                    skippedCount++;
                    continue;
                }
                
                try {
                    // IMPORTANT: Only register if the record actually exists in GUN
                    // (Migration should not register records that only exist in Elasticsearch)
                    const gunRecord = await this.registry.gunHelper.getRecord(soul);
                    if (!gunRecord || !gunRecord.data) {
                        // Record doesn't exist in GUN, skip registration
                        skippedCount++;
                        continue;
                    }
                    
                    // Register in the GUN registry for discovery by other nodes
                    await this.registry.registerOIPRecord(
                        did,
                        soul,
                        record.oip.recordType,
                        record.oip.creator.publicKey
                    );
                    
                    registeredCount++;
                    
                } catch (error) {
                    skippedCount++;
                }
            }
            
            if (registeredCount > 0) {
                console.log(`✅ GUN migration: ${registeredCount} records registered`);
            }
            
        } catch (error) {
            // Ignore migration errors
        }
    }
    
    /**
     * Get sync service status and health information
     * @returns {Object} Status information
     */
    getStatus() {
        const memUsage = process.memoryUsage();
        const timeSinceLastClear = Date.now() - this.lastCacheClear;
        
        return {
            isRunning: this.isRunning,
            syncInterval: this.syncInterval,
            nodeId: this.registry.nodeId,
            processedRecordsCount: this.processedRecords.size,
            health: this.healthMonitor.getHealthStatus(),
            configuration: {
                privateRecordsEnabled: this.privateHandler.decryptionEnabled,
                trustedNodes: this.privateHandler.trustedNodes,
                cacheMaxAge: this.cacheMaxAge,
                cacheMaxAgeMinutes: Math.round(this.cacheMaxAge / 60000)
            },
            memory: {
                heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
                heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
                rssMB: Math.round(memUsage.rss / 1024 / 1024),
                externalMB: Math.round(memUsage.external / 1024 / 1024),
                cacheSize: this.processedRecords.size,
                timeSinceLastClearMinutes: Math.round(timeSinceLastClear / 60000),
                nextClearInMinutes: Math.round((this.cacheMaxAge - timeSinceLastClear) / 60000)
            }
        };
    }
    
    /**
     * Get health monitor instance for external access
     * @returns {SyncHealthMonitor} Health monitor instance
     */
    getHealthMonitor() {
        return this.healthMonitor;
    }
    
    /**
     * Force a sync cycle (for manual triggering)
     */
    async forceSync() {
        if (!this.isRunning) {
            throw new Error('Sync service is not running');
        }
        
        await this.performSync();
    }
    
    /**
     * Clear processed records cache (for testing or reset)
     */
    clearProcessedCache() {
        this.processedRecords.clear();
        
        // MEMORY LEAK FIX: Limit permanently failed records to prevent unbounded growth
        // Keep only last 1000 failed records
        if (this.permanentlyFailedRecords.size > 1000) {
            const failedArray = Array.from(this.permanentlyFailedRecords);
            this.permanentlyFailedRecords.clear();
            // Keep only most recent 500
            failedArray.slice(-500).forEach(did => this.permanentlyFailedRecords.add(did));
        }
    }
}

/**
 * Sync service health monitoring
 */
class SyncHealthMonitor {
    constructor() {
        this.metrics = {
            totalDiscovered: 0,
            totalSynced: 0,
            totalErrors: 0,
            lastSyncTime: null,
            averageSyncTime: 0,
            syncCycles: 0
        };
    }
    
    recordSyncCycle(discovered, synced, errors, duration) {
        this.metrics.totalDiscovered += discovered;
        this.metrics.totalSynced += synced;
        this.metrics.totalErrors += errors;
        this.metrics.lastSyncTime = new Date();
        this.metrics.syncCycles++;
        
        // Update average sync time (exponential moving average)
        if (this.metrics.averageSyncTime === 0) {
            this.metrics.averageSyncTime = duration;
        } else {
            this.metrics.averageSyncTime = (this.metrics.averageSyncTime * 0.7) + (duration * 0.3);
        }
    }
    
    getHealthStatus() {
        const successRate = this.metrics.totalDiscovered > 0 
            ? (this.metrics.totalSynced / this.metrics.totalDiscovered) * 100 
            : 100;
            
        const isHealthy = successRate > 90 && 
                         this.metrics.totalErrors < 10 && 
                         this.metrics.lastSyncTime && 
                         (Date.now() - this.metrics.lastSyncTime.getTime()) < 120000; // Within last 2 minutes
            
        return {
            ...this.metrics,
            successRate: parseFloat(successRate.toFixed(2)),
            isHealthy,
            lastSyncAgo: this.metrics.lastSyncTime 
                ? Date.now() - this.metrics.lastSyncTime.getTime() 
                : null
        };
    }
    
    reset() {
        this.metrics = {
            totalDiscovered: 0,
            totalSynced: 0,
            totalErrors: 0,
            lastSyncTime: null,
            averageSyncTime: 0,
            syncCycles: 0
        };
    }
}

module.exports = { GunSyncService, SyncHealthMonitor };
