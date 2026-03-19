# OIP v0.9 Bootstrap Guide

> **Purpose**: This guide explains how to bootstrap the first OIP v0.9 creator and publish the initial v0.9 template records.

## Overview

OIP v0.9 introduces DID-based identity with HD key derivation, replacing Arweave-based signatures for new records. This creates a bootstrap problem:

**The Chicken-and-Egg Problem:**
1. To publish v0.9 records, you need a creator with a **DID document** containing your **verification method** (xpub)
2. To publish a DID document, you need to be a registered creator whose signature can be verified
3. The indexer can't verify your signature without your xpub... which is in the DID document you're trying to publish

**The Solution:**
Like v0.8, we **hardcode the first creator's verification data** so their records can be verified before they're indexed. This "bootstrap creator" then publishes the v0.9 templates and their own DID document.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    BOOTSTRAP PROCESS                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Generate Bootstrap Creator (mnemonic → DID + xpub)          │
│                         │                                        │
│                         ▼                                        │
│  2. Hardcode creator data in sync-verification.js               │
│                         │                                        │
│                         ▼                                        │
│  3. Publish DID Document (self-referential, signed)             │
│                         │                                        │
│                         ▼                                        │
│  4. Publish v0.9 Template Records                               │
│     - didVerificationMethod template                            │
│     - didDocument template                                      │
│     - socialMedia template                                      │
│     - communication template                                    │
│                         │                                        │
│                         ▼                                        │
│  5. Update TEMPLATE_DIDS with real txIds                        │
│                         │                                        │
│                         ▼                                        │
│  6. Other creators can now register using v0.9 flow             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Files Involved

| File | Purpose |
|------|---------|
| `scripts/bootstrap-v09-creator.js` | CLI tool to generate bootstrap creator |
| `helpers/core/sync-verification.js` | Contains bootstrap creator hardcoded data |
| `config/templates-v09.js` | v0.9 template definitions and DIDs |
| `routes/onion-press/debug.js` | Debug endpoints for bootstrap process |
| `public/onion-press/debug.html` | Visual debugging interface |

---

## Step-by-Step Bootstrap Process

### Step 1: Generate Bootstrap Creator

Run the bootstrap script to generate a new creator identity:

```bash
cd /path/to/oip-arweave-indexer
node scripts/bootstrap-v09-creator.js --generate
```

This will:
- Generate a cryptographically secure 24-word BIP-39 mnemonic
- Derive the DID from the master public key
- Derive the signing xpub at path `m/176800'/0'/0'`
- Save configuration to `config/bootstrap-v09-creator.json`
- Output the hardcode snippet for `sync-verification.js`

**Example Output:**
```
═══════════════════════════════════════════════════════════════
🔐 BOOTSTRAP CREATOR MNEMONIC (KEEP SECURE!)
═══════════════════════════════════════════════════════════════
abandon abandon abandon ... (24 words)
═══════════════════════════════════════════════════════════════

📋 BOOTSTRAP CREATOR CONFIGURATION
═══════════════════════════════════════════════════════════════
DID:              did:arweave:abc123...
Signing xpub:     xpub6ABC...
Derivation Path:  m/176800'/0'/0'
═══════════════════════════════════════════════════════════════
```

#### Alternative: Use Existing Mnemonic

If you already have a mnemonic you want to use:

```bash
node scripts/bootstrap-v09-creator.js --use-mnemonic "your 24 word mnemonic phrase here"
```

#### View Current Configuration

```bash
node scripts/bootstrap-v09-creator.js --show
```

#### Output Hardcode Data

```bash
node scripts/bootstrap-v09-creator.js --output-hardcode
```

---

### Step 2: Hardcode the Bootstrap Creator

Open `helpers/core/sync-verification.js` and update the bootstrap creator configuration:

```javascript
// ═══════════════════════════════════════════════════════════════
// BOOTSTRAP VERIFICATION
// ═══════════════════════════════════════════════════════════════

const BOOTSTRAP_V09_ENABLED = true; // ← Set to true!

const BOOTSTRAP_V09_CREATOR = {
    did: 'did:arweave:YOUR_GENERATED_DID',           // ← Replace
    signingXpub: 'xpub6YOUR_GENERATED_XPUB...',      // ← Replace
    validFromBlock: 0,
    isV09: true,
    verificationMethods: [{
        vmId: '#sign',
        vmType: 'oip:XpubDerivation2025',
        xpub: 'xpub6YOUR_GENERATED_XPUB...',         // ← Replace (same as above)
        validFromBlock: 0,
        revokedFromBlock: null
    }]
};
```

**Important:** The `signingXpub` and the xpub in `verificationMethods` must be identical.

---

### Step 3: Rebuild the Service

After updating the hardcoded bootstrap creator, rebuild the service:

```bash
# For Docker deployment
docker compose -f docker-compose-split.yml build onion-press-service
docker compose -f docker-compose-split.yml up -d onion-press-service

# Or for the full alexandria-decentralized stack
make -f Makefile.split rebuild-alexandria-decentralized
```

---

### Step 4: Publish DID Document via Debug Interface

1. Navigate to the debug interface:
   ```
   http://localhost:3008/debug
   ```

2. Enter your bootstrap mnemonic in Step 1

3. Fill in the profile fields (these go in your DID document):
   - **Title**: Your display name
   - **Description**: Brief bio
   - **Byline**: Your handle

4. Click through each step to see:
   - **Step 2**: OIP v0.9 format translation (field names → indices)
   - **Step 3**: Payload digest computation
   - **Step 4**: Signature generation
   - **Step 5**: Signature verification
   - **Step 6**: Final transaction data

5. On Step 6, select destinations and click **"Approve & Publish to Blockchain"**

6. Note the returned transaction ID - this is your DID document's txId

---

### Step 5: Publish v0.9 Template Records

Using the same bootstrap creator, publish the template definitions:

#### Option A: Via Debug Interface

Create records for each template type:
- `didVerificationMethod`
- `didDocument`
- `socialMedia`
- `communication`

#### Option B: Via Bootstrap Script (Future)

```bash
node scripts/bootstrap-v09-creator.js --publish-templates
```

#### Template Record Structure

Each template record defines the field schema for a record type:

```json
{
  "t": "template",
  "recordType": "didDocument",
  "fields": {
    "did": "string",
    "index_did": 0,
    "controller": "dref",
    "index_controller": 1,
    ...
  }
}
```

---

### Step 6: Update Template DIDs

Once the templates are published, update `config/templates-v09.js` with the actual transaction IDs:

```javascript
const TEMPLATE_DIDS = {
    // Existing v0.8 templates (keep for backward compatibility)
    basic: 'did:arweave:-9DirnjVO1FlbEW1lN8jITBESrTsQKEM_BoZ1ey_0mk',
    post: 'did:arweave:op6y-d_6bqivJ2a2oWQnbylD4X_LH6eQyR6rCGqtVZ8',
    
    // New v0.9 templates (replace with actual txIds)
    didDocument: 'did:arweave:ACTUAL_TXID_FROM_STEP_5',
    didVerificationMethod: 'did:arweave:ACTUAL_TXID_FROM_STEP_5',
    socialMedia: 'did:arweave:ACTUAL_TXID_FROM_STEP_5',
    communication: 'did:arweave:ACTUAL_TXID_FROM_STEP_5'
};
```

---

## API Endpoints

The debug routes provide programmatic access to the bootstrap process:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/debug/bootstrap/status` | GET | Check if bootstrap creator is configured |
| `/api/debug/bootstrap/build-did` | POST | Build & sign a DID document |
| `/api/debug/v09-templates` | GET | Get v0.9 template schemas |
| `/api/debug/identity` | POST | Create identity from mnemonic |
| `/api/debug/digest` | POST | Compute payload digest |
| `/api/debug/sign` | POST | Sign payload with HD key |
| `/api/debug/verify` | POST | Verify signature |
| `/api/debug/generate-mnemonic` | GET | Generate test mnemonic |

### Example: Check Bootstrap Status

```bash
curl http://localhost:3008/api/debug/bootstrap/status
```

Response:
```json
{
  "enabled": true,
  "creator": {
    "did": "did:arweave:abc123...",
    "signingXpub": "xpub6ABC..."
  },
  "message": "Bootstrap creator is configured"
}
```

### Example: Build DID Document

```bash
curl -X POST http://localhost:3008/api/debug/bootstrap/build-did \
  -H "Content-Type: application/json" \
  -d '{
    "mnemonic": "your 24 word mnemonic...",
    "profile": {
      "handle": "MyHandle",
      "name": "My Name"
    }
  }'
```

---

## v0.9 Template Field Mappings

### didVerificationMethod

| Field | Index | Type | Description |
|-------|-------|------|-------------|
| vmId | 0 | string | VM fragment ID (e.g., "#sign") |
| vmType | 1 | string | Key type (e.g., "oip:XpubDerivation2025") |
| controller | 2 | dref | DID that controls this key |
| publicKeyMultibase | 3 | string | Public key (multibase encoded) |
| publicKeyJwk | 4 | json | Public key (JWK format) |
| xpub | 5 | string | Extended public key for derivation |
| derivationSubPurpose | 6 | string | Sub-purpose identifier |
| derivationAccount | 7 | uint32 | Account index |
| derivationPathPrefix | 8 | string | Full derivation path prefix |
| leafIndexPolicy | 9 | string | "payload_digest" \| "sequential" \| "fixed" |
| leafIndexFixed | 10 | uint32 | Fixed index if policy is "fixed" |
| leafHardened | 11 | bool | Whether leaf derivation is hardened |
| validFromBlock | 12 | uint64 | Block height when key becomes valid |
| revokedFromBlock | 13 | uint64 | Block height when key is revoked |
| bindingProofJws | 14 | string | JWS binding proof for hardened keys |
| bindingProofPurpose | 15 | string | Purpose of binding proof |

### didDocument

| Field | Index | Type | Description |
|-------|-------|------|-------------|
| did | 0 | string | The DID subject |
| controller | 1 | dref | DID that controls this document |
| verificationMethod | 2 | repeated dref | List of verification methods |
| authentication | 3 | repeated string | Authentication method refs |
| assertionMethod | 4 | repeated string | Assertion method refs |
| keyAgreement | 5 | repeated string | Key agreement method refs |
| service | 6 | json | Service endpoints (JSON array) |
| alsoKnownAs | 7 | repeated string | Alternative identifiers |
| oipHandleRaw | 8 | string | Handle as entered (preserves case) |
| oipHandle | 9 | string | Normalized handle (lowercase) |
| oipName | 10 | string | Display name |
| oipSurname | 11 | string | Surname/family name |
| oipLanguage | 12 | string | Preferred language (ISO 639-1) |
| oipSocialX | 13 | string | X/Twitter handle |
| oipSocialYoutube | 14 | string | YouTube channel |
| oipSocialInstagram | 15 | string | Instagram handle |
| oipSocialTiktok | 16 | string | TikTok handle |
| anchorArweaveTxid | 17 | string | Anchor transaction ID |
| keyBindingPolicy | 18 | string | "xpub" \| "binding" |

---

## Security Considerations

1. **Protect the Mnemonic**: The bootstrap creator's mnemonic is the master key. Store it securely offline.

2. **Single Point of Trust**: The bootstrap creator is trusted by hardcoding. Compromise of this key allows forging initial templates.

3. **Transition Plan**: Once the bootstrap creator publishes templates and their DID document, normal v0.9 verification takes over.

4. **Key Rotation**: The bootstrap creator can publish a new verification method with a later `validFromBlock` to rotate keys.

---

## Troubleshooting

### "Bootstrap creator not configured"

Run the bootstrap script and update `sync-verification.js`:
```bash
node scripts/bootstrap-v09-creator.js --generate --output-hardcode
```

### "Signature verification failed"

1. Ensure `BOOTSTRAP_V09_ENABLED = true`
2. Verify the xpub in hardcode matches the one derived from your mnemonic
3. Check that you're using the correct mnemonic

### "Template DID not found"

Template DIDs are placeholders until you publish actual template records. Use the v0.8 templates until v0.9 templates are published.

---

## Quick Reference

```bash
# Generate new bootstrap creator
node scripts/bootstrap-v09-creator.js --generate

# View current config
node scripts/bootstrap-v09-creator.js --show

# Output hardcode snippet
node scripts/bootstrap-v09-creator.js --output-hardcode

# Use existing mnemonic
node scripts/bootstrap-v09-creator.js --use-mnemonic "your words here"

# Build DID document (preview)
node scripts/bootstrap-v09-creator.js --build-did

# Build templates (preview)
node scripts/bootstrap-v09-creator.js --build-templates
```

---

## Related Documentation

- [OIP v0.9 Implementation Plan](./toBuild/oip-09-js-implementation-plan.md) - Full technical specification
- [OIP Technical Overview](./OIP_TECHNICAL_OVERVIEW.md) - General OIP architecture
- [API Publish Documentation](./API_PUBLISH_DOCUMENTATION.md) - Publishing endpoints
- [TOR Hidden Service Guide](./TOR_HIDDEN_SERVICE_GUIDE.md) - Accessing via TOR

---

## Changelog

| Date | Change |
|------|--------|
| 2026-01-15 | Initial documentation created |
