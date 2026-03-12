/**
 * Organization Decryption Queue
 * Handles decryption of organization records when organization owners log in
 */

const crypto = require('crypto');
const { elasticClient } = require('./elasticsearch');

class OrganizationDecryptionQueue {
    constructor() {
        this.pendingDecryptions = new Map(); // organizationDid -> pending records
    }
    
    /**
     * Add organization record to decryption queue
     * @param {Object} encryptedRecord - Encrypted organization record
     * @param {string} organizationDid - Organization DID
     */
    async queueForDecryption(encryptedRecord, organizationDid) {
        try {
            console.log(`📥 Queueing organization record for decryption: ${encryptedRecord.oip.did}`);
            
            // Store encrypted record in queue index
            await elasticClient.index({
                index: 'organization_decrypt_queue',
                id: encryptedRecord.oip.did,
                body: {
                    organizationDid: organizationDid,
                    encryptedRecord: encryptedRecord,
                    queuedAt: new Date().toISOString(),
                    status: 'pending'
                }
            });
            
            // Track in memory for quick access
            if (!this.pendingDecryptions.has(organizationDid)) {
                this.pendingDecryptions.set(organizationDid, new Set());
            }
            this.pendingDecryptions.get(organizationDid).add(encryptedRecord.oip.did);
            
            console.log(`✅ Queued record ${encryptedRecord.oip.did} for organization ${organizationDid}`);
            
        } catch (error) {
            console.error('❌ Error queueing record for decryption:', error);
        }
    }
    
    /**
     * Process decryption queue when organization owner logs in
     * @param {string} userPublicKey - User's public key
     * @param {string} userPrivateKey - User's decrypted private key (from login)
     */
    async processDecryptionQueue(userPublicKey, userPrivateKey) {
        try {
            console.log(`🔑 Organization owner logged in: ${userPublicKey.slice(0, 12)}...`);
            
            // Find organizations where this user is the owner (orgPublicKey)
            const ownedOrganizations = await this.findOwnedOrganizations(userPublicKey);
            
            for (const organization of ownedOrganizations) {
                await this.decryptOrganizationRecords(organization, userPrivateKey);
            }
            
        } catch (error) {
            console.error('❌ Error processing decryption queue:', error);
        }
    }
    
    /**
     * Find organizations owned by user
     * @param {string} userPublicKey - User's public key
     * @returns {Array} Organizations where user is the owner
     */
    async findOwnedOrganizations(userPublicKey) {
        try {
            const searchResult = await elasticClient.search({
                index: 'organizations',
                body: {
                    query: {
                        term: {
                            'data.orgPublicKey': userPublicKey // Organizations where user is owner
                        }
                    }
                }
            });
            
            return searchResult.hits.hits.map(hit => hit._source);
            
        } catch (error) {
            console.error('❌ Error finding owned organizations:', error);
            return [];
        }
    }
    
    /**
     * Decrypt all queued records for an organization
     * @param {Object} organization - Organization data
     * @param {string} ownerPrivateKey - Organization owner's private key
     */
    async decryptOrganizationRecords(organization, ownerPrivateKey) {
        try {
            const organizationDid = organization.oip.did;
            console.log(`🔓 Decrypting queued records for organization: ${organizationDid}`);
            
            // Get all queued records for this organization
            let queuedRecords;
            try {
                queuedRecords = await elasticClient.search({
                    index: 'organization_decrypt_queue',
                    body: {
                        query: {
                            bool: {
                                must: [
                                    { term: { organizationDid: organizationDid } },
                                    { term: { status: 'pending' } }
                                ]
                            }
                        }
                    }
                });
            } catch (indexError) {
                // If index doesn't exist, there's nothing to decrypt - this is not an error
                if (indexError.meta?.body?.error?.type === 'index_not_found_exception') {
                    console.log(`ℹ️  No organization decryption queue exists yet (index not found)`);
                    return;
                }
                throw indexError; // Re-throw if it's a different error
            }
            
            for (const hit of queuedRecords.hits.hits) {
                const queueItem = hit._source;
                const encryptedRecord = queueItem.encryptedRecord;
                
                try {
                    // Generate organization encryption key using owner's private key
                    const orgEncryptionKey = this.generateOwnerBasedOrgKey(
                        organization.data.orgPublicKey, 
                        ownerPrivateKey
                    );
                    
                    // Decrypt the record
                    const decryptedRecord = await this.decryptRecordWithOrgKey(
                        encryptedRecord, 
                        orgEncryptionKey
                    );
                    
                    // Index the decrypted record to main records index
                    await elasticClient.index({
                        index: 'records',
                        id: decryptedRecord.oip.did,
                        body: decryptedRecord
                    });
                    
                    // Mark as processed in queue
                    await elasticClient.update({
                        index: 'organization_decrypt_queue',
                        id: hit._id,
                        body: {
                            doc: {
                                status: 'decrypted',
                                decryptedAt: new Date().toISOString()
                            }
                        }
                    });
                    
                    console.log(`✅ Decrypted and indexed: ${decryptedRecord.oip.did}`);
                    
                } catch (decryptError) {
                    console.error(`❌ Failed to decrypt record ${encryptedRecord.oip.did}:`, decryptError);
                    
                    // Mark as failed
                    await elasticClient.update({
                        index: 'organization_decrypt_queue',
                        id: hit._id,
                        body: {
                            doc: {
                                status: 'failed',
                                failedAt: new Date().toISOString(),
                                error: decryptError.message
                            }
                        }
                    });
                }
            }
            
        } catch (error) {
            console.error('❌ Error decrypting organization records:', error);
        }
    }
    
    /**
     * Generate organization encryption key using owner's private key
     * @param {string} orgPublicKey - Organization's public key (owner's key)
     * @param {string} ownerPrivateKey - Owner's private key
     * @returns {Buffer} Organization encryption key
     */
    generateOwnerBasedOrgKey(orgPublicKey, ownerPrivateKey) {
        // Use owner's private key + organization public key to create deterministic key
        // This ensures only the owner can generate this key
        const keyMaterial = ownerPrivateKey + orgPublicKey;
        
        return crypto.pbkdf2Sync(
            keyMaterial,
            'oip-organization-owner-encryption',
            100000,
            32,
            'sha256'
        );
    }
    
    /**
     * Decrypt organization record with generated key
     * @param {Object} encryptedRecord - Encrypted record
     * @param {Buffer} orgEncryptionKey - Organization encryption key
     * @returns {Object} Decrypted record
     */
    async decryptRecordWithOrgKey(encryptedRecord, orgEncryptionKey) {
        try {
            const iv = Buffer.from(encryptedRecord.data.iv, 'base64');
            const tag = Buffer.from(encryptedRecord.data.tag, 'base64');
            const encryptedBuf = Buffer.from(encryptedRecord.data.encrypted, 'base64');
            
            const decipher = crypto.createDecipheriv('aes-256-gcm', orgEncryptionKey, iv);
            decipher.setAuthTag(tag);
            
            const dec = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
            const decryptedData = JSON.parse(dec.toString('utf8'));
            
            return {
                data: decryptedData,
                meta: {
                    ...encryptedRecord.meta,
                    encrypted: false,
                    wasEncrypted: true,
                    decryptedAt: new Date().toISOString(),
                    decryptedBy: 'organization-owner'
                },
                oip: encryptedRecord.oip
            };
            
        } catch (error) {
            console.error('❌ Error decrypting record:', error);
            throw error;
        }
    }
    
    /**
     * Get queue status for monitoring
     * @returns {Object} Queue statistics
     */
    async getQueueStatus() {
        try {
            const stats = await elasticClient.search({
                index: 'organization_decrypt_queue',
                body: {
                    aggs: {
                        by_status: {
                            terms: {
                                field: 'status'
                            }
                        },
                        by_organization: {
                            terms: {
                                field: 'organizationDid'
                            }
                        }
                    }
                }
            });
            
            return {
                total: stats.hits.total.value,
                byStatus: stats.aggregations.by_status.buckets,
                byOrganization: stats.aggregations.by_organization.buckets
            };
            
        } catch (error) {
            // If index doesn't exist, return empty stats
            if (error.meta?.body?.error?.type === 'index_not_found_exception') {
                return { total: 0, byStatus: [], byOrganization: [], indexExists: false };
            }
            console.error('❌ Error getting queue status:', error);
            return { error: error.message };
        }
    }
}

module.exports = { OrganizationDecryptionQueue };
