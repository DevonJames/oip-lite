/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * User OIP Identity Helper
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Derives OIP v0.9 signing identity from user's account (mnemonic).
 * Users have HD wallets stored at m/44'/0'/0'/0/0, but OIP signing uses m/176800'/0'/0'.
 */

const { createIdentityFromMnemonic } = require('./oip-crypto');

// Import decryption function - need to access it from user routes
// TODO: Move decryption functions to a shared helper
function decryptMnemonicWithPassword(encryptedMnemonic, password) {
    const crypto = require('crypto');
    
    try {
        // Check if it's the new AES-256-GCM format (JSON string)
        if (encryptedMnemonic.startsWith('{')) {
            // New format - use AES decryption
            const mnemonicData = JSON.parse(encryptedMnemonic);
            
            const key = crypto.pbkdf2Sync(password, 'oip-mnemonic-encryption', 100000, 32, 'sha256');
            const iv = Buffer.from(mnemonicData.iv, 'base64');
            const authTag = Buffer.from(mnemonicData.authTag, 'base64');
            const encrypted = Buffer.from(mnemonicData.encrypted, 'base64');
            
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(authTag);
            
            const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
            return decrypted.toString('utf8');
            
        } else {
            // Legacy format - stored as PBKDF2 hex string
            throw new Error('Legacy account: Mnemonic cannot be retrieved. Please contact support for account migration.');
        }
        
    } catch (error) {
        if (error.message.includes('Legacy account')) {
            throw error; // Re-throw legacy account message
        }
        throw new Error(`Failed to decrypt mnemonic: ${error.message}`);
    }
}

/**
 * Get user's OIP identity from their account
 * @param {object} user - User object from database
 * @param {string} password - User's password (to decrypt mnemonic)
 * @param {number} account - OIP account index (default 0)
 * @returns {Promise<object>} OIP identity with signing keys
 */
async function getUserOipIdentity(user, password, account = 0) {
    if (!user.encryptedMnemonic) {
        throw new Error('User does not have a mnemonic stored');
    }
    
    // Decrypt user's mnemonic
    const mnemonic = decryptMnemonicWithPassword(user.encryptedMnemonic, password);
    
    // Create OIP identity from mnemonic (derives at m/176800'/0'/account')
    const identity = createIdentityFromMnemonic(mnemonic, account);
    
    return identity;
}

/**
 * Get user's OIP identity from JWT and password
 * @param {object} req - Express request with user JWT
 * @param {string} password - User's password
 * @param {number} account - OIP account index (default 0)
 * @returns {Promise<object>} OIP identity with signing keys
 */
async function getUserOipIdentityFromRequest(req, password, account = 0) {
    if (!req.user || !req.user.email) {
        throw new Error('User not authenticated');
    }
    
    // Use Elasticsearch client directly to avoid circular dependency
    const { elasticClient } = require('./elasticsearch');
    
    // Search for user by email (exact match)
    const searchResult = await elasticClient.search({
        index: 'users',
        body: {
            query: {
                term: { 
                    'email.keyword': req.user.email.toLowerCase()
                }
            }
        }
    });
    
    // Try alternative search if .keyword doesn't work
    if (!searchResult.hits.hits.length) {
        const altSearch = await elasticClient.search({
            index: 'users',
            body: {
                query: {
                    term: { 
                        email: req.user.email.toLowerCase()
                    }
                }
            }
        });
        if (altSearch.hits.hits.length) {
            searchResult.hits.hits = altSearch.hits.hits;
        }
    }
    
    if (!searchResult.hits.hits.length) {
        throw new Error('User not found');
    }
    
    const user = searchResult.hits.hits[0]._source;
    return await getUserOipIdentity(user, password, account);
}

module.exports = {
    getUserOipIdentity,
    getUserOipIdentityFromRequest
};
