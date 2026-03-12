/**
 * GUN Deletion Registry
 * Tracks deleted GUN records across all OIP nodes
 * Prevents sync service from re-indexing intentionally deleted records
 */

const { elasticClient } = require('./elasticsearch');

class GunDeletionRegistry {
    constructor(gunHelper) {
        this.gunHelper = gunHelper;
        this.registryRoot = 'oip:deleted:records';
        this.indexSoul = `${this.registryRoot}:index`;
        
        // MEMORY LEAK FIX: Track recently processed deletions to avoid infinite loops
        // Map of DID -> timestamp of last processing
        this.recentlyProcessed = new Map();
        // Only reprocess deletions after 24 hours
        this.reprocessInterval = 24 * 60 * 60 * 1000; // 24 hours in ms
    }
    
    /**
     * Mark a GUN record as deleted
     * This creates an entry in the distributed deletion registry that syncs across all nodes
     * @param {string} did - The DID of the deleted record (e.g., "did:gun:647f79c2a338:record1")
     * @param {string} deletedBy - Public key of the user who deleted the record
     * @returns {Promise<boolean>} - Success status
     */
    async markDeleted(did, deletedBy) {
        try {
            const entry = {
                deletedAt: Date.now(),
                deletedBy: deletedBy,
                timestamp: new Date().toISOString(),
                did: did
            };
            
            // Store individual deletion entry
            const soul = `${this.registryRoot}:${did}`;
            await this.gunHelper.putSimple(entry, soul);
            
            // Also add to index for quick lookups
            // Note: We store just a flag in the index, full details are in the individual entry
            const indexEntry = { [did]: true };
            await this.gunHelper.putSimple(indexEntry, this.indexSoul);
            
            console.log(`✅ Marked ${did} as deleted in GUN deletion registry`);
            return true;
            
        } catch (error) {
            console.error(`❌ Failed to mark ${did} as deleted:`, error.message);
            return false;
        }
    }
    
    /**
     * Check if a record is marked as deleted
     * @param {string} did - The DID to check
     * @returns {Promise<boolean>} - True if the record is marked as deleted
     */
    async isDeleted(did) {
        try {
            // First try the quick index lookup
            const index = await this.gunHelper.getRecord(this.indexSoul);
            if (index && index[did]) {
                return true;
            }
            
            // Fallback: Check individual entry
            const soul = `${this.registryRoot}:${did}`;
            const entry = await this.gunHelper.getRecord(soul);
            return !!entry;
            
        } catch (error) {
            // If there's an error, assume not deleted (fail open)
            return false;
        }
    }
    
    /**
     * Get all deleted DIDs from the registry
     * Useful for initialization, migration, and debugging
     * @returns {Promise<Array<string>>} - Array of deleted DIDs
     */
    async getAllDeletedDIDs() {
        try {
            const index = await this.gunHelper.getRecord(this.indexSoul);
            if (!index) {
                return [];
            }
            
            // Filter out GUN metadata and return only DIDs
            const deletedDIDs = Object.keys(index).filter(key => 
                key.startsWith('did:gun:') && index[key] === true
            );
            
            console.log(`📊 Found ${deletedDIDs.length} deleted DIDs in registry`);
            return deletedDIDs;
            
        } catch (error) {
            console.error('Error getting all deleted DIDs:', error.message);
            return [];
        }
    }
    
    /**
     * Get deletion details for a specific DID
     * @param {string} did - The DID to get details for
     * @returns {Promise<Object|null>} - Deletion details or null if not found
     */
    async getDeletionDetails(did) {
        try {
            const soul = `${this.registryRoot}:${did}`;
            const entry = await this.gunHelper.getRecord(soul);
            return entry;
        } catch (error) {
            return null;
        }
    }
    
    /**
     * Process local deletion of a record
     * Removes the record from local Elasticsearch, GUN storage, and registry
     * Called when a deletion is discovered from another node
     * @param {string} did - The DID to delete locally
     * @returns {Promise<boolean>} - Success status
     */
    async processLocalDeletion(did) {
        try {
            // MEMORY LEAK FIX: Skip if recently processed (avoid infinite loop)
            const lastProcessed = this.recentlyProcessed.get(did);
            if (lastProcessed && (Date.now() - lastProcessed) < this.reprocessInterval) {
                // Silently skip - already processed recently
                return true;
            }
            
            let deletedSomething = false;
            
            // 1. Remove from Elasticsearch
            try {
                await elasticClient.delete({
                    index: 'records',
                    id: did
                });
                deletedSomething = true;
            } catch (esError) {
                // If record doesn't exist (404), that's fine - already deleted
                if (esError.meta && esError.meta.statusCode !== 404) {
                    console.warn(`⚠️ Elasticsearch deletion failed for ${did}:`, esError.message);
                }
            }
            
            // 2. Remove from local GUN storage
            try {
                const soul = did.replace('did:gun:', '');
                await this.gunHelper.deleteRecord(soul);
                deletedSomething = true;
            } catch (gunError) {
                // Only log if not a 404-equivalent error
                if (!gunError.message.includes('404') && !gunError.message.includes('not found')) {
                    console.warn(`⚠️ GUN deletion failed for ${did}:`, gunError.message);
                }
            }
            
            // 3. Remove from OIP registry (so it doesn't show up in discovery)
            try {
                const { OIPGunRegistry } = require('./oipGunRegistry');
                const registry = new OIPGunRegistry();
                await registry.unregisterOIPRecord(did);
                deletedSomething = true;
            } catch (regError) {
                // Only log unexpected errors
                if (!regError.message.includes('not found') && !regError.message.includes('may already be unregistered')) {
                    console.warn(`⚠️ Registry removal failed for ${did}:`, regError.message);
                }
            }
            
            if (deletedSomething) {
                console.log(`✅ Deleted ${did}`);
            }
            
            // MEMORY LEAK FIX: Mark as recently processed to avoid reprocessing
            this.recentlyProcessed.set(did, Date.now());
            
            // MEMORY LEAK FIX: Cleanup old entries from recentlyProcessed to prevent memory growth
            // Only keep entries from last 48 hours
            const cutoffTime = Date.now() - (2 * this.reprocessInterval);
            for (const [cachedDid, timestamp] of this.recentlyProcessed.entries()) {
                if (timestamp < cutoffTime) {
                    this.recentlyProcessed.delete(cachedDid);
                }
            }
            
            return true;
            
        } catch (error) {
            console.error(`❌ Error processing local deletion for ${did}:`, error.message);
            return false;
        }
    }
    
    /**
     * Remove a DID from the deletion registry (for testing or error recovery)
     * @param {string} did - The DID to unmark
     * @returns {Promise<boolean>} - Success status
     */
    async unmarkDeleted(did) {
        try {
            // Remove individual entry
            const soul = `${this.registryRoot}:${did}`;
            await this.gunHelper.deleteRecord(soul);
            
            // Remove from index
            const indexEntry = { [did]: null }; // Setting to null removes it
            await this.gunHelper.putSimple(indexEntry, this.indexSoul);
            
            return true;
            
        } catch (error) {
            console.error(`❌ Failed to unmark ${did}:`, error.message);
            return false;
        }
    }
    
    /**
     * Get statistics about the deletion registry
     * @returns {Promise<Object>} - Stats object
     */
    async getStats() {
        try {
            const allDeleted = await this.getAllDeletedDIDs();
            
            return {
                totalDeleted: allDeleted.length,
                registryRoot: this.registryRoot,
                deletedDIDs: allDeleted.slice(0, 10), // First 10 for display
                hasMore: allDeleted.length > 10
            };
        } catch (error) {
            console.error('Error getting deletion registry stats:', error.message);
            return {
                totalDeleted: 0,
                error: error.message
            };
        }
    }
}

module.exports = { GunDeletionRegistry };

