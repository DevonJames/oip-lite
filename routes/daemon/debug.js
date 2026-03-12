/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEBUG ROUTES - OIP v0.9 Cryptographic Debugging Interface
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Endpoints for step-by-step debugging of the OIP v0.9 signing workflow:
 *   POST /api/debug/identity       - Create identity from mnemonic
 *   POST /api/debug/digest         - Compute payload digest
 *   POST /api/debug/sign           - Sign payload with HD key
 *   POST /api/debug/verify         - Verify signature
 *   GET  /api/debug/generate-mnemonic - Generate test mnemonic
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

'use strict';

const express = require('express');
const router = express.Router();

const { sha256 } = require('@noble/hashes/sha256');
const { secp256k1 } = require('@noble/curves/secp256k1');
const { bytesToHex } = require('@noble/hashes/utils');
const base64url = require('base64url');

const {
    createIdentityFromMnemonic,
    validateMnemonic,
    generateMnemonic,
    computePayloadDigest,
    deriveIndexFromPayloadDigest,
    canonicalJson,
    getXpubBasePath,
    SubPurpose,
    OIP_PURPOSE
} = require('../../helpers/core/oip-crypto');

const {
    signPayload,
    preparePayloadForSigning,
    extractSignatureData,
    removeSignatureTags
} = require('../../helpers/core/oip-signing');

const { HDKey } = require('@scure/bip32');
const { v4: uuidv4 } = require('uuid');

const { 
    V09_TEMPLATES,
    didDocumentSchema,
    didVerificationMethodSchema
} = require('../../config/templates-v09');

const {
    BOOTSTRAP_V09_CREATOR,
    BOOTSTRAP_V09_ENABLED
} = require('../../helpers/core/sync-verification');

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/debug/identity
// Create identity from mnemonic
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/identity', (req, res) => {
    try {
        const { mnemonic, account = 0 } = req.body;

        if (!mnemonic) {
            return res.status(400).json({
                error: 'Missing mnemonic',
                message: 'Request body must include "mnemonic"'
            });
        }

        // Validate mnemonic
        if (!validateMnemonic(mnemonic)) {
            return res.status(400).json({
                error: 'Invalid mnemonic',
                message: 'The mnemonic phrase is not valid BIP-39'
            });
        }

        // Create identity
        const identity = createIdentityFromMnemonic(mnemonic, account);

        res.json({
            did: identity.did,
            signingXpub: identity.signingXpub,
            account: identity.account,
            derivationPath: getXpubBasePath(SubPurpose.IDENTITY_SIGN, account)
        });

    } catch (error) {
        console.error('[Debug] Identity creation error:', error);
        res.status(500).json({
            error: 'Identity creation failed',
            message: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/debug/digest
// Compute payload digest and key derivation index
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/digest', (req, res) => {
    try {
        const { payload } = req.body;

        if (!payload) {
            return res.status(400).json({
                error: 'Missing payload',
                message: 'Request body must include "payload"'
            });
        }

        // Compute canonical JSON
        const canonical = canonicalJson(payload);

        // Compute digest
        const payloadDigest = computePayloadDigest(payload);

        // Derive key index
        const keyIndex = deriveIndexFromPayloadDigest(payloadDigest);

        // Build derivation path
        const derivationPath = `m/${OIP_PURPOSE}'/0'/0'/${keyIndex}`;

        res.json({
            canonicalJson: canonical,
            payloadDigest,
            keyIndex,
            derivationPath
        });

    } catch (error) {
        console.error('[Debug] Digest computation error:', error);
        res.status(500).json({
            error: 'Digest computation failed',
            message: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/debug/sign
// Sign payload with HD-derived key
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/sign', (req, res) => {
    try {
        const { mnemonic, payload, account = 0 } = req.body;

        if (!mnemonic || !payload) {
            return res.status(400).json({
                error: 'Missing parameters',
                message: 'Request body must include "mnemonic" and "payload"'
            });
        }

        // Create identity
        const identity = createIdentityFromMnemonic(mnemonic, account);

        // Compute payload digest before signing
        const payloadDigest = computePayloadDigest(payload);
        const keyIndex = deriveIndexFromPayloadDigest(payloadDigest);

        // Get the canonical JSON for signing
        const payloadBytes = canonicalJson(payload);
        const messageHash = sha256(new TextEncoder().encode(payloadBytes));
        const messageHashHex = bytesToHex(messageHash);

        // Derive child signing key
        const childKey = identity.signingKey.deriveChild(keyIndex);
        const derivedPublicKey = bytesToHex(childKey.publicKey);

        // Sign the message hash
        const signature = secp256k1.sign(messageHash, childKey.privateKey);
        const signatureBase64 = base64url.encode(Buffer.from(signature.toCompactRawBytes()));

        // Build signed payload
        const signedPayload = JSON.parse(JSON.stringify(payload));
        signedPayload.tags = signedPayload.tags || [];
        signedPayload.tags.push({ name: 'PayloadDigest', value: payloadDigest });
        signedPayload.tags.push({ name: 'KeyIndex', value: keyIndex.toString() });
        signedPayload.tags.push({ name: 'CreatorSig', value: signatureBase64 });

        res.json({
            signature: signatureBase64,
            signedPayload,
            derivedPublicKey,
            messageHash: messageHashHex,
            keyIndex,
            payloadDigest,
            derivationPath: `m/${OIP_PURPOSE}'/0'/${account}'/${keyIndex}`
        });

    } catch (error) {
        console.error('[Debug] Signing error:', error);
        res.status(500).json({
            error: 'Signing failed',
            message: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/debug/verify
// Verify signature using xpub
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/verify', (req, res) => {
    try {
        const { signedPayload, xpub } = req.body;

        if (!signedPayload || !xpub) {
            return res.status(400).json({
                error: 'Missing parameters',
                message: 'Request body must include "signedPayload" and "xpub"'
            });
        }

        // Extract signature data from tags
        const sigData = extractSignatureData(signedPayload);
        const { creatorSig, keyIndex: keyIndexTag, payloadDigest: digestTag } = sigData;

        // Initialize verification steps
        const steps = [false, false, false, false, false, false];
        let error = null;

        try {
            // Step 1: Extract PayloadDigest from tags
            if (!digestTag) throw new Error('PayloadDigest tag not found');
            steps[0] = true;

            // Step 2: Recompute digest from unsigned payload
            const payloadWithoutSig = removeSignatureTags(signedPayload);
            const digestComputed = computePayloadDigest(payloadWithoutSig);
            steps[1] = true;

            // Step 3: Compare digests
            if (digestComputed !== digestTag) {
                throw new Error(`Digest mismatch: expected ${digestTag}, got ${digestComputed}`);
            }
            steps[2] = true;

            // Step 4: Derive key index from digest
            const keyIndexDerived = deriveIndexFromPayloadDigest(digestTag);
            if (parseInt(keyIndexTag) !== keyIndexDerived) {
                throw new Error(`Key index mismatch: expected ${keyIndexDerived}, got ${keyIndexTag}`);
            }
            steps[3] = true;

            // Step 5: Derive verification key from xpub
            const hdKey = HDKey.fromExtendedKey(xpub);
            const childKey = hdKey.deriveChild(keyIndexDerived);
            const publicKey = childKey.publicKey;
            steps[4] = true;

            // Step 6: Verify ECDSA signature
            const payloadBytes = canonicalJson(payloadWithoutSig);
            const messageHash = sha256(new TextEncoder().encode(payloadBytes));
            const signatureBytes = base64url.toBuffer(creatorSig);

            const isValid = secp256k1.verify(signatureBytes, messageHash, publicKey);
            steps[5] = isValid;

            if (!isValid) {
                error = 'Signature verification failed';
            }

            res.json({
                isValid,
                steps,
                error,
                digestFromTag: digestTag,
                digestComputed,
                keyIndexFromTag: keyIndexTag,
                keyIndexDerived,
                derivedPublicKey: bytesToHex(publicKey)
            });

        } catch (e) {
            res.json({
                isValid: false,
                steps,
                error: e.message,
                digestFromTag: digestTag || null,
                digestComputed: null,
                keyIndexFromTag: keyIndexTag || null,
                keyIndexDerived: null
            });
        }

    } catch (error) {
        console.error('[Debug] Verification error:', error);
        res.status(500).json({
            error: 'Verification failed',
            message: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/debug/generate-mnemonic
// Generate a test mnemonic
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/generate-mnemonic', (req, res) => {
    try {
        const strength = parseInt(req.query.strength) || 256; // 256 = 24 words, 128 = 12 words
        const mnemonic = generateMnemonic(strength);

        res.json({
            mnemonic,
            wordCount: mnemonic.split(' ').length,
            strength
        });

    } catch (error) {
        console.error('[Debug] Mnemonic generation error:', error);
        res.status(500).json({
            error: 'Mnemonic generation failed',
            message: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/debug/templates
// Get available template schemas for reference
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/templates', (req, res) => {
    // Return template field mappings
    const templates = {
        basic: {
            did: '-9DirnjVO1FlbEW1lN8jITBESrTsQKEM_BoZ1ey_0mk',
            fields: {
                name: { index: 0, type: 'string' },
                description: { index: 1, type: 'string' },
                date: { index: 2, type: 'string' },
                language: { index: 3, type: 'string' },
                tagItems: { index: 4, type: 'repeated string' },
                nsfw: { index: 5, type: 'bool' },
                replyTo: { index: 6, type: 'dref' },
                citations: { index: 7, type: 'repeated dref' }
            }
        },
        post: {
            did: 'op6y-d_6bqivJ2a2oWQnbylD4X_LH6eQyR6rCGqtVZ8',
            fields: {
                webUrl: { index: 0, type: 'string' },
                bylineWriter: { index: 1, type: 'string' },
                bylineWritersTitle: { index: 2, type: 'string' },
                bylineWritersLocation: { index: 3, type: 'string' },
                articleText: { index: 4, type: 'dref' },
                featuredImage: { index: 5, type: 'dref' },
                imageItems: { index: 6, type: 'repeated dref' },
                imageCaptionItems: { index: 7, type: 'repeated string' },
                videoItems: { index: 8, type: 'repeated dref' },
                audioItems: { index: 9, type: 'repeated dref' },
                audioCaptionItems: { index: 10, type: 'repeated string' },
                replyTo: { index: 11, type: 'dref' }
            }
        },
        image: {
            did: 'AkZnE1VckJJlRamgNJuIGE7KrYwDcCciWOMrMh68V4o',
            fields: {
                thumbnailAddress: { index: 0, type: 'string' },
                displayAddress: { index: 1, type: 'string' },
                location: { index: 2, type: 'string' }
            }
        }
    };

    res.json(templates);
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/debug/bootstrap/status
// Get bootstrap creator status
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/bootstrap/status', (req, res) => {
    res.json({
        enabled: BOOTSTRAP_V09_ENABLED,
        creator: BOOTSTRAP_V09_ENABLED ? {
            did: BOOTSTRAP_V09_CREATOR.did,
            signingXpub: BOOTSTRAP_V09_CREATOR.signingXpub
        } : null,
        message: BOOTSTRAP_V09_ENABLED 
            ? 'Bootstrap creator is configured'
            : 'Bootstrap creator not configured. Run: node scripts/bootstrap-v09-creator.js'
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/debug/bootstrap/build-did
// Build a DID document for a bootstrap creator
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/bootstrap/build-did', (req, res) => {
    try {
        const { mnemonic, account = 0, profile = {} } = req.body;

        if (!mnemonic) {
            return res.status(400).json({
                error: 'Missing mnemonic',
                message: 'Request body must include "mnemonic"'
            });
        }

        if (!validateMnemonic(mnemonic)) {
            return res.status(400).json({
                error: 'Invalid mnemonic',
                message: 'The mnemonic phrase is not valid BIP-39'
            });
        }

        const identity = createIdentityFromMnemonic(mnemonic, account);
        const derivationPath = getXpubBasePath(SubPurpose.IDENTITY_SIGN, account);

        const vmFragmentId = uuidv4();
        const docFragmentId = uuidv4();

        // Build verification method record
        const vmRecord = {
            t: 'didVerificationMethod',
            0: '#sign',                              // vmId
            1: 'oip:XpubDerivation2025',            // vmType
            2: identity.did,                        // controller
            5: identity.signingXpub,                // xpub
            6: 'identity.sign',                     // derivationSubPurpose
            7: account,                             // derivationAccount
            8: derivationPath,                      // derivationPathPrefix
            9: 'payload_digest',                    // leafIndexPolicy
            11: false                               // leafHardened
        };

        // Build DID document record
        const didDocRecord = {
            t: 'didDocument',
            0: identity.did,                        // did
            1: identity.did,                        // controller
            2: [`#${vmFragmentId}`],               // verificationMethod
            3: ['#sign'],                          // authentication
            4: ['#sign'],                          // assertionMethod
            8: profile.handleRaw || profile.handle || 'BootstrapCreator',
            9: (profile.handle || 'bootstrapcreator').toLowerCase(),
            10: profile.name || 'Bootstrap',
            11: profile.surname || 'Creator',
            18: 'xpub'                             // keyBindingPolicy
        };

        // Build payload
        const payload = {
            '@context': identity.did,
            tags: [
                { name: 'Index-Method', value: 'OIP' },
                { name: 'Ver', value: '0.9.0' },
                { name: 'Content-Type', value: 'application/json' },
                { name: 'Creator', value: identity.did },
                { name: 'RecordType', value: 'didDocument' }
            ],
            fragments: [
                {
                    id: vmFragmentId,
                    dataType: 'Record',
                    recordType: 'didVerificationMethod',
                    records: [vmRecord]
                },
                {
                    id: docFragmentId,
                    dataType: 'Record',
                    recordType: 'didDocument',
                    records: [didDocRecord]
                }
            ]
        };

        // Now sign it
        const payloadDigest = computePayloadDigest(payload);
        const keyIndex = deriveIndexFromPayloadDigest(payloadDigest);
        const payloadBytes = canonicalJson(payload);
        const messageHash = sha256(new TextEncoder().encode(payloadBytes));
        const childKey = identity.signingKey.deriveChild(keyIndex);
        const signature = secp256k1.sign(messageHash, childKey.privateKey);
        const signatureBase64 = base64url.encode(Buffer.from(signature.toCompactRawBytes()));

        // Add signature tags
        const signedPayload = JSON.parse(JSON.stringify(payload));
        signedPayload.tags.push({ name: 'PayloadDigest', value: payloadDigest });
        signedPayload.tags.push({ name: 'KeyIndex', value: keyIndex.toString() });
        signedPayload.tags.push({ name: 'CreatorSig', value: signatureBase64 });

        // Generate the hardcode snippet
        const hardcodeSnippet = `
// Add this to helpers/core/sync-verification.js
// Then set BOOTSTRAP_V09_ENABLED = true

const BOOTSTRAP_V09_CREATOR = {
    did: '${identity.did}',
    signingXpub: '${identity.signingXpub}',
    validFromBlock: 0,
    isV09: true,
    verificationMethods: [{
        vmId: '#sign',
        vmType: 'oip:XpubDerivation2025',
        xpub: '${identity.signingXpub}',
        validFromBlock: 0,
        revokedFromBlock: null
    }]
};`;

        res.json({
            identity: {
                did: identity.did,
                signingXpub: identity.signingXpub,
                derivationPath,
                account
            },
            unsignedPayload: payload,
            signedPayload,
            signingDetails: {
                payloadDigest,
                keyIndex,
                signature: signatureBase64,
                derivedPublicKey: bytesToHex(childKey.publicKey)
            },
            hardcodeSnippet,
            instructions: [
                '1. Copy the hardcode snippet above',
                '2. Replace the placeholder values in helpers/core/sync-verification.js',
                '3. Set BOOTSTRAP_V09_ENABLED = true',
                '4. Rebuild/restart the service',
                '5. Publish the signed payload using the publish endpoint'
            ]
        });

    } catch (error) {
        console.error('[Debug] Bootstrap DID build error:', error);
        res.status(500).json({
            error: 'Failed to build DID document',
            message: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/debug/v09-templates
// Get v0.9 template schemas with field mappings
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/v09-templates', (req, res) => {
    const templates = {};
    
    for (const [name, schema] of Object.entries(V09_TEMPLATES)) {
        templates[name] = {
            recordType: schema.recordType,
            templateDid: schema.templateDid,
            fields: {}
        };
        
        for (const [index, field] of Object.entries(schema.fields)) {
            templates[name].fields[field.name] = {
                index: parseInt(index),
                type: field.type,
                description: field.description
            };
        }
    }
    
    res.json({
        templates,
        note: 'Template DIDs are placeholders until actual templates are published'
    });
});

module.exports = router;
