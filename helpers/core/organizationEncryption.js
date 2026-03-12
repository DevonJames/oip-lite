/**
 * Organization Encryption Helper
 * Handles encryption/decryption for organization-level access control
 */

const crypto = require('crypto');
const { elasticClient } = require('./elasticsearch');

class OrganizationEncryption {
    constructor() {
        this.orgKeyCache = new Map(); // Cache organization keys
    }
    
    /**
     * Generate organization encryption key (requires owner's private key)
     * @param {string} organizationDid - Organization DID
     * @param {string} ownerPrivateKey - Organization owner's private key
     * @returns {Buffer} Organization encryption key
     */
    async getOrganizationEncryptionKey(organizationDid, ownerPrivateKey = null) {
        try {
            if (!ownerPrivateKey) {
                throw new Error('Organization owner private key required for encryption key generation');
            }
            
            // Get organization data
            const organization = await this.getOrganizationData(organizationDid);
            if (!organization) {
                throw new Error(`Organization not found: ${organizationDid}`);
            }
            
            // Use owner's private key + organization public key to create encryption key
            // This ensures only the organization owner can generate the encryption key
            const orgPublicKey = organization.data.orgPublicKey || organization.oip.organization.orgPublicKey;
            if (!orgPublicKey) {
                throw new Error(`Organization public key not found for: ${organizationDid}`);
            }
            
            const keyMaterial = ownerPrivateKey + orgPublicKey;
            const orgEncryptionKey = crypto.pbkdf2Sync(
                keyMaterial,
                'oip-organization-owner-encryption',
                100000,
                32,
                'sha256'
            );
            
            console.log(`🔑 Generated organization encryption key for: ${organizationDid} (owner-based)`);
            return orgEncryptionKey;
            
        } catch (error) {
            console.error('❌ Error getting organization encryption key:', error);
            throw error;
        }
    }
    
    /**
     * Check if user is member of organization based on membership policy
     * @param {string} userPublicKey - User's public key
     * @param {string} organizationDid - Organization DID
     * @param {Object} requestInfo - Request information (for domain checking)
     * @returns {boolean} True if user is member
     */
    async isUserOrganizationMember(userPublicKey, organizationDid, requestInfo = {}) {
        try {
            const organization = await this.getOrganizationData(organizationDid);
            if (!organization) return false;
            
            const orgData = organization.data;
            const adminKeys = Array.isArray(orgData.adminPublicKeys) 
                ? orgData.adminPublicKeys 
                : [orgData.adminPublicKeys];
            
            // Check if user is admin (admins are always members)
            if (adminKeys.includes(userPublicKey)) {
                console.log(`✅ User is admin of organization: ${organizationDid}`);
                return true;
            }
            
            // Check membership based on organization's membership policy
            const membershipPolicy = orgData.membershipPolicy;
            
            // Normalize policy for comparison (handle various formats)
            const normalizedPolicy = typeof membershipPolicy === 'string' 
                ? membershipPolicy.toLowerCase().replace(/[\s-_]/g, '') 
                : membershipPolicy;
            
            if (membershipPolicy === 1 || normalizedPolicy === 'appuserauto' || normalizedPolicy === 'autoenrollappusers') {
                // Auto-Enroll App Users: Check if request came from organization's domain
                return await this.checkDomainBasedMembership(organization, requestInfo);
                
            } else if (membershipPolicy === 0 || normalizedPolicy === 'inviteonly') {
                // Invite Only: Check invitation list (not yet implemented)
                console.log(`⚠️ Invite-only membership not yet implemented for: ${organizationDid}`);
                return false;
                
            } else if (membershipPolicy === 2 || normalizedPolicy === 'tokengated') {
                // Token-Gated: Check token ownership (not yet implemented)
                console.log(`⚠️ Token-gated membership not yet implemented for: ${organizationDid}`);
                return false;
                
            } else if (membershipPolicy === 3 || normalizedPolicy === 'openjoin') {
                // Open Join: Anyone can be a member
                console.log(`✅ Open-join policy, user is member: ${organizationDid}`);
                return true;
                
            } else {
                console.warn(`⚠️ Unknown membership policy: ${membershipPolicy} (normalized: ${normalizedPolicy}) for ${organizationDid}`);
                return false;
            }
            
        } catch (error) {
            console.error('❌ Error checking organization membership:', error);
            return false;
        }
    }
    
    /**
     * Check domain-based membership for Auto-Enroll App Users policy
     * @param {Object} organization - Organization data
     * @param {Object} requestInfo - Request information (headers, origin, etc.)
     * @returns {boolean} True if request came from organization's domain
     */
    async checkDomainBasedMembership(organization, requestInfo = {}) {
        try {
            const orgWebUrl = organization.data.webUrl;
            if (!orgWebUrl) {
                console.warn('⚠️ Organization has Auto-Enroll policy but no webUrl defined');
                return false;
            }
            
            // Extract domain from organization's webUrl (handle URLs without protocol)
            let orgDomain;
            try {
                if (orgWebUrl.startsWith('http://') || orgWebUrl.startsWith('https://')) {
                    orgDomain = new URL(orgWebUrl).hostname;
                } else {
                    // Assume it's just a domain name
                    orgDomain = orgWebUrl;
                }
            } catch (error) {
                console.warn(`⚠️ Could not parse organization webUrl: ${orgWebUrl}`, error);
                return false;
            }
            console.log(`🌐 Organization domain: ${orgDomain}`);
            
            // Check various request sources for domain match
            const requestSources = [
                requestInfo.origin,
                requestInfo.referer,
                requestInfo.host,
                requestInfo.headers?.origin,
                requestInfo.headers?.referer,
                requestInfo.headers?.host
            ].filter(Boolean);
            
            console.log(`🔍 Checking domain membership for sources:`, requestSources);
            
            for (const source of requestSources) {
                try {
                    let sourceDomain;
                    if (source.startsWith('http')) {
                        sourceDomain = new URL(source).hostname;
                    } else {
                        sourceDomain = source;
                    }
                    
                    console.log(`🔍 Comparing: ${sourceDomain} vs ${orgDomain}`);
                    
                    // Check for exact domain match or subdomain
                    if (sourceDomain === orgDomain) {
                        console.log(`✅ Domain-based membership granted (exact match): ${sourceDomain} === ${orgDomain}`);
                        return true;
                    } else if (sourceDomain.endsWith('.' + orgDomain)) {
                        console.log(`✅ Domain-based membership granted (subdomain match): ${sourceDomain} ends with .${orgDomain}`);
                        return true;
                    } else {
                        console.log(`❌ No match: ${sourceDomain} does not match ${orgDomain}`);
                    }
                } catch (error) {
                    console.warn(`⚠️ Error processing source ${source}:`, error);
                    continue;
                }
            }
            
            console.log(`❌ Domain-based membership denied: no match for ${orgDomain}`);
            console.log(`   Request sources checked:`, requestSources);
            return false;
            
        } catch (error) {
            console.error('❌ Error checking domain-based membership:', error);
            return false;
        }
    }
    
    /**
     * Get organization data from Elasticsearch
     * @param {string} organizationDid - Organization DID
     * @returns {Object} Organization record
     */
    async getOrganizationData(organizationDid) {
        try {
            const searchResult = await elasticClient.search({
                index: 'organizations',
                body: {
                    query: {
                        bool: {
                            should: [
                                { term: { "oip.did": organizationDid } },
                                { term: { "oip.didTx": organizationDid } }
                            ]
                        }
                    }
                }
            });
            
            if (searchResult.hits.hits.length > 0) {
                return searchResult.hits.hits[0]._source;
            }
            
            return null;
            
        } catch (error) {
            console.error('❌ Error fetching organization data:', error);
            return null;
        }
    }
    
    /**
     * Determine encryption strategy for a record based on access control
     * @param {Object} accessControl - Access control configuration
     * @param {string} userPublicKey - User's public key
     * @returns {Object} Encryption strategy
     */
    async determineEncryptionStrategy(accessControl, userPublicKey) {
        const accessLevel = accessControl?.access_level;
        
        if (!accessLevel || accessLevel === 'public') {
            return {
                encrypt: false,
                encryptionType: 'none'
            };
        }
        
        if (accessLevel === 'private') {
            return {
                encrypt: true,
                encryptionType: 'per-user',
                encryptionKey: null, // Will be generated with user's key
                encryptedBy: userPublicKey
            };
        }
        
        if (accessLevel === 'organization') {
            const sharedWith = accessControl.shared_with;
            if (!sharedWith || !Array.isArray(sharedWith) || sharedWith.length === 0) {
                throw new Error('Organization access level requires shared_with field with organization DIDs');
            }
            
            // Use the first organization for encryption key
            const organizationDid = sharedWith[0];
            const orgEncryptionKey = await this.getOrganizationEncryptionKey(organizationDid);
            
            return {
                encrypt: true,
                encryptionType: 'organization',
                encryptionKey: orgEncryptionKey,
                organizationDid: organizationDid,
                sharedWith: sharedWith
            };
        }
        
        if (accessLevel === 'shared') {
            // For shared access, we'll need to implement multi-user encryption
            // For now, fall back to per-user encryption
            return {
                encrypt: true,
                encryptionType: 'per-user',
                encryptionKey: null,
                encryptedBy: userPublicKey,
                note: 'Shared access not yet implemented, using per-user encryption'
            };
        }
        
        // Default to no encryption for unknown access levels
        return {
            encrypt: false,
            encryptionType: 'none'
        };
    }
    
    /**
     * Encrypt record data using organization key
     * @param {Object} recordData - Record data to encrypt
     * @param {Buffer} orgEncryptionKey - Organization encryption key
     * @param {string} organizationDid - Organization DID
     * @returns {Object} Encrypted record structure
     */
    encryptWithOrganizationKey(recordData, orgEncryptionKey, organizationDid) {
        try {
            const algorithm = 'aes-256-gcm';
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv(algorithm, orgEncryptionKey, iv);
            
            const plaintext = Buffer.from(JSON.stringify(recordData), 'utf8');
            const encryptedBuf = Buffer.concat([cipher.update(plaintext), cipher.final()]);
            const authTag = cipher.getAuthTag();
            
            return {
                data: {
                    encrypted: encryptedBuf.toString('base64'),
                    iv: iv.toString('base64'),
                    tag: authTag.toString('base64')
                },
                meta: {
                    encrypted: true,
                    encryptionMethod: algorithm,
                    encryptionType: 'organization',
                    encryptedForOrganization: organizationDid
                }
            };
            
        } catch (error) {
            console.error('❌ Error encrypting with organization key:', error);
            throw error;
        }
    }
    
    /**
     * Decrypt record data using organization key
     * @param {Object} encryptedRecord - Encrypted record
     * @param {string} userPublicKey - User requesting decryption
     * @returns {Object} Decrypted record data
     */
    async decryptWithOrganizationKey(encryptedRecord, userPublicKey) {
        try {
            const organizationDid = encryptedRecord.meta.encryptedForOrganization;
            if (!organizationDid) {
                throw new Error('Organization DID not found in encrypted record metadata');
            }
            
            // Check if user is member of the organization
            const isMember = await this.isUserOrganizationMember(userPublicKey, organizationDid);
            if (!isMember) {
                throw new Error(`User ${userPublicKey.slice(0, 12)}... is not a member of organization ${organizationDid}`);
            }
            
            // Get organization encryption key
            const orgEncryptionKey = await this.getOrganizationEncryptionKey(organizationDid);
            
            // Decrypt the record
            const iv = Buffer.from(encryptedRecord.data.iv, 'base64');
            const tag = Buffer.from(encryptedRecord.data.tag, 'base64');
            const encryptedBuf = Buffer.from(encryptedRecord.data.encrypted, 'base64');
            
            const decipher = crypto.createDecipheriv('aes-256-gcm', orgEncryptionKey, iv);
            decipher.setAuthTag(tag);
            
            const dec = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
            const decryptedData = JSON.parse(dec.toString('utf8'));
            
            console.log(`✅ Successfully decrypted organization record for member: ${userPublicKey.slice(0, 12)}...`);
            
            return {
                data: decryptedData,
                meta: {
                    ...encryptedRecord.meta,
                    encrypted: false,
                    wasEncrypted: true,
                    decryptedAt: new Date().toISOString(),
                    decryptedBy: userPublicKey,
                    decryptedForOrganization: organizationDid
                },
                oip: encryptedRecord.oip
            };
            
        } catch (error) {
            console.error('❌ Error decrypting with organization key:', error);
            throw error;
        }
    }
}

module.exports = { OrganizationEncryption };
