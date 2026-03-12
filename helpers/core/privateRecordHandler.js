/**
 * Private Record Handler
 * Handles discovery, decryption, and processing of encrypted GUN records
 */

const crypto = require('crypto');
const { OIPGunRegistry } = require('./oipGunRegistry');

class PrivateRecordHandler {
    constructor() {
        this.registry = new OIPGunRegistry();
        this.decryptionEnabled = process.env.GUN_SYNC_PRIVATE_RECORDS !== 'false';
        this.trustedNodes = this.parseTrustedNodes();
        
        console.log('🔐 Private Record Handler initialized:', {
            decryptionEnabled: this.decryptionEnabled,
            trustedNodes: this.trustedNodes
        });
    }
    
    parseTrustedNodes() {
        const trustedNodesEnv = process.env.GUN_SYNC_TRUSTED_NODES;
        if (!trustedNodesEnv) return null; // Trust all nodes if not specified
        
        return trustedNodesEnv.split(',').map(node => node.trim());
    }
    
    /**
     * Discover private records from other nodes
     * @returns {Array} Array of decrypted private records
     */
    async discoverPrivateRecords() {
        if (!this.decryptionEnabled) {
            console.log('🔒 Private record sync disabled via configuration');
            return [];
        }
        
        try {
            // console.log('🔍 Discovering private records from other nodes...'); // Commented out - too verbose
            
            const discoveredRecords = await this.registry.discoverOIPRecords();
            const privateRecords = [];
            
            for (const record of discoveredRecords) {
                // Check if record is from a trusted node (if trust list is configured)
                if (this.trustedNodes && !this.trustedNodes.includes(record.sourceNodeId)) {
                    console.log(`⏭️ Skipping record from untrusted node: ${record.sourceNodeId}`);
                    continue;
                }
                
                // Check if record is encrypted
                if (this.isEncryptedRecord(record.data)) {
                    try {
                        // For sync discovery, we can only decrypt records we own or legacy records
                        // Since we don't have user passwords during sync, we'll try different approaches
                        
                        const encryptedBy = record.data.meta?.encryptedBy;
                        
                        if (!encryptedBy) {
                            // Legacy record - try with shared key
                            console.log(`🔓 Attempting to decrypt legacy record: ${record.data.oip.did}`);
                            const decryptedRecord = await this.decryptLegacyRecord(record.data);
                            privateRecords.push({
                                ...record,
                                data: decryptedRecord,
                                wasEncrypted: true,
                                isLegacy: true
                            });
                            console.log(`✅ Successfully decrypted legacy private record: ${record.data.oip.did}`);
                        } else {
                            // Check encryption type to determine sync strategy
                            const encryptionType = record.data.meta?.encryptionType;
                            
                            if (encryptionType === 'organization') {
                                // Organization encrypted record - queue for decryption when owner logs in
                                console.log(`🏢 Found organization encrypted record: ${record.data.oip.did}`);
                                
                                try {
                                    const organizationDid = record.data.meta.encryptedForOrganization;
                                    if (organizationDid) {
                                        // Queue for decryption when organization owner logs in
                                        const { OrganizationDecryptionQueue } = require('./organizationDecryptionQueue');
                                        const decryptQueue = new OrganizationDecryptionQueue();
                                        await decryptQueue.queueForDecryption(record.data, organizationDid);
                                        
                                        console.log(`📥 Queued organization record for decryption: ${record.data.oip.did}`);
                                        
                                        // Don't add to privateRecords array - it will be processed when owner logs in
                                        
                                    } else {
                                        throw new Error('Organization DID not found in metadata');
                                    }
                                } catch (error) {
                                    console.warn(`❌ Failed to queue organization record: ${record.data.oip.did}`, error.message);
                                }
                                
                            } else {
                                // Per-user encrypted record - can only be decrypted by the owner
                                console.log(`🔒 Found per-user encrypted record (owner: ${encryptedBy.slice(0, 12)}...): ${record.data.oip.did}`);
                                privateRecords.push({
                                    ...record,
                                    data: record.data, // Keep encrypted
                                    wasEncrypted: true,
                                    needsUserDecryption: true,
                                    encryptedBy: encryptedBy
                                });
                            }
                        }
                        
                    } catch (error) {
                        console.warn(`❌ Failed to process encrypted record: ${record.data.oip.did}`, error.message);
                        // Skip records we can't process
                        continue;
                    }
                } else {
                    // Public record - add to list without special handling
                    privateRecords.push(record);
                }
            }
            
            // Only log if we actually found records
            if (privateRecords.length > 0) {
                console.log(`🔓 Processed ${privateRecords.length} records (including private ones)`);
            }
            return privateRecords;
            
        } catch (error) {
            console.error('❌ Error discovering private records:', error);
            return [];
        }
    }
    
    /**
     * Check if a record is encrypted
     * @param {Object} record - The record to check
     * @returns {boolean} True if record is encrypted
     */
    isEncryptedRecord(record) {
        return record.meta && 
               record.meta.encrypted === true && 
               record.data && 
               record.data.encrypted && 
               record.data.iv && 
               record.data.tag;
    }
    
    /**
     * Decrypt a GUN record using per-user encryption keys
     * @param {Object} encryptedRecord - The encrypted record
     * @param {Object} decryptionOptions - Decryption options with user credentials
     * @returns {Object} Decrypted record data
     */
    async decryptGunRecord(encryptedRecord, decryptionOptions = {}) {
        try {
            console.log('🔓 Decrypting GUN record with per-user encryption...');
            
            const encryptedBy = encryptedRecord.meta?.encryptedBy;
            const userPublicKey = decryptionOptions.userPublicKey;
            const userPassword = decryptionOptions.userPassword;
            
            if (!encryptedBy) {
                // Legacy record without encryptedBy metadata - try fallback decryption
                console.log('⚠️ Legacy encrypted record without encryptedBy metadata, trying fallback');
                return await this.decryptLegacyRecord(encryptedRecord);
            }
            
            if (!userPublicKey) {
                throw new Error('User public key required for per-user decryption');
            }
            
            // Check if user can decrypt this record (must be the same user who encrypted it)
            if (encryptedBy !== userPublicKey) {
                throw new Error(`Cannot decrypt record: encrypted by ${encryptedBy.slice(0, 12)}..., but you are ${userPublicKey.slice(0, 12)}...`);
            }
            
            let decryptionKey;
            
            if (userPassword) {
                // Use user-specific salt for decryption
                try {
                    const { getUserGunEncryptionSalt, generateUserEncryptionKey } = require('../../routes/daemon/user');
                    const userSalt = await getUserGunEncryptionSalt(userPublicKey, userPassword);
                    decryptionKey = generateUserEncryptionKey(userPublicKey, userSalt);
                    console.log('🔑 Using user-specific decryption key with personal salt');
                } catch (error) {
                    console.warn('🔑 Failed to get user salt for decryption, falling back to public key only:', error.message);
                    // Fallback: use public key as key material
                    decryptionKey = crypto.pbkdf2Sync(userPublicKey, 'oip-gun-fallback', 100000, 32, 'sha256');
                }
            } else {
                // Fallback for cases where password is not available
                decryptionKey = crypto.pbkdf2Sync(userPublicKey, 'oip-gun-fallback', 100000, 32, 'sha256');
                console.log('🔑 Using public key only decryption (no password available)');
            }
            
            const iv = Buffer.from(encryptedRecord.data.iv, 'base64');
            const tag = Buffer.from(encryptedRecord.data.tag, 'base64');
            const encryptedBuf = Buffer.from(encryptedRecord.data.encrypted, 'base64');
            
            const decipher = crypto.createDecipheriv('aes-256-gcm', decryptionKey, iv);
            decipher.setAuthTag(tag);
            
            const dec = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
            const decryptedData = JSON.parse(dec.toString('utf8'));
            
            console.log('✅ Successfully decrypted GUN record with per-user encryption');
            
            return {
                data: decryptedData,
                meta: {
                    ...encryptedRecord.meta,
                    encrypted: false,
                    wasEncrypted: true,
                    decryptedAt: new Date().toISOString(),
                    decryptedBy: userPublicKey
                },
                oip: encryptedRecord.oip
            };
            
        } catch (error) {
            console.error('❌ Failed to decrypt GUN record:', error);
            throw new Error(`Per-user decryption failed: ${error.message}`);
        }
    }
    
    /**
     * Decrypt legacy records that use the old shared key system
     * @param {Object} encryptedRecord - The encrypted record
     * @returns {Object} Decrypted record data
     */
    async decryptLegacyRecord(encryptedRecord) {
        try {
            console.log('🔓 Attempting legacy decryption with shared key...');
            
            // Use the old shared key for legacy records
            const key = crypto.pbkdf2Sync('gun-encryption-key', 'salt', 100000, 32, 'sha256');
            const iv = Buffer.from(encryptedRecord.data.iv, 'base64');
            const tag = Buffer.from(encryptedRecord.data.tag, 'base64');
            const encryptedBuf = Buffer.from(encryptedRecord.data.encrypted, 'base64');
            
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(tag);
            
            const dec = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
            const decryptedData = JSON.parse(dec.toString('utf8'));
            
            console.log('✅ Successfully decrypted legacy GUN record');
            
            return {
                data: decryptedData,
                meta: {
                    ...encryptedRecord.meta,
                    encrypted: false,
                    wasEncrypted: true,
                    isLegacyEncryption: true,
                    decryptedAt: new Date().toISOString()
                },
                oip: encryptedRecord.oip
            };
            
        } catch (error) {
            console.error('❌ Failed to decrypt legacy GUN record:', error);
            throw new Error(`Legacy decryption failed: ${error.message}`);
        }
    }
    
    /**
     * Validate decrypted record structure
     * @param {Object} decryptedRecord - The decrypted record
     * @returns {boolean} True if structure is valid
     */
    validateDecryptedRecord(decryptedRecord) {
        try {
            // Check that decrypted data has the expected structure
            if (!decryptedRecord.data || typeof decryptedRecord.data !== 'object') {
                return false;
            }
            
            // Check for basic template structure (should have at least one template)
            const dataKeys = Object.keys(decryptedRecord.data);
            if (dataKeys.length === 0) {
                return false;
            }
            
            // Validate that it looks like OIP record data
            const hasBasicTemplate = dataKeys.some(key => 
                key === 'basic' || 
                (decryptedRecord.data[key] && typeof decryptedRecord.data[key] === 'object')
            );
            
            return hasBasicTemplate;
            
        } catch (error) {
            console.error('Error validating decrypted record:', error);
            return false;
        }
    }
    
    /**
     * Get statistics about private record discovery
     * @returns {Object} Statistics object
     */
    async getPrivateRecordStats() {
        try {
            const stats = {
                decryptionEnabled: this.decryptionEnabled,
                trustedNodes: this.trustedNodes,
                totalDiscovered: 0,
                totalDecrypted: 0,
                decryptionErrors: 0,
                lastDiscoveryTime: null
            };
            
            // This would be populated during actual discovery cycles
            // For now, return the configuration state
            
            return stats;
            
        } catch (error) {
            console.error('Error getting private record stats:', error);
            return { error: error.message };
        }
    }
    
    /**
     * Decrypt organization record directly with organization key (for sync)
     * @param {Object} encryptedRecord - Encrypted record
     * @param {Buffer} orgEncryptionKey - Organization encryption key
     * @param {string} organizationDid - Organization DID
     * @returns {Object} Decrypted record data
     */
    async decryptWithOrganizationKey(encryptedRecord, orgEncryptionKey, organizationDid) {
        try {
            console.log(`🏢 Decrypting organization record for: ${organizationDid}`);
            
            const iv = Buffer.from(encryptedRecord.data.iv, 'base64');
            const tag = Buffer.from(encryptedRecord.data.tag, 'base64');
            const encryptedBuf = Buffer.from(encryptedRecord.data.encrypted, 'base64');
            
            const decipher = crypto.createDecipheriv('aes-256-gcm', orgEncryptionKey, iv);
            decipher.setAuthTag(tag);
            
            const dec = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
            const decryptedData = JSON.parse(dec.toString('utf8'));
            
            console.log(`✅ Successfully decrypted organization record`);
            
            return {
                data: decryptedData,
                meta: {
                    ...encryptedRecord.meta,
                    encrypted: false,
                    wasEncrypted: true,
                    decryptedAt: new Date().toISOString(),
                    decryptedForOrganization: organizationDid
                },
                oip: encryptedRecord.oip
            };
            
        } catch (error) {
            console.error('❌ Error decrypting organization record:', error);
            throw error;
        }
    }
}

module.exports = { PrivateRecordHandler };
