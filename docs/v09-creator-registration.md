# OIP v0.9 Creator Registration Guide

> **How to register yourself as a creator using OIP v0.9 DID-based identity**

## Overview

OIP v0.9 introduces DID-based identity with HD key derivation, allowing creators to register themselves without requiring server-side account creation. This guide walks you through the registration process using the web interface.

## Prerequisites

- Access to an OIP node (local or remote)
- A BIP-39 mnemonic phrase (12 or 24 words) - you can generate one during registration
- The v0.9 templates must be published (`didVerificationMethod`, `didDocument`, `socialMedia`, `communication`)

## Accessing the Registration Interface

The registration interface is available at:

- **Standard service**: `http://localhost:3005/register.html`
- **Onion Press service**: `http://localhost:3008/register.html`

Or navigate to `/register.html` on your OIP node.

## Registration Steps

### Step 1: Create Your Identity

1. **Enter or Generate a Mnemonic**
   - Enter your existing BIP-39 mnemonic phrase (12 or 24 words)
   - OR click **"🎲 Generate Test Mnemonic"** to create a new one
   - ⚠️ **Important**: Save your mnemonic securely! This is your master key and cannot be recovered if lost.

2. **Load Identity**
   - Click **"🔑 Load Identity"**
   - Your DID and signing xpub will be displayed
   - These are derived from your mnemonic and will be used for signing records

3. **Continue** to Step 2

### Step 2: Verification Method

The verification method defines how others can verify signatures from your DID.

**Most fields are auto-filled from your identity:**
- `vmId`: `#sign` (default)
- `vmType`: `oip:XpubDerivation2025` (default)
- `controller`: Your DID (auto-filled)
- `xpub`: Your signing xpub (auto-filled)
- `derivationSubPurpose`: `identity.sign` (default)
- `derivationAccount`: `0` (default)
- `derivationPathPrefix`: `m/176800'/0'/0'` (default)
- `leafIndexPolicy`: `payload_digest` (default)
- `leafHardened`: `false` (default)
- `validFromBlock`: `0` (default)

**You can modify these if needed**, but the defaults work for most use cases.

Click **"Continue to DID Document"** when ready.

### Step 3: DID Document

Your DID Document is your public identity profile. It references your verification method and includes profile information.

**Auto-filled fields:**
- `did`: Your DID (auto-filled)
- `controller`: Your DID (auto-filled)
- `keyBindingPolicy`: `xpub` (default)

**Fields you should fill:**
- `oipHandleRaw`: Your handle as you want it displayed (preserves case)
- `oipHandle`: Normalized handle (lowercase, auto-generated from handleRaw)
- `oipName`: Your display name
- `oipSurname`: Your surname/family name (optional)
- `oipLanguage`: Preferred language code (ISO 639-1, e.g., "en", "es")
- `verificationMethod`: Will be auto-populated after Verification Method is published
- `authentication`: Defaults to `#sign`
- `assertionMethod`: Defaults to `#sign`

**Optional fields:**
- `oipSocialX`: X/Twitter handle
- `oipSocialYoutube`: YouTube channel
- `oipSocialInstagram`: Instagram handle
- `oipSocialTiktok`: TikTok handle
- `alsoKnownAs`: Alternative identifiers
- `service`: Service endpoints (JSON array)

Click **"Continue to Social Media"** when ready.

### Step 4: Social Media (Optional)

Link your social media profiles. All fields are optional.

**Available fields:**
- `website`: Array of website URLs (drefs to other records)
- `youtube`: Array of YouTube channel references (drefs)
- `x`: X/Twitter handle (string)
- `instagram`: Array of Instagram handles (strings)
- `tiktok`: Array of TikTok handles (strings)

Click **"+ Add"** to add multiple entries for repeated fields.

Click **"Continue to Communication"** when ready.

### Step 5: Communication (Optional)

Add communication channels. All fields are optional.

**Available fields:**
- `phone`: Array of phone numbers
- `email`: Array of email addresses
- `signal`: Array of Signal identifiers

Click **"+ Add"** to add multiple entries.

Click **"Review & Publish"** when ready.

### Step 6: Review & Publish

1. **Review all records** displayed in JSON format
2. **Check the confirmation box**: "I confirm that all information is correct and I want to publish these records to the blockchain"
3. **Click "✅ Publish All Records"**

The interface will:
- Publish records in order: Verification Method → DID Document → Social Media → Communication
- Sign each record with your identity
- Update the DID Document to reference the Verification Method after it's published
- Display transaction IDs for each published record

## What Gets Published

Four separate records are published to Arweave:

1. **didVerificationMethod** - Your verification method (xpub and derivation info)
2. **didDocument** - Your DID document (profile and references)
3. **socialMedia** - Your social media links (optional)
4. **communication** - Your communication channels (optional)

Each record is:
- Signed with your HD wallet-derived key
- Published with version `0.9.0`
- Indexed by the OIP node
- Permanently stored on Arweave

## After Registration

Once published, your DID and records will be:
- ✅ Indexed by OIP nodes
- ✅ Resolvable via `/api/did/:did` endpoint
- ✅ Verifiable by anyone using your xpub
- ✅ Available for use in future record publishing

## Using Your Identity

After registration, you can use your mnemonic to:
- Sign and publish new records using the DID publishing interface
- Verify your identity when publishing content
- Create a cryptographic link between all your published content

## Troubleshooting

### "Template not found" Error

**Problem**: Templates aren't loading  
**Solution**: Ensure the v0.9 templates (`didVerificationMethod`, `didDocument`, `socialMedia`, `communication`) are published and indexed. Check `/api/templates` to verify they're available.

### "Signing failed" Error

**Problem**: Cannot sign records  
**Solution**: 
- Verify your mnemonic is valid (12 or 24 words)
- Ensure `SERVER_CREATOR_MNEMONIC` is set if using server-side signing
- Check that the debug endpoints (`/api/debug/sign`) are accessible

### "Publishing failed" Error

**Problem**: Records won't publish  
**Solution**:
- Check that the server has an Arweave wallet configured
- Verify the server can sign Arweave transactions
- Check server logs for detailed error messages

### Fields Not Auto-Filling

**Problem**: Verification method fields aren't auto-filled  
**Solution**: Make sure you've loaded your identity in Step 1 before proceeding to Step 2.

## Security Best Practices

1. **Never share your mnemonic** - It's your master key
2. **Store it securely** - Use a password manager or hardware wallet
3. **Backup your mnemonic** - Write it down and store it safely offline
4. **Use test mnemonics for testing** - Only use real mnemonics for production identities
5. **Verify your DID** - After publishing, verify your DID resolves correctly

## Related Documentation

- [OIP v0.9 Bootstrap Guide](./OIP_V09_BOOTSTRAP_GUIDE.md) - For node operators publishing templates
- [OIP v0.9 Implementation Plan](./toBuild/oip-09-js-implementation-plan.md) - Technical details
- [Dynamic Template Schema Lookup](./feature_documentation/DynamicTemplateSchemaLookup.md) - How templates are loaded
- [OIP Technical Overview](./OIP_TECHNICAL_OVERVIEW.md) - General OIP architecture

## API Endpoints Used

The registration interface uses these endpoints:

- `GET /api/templates` - Load template schemas dynamically
- `GET /api/debug/generate-mnemonic` - Generate test mnemonic
- `POST /api/debug/identity` - Create identity from mnemonic
- `POST /api/debug/sign` - Sign payload with HD key
- `POST /api/records/newRecord` - Publish signed records

## Example Registration Flow

```
1. User enters mnemonic → Identity created (DID + xpub)
2. Verification Method form auto-fills → User reviews/edits
3. DID Document form auto-fills → User adds profile info
4. Social Media (optional) → User adds links
5. Communication (optional) → User adds contact info
6. Review all records → User confirms
7. Publish → All records signed and published to Arweave
```

## Next Steps

After registration:
- Your DID is now publicly resolvable
- You can publish records signed with your identity
- Other users can verify your signatures
- Your profile information is available via DID resolution

---

**Questions or Issues?** Check the troubleshooting section or review the OIP v0.9 technical documentation.
