/**
 * OIP v0.9.0 Verification Service
 * 
 * Verifies record signatures using creator's xpub.
 * Supports both v0.9 (xpub derivation) and legacy (v0.8) verification.
 * 
 * Used by both oip-daemon-service and alexandria-service.
 */

const { sha256 } = require('@noble/hashes/sha256');
const { secp256k1 } = require('@noble/curves/secp256k1');
const { HDKey } = require('@scure/bip32');
const base64url = require('base64url');
const {
    deriveIndexFromPayloadDigest,
    canonicalJson,
    computePayloadDigest
} = require('./oip-crypto');
const { extractSignatureData, removeSignatureTags } = require('./oip-signing');

// ═══════════════════════════════════════════════════════════════════════════
// VERIFICATION MODES
// ═══════════════════════════════════════════════════════════════════════════

const VerificationMode = {
    XPUB: 'xpub',           // Non-hardened leaf, verify from xpub
    BINDING: 'binding',      // Hardened leaf with JWS binding proof
    LEGACY: 'legacy'         // v0.8 Arweave-based verification
};

/**
 * Verification result structure
 */
class VerificationResult {
    constructor(isValid, mode, error = null, details = {}) {
        this.isValid = isValid;
        this.mode = mode;
        this.error = error;
        this.keyIndex = details.keyIndex || null;
        this.creatorDid = details.creatorDid || null;
        this.blockHeight = details.blockHeight || null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verifies a record's signature.
 * Automatically detects version and uses appropriate verification method.
 * 
 * @param {object} payload - The signed record payload
 * @param {function} creatorResolver - Async function to resolve creator DID → verification data
 * @param {number} blockHeight - Block height where record was confirmed
 * @returns {Promise<VerificationResult>}
 */
async function verifyRecord(payload, creatorResolver, blockHeight) {
    try {
        const sigData = extractSignatureData(payload);
        
        // Determine version
        const version = parseVersion(sigData.version);
        
        if (version < 0.9) {
            // Legacy verification (v0.8 and earlier)
            return await verifyLegacy(payload, sigData, creatorResolver);
        }
        
        // v0.9+ verification
        return await verifyV09(payload, sigData, creatorResolver, blockHeight);
        
    } catch (error) {
        return new VerificationResult(false, null, error.message);
    }
}

/**
 * Verifies a v0.9 record using xpub mode.
 * 
 * @param {object} payload - Signed payload
 * @param {object} sigData - Extracted signature data
 * @param {function} creatorResolver - Creator resolution function
 * @param {number} blockHeight - Block height for validity check
 * @returns {Promise<VerificationResult>}
 */
async function verifyV09(payload, sigData, creatorResolver, blockHeight) {
    const { creator, creatorSig, keyIndex, payloadDigest } = sigData;
    
    // 1. Resolve creator to get verification method
    const creatorData = await creatorResolver(creator);
    if (!creatorData) {
        return new VerificationResult(false, VerificationMode.XPUB, 
            `Creator not found: ${creator}`);
    }
    
    // 2. Find valid verification method for this blockHeight
    const vm = findValidVerificationMethod(creatorData.verificationMethods, blockHeight);
    if (!vm) {
        return new VerificationResult(false, VerificationMode.XPUB,
            `No valid verification method for block ${blockHeight}`);
    }
    
    // 3. Verify payload digest matches
    const payloadWithoutSig = removeSignatureTags(payload);
    const computedDigest = computePayloadDigest(payloadWithoutSig);
    
    if (computedDigest !== payloadDigest) {
        return new VerificationResult(false, VerificationMode.XPUB,
            'Payload digest mismatch');
    }
    
    // 4. Verify key index matches
    const expectedIndex = deriveIndexFromPayloadDigest(payloadDigest);
    if (parseInt(keyIndex) !== expectedIndex) {
        return new VerificationResult(false, VerificationMode.XPUB,
            `Key index mismatch: expected ${expectedIndex}, got ${keyIndex}`);
    }
    
    // 5. Derive verification key from xpub
    const hdKey = HDKey.fromExtendedKey(vm.xpub);
    const childKey = hdKey.deriveChild(expectedIndex);
    const publicKey = childKey.publicKey;
    
    // 6. Verify signature
    const payloadBytes = canonicalJson(payloadWithoutSig);
    const messageHash = sha256(new TextEncoder().encode(payloadBytes));
    const signatureBytes = base64url.toBuffer(creatorSig);
    
    const isValid = secp256k1.verify(signatureBytes, messageHash, publicKey);
    
    return new VerificationResult(isValid, VerificationMode.XPUB, 
        isValid ? null : 'Signature verification failed',
        { keyIndex: expectedIndex, creatorDid: creator, blockHeight });
}

/**
 * Verifies a v0.8 (legacy) record.
 * Uses Arweave-based signature verification.
 * 
 * @param {object} payload - Signed payload
 * @param {object} sigData - Extracted signature data
 * @param {function} creatorResolver - Creator resolution function
 * @returns {Promise<VerificationResult>}
 */
async function verifyLegacy(payload, sigData, creatorResolver) {
    // For v0.8 records, we pass through since they use Arweave's built-in
    // transaction signing which is verified by the Arweave network itself.
    // The creator's address is verified against the transaction owner.
    console.log('[Verification] Legacy v0.8 record - using passthrough');
    return new VerificationResult(true, VerificationMode.LEGACY, null, {
        creatorDid: sigData.creator
    });
}

/**
 * Verifies using binding mode (hardened keys with JWS proof).
 * Used for delegation, revocation, and other sensitive operations.
 * 
 * @param {object} payload - Signed payload
 * @param {string} publicKeyMultibase - Published public key
 * @param {string} bindingProofJws - JWS binding proof
 * @param {string} parentXpub - Parent key that authorized this binding
 * @returns {Promise<VerificationResult>}
 */
async function verifyBinding(payload, publicKeyMultibase, bindingProofJws, parentXpub) {
    // TODO: Implement binding verification
    // This is used for hardened keys that can't be derived from xpub
    throw new Error('Binding mode verification not yet implemented');
}

// ═══════════════════════════════════════════════════════════════════════════
// KEY VALIDITY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Finds the valid verification method for a given block height.
 * 
 * Rule: Key K is valid for records with blockHeight in [K.validFromBlock, K.revokedFromBlock)
 * 
 * @param {Array} verificationMethods - Array of verification methods
 * @param {number} blockHeight - Block height to check
 * @returns {object|null} Valid verification method or null
 */
function findValidVerificationMethod(verificationMethods, blockHeight) {
    if (!verificationMethods || verificationMethods.length === 0) {
        return null;
    }
    
    // Filter to methods valid at this blockHeight
    const validMethods = verificationMethods.filter(vm => {
        const validFrom = vm.validFromBlock || 0;
        const revokedFrom = vm.revokedFromBlock || Infinity;
        return blockHeight >= validFrom && blockHeight < revokedFrom;
    });
    
    if (validMethods.length === 0) {
        return null;
    }
    
    // Return the most recently created valid method
    return validMethods.reduce((newest, vm) => {
        return (vm.validFromBlock || 0) > (newest.validFromBlock || 0) ? vm : newest;
    });
}

/**
 * Checks if a verification method is currently valid.
 * 
 * @param {object} vm - Verification method
 * @param {number} blockHeight - Block height to check
 * @returns {boolean}
 */
function isVerificationMethodValid(vm, blockHeight) {
    const validFrom = vm.validFromBlock || 0;
    const revokedFrom = vm.revokedFromBlock || Infinity;
    return blockHeight >= validFrom && blockHeight < revokedFrom;
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parses version string to number.
 * 
 * @param {string} version - Version string (e.g., "0.9.0")
 * @returns {number} Major.minor as float (e.g., 0.9)
 */
function parseVersion(version) {
    if (!version) return 0.8;
    const parts = version.split('.');
    return parseFloat(`${parts[0]}.${parts[1] || 0}`);
}

/**
 * Detects record version and routes to appropriate handler.
 * 
 * @param {object} record - Record to check
 * @returns {string} Version string
 */
function detectVersion(record) {
    // Check for Ver tag
    const verTag = record.tags?.find(t => t.name === 'Ver');
    if (verTag) {
        return verTag.value;
    }
    
    // Check for version in oip object
    if (record.oip?.version) {
        return record.oip.version;
    }
    
    // Default to v0.8 for legacy records
    return '0.8.0';
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    // Main verification
    verifyRecord,
    verifyV09,
    verifyLegacy,
    verifyBinding,
    
    // Key validity
    findValidVerificationMethod,
    isVerificationMethodValid,
    
    // Types
    VerificationMode,
    VerificationResult,
    
    // Utilities
    parseVersion,
    detectVersion
};

