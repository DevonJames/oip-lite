/**
 * Sync Process Verification Integration
 * 
 * Integrates v0.9 signature verification into the Arweave sync process.
 * Records that fail verification are NOT indexed.
 */

const { verifyRecord, parseVersion, VerificationMode } = require('./oip-verification');

// ═══════════════════════════════════════════════════════════════════════════
// CREATOR RESOLVER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolves a creator DID to their verification data.
 * Used during signature verification.
 * 
 * @param {string} creatorDid - Creator's DID
 * @returns {Promise<object|null>} Creator verification data
 */
async function resolveCreator(creatorDid) {
    // Lazy load to avoid circular dependencies
    const { getRecords } = require('./elasticsearch');
    
    try {
        // Try to find DID document (v0.9 format)
        const didDocResults = await getRecords({
            recordType: 'didDocument',
            fieldName: 'oip.data.did',
            fieldSearch: creatorDid,
            limit: 1
        });
        
        if (didDocResults.records && didDocResults.records.length > 0) {
            const didDoc = didDocResults.records[0];
            
            // Get verification methods
            const vmRefs = didDoc.oip?.data?.verificationMethod || [];
            const verificationMethods = await resolveVerificationMethods(vmRefs);
            
            return {
                did: creatorDid,
                didDocument: didDoc,
                verificationMethods,
                isV09: true
            };
        }
        
        // Fall back to legacy creatorRegistration (v0.8)
        const legacyResults = await getRecords({
            recordType: 'creatorRegistration',
            fieldName: 'oip.creator.didAddress',
            fieldSearch: creatorDid,
            limit: 1
        });
        
        if (legacyResults.records && legacyResults.records.length > 0) {
            const legacy = legacyResults.records[0];
            return {
                did: creatorDid,
                legacyRecord: legacy,
                signingXpub: legacy.oip?.data?.signingXpub,
                isV09: false
            };
        }
        
        return null;
        
    } catch (error) {
        console.error(`[CreatorResolver] Error resolving ${creatorDid}:`, error);
        return null;
    }
}

/**
 * Resolves verification method references to full data.
 * 
 * @param {Array<string>} vmRefs - Array of verification method drefs
 * @returns {Promise<Array>} Resolved verification methods
 */
async function resolveVerificationMethods(vmRefs) {
    const { getRecords } = require('./elasticsearch');
    const methods = [];
    
    for (const ref of vmRefs) {
        try {
            // Handle local fragment refs (#sign-0) vs full drefs
            const vmResults = await getRecords({
                recordType: 'didVerificationMethod',
                did: ref.replace(/^#/, ''),
                limit: 1
            });
            
            if (vmResults.records && vmResults.records.length > 0) {
                const vm = vmResults.records[0];
                methods.push({
                    vmId: vm.oip?.data?.vmId,
                    vmType: vm.oip?.data?.vmType,
                    xpub: vm.oip?.data?.xpub,
                    validFromBlock: vm.oip?.data?.validFromBlock || vm.oip?.blockHeight,
                    revokedFromBlock: vm.oip?.data?.revokedFromBlock
                });
            }
        } catch (error) {
            console.error(`[CreatorResolver] Error resolving VM ${ref}:`, error);
        }
    }
    
    return methods;
}

// ═══════════════════════════════════════════════════════════════════════════
// SYNC VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verifies a record before indexing.
 * 
 * @param {object} record - Record to verify
 * @param {number} blockHeight - Block height where record was confirmed
 * @returns {Promise<{shouldIndex: boolean, verificationResult: object}>}
 */
async function verifyBeforeIndex(record, blockHeight) {
    try {
        // Get version from record
        const version = record.oip?.version || 
                       record.tags?.find(t => t.name === 'Ver')?.value ||
                       '0.8';
        
        const parsedVersion = parseVersion(version);
        
        // For v0.8 and earlier, use legacy passthrough
        if (parsedVersion < 0.9) {
            console.log(`[SyncVerification] v${version} record - legacy passthrough`);
            return {
                shouldIndex: true,
                verificationResult: {
                    isValid: true,
                    mode: VerificationMode.LEGACY,
                    version
                }
            };
        }
        
        // For v0.9+, verify signature
        console.log(`[SyncVerification] v${version} record - verifying signature`);
        
        const result = await verifyRecord(record, resolveCreator, blockHeight);
        
        if (!result.isValid) {
            console.error(`[SyncVerification] ❌ Verification failed: ${result.error}`);
            console.error(`[SyncVerification] Record will NOT be indexed`);
        } else {
            console.log(`[SyncVerification] ✅ Signature verified (mode: ${result.mode})`);
        }
        
        return {
            shouldIndex: result.isValid,
            verificationResult: result
        };
        
    } catch (error) {
        console.error(`[SyncVerification] Error during verification:`, error);
        // On error, don't index (fail safe)
        return {
            shouldIndex: false,
            verificationResult: {
                isValid: false,
                error: error.message
            }
        };
    }
}

/**
 * Handles legacy v0.8 records during indexing.
 * Preserves existing verification logic.
 * 
 * @param {object} record - Record to handle
 * @param {number} blockHeight - Block height
 * @returns {Promise<{shouldIndex: boolean, version: string, verificationMode: string}>}
 */
async function handleLegacyRecord(record, blockHeight) {
    // Use existing Arweave-based verification
    // (no changes to current indexing logic for v0.8 records)
    return {
        shouldIndex: true,
        version: '0.8',
        verificationMode: 'legacy'
    };
}

/**
 * Checks if a record is a v0.9+ record.
 * 
 * @param {object} record - Record to check
 * @returns {boolean}
 */
function isV09Record(record) {
    const version = record.oip?.version || 
                   record.tags?.find(t => t.name === 'Ver')?.value ||
                   '0.8';
    return parseVersion(version) >= 0.9;
}

/**
 * Gets the version from a record.
 * 
 * @param {object} record - Record to check
 * @returns {string} Version string
 */
function getRecordVersion(record) {
    return record.oip?.version || 
           record.tags?.find(t => t.name === 'Ver')?.value ||
           '0.8';
}

// ═══════════════════════════════════════════════════════════════════════════
// BOOTSTRAP VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bootstrap v0.9 Creator Configuration
 * 
 * INSTRUCTIONS TO ACTIVATE:
 * 1. Run: node scripts/bootstrap-v09-creator.js --generate
 * 2. Copy the generated values below
 * 3. Set BOOTSTRAP_V09_ENABLED = true
 * 4. Publish the DID document using the debug interface
 * 
 * This creator is used to publish the first v0.9 records.
 */
const BOOTSTRAP_V09_ENABLED = true; // Set to true after generating bootstrap creator

const BOOTSTRAP_V09_CREATOR = {
    // TODO: Replace with actual values from bootstrap script
    did: 'did:arweave:Lc1Ak-qzTdWSPGBoZYOBopBocRS5Mfy-vO6ChujzYbU',
    signingXpub: 'xpub6DMaz5ZtqvapPzE8xtHiZyNqcJetimwiNnQ5XqqksqAuZXvqV88G8uepxyB6tJnkt2ngZehREvGsMZJQhNP55ZKsxDnAaLDvSFT9ixTVqzT',
    validFromBlock: 1837357,
    isV09: true,
    verificationMethods: [{
        vmId: '#sign',
        vmType: 'oip:XpubDerivation2025',
        xpub: 'xpub6DMaz5ZtqvapPzE8xtHiZyNqcJetimwiNnQ5XqqksqAuZXvqV88G8uepxyB6tJnkt2ngZehREvGsMZJQhNP55ZKsxDnAaLDvSFT9ixTVqzT',
        validFromBlock: 1837357,
        revokedFromBlock: null
    }]
};

/**
 * Resolves a creator DID, checking bootstrap creator first.
 * 
 * @param {string} creatorDid - Creator's DID
 * @returns {Promise<object|null>} Creator verification data
 */
async function resolveCreatorWithBootstrap(creatorDid) {
    // Check if this is the bootstrap creator
    if (BOOTSTRAP_V09_ENABLED && creatorDid === BOOTSTRAP_V09_CREATOR.did) {
        console.log(`[SyncVerification] Using hardcoded bootstrap creator for ${creatorDid}`);
        return BOOTSTRAP_V09_CREATOR;
    }
    // Otherwise use normal resolution
    return await resolveCreator(creatorDid);
}

/**
 * Verifies a bootstrap creator registration.
 * Used for the first v0.9 creator that publishes templates.
 * 
 * For bootstrap, we trust the hardcoded creator data rather than
 * looking it up from the index (which wouldn't exist yet).
 * 
 * @param {object} record - Bootstrap creator registration record
 * @param {object} bootstrapCreatorData - Hardcoded bootstrap creator verification data
 * @returns {Promise<{shouldIndex: boolean, verificationResult: object}>}
 */
async function verifyBootstrapCreator(record, bootstrapCreatorData) {
    // Create a resolver that returns the hardcoded bootstrap data
    const bootstrapResolver = async (creatorDid) => {
        if (creatorDid === bootstrapCreatorData.did) {
            return bootstrapCreatorData;
        }
        return null;
    };
    
    const blockHeight = record.oip?.blockHeight || 0;
    const result = await verifyRecord(record, bootstrapResolver, blockHeight);
    
    return {
        shouldIndex: result.isValid,
        verificationResult: result
    };
}

/**
 * Gets the bootstrap creator configuration.
 * 
 * @returns {object|null} Bootstrap creator data or null if not enabled
 */
function getBootstrapCreator() {
    if (!BOOTSTRAP_V09_ENABLED) return null;
    return BOOTSTRAP_V09_CREATOR;
}

/**
 * Checks if a DID is the bootstrap creator.
 * 
 * @param {string} did - DID to check
 * @returns {boolean}
 */
function isBootstrapCreator(did) {
    return BOOTSTRAP_V09_ENABLED && did === BOOTSTRAP_V09_CREATOR.did;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    resolveCreator,
    resolveCreatorWithBootstrap,
    resolveVerificationMethods,
    verifyBeforeIndex,
    handleLegacyRecord,
    isV09Record,
    getRecordVersion,
    verifyBootstrapCreator,
    getBootstrapCreator,
    isBootstrapCreator,
    BOOTSTRAP_V09_CREATOR,
    BOOTSTRAP_V09_ENABLED
};

