/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Server OIP Identity Helper
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Derives OIP v0.9 signing identity from server's Arweave wallet or mnemonic.
 * Priority:
 * 1. SERVER_CREATOR_MNEMONIC env var (if set)
 * 2. Arweave wallet file (config/arweave-keyfile.json)
 * 3. Fallback to bootstrap creator (read-only, no signing)
 */

const fs = require('fs');
const path = require('path');
const { getWalletFilePath } = require('../utils');
const { createIdentityFromMnemonic } = require('./oip-crypto');
const { HDKey } = require('@scure/bip32');
const { secp256k1 } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha256');
const base64url = require('base64url');

let cachedServerIdentity = null;

/**
 * Get server's OIP identity for signing
 * @returns {Promise<object|null>} Server OIP identity or null if unavailable
 */
async function getServerOipIdentity() {
    // Return cached identity if available
    if (cachedServerIdentity) {
        return cachedServerIdentity;
    }
    
    // Priority 1: Arweave wallet file (check first)
    try {
        const walletPath = getWalletFilePath();
        if (fs.existsSync(walletPath)) {
            try {
                console.log('[ServerIdentity] Loading server identity from Arweave wallet:', walletPath);
                const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
                
                // Arweave wallets are typically RSA format (kty: "RSA")
                // OIP v0.9 requires secp256k1 keys derived from HD wallets
                // Since we can't convert RSA to secp256k1, we'll use the bootstrap creator's DID
                // but we need a secp256k1 key for signing
                // 
                // For now, if the wallet is RSA, we'll fall back to SERVER_CREATOR_MNEMONIC
                // If it's secp256k1, we can use it directly
                
                if (walletData.kty === 'EC' && walletData.crv === 'secp256k1') {
                    // This is a secp256k1 wallet - we can use it directly
                    const privateKeyBytes = Buffer.from(walletData.d, 'base64url');
                    
                    // Create a master key from the private key
                    // Note: This creates a "virtual" HD key - not a true HD wallet
                    // but it allows us to derive signing keys at the OIP path
                    const masterKey = HDKey.fromPrivateKey(privateKeyBytes);
                    
                    // Derive signing key at m/176800'/0'/0'
                    const signingPath = `m/176800'/0'/0'`;
                    const signingKey = masterKey.derive(signingPath);
                    
                    // Generate DID from master public key
                    const pubKeyHash = sha256(masterKey.publicKey);
                    const did = `did:arweave:${base64url.encode(Buffer.from(pubKeyHash))}`;
                    
                    const identity = {
                        did,
                        signingXpub: signingKey.publicExtendedKey,
                        signingKey: signingKey,
                        masterKey: masterKey,
                        account: 0,
                        source: 'arweave-wallet-secp256k1'
                    };
                    
                    cachedServerIdentity = identity;
                    console.log('[ServerIdentity] Created server identity from secp256k1 Arweave wallet');
                    return identity;
                } else if (walletData.kty === 'RSA') {
                    // RSA wallet - cannot use directly for OIP signing
                    // Fall through to try SERVER_CREATOR_MNEMONIC or bootstrap creator
                    console.log('[ServerIdentity] Arweave wallet is RSA format, cannot use for OIP signing');
                    console.log('[ServerIdentity] Will try SERVER_CREATOR_MNEMONIC or bootstrap creator');
                } else {
                    console.warn('[ServerIdentity] Unknown Arweave wallet format:', walletData.kty);
                }
            } catch (error) {
                // Error reading or parsing wallet file
                console.error('[ServerIdentity] Failed to load Arweave wallet:', error.message);
            }
        }
    } catch (error) {
        // Wallet file doesn't exist or can't be accessed - that's okay, we'll try other methods
        console.log('[ServerIdentity] Arweave wallet file not accessible:', error.message);
    }
    
    // Priority 2: SERVER_CREATOR_MNEMONIC env var (fallback if wallet file doesn't exist or is RSA)
    const SERVER_CREATOR_MNEMONIC = process.env.SERVER_CREATOR_MNEMONIC;
    if (SERVER_CREATOR_MNEMONIC) {
        console.log('[ServerIdentity] Using SERVER_CREATOR_MNEMONIC for server signing (fallback)');
        try {
            const identity = createIdentityFromMnemonic(SERVER_CREATOR_MNEMONIC, 0);
            cachedServerIdentity = identity;
            return identity;
        } catch (error) {
            console.error('[ServerIdentity] Failed to create identity from SERVER_CREATOR_MNEMONIC:', error.message);
        }
    }
    
    // Priority 3: Bootstrap creator (read-only, no signing capability)
    const { getBootstrapCreator } = require('./sync-verification');
    const bootstrapCreator = getBootstrapCreator();
    if (bootstrapCreator) {
        console.log('[ServerIdentity] Using bootstrap creator (read-only, no signing)');
        return {
            did: bootstrapCreator.did,
            signingXpub: bootstrapCreator.signingXpub,
            signingKey: null, // No private key available
            source: 'bootstrap-creator',
            readOnly: true
        };
    }
    
    console.warn('[ServerIdentity] No server signing identity available');
    return null;
}

/**
 * Check if server identity has signing capability
 * @param {object} identity - Server identity object
 * @returns {boolean}
 */
function canSign(identity) {
    return identity && identity.signingKey && !identity.readOnly;
}

module.exports = {
    getServerOipIdentity,
    canSign
};
