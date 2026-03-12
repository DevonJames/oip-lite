/**
 * Elasticsearch mappings for OIP v0.9 record types
 * 
 * These mappings define how v0.9 DID-related records are indexed.
 */

// ═══════════════════════════════════════════════════════════════════════════
// DID DOCUMENT MAPPING
// ═══════════════════════════════════════════════════════════════════════════

const didDocumentMapping = {
    properties: {
        // Core DID fields
        'oip.data.did': { type: 'keyword' },
        'oip.data.controller': { type: 'keyword' },
        
        // Verification method references
        'oip.data.verificationMethod': { type: 'keyword' },
        'oip.data.authentication': { type: 'keyword' },
        'oip.data.assertionMethod': { type: 'keyword' },
        'oip.data.keyAgreement': { type: 'keyword' },
        'oip.data.capabilityInvocation': { type: 'keyword' },
        'oip.data.capabilityDelegation': { type: 'keyword' },
        
        // Alternative identifiers
        'oip.data.alsoKnownAs': { type: 'keyword' },
        
        // Service endpoints (stored as JSON text)
        'oip.data.service': { type: 'text' },
        
        // OIP Profile fields
        'oip.data.oipHandle': { 
            type: 'keyword',
            normalizer: 'lowercase' // For case-insensitive lookups
        },
        'oip.data.oipHandleRaw': { type: 'text' },
        'oip.data.oipName': { 
            type: 'text',
            fields: {
                keyword: { type: 'keyword' }
            }
        },
        'oip.data.oipSurname': { 
            type: 'text',
            fields: {
                keyword: { type: 'keyword' }
            }
        },
        'oip.data.oipLanguage': { type: 'keyword' },
        
        // Social media handles
        'oip.data.oipSocialX': { type: 'keyword' },
        'oip.data.oipSocialYoutube': { type: 'keyword' },
        'oip.data.oipSocialInstagram': { type: 'keyword' },
        'oip.data.oipSocialTiktok': { type: 'keyword' },
        
        // Anchoring
        'oip.data.anchorArweaveTxid': { type: 'keyword' },
        
        // Policy
        'oip.data.keyBindingPolicy': { type: 'keyword' }
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// DID VERIFICATION METHOD MAPPING
// ═══════════════════════════════════════════════════════════════════════════

const didVerificationMethodMapping = {
    properties: {
        // Core VM fields
        'oip.data.vmId': { type: 'keyword' },
        'oip.data.vmType': { type: 'keyword' },
        'oip.data.controller': { type: 'keyword' },
        
        // Key material
        'oip.data.publicKeyMultibase': { type: 'keyword' },
        'oip.data.publicKeyJwk': { type: 'text' }, // JSON stored as text
        'oip.data.xpub': { type: 'keyword' },
        
        // Derivation parameters
        'oip.data.derivationSubPurpose': { type: 'keyword' },
        'oip.data.derivationAccount': { type: 'integer' },
        'oip.data.derivationPathPrefix': { type: 'keyword' },
        'oip.data.leafIndexPolicy': { type: 'keyword' },
        'oip.data.leafIndexFixed': { type: 'integer' },
        'oip.data.leafHardened': { type: 'boolean' },
        
        // Validity window
        'oip.data.validFromBlock': { type: 'long' },
        'oip.data.revokedFromBlock': { type: 'long' },
        
        // Binding proof (for hardened keys)
        'oip.data.bindingProofJws': { type: 'text' },
        'oip.data.bindingProofPurpose': { type: 'keyword' }
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// SOCIAL MEDIA MAPPING
// ═══════════════════════════════════════════════════════════════════════════

const socialMediaMapping = {
    properties: {
        'oip.data.website': { type: 'keyword' },
        'oip.data.youtube': { type: 'keyword' },
        'oip.data.x': { type: 'keyword' },
        'oip.data.instagram': { type: 'keyword' },
        'oip.data.tiktok': { type: 'keyword' }
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// COMMUNICATION MAPPING
// ═══════════════════════════════════════════════════════════════════════════

const communicationMapping = {
    properties: {
        'oip.data.phone': { type: 'keyword' },
        'oip.data.email': { type: 'keyword' },
        'oip.data.signal': { type: 'keyword' }
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// v0.9 COMMON FIELDS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Common OIP v0.9 fields added to all records.
 * These track signature verification data.
 */
const v09CommonFields = {
    properties: {
        // Version tracking
        'oip.version': { type: 'keyword' },
        
        // Signature data
        'oip.signature.payloadDigest': { type: 'keyword' },
        'oip.signature.keyIndex': { type: 'long' },
        'oip.signature.creatorSig': { type: 'keyword' },
        
        // Verification status
        'oip.verification.verified': { type: 'boolean' },
        'oip.verification.mode': { type: 'keyword' },
        'oip.verification.verifiedAt': { type: 'date' }
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// MAPPING REGISTRY
// ═══════════════════════════════════════════════════════════════════════════

const V09_MAPPINGS = {
    didDocument: didDocumentMapping,
    didVerificationMethod: didVerificationMethodMapping,
    socialMedia: socialMediaMapping,
    communication: communicationMapping
};

/**
 * Gets the mapping for a v0.9 record type.
 * 
 * @param {string} recordType - Record type name
 * @returns {object|null} Elasticsearch mapping
 */
function getV09Mapping(recordType) {
    return V09_MAPPINGS[recordType] || null;
}

/**
 * Gets all v0.9 record types that have mappings.
 * 
 * @returns {string[]} Array of record type names
 */
function getV09RecordTypes() {
    return Object.keys(V09_MAPPINGS);
}

/**
 * Merges v0.9 common fields into a mapping.
 * 
 * @param {object} mapping - Base mapping
 * @returns {object} Merged mapping with common fields
 */
function withCommonFields(mapping) {
    return {
        properties: {
            ...mapping.properties,
            ...v09CommonFields.properties
        }
    };
}

/**
 * Gets the complete mapping for a v0.9 record type including common fields.
 * 
 * @param {string} recordType - Record type name
 * @returns {object|null} Complete Elasticsearch mapping
 */
function getCompleteV09Mapping(recordType) {
    const baseMapping = V09_MAPPINGS[recordType];
    if (!baseMapping) return null;
    return withCommonFields(baseMapping);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    // Individual mappings
    didDocumentMapping,
    didVerificationMethodMapping,
    socialMediaMapping,
    communicationMapping,
    v09CommonFields,
    
    // Registry
    V09_MAPPINGS,
    getV09Mapping,
    getV09RecordTypes,
    
    // Helpers
    withCommonFields,
    getCompleteV09Mapping
};

