/**
 * OIP v0.9.0 Cryptographic Infrastructure
 * 
 * Implements SLIP-0043 custom derivation paths for OIP identity keys.
 * Uses secp256k1 for signing (BIP-32 compatible).
 */

const { HDKey } = require('@scure/bip32');
const { sha256 } = require('@noble/hashes/sha256');
const { secp256k1 } = require('@noble/curves/secp256k1');
const { bytesToHex, hexToBytes } = require('@noble/hashes/utils');
const base64url = require('base64url');

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * OIP custom purpose under SLIP-0043
 */
const OIP_PURPOSE = 176800;

/**
 * Sub-purpose indices for different key uses
 */
const SubPurpose = {
    IDENTITY_SIGN: 0,      // DID assertion/authentication keys (xpub mode)
    IDENTITY_ENCRYPT: 1,   // DID keyAgreement - x25519 (binding mode)
    DELEGATION: 2,         // Delegate capability keys (binding mode)
    REVOCATION: 3,         // Revoke/expire other keys (binding mode)
    JWT: 4,                // App/API tokens (xpub or binding)
    SSH: 5,                // SSH login keys (binding mode)
    BACKUP: 6,             // Rolling backup encryption (hardened only, never publish)
    ONION: 7,              // Tor onion service identity (hardened only)
    EXPERIMENTAL: 8        // Future expansion (binding mode default)
};

/**
 * Verification mode policies per sub-purpose
 */
const VerificationPolicy = {
    [SubPurpose.IDENTITY_SIGN]: 'xpub',      // Third parties can derive pubkey from xpub
    [SubPurpose.IDENTITY_ENCRYPT]: 'binding', // Explicit pubkey with JWS proof
    [SubPurpose.DELEGATION]: 'binding',       // Auditable authorization chains
    [SubPurpose.REVOCATION]: 'binding',       // Explicit revocation authority
    [SubPurpose.JWT]: 'xpub',                 // Third-party token verification
    [SubPurpose.SSH]: 'binding',              // SSH expects explicit keys
    [SubPurpose.BACKUP]: 'none',              // Never publish
    [SubPurpose.ONION]: 'none',               // Never publish
    [SubPurpose.EXPERIMENTAL]: 'binding'      // Safe default
};

/**
 * OIP version for v0.9 records
 */
const OIP_VERSION = '0.9.0';

// ═══════════════════════════════════════════════════════════════════════════
// KEY DERIVATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Builds derivation path: m / 176800' / sub-purpose' / account' / index[']
 * 
 * @param {number} subPurpose - Sub-purpose index (0-8)
 * @param {number} account - Account index
 * @param {number} index - Leaf index
 * @param {boolean} hardened - Whether leaf is hardened
 * @returns {string} Derivation path string
 */
function getDerivationPath(subPurpose, account, index, hardened = false) {
    const leafSuffix = hardened ? "'" : "";
    return `m/${OIP_PURPOSE}'/${subPurpose}'/${account}'/${index}${leafSuffix}`;
}

/**
 * Gets the xpub derivation base path: m / 176800' / sub-purpose' / account'
 * This is the path at which the xpub is published in creator DID documents.
 * 
 * @param {number} subPurpose - Sub-purpose index
 * @param {number} account - Account index
 * @returns {string} Base derivation path
 */
function getXpubBasePath(subPurpose, account) {
    return `m/${OIP_PURPOSE}'/${subPurpose}'/${account}'`;
}

/**
 * Derives key index from payload digest per OIP v0.9 spec.
 * 
 * Algorithm: uint31(SHA256("oip:" + payloadDigest))
 * 
 * @param {string} payloadDigest - Base64URL-encoded payload digest
 * @returns {number} Derived index (31-bit unsigned integer)
 */
function deriveIndexFromPayloadDigest(payloadDigest) {
    const input = `oip:${payloadDigest}`;
    const hash = sha256(new TextEncoder().encode(input));
    // Take first 4 bytes as uint32, mask to uint31 (clear high bit)
    const view = new DataView(hash.buffer, hash.byteOffset, hash.byteLength);
    return view.getUint32(0, false) & 0x7FFFFFFF;
}

/**
 * Computes the payload digest for a DataForSignature object.
 * This is computed BEFORE adding CreatorSig, KeyIndex, PayloadDigest tags.
 * 
 * @param {object} payload - DataForSignature without signature tags
 * @returns {string} Base64URL-encoded SHA256 digest
 */
function computePayloadDigest(payload) {
    // Canonical JSON serialization (sorted keys, no whitespace)
    const canonical = canonicalJson(payload);
    const hash = sha256(new TextEncoder().encode(canonical));
    return base64url.encode(Buffer.from(hash));
}

/**
 * Canonical JSON serialization for deterministic digests.
 * Sorts keys alphabetically, removes whitespace.
 * 
 * @param {object} obj - Object to serialize
 * @returns {string} Canonical JSON string
 */
function canonicalJson(obj) {
    return JSON.stringify(obj, (key, value) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return Object.keys(value).sort().reduce((sorted, k) => {
                sorted[k] = value[k];
                return sorted;
            }, {});
        }
        return value;
    });
}

/**
 * Creates an OIP identity from a BIP-39 mnemonic.
 * 
 * @param {string} mnemonic - BIP-39 mnemonic phrase
 * @param {number} account - Account index (default 0)
 * @returns {object} OIP identity with signing keys
 */
function createIdentityFromMnemonic(mnemonic, account = 0) {
    const { mnemonicToSeedSync } = require('@scure/bip39');
    const seed = mnemonicToSeedSync(mnemonic);
    const masterKey = HDKey.fromMasterSeed(seed);
    
    // Derive signing xpub at m/176800'/0'/account'
    const signingBasePath = getXpubBasePath(SubPurpose.IDENTITY_SIGN, account);
    const signingKey = masterKey.derive(signingBasePath);
    
    // Generate DID from master public key
    const did = generateDidFromPubKey(masterKey.publicKey);
    
    return {
        did,
        signingXpub: signingKey.publicExtendedKey,
        signingXprv: signingKey.privateExtendedKey,
        signingKey: signingKey,
        masterKey: masterKey,
        account
    };
}

/**
 * Generates did:arweave identifier from public key.
 * Uses SHA256 hash of public key, base64url encoded.
 * 
 * @param {Uint8Array} publicKey - Compressed public key bytes
 * @returns {string} DID identifier
 */
function generateDidFromPubKey(publicKey) {
    const hash = sha256(publicKey);
    const address = base64url.encode(Buffer.from(hash));
    return `did:arweave:${address}`;
}

/**
 * Derives a child signing key for a specific payload.
 * 
 * @param {HDKey} signingKey - Base signing key at xpub path
 * @param {string} payloadDigest - Payload digest for index derivation
 * @returns {HDKey} Derived child key
 */
function deriveSigningKeyForPayload(signingKey, payloadDigest) {
    const index = deriveIndexFromPayloadDigest(payloadDigest);
    return signingKey.deriveChild(index);
}

/**
 * Derives child public key from xpub for verification.
 * 
 * @param {string} xpub - Extended public key string
 * @param {string} payloadDigest - Payload digest for index derivation
 * @returns {Uint8Array} Derived public key
 */
function deriveVerificationKey(xpub, payloadDigest) {
    const hdKey = HDKey.fromExtendedKey(xpub);
    const index = deriveIndexFromPayloadDigest(payloadDigest);
    return hdKey.deriveChild(index).publicKey;
}

/**
 * Validates a mnemonic phrase.
 * 
 * @param {string} mnemonic - Mnemonic phrase to validate
 * @returns {boolean} True if valid
 */
function validateMnemonic(mnemonic) {
    const { validateMnemonic: validate } = require('@scure/bip39');
    const { wordlist } = require('@scure/bip39/wordlists/english');
    return validate(mnemonic, wordlist);
}

/**
 * Generates a new random mnemonic phrase.
 * 
 * @param {number} strength - Entropy bits (128 = 12 words, 256 = 24 words)
 * @returns {string} Mnemonic phrase
 */
function generateMnemonic(strength = 256) {
    const { generateMnemonic: generate } = require('@scure/bip39');
    const { wordlist } = require('@scure/bip39/wordlists/english');
    return generate(wordlist, strength);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    // Constants
    OIP_PURPOSE,
    OIP_VERSION,
    SubPurpose,
    VerificationPolicy,
    
    // Key Derivation
    getDerivationPath,
    getXpubBasePath,
    deriveIndexFromPayloadDigest,
    computePayloadDigest,
    canonicalJson,
    createIdentityFromMnemonic,
    generateDidFromPubKey,
    deriveSigningKeyForPayload,
    deriveVerificationKey,
    
    // Mnemonic utilities
    validateMnemonic,
    generateMnemonic
};

