/**
 * OIP GUN Record Registry
 * Manages a distributed registry of OIP records across GUN network
 * Enables efficient discovery of OIP records from other nodes
 */

const { GunHelper } = require('./gun');
const { elasticClient } = require('./elasticsearch');
const { defaultTemplates } = require('../../config/templates.config');

class OIPGunRegistry {
    constructor() {
        this.gunHelper = new GunHelper();
        this.registryRoot = process.env.GUN_REGISTRY_ROOT || 'oip:registry';
        this.nodeId = this.generateNodeId();
        this.lastSyncTimestamp = 0;
        
        console.log('🏗️ OIP GUN Registry initialized:', {
            registryRoot: this.registryRoot,
            nodeId: this.nodeId
        });
    }
    
    generateNodeId() {
        // Generate unique node identifier based on server config
        const crypto = require('crypto');
        
        // Use override if provided
        if (process.env.GUN_NODE_ID_OVERRIDE) {
            return process.env.GUN_NODE_ID_OVERRIDE;
        }
        
        // Generate based on server info
        const serverInfo = `${process.env.HOSTNAME || 'unknown'}:${process.env.PORT || 3005}:${Date.now()}`;
        return crypto.createHash('sha256').update(serverInfo).digest('hex').slice(0, 16);
    }
    
    /**
     * Get record types based on configuration
     * Uses RECORD_TYPE_INDEX_MODE and RECORD_TYPE_INDEX_WHITELIST/BLACKLIST from .env
     */
    getRecordTypes() {
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
     * Register a new OIP record in the distributed registry
     * @param {string} recordDid - The DID of the record
     * @param {string} soul - The GUN soul identifier
     * @param {string} recordType - The type of record (post, conversationSession, etc.)
     * @param {string} creatorPubKey - Creator's public key
     */
    async registerOIPRecord(recordDid, soul, recordType, creatorPubKey) {
        try {
            // console.log(`📝 Registering OIP record in GUN registry: ${recordDid}`);
            
            const registryEntry = {
                did: recordDid,
                soul: soul,
                recordType: recordType,
                creatorPubKey: creatorPubKey,
                nodeId: this.nodeId,
                timestamp: Date.now(),
                oipVersion: '0.8.0'
            };
            
            // Register in node-specific registry (for detailed tracking)
            const nodeRegistryKey = `${this.registryRoot}:nodes:${this.nodeId}`;
            await this.gunHelper.putSimple(registryEntry, `${nodeRegistryKey}:${soul}`);
            
            // Register in global index for discovery
            const globalIndexKey = `${this.registryRoot}:index:${recordType}`;
            const indexEntry = {
                soul: soul,
                nodeId: this.nodeId,
                timestamp: Date.now()
            };
            
            // IMPORTANT: Update the parent index with all entries for this record type
            // This is what sync polls to discover records
            try {
                // Fetch current parent index
                const parentIndexData = await this.gunHelper.getRecord(globalIndexKey);
                // Extract the actual data object (may be wrapped or direct)
                let parentIndex = {};
                if (parentIndexData) {
                    if (parentIndexData.data && typeof parentIndexData.data === 'object') {
                        parentIndex = parentIndexData.data;
                    } else if (typeof parentIndexData === 'object' && !parentIndexData.success) {
                        // Direct object without wrapper
                        parentIndex = parentIndexData;
                    }
                }
                
                // Add this entry to the parent index
                parentIndex[soul] = indexEntry;
                
                // Store parent index as flat object (no data/oip/meta wrapper)
                await this.gunHelper.putSimple(parentIndex, globalIndexKey);
                
                console.log(`📝 Updated registry index ${globalIndexKey} with entry ${soul}`);
            } catch (parentError) {
                // If parent update fails, log but don't fail registration
                console.warn(`⚠️ Failed to update parent registry index ${globalIndexKey}: ${parentError.message}`);
            }
            
            // console.log('✅ Registered OIP record in GUN registry:', recordDid);
            
        } catch (error) {
            // Log concise error with DID for identification
            console.error(`❌ Failed to register OIP record ${recordDid}: ${error.message || error.code || 'Unknown error'}`);
            // Don't re-throw to avoid blocking other records from being registered
        }
    }
    
    /**
     * Unregister an OIP record from the distributed registry
     * Used when a record is deleted from the system
     * @param {string} recordDid - The DID of the record to unregister
     */
    async unregisterOIPRecord(recordDid) {
        try {
            // Extract soul from DID
            const soul = recordDid.replace('did:gun:', '');
            
            // Find the record type by checking each type's index
            const recordTypes = this.getRecordTypes();
            let foundType = null;
            
            for (const recordType of recordTypes) {
                const globalIndexKey = `${this.registryRoot}:index:${recordType}`;
                const typeIndex = await this.gunHelper.getRecord(globalIndexKey);
                
                if (typeIndex && typeIndex[soul]) {
                    foundType = recordType;
                    break;
                }
            }
            
            if (!foundType) {
                // Silently skip if not found
                return;
            }
            
            // Remove from node-specific registry
            const nodeRegistryKey = `${this.registryRoot}:nodes:${this.nodeId}`;
            const nodeEntryKey = `${nodeRegistryKey}:${soul}`;
            await this.gunHelper.deleteRecord(nodeEntryKey);
            
            // Remove from global index
            const globalIndexKey = `${this.registryRoot}:index:${foundType}`;
            const indexUpdate = { [soul]: null }; // Setting to null removes it from GUN
            await this.gunHelper.putSimple(indexUpdate, globalIndexKey);
            
        } catch (error) {
            // Only log unexpected errors
            if (!error.message.includes('not found')) {
                console.error(`❌ Failed to unregister ${recordDid}:`, error.message);
            }
            // Don't throw - unregister is best-effort
        }
    }
    
    /**
     * Discover OIP records from other nodes
     * @returns {Array} Array of discovered records with metadata
     */
    async discoverOIPRecords() {
        try {
            // console.log('🔍 Discovering OIP records from other nodes...'); // Commented out - too verbose
            const discoveredRecords = [];
            
            // Get record types from configuration
            const recordTypes = this.getRecordTypes();
            
            for (const recordType of recordTypes) {
                const typeRecords = await this.discoverRecordsOfType(recordType);
                discoveredRecords.push(...typeRecords);
            }
            
            // Only log if we discovered new records
            if (discoveredRecords.length > 0) {
                console.log(`🔍 Discovered ${discoveredRecords.length} new OIP records from other nodes`);
            }
            return discoveredRecords;
            
        } catch (error) {
            console.error('❌ Error discovering OIP records:', error);
            return [];
        }
    }
    
    /**
     * Discover records of a specific type
     * @param {string} recordType - The type of records to discover
     * @returns {Array} Array of discovered records of this type
     */
    async discoverRecordsOfType(recordType) {
        const typeRecords = [];
        
        try {
            const globalIndexKey = `${this.registryRoot}:index:${recordType}`;
            
            // Get all records of this type from registry
            // This read will trigger GUN WebSocket sync if peers are connected
            const typeIndexResponse = await this.gunHelper.getRecord(globalIndexKey);
            if (!typeIndexResponse) {
                // Registry index doesn't exist yet - this is normal for new record types
                return typeRecords;
            }
            
            // Extract the actual index data (getRecord returns { data, oip, meta } structure)
            const typeIndex = typeIndexResponse.data || typeIndexResponse;
            if (!typeIndex || typeof typeIndex !== 'object') {
                return typeRecords;
            }
            
            // Log discovery attempt for debugging
            const entryCount = Object.keys(typeIndex).filter(key => 
                !key.startsWith('oip:') && !key.startsWith('_')
            ).length;
            // Silent - this is normal operation
            
            for (const [soulKey, indexEntry] of Object.entries(typeIndex)) {
                // Skip metadata entries
                if (soulKey.startsWith('oip:') || soulKey.startsWith('_') || !indexEntry.soul) {
                    continue;
                }
                
                // Skip records from our own node
                if (indexEntry.nodeId === this.nodeId) {
                    continue;
                }
                
                // Check if we already have this record
                const recordExists = await this.checkRecordExists(indexEntry.soul);
                if (recordExists) {
                    continue;
                }
                
                // Fetch the actual record data
                const recordData = await this.gunHelper.getRecord(indexEntry.soul);
                if (this.isValidOIPRecord(recordData)) {
                    typeRecords.push({
                        soul: indexEntry.soul,
                        data: recordData,
                        sourceNodeId: indexEntry.nodeId,
                        discoveredAt: Date.now()
                    });
                    
                    console.log(`📥 Discovered ${recordType} record: ${recordData.oip?.did} from node ${indexEntry.nodeId}`);
                } else {
                    console.warn(`⚠️ Invalid OIP record structure for soul: ${indexEntry.soul}`);
                }
            }
            
        } catch (error) {
            console.error(`❌ Error discovering ${recordType} records:`, error);
        }
        
        return typeRecords;
    }
    
    /**
     * Validate that a record conforms to OIP structure
     * @param {Object} record - The record to validate
     * @returns {boolean} True if valid OIP record
     */
    isValidOIPRecord(record) {
        // Check basic OIP structure
        if (!record || !record.oip || !record.data) {
            // Silent - invalid records are common during sync
            return false;
        }
        
        // Check required OIP fields
        const oip = record.oip;
        if (!oip.ver || !oip.recordType || !oip.creator) {
            console.warn(`  ⚠️ Missing OIP fields: ver=${!!oip.ver}, recordType=${!!oip.recordType}, creator=${!!oip.creator}`);
            return false;
        }
        
        // Check version compatibility
        if (typeof oip.ver !== 'string' || !oip.ver.startsWith('0.8')) {
            console.warn(`  ⚠️ Version incompatible: ${oip.ver} (expected 0.8.x)`);
            return false;
        }
        
        // Check creator structure (supports object and flattened formats)
        const hasValidCreator = oip.creator && 
                                typeof oip.creator === 'object' && 
                                oip.creator.publicKey && 
                                oip.creator.didAddress;
        const hasFlatCreator = oip.creator_publicKey && oip.creator_didAddress;
        
        if (!hasValidCreator && !hasFlatCreator) {
            console.warn(`  ⚠️ Missing creator fields`);
            console.warn(`    Creator:`, oip.creator);
            console.warn(`    Flat fields: creator_publicKey=${!!oip.creator_publicKey}, creator_didAddress=${!!oip.creator_didAddress}`);
            return false;
        }
        
        return true;
    }
    
    /**
     * Check if we already have a record indexed locally
     * @param {string} soul - The GUN soul to check
     * @returns {boolean} True if record exists locally
     */
    async checkRecordExists(soul) {
        try {
            const did = `did:gun:${soul}`;
            const exists = await elasticClient.exists({
                index: 'records',
                id: did
            });
            return exists.body;
        } catch (error) {
            console.error(`Error checking if record exists for soul ${soul}:`, error);
            return false;
        }
    }
    
    /**
     * Get registry statistics for monitoring
     * @returns {Object} Registry statistics
     */
    async getRegistryStats() {
        try {
            const stats = {
                nodeId: this.nodeId,
                registryRoot: this.registryRoot,
                totalRecordsRegistered: 0,
                recordsByType: {}
            };
            
            // Get record types from configuration
            const recordTypes = this.getRecordTypes();
            
            for (const recordType of recordTypes) {
                const globalIndexKey = `${this.registryRoot}:index:${recordType}`;
                const typeIndex = await this.gunHelper.getRecord(globalIndexKey);
                
                if (typeIndex) {
                    const count = Object.keys(typeIndex).filter(key => 
                        !key.startsWith('oip:') && !key.startsWith('_')
                    ).length;
                    
                    stats.recordsByType[recordType] = count;
                    stats.totalRecordsRegistered += count;
                }
            }
            
            return stats;
            
        } catch (error) {
            console.error('Error getting registry stats:', error);
            return {
                nodeId: this.nodeId,
                error: error.message
            };
        }
    }
}

module.exports = { OIPGunRegistry };
