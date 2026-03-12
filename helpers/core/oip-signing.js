/**
 * OIP v0.9.0 Signing Service
 * 
 * Handles record signing with HD-derived keys.
 * Note: This is primarily for SERVER-SIDE operations.
 * Client-side signing uses the SDK (Phase 4).
 */

const { sha256 } = require('@noble/hashes/sha256');
const { secp256k1 } = require('@noble/curves/secp256k1');
const base64url = require('base64url');
const {
    computePayloadDigest,
    deriveIndexFromPayloadDigest,
    canonicalJson,
    OIP_VERSION
} = require('./oip-crypto');

// ═══════════════════════════════════════════════════════════════════════════
// SIGNING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Signs a DataForSignature payload with HD key derivation.
 * 
 * Process:
 * 1. Compute payload digest (before sig tags)
 * 2. Derive key index from digest
 * 3. Sign the digest
 * 4. Add CreatorSig, KeyIndex, PayloadDigest tags
 * 
 * @param {object} payload - DataForSignature object (without sig tags)
 * @param {HDKey} signingKey - Base signing key (at xpub path)
 * @returns {object} Payload with signature tags added
 */
function signPayload(payload, signingKey) {
    // 1. Compute payload digest
    const payloadDigest = computePayloadDigest(payload);
    
    // 2. Derive key index and child key
    const index = deriveIndexFromPayloadDigest(payloadDigest);
    const childKey = signingKey.deriveChild(index);
    
    // 3. Sign the payload hash
    const payloadBytes = canonicalJson(payload);
    const messageHash = sha256(new TextEncoder().encode(payloadBytes));
    const signature = secp256k1.sign(messageHash, childKey.privateKey);
    const signatureBase64 = base64url.encode(Buffer.from(signature.toCompactRawBytes()));
    
    // 4. Add signature tags
    const signedPayload = JSON.parse(JSON.stringify(payload)); // Deep clone
    signedPayload.tags.push({ name: 'PayloadDigest', value: payloadDigest });
    signedPayload.tags.push({ name: 'KeyIndex', value: index.toString() });
    signedPayload.tags.push({ name: 'CreatorSig', value: signatureBase64 });
    
    return signedPayload;
}

/**
 * Prepares a payload with required OIP tags before signing.
 * 
 * @param {object} payload - Raw payload
 * @param {string} creatorDid - Creator's DID
 * @returns {object} Payload with required tags
 */
function preparePayloadForSigning(payload, creatorDid) {
    const prepared = JSON.parse(JSON.stringify(payload));
    
    // Ensure @context
    if (!prepared['@context']) {
        prepared['@context'] = creatorDid;
    }
    
    // Ensure required tags
    if (!prepared.tags) prepared.tags = [];
    
    const hasTag = (name) => prepared.tags.some(t => t.name === name);
    
    if (!hasTag('Index-Method')) {
        prepared.tags.unshift({ name: 'Index-Method', value: 'OIP' });
    }
    if (!hasTag('Ver')) {
        prepared.tags.push({ name: 'Ver', value: OIP_VERSION });
    }
    if (!hasTag('Content-Type')) {
        prepared.tags.push({ name: 'Content-Type', value: 'application/json' });
    }
    if (!hasTag('Creator')) {
        prepared.tags.push({ name: 'Creator', value: creatorDid });
    }
    
    return prepared;
}

/**
 * Extracts signature components from a signed payload.
 * 
 * @param {object} payload - Signed DataForSignature object
 * @returns {object} Extracted signature data
 */
function extractSignatureData(payload) {
    const tags = payload.tags || [];
    const getTag = (name) => tags.find(t => t.name === name)?.value;
    
    return {
        creator: getTag('Creator'),
        creatorSig: getTag('CreatorSig'),
        keyIndex: getTag('KeyIndex'),
        payloadDigest: getTag('PayloadDigest'),
        version: getTag('Ver') || '0.8'
    };
}

/**
 * Removes signature tags from payload for verification.
 * 
 * @param {object} payload - Signed payload
 * @returns {object} Payload without signature tags
 */
function removeSignatureTags(payload) {
    const signatureTags = ['CreatorSig', 'KeyIndex', 'PayloadDigest'];
    const cleaned = JSON.parse(JSON.stringify(payload));
    cleaned.tags = cleaned.tags.filter(t => !signatureTags.includes(t.name));
    return cleaned;
}

/**
 * Checks if a payload has valid signature tags.
 * 
 * @param {object} payload - Payload to check
 * @returns {boolean} True if payload has all required signature tags
 */
function hasSignatureTags(payload) {
    const sigData = extractSignatureData(payload);
    return !!(sigData.creatorSig && sigData.keyIndex && sigData.payloadDigest);
}

/**
 * Signs a payload and returns it ready for Arweave submission.
 * Complete signing flow for server-side use.
 * 
 * @param {object} rawPayload - Raw payload data
 * @param {HDKey} signingKey - Base signing key
 * @param {string} creatorDid - Creator's DID
 * @returns {object} Fully signed payload
 */
function signRecord(rawPayload, signingKey, creatorDid) {
    const prepared = preparePayloadForSigning(rawPayload, creatorDid);
    return signPayload(prepared, signingKey);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    signPayload,
    preparePayloadForSigning,
    extractSignatureData,
    removeSignatureTags,
    hasSignatureTags,
    signRecord
};

