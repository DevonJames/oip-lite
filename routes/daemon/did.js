/**
 * DID Resolution API Endpoints
 * 
 * Provides W3C DID Document resolution and verification endpoints.
 * Part of the oip-daemon-service.
 */

const express = require('express');
const router = express.Router();
const { resolveCreatorWithBootstrap, getBootstrapCreator, isBootstrapCreator } = require('../../helpers/core/sync-verification');
const { verifyRecord, VerificationMode } = require('../../helpers/core/oip-verification');
const { getDidContextArray } = require('../../helpers/core/urlHelper');

// ═══════════════════════════════════════════════════════════════════════════
// DID RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/did/:did
 * Resolves a DID to its W3C DID Document.
 * 
 * @param {string} did - DID to resolve (URL encoded)
 * @returns {object} DID Document in W3C format
 */
router.get('/:did', async (req, res) => {
    try {
        const { did } = req.params;
        const decodedDid = decodeURIComponent(did);
        
        const creatorData = await resolveCreatorWithBootstrap(decodedDid);
        
        if (!creatorData) {
            return res.status(404).json({
                success: false,
                error: 'DID not found'
            });
        }
        
        // Use pre-computed W3C format if available (indexed with the record)
        // Otherwise fall back to on-the-fly formatting
        let didDocument;
        let source = 'computed';
        
        if (creatorData.didDocument?.oip?.w3c) {
            // Pre-computed format available - return directly (zero processing)
            didDocument = { ...creatorData.didDocument.oip.w3c };
            
            // Add resolved verification methods (these need current validity info)
            if (creatorData.verificationMethods && creatorData.verificationMethods.length > 0) {
                didDocument.verificationMethod = creatorData.verificationMethods.map(vm => ({
                    id: `${didDocument.id}${vm.vmId}`,
                    type: vm.vmType,
                    controller: didDocument.id,
                    'oip:xpub': vm.xpub,
                    'oip:derivationPathPrefix': vm.derivationPathPrefix,
                    'oip:leafIndexPolicy': vm.leafIndexPolicy,
                    'oip:validFromBlock': vm.validFromBlock,
                    'oip:revokedFromBlock': vm.revokedFromBlock,
                    'oip:isActive': !vm.revokedFromBlock
                }));
            }
            
            // Remove the refs array (was for internal use)
            delete didDocument.verificationMethodRefs;
            source = 'indexed';
        } else {
            // Fall back to on-the-fly formatting
            didDocument = formatAsW3C(creatorData, req);
        }
        
        res.json({
            success: true,
            didDocument,
            metadata: {
                isV09: creatorData.isV09,
                source, // 'indexed' = fast pre-computed, 'computed' = on-the-fly
                resolvedAt: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('[DID API] Resolution error:', error);
        res.status(500).json({
            success: false,
            error: 'DID resolution failed'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// SIGNATURE VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/did/verify
 * Verifies a signed record payload.
 * 
 * @body {object} payload - Signed record payload
 * @body {number} blockHeight - Optional block height for validity check
 * @returns {object} Verification result
 */
router.post('/verify', async (req, res) => {
    try {
        const { payload, blockHeight } = req.body;
        
        if (!payload) {
            return res.status(400).json({
                success: false,
                error: 'payload is required'
            });
        }
        
        const result = await verifyRecord(
            payload,
            resolveCreatorWithBootstrap,
            blockHeight || 0
        );
        
        res.json({
            success: true,
            verification: {
                isValid: result.isValid,
                mode: result.mode,
                error: result.error,
                keyIndex: result.keyIndex,
                creatorDid: result.creatorDid,
                blockHeight: result.blockHeight
            }
        });
        
    } catch (error) {
        console.error('[DID API] Verification error:', error);
        res.status(500).json({
            success: false,
            error: 'Verification failed'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// VERIFICATION METHODS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/did/:did/verification-methods
 * Gets all verification methods for a DID.
 * 
 * @param {string} did - DID to lookup
 * @returns {object} List of verification methods
 */
router.get('/:did/verification-methods', async (req, res) => {
    try {
        const { did } = req.params;
        const decodedDid = decodeURIComponent(did);
        
        const creatorData = await resolveCreatorWithBootstrap(decodedDid);
        
        if (!creatorData) {
            return res.status(404).json({
                success: false,
                error: 'DID not found'
            });
        }
        
        const verificationMethods = creatorData.verificationMethods || [];
        
        res.json({
            success: true,
            did: decodedDid,
            isV09: creatorData.isV09,
            verificationMethods: verificationMethods.map(vm => ({
                vmId: vm.vmId,
                vmType: vm.vmType,
                xpub: vm.xpub,
                validFromBlock: vm.validFromBlock,
                revokedFromBlock: vm.revokedFromBlock,
                isActive: !vm.revokedFromBlock
            }))
        });
        
    } catch (error) {
        console.error('[DID API] Verification methods error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get verification methods'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Formats OIP creator data as W3C DID Document.
 * 
 * @param {object} creatorData - Creator data from resolver
 * @param {object} req - Express request object (for dynamic context URL)
 * @returns {object} W3C DID Document
 */
function formatAsW3C(creatorData, req = null) {
    const contextArray = getDidContextArray(req);
    
    // v0.9 format with full DID document
    if (creatorData.isV09 && creatorData.didDocument) {
        const doc = creatorData.didDocument.oip?.data || {};
        return {
            '@context': contextArray,
            id: doc.did,
            controller: doc.controller,
            verificationMethod: creatorData.verificationMethods?.map(vm => ({
                id: `${doc.did}${vm.vmId}`,
                type: vm.vmType,
                controller: doc.did,
                'oip:xpub': vm.xpub,
                'oip:derivationPathPrefix': vm.derivationPathPrefix,
                'oip:leafIndexPolicy': vm.leafIndexPolicy
            })),
            authentication: doc.authentication?.map(ref => 
                ref.startsWith('#') ? `${doc.did}${ref}` : ref
            ),
            assertionMethod: doc.assertionMethod?.map(ref => 
                ref.startsWith('#') ? `${doc.did}${ref}` : ref
            ),
            keyAgreement: doc.keyAgreement?.map(ref => 
                ref.startsWith('#') ? `${doc.did}${ref}` : ref
            ),
            service: doc.service,
            alsoKnownAs: doc.alsoKnownAs,
            'oip:profile': {
                handle: doc.oipHandle,
                handleRaw: doc.oipHandleRaw,
                name: doc.oipName,
                surname: doc.oipSurname,
                language: doc.oipLanguage
            },
            'oip:social': {
                x: doc.oipSocialX,
                youtube: doc.oipSocialYoutube,
                instagram: doc.oipSocialInstagram,
                tiktok: doc.oipSocialTiktok
            }
        };
    }
    
    // v0.9 bootstrap creator (hardcoded, no indexed DID document yet)
    if (creatorData.isV09 && creatorData.verificationMethods) {
        return {
            '@context': contextArray,
            id: creatorData.did,
            controller: creatorData.did,
            verificationMethod: creatorData.verificationMethods.map(vm => ({
                id: `${creatorData.did}${vm.vmId}`,
                type: vm.vmType,
                controller: creatorData.did,
                'oip:xpub': vm.xpub,
                'oip:validFromBlock': vm.validFromBlock,
                'oip:revokedFromBlock': vm.revokedFromBlock
            })),
            authentication: [`${creatorData.did}#sign`],
            assertionMethod: [`${creatorData.did}#sign`],
            'oip:isBootstrap': true,
            'oip:note': 'This is a bootstrap creator. Full DID document will be available after publishing.'
        };
    }
    
    // Legacy v0.8 format (no OIP extension context needed)
    const legacy = creatorData.legacyRecord?.oip?.data || {};
    return {
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: creatorData.did,
        verificationMethod: [{
            id: `${creatorData.did}#legacy`,
            type: 'EcdsaSecp256k1VerificationKey2019',
            controller: creatorData.did,
            'oip:signingXpub': creatorData.signingXpub
        }],
        authentication: [`${creatorData.did}#legacy`],
        assertionMethod: [`${creatorData.did}#legacy`],
        'oip:profile': {
            handle: legacy.handle,
            surname: legacy.surname
        },
        'oip:isLegacy': true
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = router;

