/**
 * OIP v0.9.0 Hardcoded Template Definitions
 * 
 * These templates are hardcoded for bootstrap. The first v0.9 records published
 * will be the actual template definitions that others can use.
 * 
 * Similar to how creatorRegistration was hardcoded in v0.8.
 */

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATE DIDs (To be replaced with actual txIds after publishing)
// ═══════════════════════════════════════════════════════════════════════════

const TEMPLATE_DIDS = {
    // Existing v0.8 templates (keep for backward compatibility)
    basic: 'did:arweave:-9DirnjVO1FlbEW1lN8jITBESrTsQKEM_BoZ1ey_0mk',
    creatorRegistration: 'did:arweave:LEGACY_CREATOR_TEMPLATE', // v0.8 legacy
    image: 'did:arweave:AkZnE1VckJJlRamgNJuIGE7KrYwDcCciWOMrMh68V4o',
    post: 'did:arweave:op6y-d_6bqivJ2a2oWQnbylD4X_LH6eQyR6rCGqtVZ8',
    
    // New v0.9 templates (placeholder DIDs until first publish)
    didDocument: 'did:arweave:oLdaefbl46MSQTljX6QSvlhWLAjhg0CLY8ejHDj-XxM',
    didVerificationMethod: 'did:arweave:mT1c8GcBRrzQ39treEUiS7_K8KyBEH_aXo0L4mdAQHw',
    socialMedia: 'did:arweave:qH5crxeNs44ReuuIAxoU3Ax_nRVku2GXtedQsk3tE4Y',
    communication: 'did:arweave:smEHXLQo1dYL9hEvVMvyyOTqZ0OZg-earraTTl-J11A'
};

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATE SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * didVerificationMethod Template
 * W3C DID Verification Method with OIP derivation extensions.
 */
const didVerificationMethodSchema = {
    templateDid: TEMPLATE_DIDS.didVerificationMethod,
    recordType: 'didVerificationMethod',
    fields: {
        0: { name: 'vmId', type: 'string', description: 'VM fragment ID (e.g., "#sign-0")' },
        1: { name: 'vmType', type: 'string', description: 'Key type (e.g., "oip:XpubDerivation2025")' },
        2: { name: 'controller', type: 'dref', description: 'DID that controls this key' },
        3: { name: 'publicKeyMultibase', type: 'string', description: 'Public key (multibase encoded)' },
        4: { name: 'publicKeyJwk', type: 'json', description: 'Public key (JWK format)' },
        5: { name: 'xpub', type: 'string', description: 'Extended public key for derivation' },
        6: { name: 'derivationSubPurpose', type: 'string', description: 'Sub-purpose identifier' },
        7: { name: 'derivationAccount', type: 'uint32', description: 'Account index' },
        8: { name: 'derivationPathPrefix', type: 'string', description: 'Full derivation path prefix' },
        9: { name: 'leafIndexPolicy', type: 'string', description: '"payload_digest" | "sequential" | "fixed"' },
        10: { name: 'leafIndexFixed', type: 'uint32', description: 'Fixed index if policy is "fixed"' },
        11: { name: 'leafHardened', type: 'bool', description: 'Whether leaf derivation is hardened' },
        12: { name: 'validFromBlock', type: 'uint64', description: 'Block height when key becomes valid' },
        13: { name: 'revokedFromBlock', type: 'uint64', description: 'Block height when key is revoked' },
        14: { name: 'bindingProofJws', type: 'string', description: 'JWS binding proof for hardened keys' },
        15: { name: 'bindingProofPurpose', type: 'string', description: 'Purpose of binding proof' }
    }
};

/**
 * didDocument Template
 * W3C DID Document with OIP profile extension.
 */
const didDocumentSchema = {
    templateDid: TEMPLATE_DIDS.didDocument,
    recordType: 'didDocument',
    fields: {
        0: { name: 'did', type: 'string', description: 'The DID subject' },
        1: { name: 'controller', type: 'dref', description: 'DID that controls this document' },
        2: { name: 'verificationMethod', type: 'repeated dref', description: 'List of verification methods' },
        3: { name: 'authentication', type: 'repeated string', description: 'Authentication method refs' },
        4: { name: 'assertionMethod', type: 'repeated string', description: 'Assertion method refs' },
        5: { name: 'keyAgreement', type: 'repeated string', description: 'Key agreement method refs' },
        6: { name: 'service', type: 'json', description: 'Service endpoints (JSON array)' },
        7: { name: 'alsoKnownAs', type: 'repeated string', description: 'Alternative identifiers' },
        // OIP Profile fields
        8: { name: 'oipHandleRaw', type: 'string', description: 'Handle as entered (preserves case)' },
        9: { name: 'oipHandle', type: 'string', description: 'Normalized handle (lowercase)' },
        10: { name: 'oipName', type: 'string', description: 'Display name' },
        11: { name: 'oipSurname', type: 'string', description: 'Surname/family name' },
        12: { name: 'oipLanguage', type: 'string', description: 'Preferred language (ISO 639-1)' },
        13: { name: 'oipSocialX', type: 'string', description: 'X/Twitter handle' },
        14: { name: 'oipSocialYoutube', type: 'string', description: 'YouTube channel' },
        15: { name: 'oipSocialInstagram', type: 'string', description: 'Instagram handle' },
        16: { name: 'oipSocialTiktok', type: 'string', description: 'TikTok handle' },
        17: { name: 'anchorArweaveTxid', type: 'string', description: 'Anchor transaction ID' },
        18: { name: 'keyBindingPolicy', type: 'string', description: '"xpub" | "binding"' }
    }
};

/**
 * socialMedia Template
 */
const socialMediaSchema = {
    templateDid: TEMPLATE_DIDS.socialMedia,
    recordType: 'socialMedia',
    fields: {
        0: { name: 'website', type: 'repeated dref', description: 'Website URLs' },
        1: { name: 'youtube', type: 'repeated dref', description: 'YouTube channel refs' },
        2: { name: 'x', type: 'string', description: 'X/Twitter handle' },
        3: { name: 'instagram', type: 'repeated string', description: 'Instagram handles' },
        4: { name: 'tiktok', type: 'repeated string', description: 'TikTok handles' }
    }
};

/**
 * communication Template
 */
const communicationSchema = {
    templateDid: TEMPLATE_DIDS.communication,
    recordType: 'communication',
    fields: {
        0: { name: 'phone', type: 'repeated string', description: 'Phone numbers' },
        1: { name: 'email', type: 'repeated string', description: 'Email addresses' },
        2: { name: 'signal', type: 'repeated string', description: 'Signal identifiers' }
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATE REGISTRY
// ═══════════════════════════════════════════════════════════════════════════

const V09_TEMPLATES = {
    didDocument: didDocumentSchema,
    didVerificationMethod: didVerificationMethodSchema,
    socialMedia: socialMediaSchema,
    communication: communicationSchema
};

/**
 * Gets template schema by record type.
 * 
 * @param {string} recordType - Record type name
 * @returns {object|null} Template schema
 */
function getTemplateSchema(recordType) {
    return V09_TEMPLATES[recordType] || null;
}

/**
 * Gets field name by index for a record type.
 * 
 * @param {string} recordType - Record type name
 * @param {number} fieldIndex - Field index
 * @returns {string|null} Field name
 */
function getFieldName(recordType, fieldIndex) {
    const schema = V09_TEMPLATES[recordType];
    if (!schema) return null;
    return schema.fields[fieldIndex]?.name || null;
}

/**
 * Gets field index by name for a record type.
 * 
 * @param {string} recordType - Record type name
 * @param {string} fieldName - Field name
 * @returns {number|null} Field index
 */
function getFieldIndex(recordType, fieldName) {
    const schema = V09_TEMPLATES[recordType];
    if (!schema) return null;
    
    for (const [index, field] of Object.entries(schema.fields)) {
        if (field.name === fieldName) {
            return parseInt(index);
        }
    }
    return null;
}

/**
 * Expands a compressed record using template schema.
 * Converts { "0": value, "1": value } to { fieldName: value, ... }
 * 
 * @param {object} compressedRecord - Record with numeric field indices
 * @param {string} recordType - Record type name
 * @returns {object} Expanded record with field names
 */
function expandRecord(compressedRecord, recordType) {
    const schema = V09_TEMPLATES[recordType];
    if (!schema) return compressedRecord;
    
    const expanded = { t: compressedRecord.t };
    for (const [index, value] of Object.entries(compressedRecord)) {
        if (index === 't') continue;
        const fieldName = schema.fields[parseInt(index)]?.name || index;
        expanded[fieldName] = value;
    }
    return expanded;
}

/**
 * Compresses an expanded record using template schema.
 * Converts { fieldName: value, ... } to { "0": value, "1": value }
 * 
 * @param {object} expandedRecord - Record with field names
 * @param {string} recordType - Record type name
 * @returns {object} Compressed record with numeric indices
 */
function compressRecord(expandedRecord, recordType) {
    const schema = V09_TEMPLATES[recordType];
    if (!schema) return expandedRecord;
    
    const compressed = { t: expandedRecord.t };
    
    for (const [fieldName, value] of Object.entries(expandedRecord)) {
        if (fieldName === 't') continue;
        
        const index = getFieldIndex(recordType, fieldName);
        if (index !== null) {
            compressed[index] = value;
        } else {
            // Keep unknown fields as-is
            compressed[fieldName] = value;
        }
    }
    
    return compressed;
}

/**
 * Checks if a record type is a v0.9 template.
 * 
 * @param {string} recordType - Record type name
 * @returns {boolean}
 */
function isV09RecordType(recordType) {
    return recordType in V09_TEMPLATES;
}

/**
 * Gets all v0.9 record types.
 * 
 * @returns {string[]} Array of record type names
 */
function getV09RecordTypes() {
    return Object.keys(V09_TEMPLATES);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    TEMPLATE_DIDS,
    V09_TEMPLATES,
    didDocumentSchema,
    didVerificationMethodSchema,
    socialMediaSchema,
    communicationSchema,
    getTemplateSchema,
    getFieldName,
    getFieldIndex,
    expandRecord,
    compressRecord,
    isV09RecordType,
    getV09RecordTypes
};

