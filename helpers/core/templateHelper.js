const { create } = require('ipfs-http-client');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { crypto, createHash } = require('crypto');
const base64url = require('base64url');
const { signMessage, txidToDid, getTurboArweave, getTemplateTxidByName, getWalletFilePath } = require('../utils');
const { searchTemplateByTxId, searchRecordInDB, getTemplatesInDB, deleteRecordFromDB, deleteTemplateFromDB, searchCreatorByAddress, indexRecord, elasticClient, convertToOrgHandle, findTemplateByTxId } = require('./elasticsearch');
const {getCurrentBlockHeight} = require('./arweave');
const arweaveWallet = require('./arweave-wallet');
const publisherManager = require('../publisher-manager');
const mediaManager = require('./media-manager');
const { getServerOipIdentity, canSign } = require('./serverOipIdentity');
const { signRecord } = require('./oip-signing');
const { OIP_VERSION } = require('./oip-crypto');

// const templatesConfig = require('../../config/templates.config');
// const jwk = JSON.parse(fs.readFileSync(process.env.WALLET_FILE));

let WebTorrent;
async function initializeWebTorrent() {
  if (!WebTorrent) {
    try {
        WebTorrent = (await import('webtorrent')).default;
      } catch (error) {
        console.warn('uTP not supported or module not found. Falling back to TCP only.');
      }
    }
}

initializeWebTorrent();

const getFileInfo = () => {
    const filename = path.basename(__filename);
    const directory = path.basename(__dirname);
    return `${directory}/${filename}`;
};

const getLineNumber = () => {
    const e = new Error();
    const stack = e.stack.split('\n');
    const lineInfo = stack[2].trim();
    const lineNumber = lineInfo.split(':')[1];
    return lineNumber;
};

function findMatchingString(mainString, arrayOfStrings) {
    const lowerMainString = mainString.toLowerCase();

    for (const str of arrayOfStrings) {
        const lowerStr = str.toLowerCase();

        if (lowerMainString.includes(lowerStr) || lowerStr.includes(lowerMainString)) {
            return str; 
        }
    }
    return null;
}

const translateJSONtoOIPData = async (record, recordType) => {
    const { qtyTemplatesInDB } = await getTemplatesInDB()
    // console.log('Translating JSON to OIP data:', record);
    const templates = Object.values(record);
    const didTxRefs = [];
    const subRecords = [];
    const subRecordTypes = [];
    const templateNames = Object.keys(record);
    // console.log('60 templateNames', templateNames)
    // console.log('61 templates', templates)
    if (qtyTemplatesInDB === 0) {
        console.log('No templates found in DB, using hardcoded translation');
        const jwk = JSON.parse(fs.readFileSync(getWalletFilePath()));

        const myPublicKey = jwk.n
        const myAddress = base64url(createHash('sha256').update(Buffer.from(myPublicKey, 'base64')).digest());

        const translatedData = [];

        if (record.creatorRegistration) {
            const creatorRegistration = record.creatorRegistration;
            const translatedCreatorRegistration = {
                "0": myAddress,
                "1": myPublicKey,
                "2": creatorRegistration.handle,
                "3": creatorRegistration.surname,
                "t": "creatorRegistration"
            };
            translatedData.push(translatedCreatorRegistration);
        }

        if (record.basic) {
            const basic = record.basic;
            const translatedBasic = {
                "0": basic.name,
                "3": 37, // index for english
                "t": "basic" // transaction ID placeholder
            };

            translatedData.push(translatedBasic);
        }
        return translatedData;
    }
    else {

        const convertedTemplates = [];
        for (let i = 0; i < templates.length; i++) {
            const template = templates[i];
            const templateName = templateNames[i];
            const templateTxid = getTemplateTxidByName(templateName);
            const json = { ...template };
            delete json.template;
            try {
                const template = await searchTemplateByTxId(templateTxid);
                if (template !== null) {
                    // Handle both old and new template field structures
                    let fields;
                    if (template.data.fields) {
                        // New structure: fields as JSON string
                        fields = JSON.parse(template.data.fields);
                    } else if (template.data.fieldsInTemplate) {
                        // Old/Updated structure: fieldsInTemplate as flat object
                        const fieldsInTemplate = template.data.fieldsInTemplate;
                        
                        // Check if it's the old nested format or new flat format
                        const firstField = Object.keys(fieldsInTemplate).find(key => !key.startsWith('index_') && !key.endsWith('Values'));
                        if (firstField && typeof fieldsInTemplate[firstField] === 'object' && fieldsInTemplate[firstField].type) {
                            // Old nested format: convert to flat format
                            fields = {};
                            Object.keys(fieldsInTemplate).forEach(fieldName => {
                                if (typeof fieldsInTemplate[fieldName] === 'object' && fieldsInTemplate[fieldName].type) {
                                    fields[fieldName] = fieldsInTemplate[fieldName].type;
                                    fields[`index_${fieldName}`] = fieldsInTemplate[fieldName].index;
                                } else {
                                    fields[fieldName] = fieldsInTemplate[fieldName];
                                }
                            });
                        } else {
                            // New flat format: use directly
                            fields = fieldsInTemplate;
                        }
                    } else {
                        console.error('Template has no fields data:', template.data);
                        continue;
                    }
                    const converted = {};
                    for (const key in json) {
                        const indexKey = `index_${key}`;
                        const fieldType = fields[key];
                        const fieldValuesKey = `${key}Values`;
                        
                        if (fields[indexKey] !== undefined) {
                            // console.log('field', key)
                            if (fieldType === 'enum' && fields[fieldValuesKey]) {
                                const valueIndex = fields[fieldValuesKey].findIndex(val => {
                                    const inputCode = json[key].toLowerCase();
                                    const inputName = json[key].split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
                                    return val.code === inputCode || val.name === inputName;
                                });
                                if (valueIndex !== -1) {
                                    converted[fields[indexKey]] = valueIndex;
                                } else {
                                    console.log(`Value not found in enum values for key: ${key}`);
                                }
                                        } else if (fieldType === 'dref' && key !== "show" && fieldType === 'dref' && key !== "license") {
                // Skip processing if the field is null or undefined
                if (json[key] === null || json[key] === undefined) {
                    continue;
                }
                
                // Skip processing if the field is already a valid DID string (including GUN DIDs)
                if (typeof json[key] === 'string' && json[key].startsWith('did:')) {
                    console.log(`Preserving existing DID for ${key}:`, json[key]);
                    converted[fields[indexKey]] = json[key];
                    continue;
                }
                
                const subRecord = (json[key][0] !== undefined) ? json[key][0] : json[key];
                const templatesArray = (json[key][0] !== undefined) ? Object.keys(json[key][0]) : Object.keys(json[key]);
                recordType = findMatchingString(JSON.stringify(key), templatesArray)
                                console.log('thx 133', subRecord, templatesArray, { key }, recordType)
                                if (!recordType) {
                                    // check if there is only one template in the array
                                    if (templatesArray.length === 1) {
                                        recordType = templatesArray[0];
                                    } else {
                                        recordType = key;
                                    }
                                }
                                // console.log('th 138 recordType', recordType)
                                const newRecord = await publishNewRecord(subRecord, recordType);
                                const dref = newRecord.didTx;
                                didTxRefs.push(dref);
                                subRecords.push(subRecord);
                                subRecordTypes.push(recordType);
                                // console.log('recordType 143', recordType, {didTxRefs}, {subRecords})
                                converted[fields[indexKey]] = dref;
                                        } else if (fieldType === 'repeated dref' && key !== "citations" && key !== "hosts" && key !== "ingredient") {
                // Skip processing if the field is null or undefined
                if (json[key] === null || json[key] === undefined) {
                    continue;
                }
                // Check if the array already contains resolved didTx strings
                if (Array.isArray(json[key]) && json[key].length > 0 && typeof json[key][0] === 'string' && json[key][0].startsWith('did:')) {
                    // Already resolved - just use the didTx strings
                    converted[fields[indexKey]] = json[key];
                } else {
                                    // console.log('149 Processing repeated dref:', json[key], fields[indexKey]);
                                    const subRecord = (json[key][0] !== undefined) ? json[key][0] : json[key];
                                    // console.log('151b Processing repeated dref:', subRecord);

                                    // console.log('th 113 Processing repeated dref for template:', template, json[key][0], subRecord, { key })
                                    const templatesArray = (json[key][0] !== undefined) ? Object.keys(json[key][0]) : Object.keys(json[key]);
                                    recordType = findMatchingString(JSON.stringify(key)[0], templatesArray)
                                    console.log('th 158', templatesArray, recordType)
                                    console.log('th 158 json[key]:', JSON.stringify(json[key], null, 2));
                                    console.log('th 158 json[key][0]:', JSON.stringify(json[key][0], null, 2));
                                    if (!recordType) {
                                        // check if there is only one template in the array
                                        if (templatesArray.length === 1) {
                                            recordType = templatesArray[0];
                                        } else {
                                            recordType = key;
                                            // console.log('Record type not found', { key });
                                        }
                                    }

                                    // console.log('th 155 recordType', recordType)
                                    const newRecord = await publishNewRecord(subRecord, recordType);
                                    const dref = newRecord.didTx;
                                    subRecords.push(subRecord);
                                    didTxRefs.push(dref);
                                    subRecordTypes.push(recordType);
                                    console.log('recordType 166', recordType, {didTxRefs}, {subRecords})

                                    const repeatedDref = [dref];
                                    converted[fields[indexKey]] = repeatedDref;
                                }
                            } else {
                                converted[fields[indexKey]] = json[key];
                            }
                        } else {
                            console.log('Field not found', { key }, {fields});
                        }
                    }
                    converted.t = templateTxid;
                    convertedTemplates.push(converted);
                } else {
                    console.log('Template not found in Arweave yet', { templateTxid });
                }
            } catch (error) {
                console.error('Error processing template:', { templateName, error });
            }
        }
        // console.log('convertedTemplates', convertedTemplates, { didTxRefs }, { subRecords }, { subRecordTypes })
        return { convertedTemplates, didTxRefs, subRecords, subRecordTypes };
    }
};

async function createAndSeedTorrent(videoFile) {
    try {
      // Initialize WebTorrent client TURNING THIS OFF AS A TEST
      await initializeWebTorrent();

      if (!WebTorrent) {
        throw new Error("WebTorrent module failed to load.");
      }
  
      // Create the WebTorrent client
      const client = new WebTorrent();
      
      // Seed the video file
      const torrent = await new Promise((resolve, reject) => {
        client.seed(videoFile, (torrent) => {
          console.log(`Torrent created and seeded: ${torrent.magnetURI}`);
          resolve(torrent);
        });
      });
  
      // Handle client errors
      client.on('error', (err) => {
        console.error('Error with WebTorrent client:', err);
      });
  
      return torrent;
  
    } catch (error) {
      console.error('Error creating and seeding torrent:', error);
    }
}

// note: need to have new creator records derive their address and public key before publishing the registration record
async function publishNewRecord(record, recordType, publishFiles = false, addMediaToArweave = true, addMediaToIPFS = false, youtubeUrl = null, blockchain = 'arweave', addMediaToArFleet = false, options = {}) {
    console.log('Publishing new record:', { recordType, blockchain, publishFiles, addMediaToArweave, addMediaToIPFS, addMediaToArFleet, storage: options.storage })
    
    // Check for GUN storage early
    const storage = options.storage || blockchain;
    if (storage === 'gun') {
        return await publishToGun(record, recordType, options);
    }
    
    try {
        let didTxRefs = [];
        let subRecords = [];
        let subRecordTypes = [];
        
        // Handle media processing if specified
        if (publishFiles || youtubeUrl) {
            const mediaConfig = {
                publishTo: {
                    arweave: addMediaToArweave,
                    ipfs: addMediaToIPFS,
                    arfleet: addMediaToArFleet,
                    bittorrent: true // Always create torrent for distribution
                },
                blockchain: blockchain
            };

            if (youtubeUrl) {
                // Process YouTube URL
                mediaConfig.source = 'youtube';
                mediaConfig.data = youtubeUrl;
                mediaConfig.contentType = 'video/mp4';
                
                const youtubeResult = await mediaManager.processMedia(mediaConfig);
                
                // Handle video data
                if (youtubeResult.video) {
                    record = mediaManager.updateRecordWithMediaAddresses(record, youtubeResult.video, 'video');
                }
                
                // Handle thumbnail data if available
                if (youtubeResult.thumbnail) {
                    // Create thumbnail field if it doesn't exist
                    if (!record.thumbnail) {
                        record.thumbnail = {};
                    }
                    record = mediaManager.updateRecordWithMediaAddresses(record, youtubeResult.thumbnail, 'thumbnail');
                }
                
                console.log('YouTube video and thumbnail processed and added to record:', youtubeResult);
            }
            
            // Handle other media files in the record - IMPORTANT: capture the returned record
            record = await processRecordMedia(record, mediaConfig);
        }

        let recordData = '';
        // console.log(getFileInfo(), getLineNumber(), 'Publishing new record:', { recordType }, record);
        // handle new delete record or template
        if (record.delete !== undefined && typeof record.delete === 'object' && (record.delete.didTx || record.delete.did)) {
            recordType = 'delete';
            const didTx = record.delete.didTx || record.delete.did;
            
            // Skip template processing for delete messages, handle directly
            recordData = JSON.stringify([record]);
            
            const jwk = JSON.parse(fs.readFileSync(getWalletFilePath()));
            
            const myPublicKey = jwk.n;
            const myAddress = base64url(createHash('sha256').update(Buffer.from(myPublicKey, 'base64')).digest()); 
            const creatorDid = `did:arweave:${myAddress}`;
            
            // Perform immediate deletion on local node
            try {
                console.log('Processing delete message for:', didTx);
                await deleteRecordFromDB(creatorDid, { creator: myAddress, data: record });
                console.log('Local deletion processed for:', didTx);
            } catch (error) {
                console.error('Error processing local delete message:', error);
                // Continue with blockchain publishing even if local deletion fails
            }
            
        } else if (record.deleteTemplate !== undefined && typeof record.deleteTemplate === 'object' && (record.deleteTemplate.didTx || record.deleteTemplate.did)) {
            recordType = 'deleteTemplate';
            const didTx = record.deleteTemplate.didTx || record.deleteTemplate.did;
            
            // Skip template processing for deleteTemplate messages, handle directly
            recordData = JSON.stringify([record]);
            
            const jwk = JSON.parse(fs.readFileSync(getWalletFilePath()));
            
            const myPublicKey = jwk.n;
            const myAddress = base64url(createHash('sha256').update(Buffer.from(myPublicKey, 'base64')).digest()); 
            const creatorDid = `did:arweave:${myAddress}`;
            const transaction = { creator: myAddress, data: record };
            
            // Check if this is a template deletion by searching in templates index
            try {
                // Extract just the transaction ID from the didTx (remove 'did:arweave:' prefix)
                const txId = didTx.replace('did:arweave:', '');
                const template = await searchTemplateByTxId(txId);
                
                if (template) {
                    console.log('Delete message is for a template:', didTx);
                    const deleteResult = await deleteTemplateFromDB(creatorDid, transaction);
                    if (deleteResult && deleteResult.error) {
                        console.error('Template deletion failed:', deleteResult.error);
                        throw new Error(deleteResult.error);
                    }
                    console.log('Template deletion processed:', didTx);
                } else {
                    console.log('Delete message is for a record:', didTx);
                    await deleteRecordFromDB(creatorDid, transaction);
                    console.log('Record deletion processed:', didTx);
                }
            } catch (error) {
                console.error('Error processing delete message:', error);
                // If template search fails, try deleting as a record (backward compatibility)
                try {
                    await deleteRecordFromDB(creatorDid, transaction);
                    console.log('Fallback: Record deletion processed:', didTx);
                } catch (recordDeleteError) {
                    console.error('Both template and record deletion failed:', recordDeleteError);
                    throw error;
                }
            }

        } else if (recordType === 'deleteTemplate') {
            // deleteTemplate messages don't need template processing, recordData is already set
            console.log('Skipping template processing for deleteTemplate message');
        } else {

            // handle creator registration
            if (recordType === 'creatorRegistration') {
                const jwk = JSON.parse(fs.readFileSync(getWalletFilePath()));
                const myPublicKey = jwk.n;
                const myAddress = base64url(createHash('sha256').update(Buffer.from(myPublicKey, 'base64')).digest());
                record.creatorRegistration.publicKey = myPublicKey;
                record.creatorRegistration.address = myAddress;
            }
            const oipData = await translateJSONtoOIPData(record);
            const oipRecord = oipData.convertedTemplates;
            didTxRefs = oipData.didTxRefs;
            subRecords = oipData.subRecords;
            subRecordTypes = oipData.subRecordTypes;
            let recordDataArray = [];
            // if (recordType === undefined || recordType === 'undefined') {
                //     if record.
                // }
                // oipRecord.forEach((record) => {
                    //     let stringValue = JSON.stringify(record);
                    //     recordDataArray.push(stringValue);
                    //     recordData = `[${recordDataArray.join(',')}]`;
                    //     console.log(getFileInfo(), getLineNumber(), 'recordData', recordData)
                    // });
                    // recordData = JSON.stringify(oipRecord);
                    
                    oipRecord.forEach((record) => {
                        let stringValue = JSON.stringify(record); // Each record is stringified here
                        recordDataArray.push(stringValue);
                    });
                    recordData = `[${recordDataArray.join(',')}]`; // Final serialized string of all records
                    // console.log(getFileInfo(), getLineNumber(), 'recordData', recordData);
                }
                
                const jwk = JSON.parse(fs.readFileSync(getWalletFilePath()));
                
                const myPublicKey = jwk.n;
                const myAddress = base64url(createHash('sha256').update(Buffer.from(myPublicKey, 'base64')).digest()); 
                
        // const irys = await getIrysArweave();
        const tags = [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Index-Method', value: 'OIP' },
            { name: 'Ver', value: '0.8.0' },
            { name: 'Type', value: 'Record' },
            { name: 'RecordType', value: `${recordType}` },
            { name: 'Creator', value: `${myAddress}` }
        ];

        const dataForSignature = JSON.stringify(tags) + recordData;
        const creatorSig = await signMessage(dataForSignature);
        tags.push({ name: 'CreatorSig', value: creatorSig });

        // console.log(getFileInfo(), getLineNumber(), 'record data and tags', recordData, tags)

        // Use the publisher manager to publish to the specified blockchain
        const publishResult = await publisherManager.publish(recordData, {
            blockchain: blockchain,
            tags: tags,
            waitForConfirmation: true
        });
        
        console.log('Record published:', publishResult.id)
        const transactionId = publishResult.id;
        const didTx = txidToDid(transactionId);

        let currentblock = await getCurrentBlockHeight();
        if (currentblock === null) {
            currentblock = await getCurrentBlockHeight();
            if (currentblock === null) {
                // Default to 1 if we can't get the current block height
                console.warn('Unable to get current block height, defaulting to 1');
                currentblock = 1;
            }
        }

        const creatorDid = `did:arweave:${myAddress}`;
        const creatorInfo = await searchCreatorByAddress(creatorDid)
        const creator = {
            creatorHandle: creatorInfo.data.creatorHandle,
            didAddress: creatorInfo.data.didAddress,
            didTx: creatorInfo.data.didTx,
            publicKey: creatorInfo.data.publicKey
          }

        let recordToIndex = {
            "data": 
                {...record
                },
                "oip": {
                    "did": "did:arweave:"+ transactionId,
                    "inArweaveBlock": currentblock,
                    "recordType": recordType,
                    "indexedAt": new Date().toISOString(),
                    "recordStatus": "pending confirmation in Arweave",
                    "creator": {
                        ...creator
                    }
                }
                };
                
                // Special handling for organization records
                if (recordType === 'organization') {
                    console.log('Processing immediate organization record for:', transactionId);
                    
                    // Create a mock transaction object for the organization processing
                    const mockTransaction = {
                        transactionId: transactionId,
                        owner: myAddress,
                        data: recordData,
                        creator: myAddress,
                        creatorSig: creatorSig,
                        ver: '0.8.0'
                    };
                    
                    // Get the organization template for enum expansion
                    const templates = await getTemplatesInDB();
                    const orgTemplate = findTemplateByTxId("NQi19GjOw-Iv8PzjZ5P-XcFkAYu50cl5V_qceT2xlGM", templates.templatesInDB);
                    
                    // Parse the compressed record data to get organization fields
                    const parsedData = JSON.parse(recordData);
                    const basicData = parsedData.find(obj => obj.t === "-9DirnjVO1FlbEW1lN8jITBESrTsQKEM_BoZ1ey_0mk");
                    const orgData = parsedData.find(obj => obj.t === "NQi19GjOw-Iv8PzjZ5P-XcFkAYu50cl5V_qceT2xlGM");
                    
                    if (basicData && orgData) {
                        // Generate unique organization handle
                        const orgHandle = await convertToOrgHandle(transactionId, orgData["0"]);
                        
                        // Expand membershipPolicy enum value
                        let membershipPolicyValue = orgData["3"]; // Raw index value
                        if (orgTemplate && orgTemplate.data && orgTemplate.data.fields) {
                            const fields = JSON.parse(orgTemplate.data.fields);
                            if (fields.membership_policy === "enum" && Array.isArray(fields.membership_policyValues)) {
                                const enumValues = fields.membership_policyValues;
                                if (typeof membershipPolicyValue === "number" && membershipPolicyValue < enumValues.length) {
                                    membershipPolicyValue = enumValues[membershipPolicyValue].name;
                                    console.log(`Expanded membershipPolicy enum: ${orgData["3"]} -> ${membershipPolicyValue}`);
                                }
                            }
                        }
                        
                        // Update the recordToIndex data with processed organization info
                        recordToIndex.data.orgHandle = orgHandle;
                        recordToIndex.data.membershipPolicy = membershipPolicyValue;
                        
                        // Create organization-specific data structure for organizations index
                        const organizationRecord = {
                            data: {
                                orgHandle: orgHandle,
                                name: basicData["0"],
                                description: basicData["1"],
                                date: basicData["2"],
                                language: basicData["3"],
                                nsfw: basicData["6"],
                                webUrl: basicData["12"],
                                orgPublicKey: orgData["1"],
                                adminPublicKeys: orgData["2"],
                                membershipPolicy: membershipPolicyValue,  // Expanded enum value
                                metadata: orgData["4"] || null,
                                org_handle: orgData["0"]  // Keep original user input
                            },
                            oip: {
                                recordType: 'organization',
                                did: 'did:arweave:' + transactionId,
                                didTx: 'did:arweave:' + transactionId, // Backward compatibility
                                inArweaveBlock: currentblock,
                                indexedAt: new Date(),
                                ver: '0.8.0',
                                signature: creatorSig,
                                organization: {
                                    orgHandle: orgHandle,
                                    orgPublicKey: orgData["1"],
                                    adminPublicKeys: orgData["2"],
                                    membershipPolicy: membershipPolicyValue,  // Expanded enum value
                                    metadata: orgData["4"] || null
                                },
                                creator: {
                                    ...creator
                                }
                            }
                        };
                        
                        // Index to organizations index
                        try {
                            await elasticClient.index({
                                index: 'organizations',
                                id: 'did:arweave:' + transactionId,
                                body: organizationRecord
                            });
                            console.log('Organization indexed to organizations index:', transactionId);
                        } catch (error) {
                            console.error('Error indexing organization to organizations index:', error);
                        }
                    }
                }
                
                // console.log('40 indexRecord pending record to index:', recordToIndex);
                
                indexRecord(recordToIndex);


        return { transactionId, didTx, dataForSignature, creatorSig, didTxRefs, subRecords , subRecordTypes, recordToIndex};
    } catch (error) {
        console.error('Error publishing new record:', error);
    }
}

/**
 * Process media files referenced in the record
 */
async function processRecordMedia(record, mediaConfig) {
    console.log('Processing record media with config:', mediaConfig);
    
    // Function to recursively find media URLs in nested objects
    function findMediaUrls(obj, path = '') {
        const mediaUrls = [];
        
        if (!obj || typeof obj !== 'object') {
            return mediaUrls;
        }
        
        // Check for direct webUrl patterns
        if (obj.webUrl && typeof obj.webUrl === 'string' && obj.webUrl.startsWith('http')) {
            // Skip YouTube URLs - they're handled separately by the YouTube processor
            if (obj.webUrl.includes('youtube.com') || obj.webUrl.includes('youtu.be')) {
                return mediaUrls;
            }
            
            // Determine if this is a media URL (not just a web reference)
            const isMediaUrl = path.includes('image') || path.includes('video') || path.includes('audio') || 
                              path.includes('media') || path.includes('featuredImage') ||
                              getContentTypeFromUrl(obj.webUrl)?.startsWith('image/') ||
                              getContentTypeFromUrl(obj.webUrl)?.startsWith('video/') ||
                              getContentTypeFromUrl(obj.webUrl)?.startsWith('audio/');
            
            if (isMediaUrl) {
                mediaUrls.push({
                    url: obj.webUrl,
                    path: path,
                    contentType: obj.contentType || getContentTypeFromUrl(obj.webUrl) || 'application/octet-stream'
                });
            }
        }
        
        // Check for associatedUrlOnWeb.url patterns (like in featuredImage)
        if (obj.associatedUrlOnWeb && obj.associatedUrlOnWeb.url) {
            mediaUrls.push({
                url: obj.associatedUrlOnWeb.url,
                path: path + '.associatedUrlOnWeb',
                contentType: obj.contentType || getContentTypeFromUrl(obj.associatedUrlOnWeb.url) || 'application/octet-stream'
            });
        }
        
        // Recursively check nested objects
        for (const [key, value] of Object.entries(obj)) {
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                const newPath = path ? `${path}.${key}` : key;
                mediaUrls.push(...findMediaUrls(value, newPath));
            }
        }
        
        return mediaUrls;
    }
    
    // Find all media URLs in the record
    const mediaUrls = findMediaUrls(record);
    
    console.log('Found media URLs:', mediaUrls);
    
    // Process each media URL if media publishing is enabled
    if (Object.values(mediaConfig.publishTo).some(publish => publish)) {
        for (const mediaItem of mediaUrls) {
            try {
                console.log(`Processing media from URL:`, mediaItem.url);
                
                // Configure media processing
                const fieldMediaConfig = {
                    ...mediaConfig,
                    source: 'url',
                    data: mediaItem.url,
                    contentType: mediaItem.contentType
                };
                
                // Process the media and get DIDs
                const mediaDIDs = await mediaManager.processMedia(fieldMediaConfig);
                
                // Add original URL to the result
                mediaDIDs.originalUrl = mediaItem.url;
                
                // Update the record by adding addresses to the appropriate location
                record = updateRecordWithMediaAddresses(record, mediaDIDs, mediaItem.path);
                
                console.log(`Media processed and addresses added for ${mediaItem.path}:`, mediaDIDs);
            } catch (error) {
                console.error(`Error processing media at ${mediaItem.path}:`, error);
                // Keep original URL on error - no changes to record
            }
        }
    } else {
        console.log('Media publishing disabled, keeping original URLs');
    }
    
    return record;
}

/**
 * Update record with media addresses at the specified path
 */
function updateRecordWithMediaAddresses(record, mediaAddresses, mediaPath) {
    // Split the path to navigate to the correct location
    const pathParts = mediaPath.split('.');
    let current = record;
    
    // Navigate to the parent object
    for (let i = 0; i < pathParts.length - 1; i++) {
        if (!current[pathParts[i]]) {
            current[pathParts[i]] = {};
        }
        current = current[pathParts[i]];
    }
    
    // Get the final field name
    const finalField = pathParts[pathParts.length - 1];
    
    // Ensure the final object exists
    if (!current[finalField]) {
        current[finalField] = {};
    }
    
    // Add template-compatible address fields
    if (mediaAddresses.arweaveAddress) {
        current[finalField].arweaveAddress = mediaAddresses.arweaveAddress;
    }
    if (mediaAddresses.ipfsAddress) {
        current[finalField].ipfsAddress = mediaAddresses.ipfsAddress;
    }
    if (mediaAddresses.bittorrentAddress) {
        current[finalField].bittorrentAddress = mediaAddresses.bittorrentAddress;
    }
    if (mediaAddresses.arfleetAddress) {
        current[finalField].arfleetAddress = mediaAddresses.arfleetAddress;
    }
    
    // Preserve original URL and webUrl
    if (mediaAddresses.originalUrl && !current[finalField].originalUrl) {
        current[finalField].originalUrl = mediaAddresses.originalUrl;
    }
    
    // Preserve existing webUrl for backward compatibility
    if (!current[finalField].webUrl && mediaAddresses.originalUrl) {
        current[finalField].webUrl = mediaAddresses.originalUrl;
    }
    
    return record;
}

/**
 * Determine content type from URL
 */
function getContentTypeFromUrl(url) {
    const extension = path.extname(url).toLowerCase();
    const contentTypeMap = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.avi': 'video/avi',
        '.mov': 'video/quicktime',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain',
        '.json': 'application/json'
    };
    
    return contentTypeMap[extension];
}

async function publishNewTemplate(template, blockchain = 'arweave', options = {}) {
    try {
        // Default to v0.9 unless explicitly requested v0.8
        const useV09 = options.version !== '0.8' && options.version !== '0.8.0';
        
        if (useV09) {
            // Use v0.9 publishing by default
            return await publishNewTemplateV09(template, blockchain);
        }
        
        // Legacy v0.8 publishing (for backward compatibility)
        // console.log(getFileInfo(), getLineNumber(), 'publishNewTemplate', template, { blockchain });

        const templateName = Object.keys(template)[0];
        const jwk = JSON.parse(fs.readFileSync(getWalletFilePath()));

        const myPublicKey = jwk.n;
        const myAddress = base64url(createHash('sha256').update(Buffer.from(myPublicKey, 'base64')).digest());

        const tags = [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Index-Method', value: 'OIP' },
            { name: 'Ver', value: '0.8.0' },
            { name: 'Type', value: 'Template' },
            { name: 'TemplateName', value: `${templateName}` },
            { name: 'Creator', value: `${myAddress}` }
        ];

        const templateNoName = Object.values(template)[0];
        const templateString = JSON.stringify(templateNoName);
        const dataForSignature = templateString + JSON.stringify(tags);
        const creatorSig = await signMessage(dataForSignature);
        tags.push({ name: 'CreatorSig', value: creatorSig });

        // Use the publisher manager to publish to the specified blockchain
        const publishResult = await publisherManager.publish(templateString, {
            blockchain: blockchain,
            tags: tags,
            waitForConfirmation: true
        });

        // Get current block height for indexing
        const currentBlock = await getCurrentBlockHeight();
        
        // Prepare template data structure for indexing
        const templateData = {
            TxId: publishResult.id,
            creator: myAddress,
            creatorSig: creatorSig,
            template: templateName,
            fields: templateString
        };

        const templateToIndex = {
            data: templateData,
            oip: {
                didTx: `did:arweave:${publishResult.id}`,
                inArweaveBlock: currentBlock, // Use current block height as estimate
                indexedAt: new Date().toISOString(),
                recordStatus: "pending confirmation in Arweave",
                ver: "0.8.0",
                creator: {
                    didAddress: `did:arweave:${myAddress}`,
                    creatorSig: creatorSig
                }
            }
        };

        return {
            transactionId: publishResult.id,
            didTx: `did:arweave:${publishResult.id}`,
            blockchain: publishResult.blockchain,
            provider: publishResult.provider,
            url: publishResult.url,
            tags: tags,
            dataForSignature: dataForSignature,
            creatorSig: creatorSig,
            templateToIndex: templateToIndex
        };

    } catch (error) {
        console.error('Error publishing template:', error);
        throw error;
    }
}

/**
 * Publishes a v0.9 template using OIP v0.9 signing (HD wallet, DID-based).
 * 
 * @param {object} template - Template object with template name as key
 * @param {string} blockchain - Blockchain to publish to (default: 'arweave')
 * @returns {Promise<object>} Publishing result with transaction ID and DID
 */
async function publishNewTemplateV09(template, blockchain = 'arweave') {
    try {
        // Get server's OIP identity for signing
        const serverIdentity = await getServerOipIdentity();
        
        if (!serverIdentity || !canSign(serverIdentity)) {
            throw new Error('Server OIP identity not available or cannot sign. Set SERVER_CREATOR_MNEMONIC or use bootstrap creator.');
        }

        const templateName = Object.keys(template)[0];
        const templateNoName = Object.values(template)[0];
        const templateString = JSON.stringify(templateNoName);

        // Build v0.9 payload structure
        const payload = {
            '@context': serverIdentity.did,
            tags: [
                { name: 'Content-Type', value: 'application/json' },
                { name: 'Index-Method', value: 'OIP' },
                { name: 'Ver', value: OIP_VERSION },
                { name: 'Type', value: 'Template' },
                { name: 'TemplateName', value: templateName },
                { name: 'Creator', value: serverIdentity.did }
            ],
            fragments: [] // Templates don't use fragments, but we need the structure
        };

        // Sign the payload with v0.9 signing
        const signedPayload = signRecord(payload, serverIdentity.signingKey, serverIdentity.did);

        // Extract tags for Arweave transaction
        const tags = signedPayload.tags;

        // Use the publisher manager to publish to the specified blockchain
        const publishResult = await publisherManager.publish(templateString, {
            blockchain: blockchain,
            tags: tags,
            waitForConfirmation: true
        });

        // Get current block height for indexing
        const currentBlock = await getCurrentBlockHeight();
        
        // Extract signature data
        const sigData = {
            creatorSig: tags.find(t => t.name === 'CreatorSig')?.value,
            keyIndex: tags.find(t => t.name === 'KeyIndex')?.value,
            payloadDigest: tags.find(t => t.name === 'PayloadDigest')?.value
        };
        
        // Prepare template data structure for indexing
        const templateData = {
            TxId: publishResult.id,
            creator: serverIdentity.did,
            creatorSig: sigData.creatorSig,
            keyIndex: sigData.keyIndex,
            payloadDigest: sigData.payloadDigest,
            template: templateName,
            fields: templateString
        };

        const templateToIndex = {
            data: templateData,
            oip: {
                didTx: `did:arweave:${publishResult.id}`,
                inArweaveBlock: currentBlock,
                indexedAt: new Date().toISOString(),
                recordStatus: "pending confirmation in Arweave",
                ver: OIP_VERSION,
                creator: {
                    didAddress: serverIdentity.did,
                    creatorSig: sigData.creatorSig,
                    keyIndex: sigData.keyIndex,
                    payloadDigest: sigData.payloadDigest
                }
            }
        };

        return {
            transactionId: publishResult.id,
            didTx: `did:arweave:${publishResult.id}`,
            did: `did:arweave:${publishResult.id}`,
            blockchain: publishResult.blockchain,
            provider: publishResult.provider,
            url: publishResult.url,
            tags: tags,
            signedPayload: signedPayload,
            templateToIndex: templateToIndex
        };

    } catch (error) {
        console.error('Error publishing v0.9 template:', error);
        throw error;
    }
}

// GUN publishing function for records
// Convert arrays to JSON strings for GUN compatibility
function convertArraysForGUN(obj) {
    if (obj === null || obj === undefined) return obj;
    
    if (Array.isArray(obj)) {
        // Convert array to JSON string
        return JSON.stringify(obj);
    }
    
    if (typeof obj === 'object') {
        const converted = {};
        for (const [key, value] of Object.entries(obj)) {
            converted[key] = convertArraysForGUN(value);
        }
        return converted;
    }
    
    return obj;
}

async function publishToGun(record, recordType, options = {}) {
    try {
        // Convert arrays to JSON strings for GUN compatibility
        const gunCompatibleRecord = convertArraysForGUN(record);
        
        // Get publisher info (reuse existing logic)
        const fs = require('fs');
        const { createHash } = require('crypto');
        const base64url = require('base64url');
        const { signMessage, getWalletFilePath } = require('../utils');
        const { indexRecord } = require('./elasticsearch');
        
        const jwk = JSON.parse(fs.readFileSync(getWalletFilePath()));
        const myPublicKey = jwk.n;
        const myAddress = base64url(createHash('sha256').update(Buffer.from(myPublicKey, 'base64')).digest());
        
        // Create signature envelope (no blockchain tags needed for GUN)
        const dataForSignature = JSON.stringify(gunCompatibleRecord);
        const creatorSig = await signMessage(dataForSignature);
        
        // Build record for GUN (expanded format, not compressed like Arweave)
        // Note: data and oip will be stringified in gun.js putRecord() to avoid nested nodes
        const gunRecordData = {
            data: gunCompatibleRecord,
            oip: {
                did: null, // Will be set after soul generation
                recordType: recordType,
                indexedAt: new Date().toISOString(),
                ver: '0.8.0',
                signature: creatorSig,
                creator: {
                    didAddress: `did:arweave:${myAddress}`,
                    publicKey: myPublicKey
                }
            }
        };
        
        // Determine if encryption is needed based on access control
        const accessControl = gunCompatibleRecord.accessControl || options.accessControl;
        
        // Ensure owner_public_key is set for access control
        if (accessControl && !accessControl.owner_public_key) {
            accessControl.owner_public_key = myPublicKey;
            accessControl.created_by = myPublicKey;
            console.log('Added owner_public_key to accessControl for ownership verification');
        }
        
        const shouldEncrypt = accessControl && 
                            (accessControl.access_level === 'private' || 
                             accessControl.access_level === 'organization' ||
                             accessControl.access_level === 'shared');
        
        // Compute soul BEFORE publishing so we can set DID in the record
        const { GunHelper } = require('./gun');
        const gunHelper = new GunHelper();
        const soul = gunHelper.computeSoul(myPublicKey, options.localId, gunRecordData);
        const did = `did:gun:${soul}`;
        
        // Set DID BEFORE publishing so it's stored correctly in GUN
        gunRecordData.oip.did = did; // Primary field
        gunRecordData.oip.didTx = did; // Backward compatibility
        
        // Publish to GUN using publisher manager
        const publishResult = await publisherManager.publish(gunRecordData, {
            storage: 'gun',
            publisherPubKey: myPublicKey,
            localId: options.localId,
            accessControl: accessControl,
            writerKeys: options.writerKeys,
            encrypt: shouldEncrypt,
            userPublicKey: myPublicKey,
            userPassword: options.userPassword // May not be available during publishing
        });
        
        // Verify DID matches (should be the same since we computed it beforehand)
        if (publishResult.did !== did) {
            console.warn(`⚠️ DID mismatch: computed ${did}, got ${publishResult.did}. Using computed DID.`);
        }
        
        // Index to Elasticsearch (gunRecordData is already in object form, just clone it)
        const elasticsearchRecord = JSON.parse(JSON.stringify(gunRecordData)); // Deep clone
        await indexRecord(elasticsearchRecord);
        console.log('GUN record indexed to Elasticsearch:', publishResult.did);
        
        // Register in GUN registry for other nodes to discover
        try {
            // MEMORY LEAK FIX: Use global gunSyncService instead of creating new instance
            if (global.gunSyncService) {
                // Use computed soul and did for consistency
                const registrySoul = publishResult.soul || soul;
                const registryDid = publishResult.did || did;
                await global.gunSyncService.registerLocalRecord(
                    registryDid,
                    registrySoul,
                    recordType,
                    myPublicKey
                );
                console.log('📝 Record registered in GUN registry for sync:', registryDid);
            } else {
                console.warn('⚠️ Global gunSyncService not available, skipping GUN registry sync');
            }
        } catch (registryError) {
            console.error('⚠️ Failed to register record in GUN registry (sync may be affected):', registryError);
            // Don't fail the entire publish operation for registry issues
        }
        
        return {
            transactionId: publishResult.id, // Use soul as transaction ID for GUN
            did: publishResult.did,
            storage: 'gun',
            provider: 'gun',
            soul: publishResult.soul,
            encrypted: publishResult.encrypted,
            recordToIndex: gunRecordData
        };
        
    } catch (error) {
        console.error('Error publishing to GUN:', error);
        throw error;
    }
}

/**
 * Index a template to Elasticsearch with pending status
 */
async function indexTemplate(templateToIndex) {
    try {
        console.log('Indexing template with pending status:', templateToIndex.oip.did || templateToIndex.oip.didTx);
        
        const existingTemplate = await elasticClient.exists({
            index: 'templates',
            id: templateToIndex.oip.did || templateToIndex.oip.didTx
        });
        
        if (existingTemplate.body) {
            // Update existing template
            const response = await elasticClient.update({
                index: 'templates',
                id: templateToIndex.oip.did || templateToIndex.oip.didTx,
                body: {
                    doc: templateToIndex
                },
                refresh: 'wait_for'
            });
            console.log(`Template updated successfully: ${templateToIndex.oip.did || templateToIndex.oip.didTx}`, response.result);
        } else {
            // Create new template
            const response = await elasticClient.index({
                index: 'templates',
                id: templateToIndex.oip.did || templateToIndex.oip.didTx,
                body: templateToIndex,
                refresh: 'wait_for'
            });
            console.log(`Template indexed successfully: ${templateToIndex.oip.did || templateToIndex.oip.didTx}`, response.result);
        }
    } catch (error) {
        console.error(`Error indexing template ${templateToIndex.oip.did || templateToIndex.oip.didTx}:`, error);
        throw error;
    }
}

async function uploadToIPFS(videoFile) {
    try {
        console.log('Uploading video to IPFS...');
        const fileBuffer = fs.readFileSync(videoFile);

        // Dynamically import the ES module
        const { create } = await import('ipfs-http-client');

        const ipfs = create({
            host: 'localhost',
            port: '5001',
            protocol: 'http',
            fetch: (url, options) => {
                options.duplex = 'half';
                return fetch(url, options);
            }
        });

        const ipfsResult = await ipfs.add(fileBuffer);
        const ipfsHash = ipfsResult.cid.toString();

        console.log(`Video uploaded to IPFS with CID: ${ipfsHash}`);
        return ipfsHash;
    } catch (error) {
        console.error('Error uploading to IPFS:', error);
        throw error;
    }
}

/**
 * Upload a file to ArFleet for temporary storage
 * @param {string} filePath - Path to the file to upload
 * @param {number} storageDuration - Duration in days to store the file (default: 30)
 * @returns {Promise<{arfleetId: string, arfleetUrl: string}>} - The ArFleet ID and URL
 */
async function uploadToArFleet(filePath, storageDuration = 30) {
  try {
    console.log(`Uploading file to ArFleet for ${storageDuration} days: ${filePath}`);
    
    // Make sure ArFleet client is running first (start in background if not already running)
    const checkArFleetCmd = 'ps aux | grep "arfleet client" | grep -v grep';
    
    try {
      await new Promise((resolve, reject) => {
        exec(checkArFleetCmd, (error, stdout, stderr) => {
          // If not running (no output from grep), start the client
          if (!stdout || stdout.trim() === '') {
            // console.log('ArFleet client not running, starting...');
            exec('./arfleet client &', (err, out, stde) => {
              if (err) {
                console.warn('Error starting ArFleet client:', err);
                // Continue anyway, might already be running in another way
              }
              resolve();
            });
          } else {
            // console.log('ArFleet client already running');
            resolve();
          }
        });
      });
    } catch (error) {
      console.warn('Error checking ArFleet client status:', error);
      // Continue anyway
    }
    
    // Execute ArFleet store command
    const arfleetCmd = `./arfleet client store "${filePath}" --duration ${storageDuration}`;
    
    const result = await new Promise((resolve, reject) => {
      exec(arfleetCmd, (error, stdout, stderr) => {
        if (error) {
          console.error(`Error uploading to ArFleet: ${stderr}`);
          reject(error);
        } else {
          // console.log(`ArFleet output: ${stdout}`);
          
          // Parse the output to extract the ArFleet ID from stdout
          // Example expected output: "Successfully stored file with ID: abc123"
          const match = stdout.match(/Successfully stored file with ID:\s*([a-zA-Z0-9]+)/);
          if (match && match[1]) {
            const arfleetId = match[1];
            resolve({
              arfleetId,
              arfleetUrl: `arfleet://${arfleetId}`
            });
          } else {
            console.warn('Could not parse ArFleet ID from output:', stdout);
            // Create a temporary ID in case we can't parse it
            const tempId = `arfleet-${Date.now()}-${path.basename(filePath)}`;
            resolve({
              arfleetId: tempId,
              arfleetUrl: `arfleet://${tempId}`
            });
          }
        }
      });
    });
    
    return result;
  } catch (error) {
    console.error('Error uploading to ArFleet:', error);
    throw error;
  }
}

async function publishVideoFiles(videoPath, videoID, uploadToArweave = true, uploadToArFleet = false) {
    try {
      const videoFile = path.resolve(videoPath);
      let videoFiles = {};
      
      // Step 1: Upload to Arweave for permanent storage (default)
      if (uploadToArweave) {
        try {
          const turbo = await getTurboArweave();
          const fileBuffer = fs.readFileSync(videoFile);
          const arweaveReceipt = await turbo.upload({
            data: fileBuffer,
            dataItemOpts: {
                tags: [
                    { name: 'Content-Type', value: 'application/octet-stream' },
                    { name: 'App-Name', value: 'OIPArweave' },
                    { name: 'App-Version', value: '0.0.1' }
                ]
            }
        });
          videoFiles.arweaveAddress = `ar://${arweaveReceipt.id}`;
          console.log(`Video uploaded to Arweave. ID: ${arweaveReceipt.id}`);
        } catch (arweaveError) {
          console.warn('Error uploading video to Arweave:', arweaveError);
        }
      }
      
      // Step 2: Optionally upload to ArFleet for temporary storage
      if (uploadToArFleet) {
        try {
          console.log('Uploading video to ArFleet:', videoFile);
          const arfleetResult = await uploadToArFleet(videoFile);
          
          if (arfleetResult && arfleetResult.arfleetUrl) {
            console.log(`Video uploaded to ArFleet. URL: ${arfleetResult.arfleetUrl}`);
            videoFiles.arfleetAddress = arfleetResult.arfleetUrl;
            videoFiles.arfleetId = arfleetResult.arfleetId;
          }
        } catch (arfleetError) {
          console.warn('Error uploading video to ArFleet:', arfleetError);
        }
      }
      
      // Step 3: Add BitTorrent as a fallback option
      try {
        const torrent = await createAndSeedTorrent(videoFile);
        if (torrent) {
          videoFiles.torrentAddress = torrent.magnetURI;
          console.log(`Video added to BitTorrent. Magnet URI: ${torrent.magnetURI}`);
        }
      } catch (torrentError) {
        console.warn('Could not create BitTorrent:', torrentError);
      }
      
      if (Object.keys(videoFiles).length === 0) {
        throw new Error('Failed to publish video to any storage backend');
      }
      
      return videoFiles;
    } catch (error) {
      console.error('Error publishing video:', error);
      throw error;
    }
}

async function publishArticleText(outputPath, articleTitle, articleAuthor, articleTags, uploadToArweave = true, uploadToArFleet = false) {
    try {
        console.log('Publishing article text...', outputPath);
        
        let textStorage = {};
        
        // Step 1: Upload to Arweave for permanent storage (default)
        if (uploadToArweave) {
            try {
                const turbo = await getTurboArweave();
                const fileBuffer = fs.readFileSync(outputPath);
                const arweaveReceipt = await turbo.upload({
                    data: fileBuffer,
                    dataItemOpts: {
                        tags: [
                            { name: 'Content-Type', value: 'application/octet-stream' },
                            { name: 'App-Name', value: 'OIPArweave' },
                            { name: 'App-Version', value: '0.0.1' }
                        ]
                    }
                });
                textStorage.arweaveAddress = `ar://${arweaveReceipt.id}`;
                console.log(`Article text uploaded to Arweave. ID: ${arweaveReceipt.id}`);
            } catch (arweaveError) {
                console.warn('Error uploading text to Arweave:', arweaveError);
            }
        }
        
        // Step 2: Optionally upload to ArFleet for time-limited storage
        if (uploadToArFleet) {
            try {
                const arfleetResult = await uploadToArFleet(outputPath);
                if (arfleetResult && arfleetResult.arfleetUrl) {
                    console.log(`Article text uploaded to ArFleet. URL: ${arfleetResult.arfleetUrl}`);
                    textStorage.arfleetAddress = arfleetResult.arfleetUrl;
                    textStorage.arfleetId = arfleetResult.arfleetId;
                }
            } catch (arfleetError) {
                console.warn('Error uploading text to ArFleet:', arfleetError);
            }
        }
        
        // Step 3: Add to BitTorrent as fallback
        try {
            const torrent = await createAndSeedTorrent(outputPath);
            console.log(`Article text added to BitTorrent. Magnet URI: ${torrent.magnetURI}`);
            textStorage.torrent = torrent;
            textStorage.bittorrentAddress = torrent.magnetURI;
        } catch (torrentError) {
            console.warn('Error creating BitTorrent for text:', torrentError);
        }
        
        return textStorage;
    } catch (error) {
        console.error('Error publishing article text:', error);
        throw error;
    }
}

async function publishImage(imagePath, uploadToArweave = true, uploadToArFleet = false) {
    try {
        const imageFile = fs.readFileSync(imagePath);
        let imageStorage = {};
        
        // Step 1: Upload to Arweave for permanent storage (default)
        if (uploadToArweave) {
            try {
                const turbo = await getTurboArweave();
                
                // Get image MIME type
                const fileExt = path.extname(imagePath).toLowerCase();
                const mimeType = {
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.png': 'image/png',
                    '.gif': 'image/gif',
                    '.webp': 'image/webp',
                    '.svg': 'image/svg+xml'
                }[fileExt] || 'image/jpeg';
                
                const arweaveReceipt = await turbo.upload({
                    data: imageFile,
                    dataItemOpts: {
                        tags: [
                            { name: 'Content-Type', value: 'image/jpeg' },
                            { name: 'App-Name', value: 'OIPArweave' },
                            { name: 'App-Version', value: '0.0.1' }
                        ]
                    }
                });
                imageStorage.arweaveAddress = `ar://${arweaveReceipt.id}`;
                console.log(`Image uploaded to Arweave. ID: ${arweaveReceipt.id}`);
            } catch (arweaveError) {
                console.warn('Error uploading image to Arweave:', arweaveError);
            }
        }
        
        // Step 2: Optionally upload to ArFleet for time-limited storage
        if (uploadToArFleet) {
            try {
                const arfleetResult = await uploadToArFleet(imagePath);
                if (arfleetResult && arfleetResult.arfleetUrl) {
                    console.log(`Image uploaded to ArFleet. URL: ${arfleetResult.arfleetUrl}`);
                    imageStorage.arfleetAddress = arfleetResult.arfleetUrl;
                    imageStorage.arfleetId = arfleetResult.arfleetId;
                }
            } catch (arfleetError) {
                console.warn('Error uploading image to ArFleet:', arfleetError);
            }
        }

        // Step 3: Create and seed torrent as fallback
        try {
            const torrent = await createAndSeedTorrent(imageFile);
            imageStorage.torrent = torrent;
            imageStorage.bittorrentAddress = torrent.magnetURI;
            console.log(`Image added to BitTorrent. Magnet URI: ${torrent.magnetURI}`);
        } catch (torrentError) {
            console.warn('Error creating BitTorrent for image:', torrentError);
        }

        return imageStorage;
    } catch (error) {
        console.error('Error publishing image:', error);
        throw error;
    }
}

  async function uploadToArweaveMethod(videoID, videoFile) {
    // Step 1: Load video file metadata (Assuming you have a metadata fetch method)
    console.log('Retrieving video information...');
    const videoInfo = await video_basic_info(`https://www.youtube.com/watch?v=${videoID}`);
    
    // Step 2: Prepare tags and video file upload to Arweave
    const tags = [
      { name: "Content-Type", value: "video/mp4" },
      { name: "AppName", value: "VideoToArweave" },
      { name: "Video-Title", value: videoInfo.video_details.title },
      { name: "Video-Creator", value: videoInfo.video_details.channel.name },
      { name: "Video-Tags", value: JSON.stringify(videoInfo.video_details.tags) }
    ];
  
    console.log(`Uploading video to Arweave with tags: ${JSON.stringify(tags)}`);
    
    const txid = await uploadFileToArweave(videoFile, tags);  // Assuming `uploadFileToArweave` is your Arweave upload function
    console.log(`Video uploaded to Arweave. Transaction ID: ${txid}`);
    
    return txid;
  }

async function uploadFileToArweave(filePath, tags) {
    const data = fs.readFileSync(filePath);
    const tx = await arweave.createTransaction({ data });
    
    tags.forEach(tag => {
      tx.addTag(tag.name, tag.value);
    });
    
    await arweave.transactions.sign(tx);
    await arweave.transactions.post(tx);
    
    return tx.id;
  }

async function resolveRecords(record, resolveDepth, recordsInDB) {
    if (resolveDepth === 0 || !record) {
        return record;
    }

    if (!Array.isArray(record.data)) {
        console.error('record.data is not an array:', record.data);
        return record;
    }

    for (const item of record.data) {
        for (const category of Object.keys(item)) {
            const properties = item[category];

            for (const key of Object.keys(properties)) {
                if (typeof properties[key] === 'string' && properties[key].startsWith('did:')) {
                    // console.log(getFileInfo(), getLineNumber(), 'Resolving DID:', properties[key]);
                    const recordInDB = await searchRecordInDB(properties[key], recordsInDB);
                    if (recordInDB) {
                        properties[key] = await resolveRecords(recordInDB, resolveDepth - 1, recordsInDB);
                    }
                } else if (Array.isArray(properties[key])) {
                    for (let i = 0; i < properties[key].length; i++) {
                        if (typeof properties[key][i] === 'string' && properties[key][i].startsWith('did:')) {
                            const recordInDB = await searchRecordInDB(properties[key][i], recordsInDB);
                            if (recordInDB) {
                                properties[key][i] = await resolveRecords(recordInDB, resolveDepth - 1, recordsInDB);
                            }
                        }
                    }
                }
            }
        }
    }
    return record;
}

// Add this simple HTML chat test page
function getChatTestHtml() {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Chat Test</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
    .container { max-width: 800px; margin: 0 auto; }
    .message-container { 
      height: 400px; 
      overflow: auto; 
      border: 1px solid #ccc; 
      padding: 10px;
      margin-bottom: 10px;
      background: #f9f9f9;
      border-radius: 5px;
    }
    .input-container {
      display: flex;
      margin-bottom: 10px;
    }
    input { 
      flex: 1; 
      padding: 8px; 
      font-size: 16px;
      border: 1px solid #ccc;
      border-radius: 4px;
    }
    button {
      padding: 8px 16px;
      background: #4285f4;
      color: white;
      border: none;
      margin-left: 10px;
      cursor: pointer;
      border-radius: 4px;
    }
    button:disabled {
      background: #ccc;
    }
    .message {
      margin-bottom: 10px;
      padding: 8px 12px;
      border-radius: 18px;
      max-width: 80%;
    }
    .user { 
      background: #4285f4; 
      color: white;
      align-self: flex-end;
      margin-left: auto;
    }
    .assistant { 
      background: #e9e9e9; 
      color: #333;
    }
    .system { 
      color: #666; 
      font-style: italic;
      text-align: center;
      background: #f1f1f1;
      padding: 5px;
      margin: 5px 0;
      border-radius: 5px;
      font-size: 14px;
    }
    .flex-container {
      display: flex;
      flex-direction: column;
    }
    #status {
      margin-bottom: 10px;
      font-size: 14px;
      color: #666;
    }
    #audio-container audio {
      width: 100%;
      margin-top: 10px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>JFK Chat Test</h1>
    <div id="status">Disconnected</div>
    <div id="messages" class="message-container flex-container"></div>
    <div id="audio-container"></div>
    <div class="input-container">
      <input type="text" id="message-input" placeholder="Type your message">
      <button id="send-btn">Send</button>
    </div>
    <div>
      <button id="check-dialogues">Check Active Dialogues</button>
      <pre id="dialogues-info" style="background:#f1f1f1;padding:10px;overflow:auto;max-height:200px;"></pre>
    </div>
  </div>

  <script>
    const messagesContainer = document.getElementById('messages');
    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-btn');
    const statusElement = document.getElementById('status');
    const audioContainer = document.getElementById('audio-container');
    const checkDialoguesButton = document.getElementById('check-dialogues');
    const dialoguesInfo = document.getElementById('dialogues-info');
    
    let dialogueId = null;
    let eventSource = null;
    let isConnecting = false;

    function updateStatus(text) {
      statusElement.textContent = text;
    }

    function connectToEventStream(id) {
      if (isConnecting) return;
      isConnecting = true;
      
      updateStatus('Connecting...');
      console.log(\`Connecting to event stream for id: \${id}\`);
      
      // Close existing connection
      if (eventSource) {
        eventSource.close();
      }
      
      // Create event source with relative URL - avoids CORS
      eventSource = new EventSource(\`/api/generate/open-stream?id=\${id}\`);
      
      eventSource.onopen = () => {
        console.log('EventSource connection opened');
        updateStatus('Connected');
      };
      
      eventSource.addEventListener('connected', (event) => {
        console.log('Connected:', event.data);
        addMessage('system', 'Connected to event stream');
        isConnecting = false;
      });
      
      eventSource.addEventListener('textChunk', (event) => {
        console.log('Text chunk received');
        const data = JSON.parse(event.data);
        
        if (data.role === 'assistant') {
          // Find or create message element
          let msgElem = document.querySelector(\`.assistant[data-id="\${id}"]\`);
          
          if (!msgElem) {
            msgElem = document.createElement('div');
            msgElem.className = 'message assistant';
            msgElem.dataset.id = id;
            messagesContainer.appendChild(msgElem);
          }
          
          // Update content
          msgElem.textContent = (msgElem.textContent || '') + data.text;
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
      });
      
      eventSource.addEventListener('audio', (event) => {
        try {
          console.log('Audio chunk received');
          const data = JSON.parse(event.data);
          
          if (data.audio) {
            const audioBlob = base64ToBlob(data.audio, 'audio/mp3');
            const audioUrl = URL.createObjectURL(audioBlob);
            
            // Create audio element
            const audio = document.createElement('audio');
            audio.controls = true;
            audio.src = audioUrl;
            
            // Remove previous audio if exists
            while (audioContainer.firstChild) {
              audioContainer.removeChild(audioContainer.firstChild);
            }
            
            audioContainer.appendChild(audio);
            
            // Auto-play
            audio.play().catch(e => console.error('Auto-play failed:', e));
          }
        } catch (error) {
          console.error('Error processing audio:', error);
        }
      });
      
      eventSource.addEventListener('done', (event) => {
        console.log('Conversation complete:', event.data);
        addMessage('system', 'Conversation complete');
      });
      
      eventSource.addEventListener('error', (event) => {
        console.error('EventSource error:', event);
        updateStatus('Connection error');
        
        if (eventSource.readyState === EventSource.CLOSED) {
          addMessage('system', 'Connection closed. Reconnecting...');
          
          // Auto-reconnect after delay
          setTimeout(() => {
            isConnecting = false;
            connectToEventStream(id);
          }, 3000);
        }
      });
    }

    function base64ToBlob(base64, type = 'audio/mp3') {
      const binaryString = window.atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return new Blob([bytes], { type });
    }

    function addMessage(role, text) {
      const msgElem = document.createElement('div');
      msgElem.className = \`message \${role}\`;
      msgElem.textContent = text;
      messagesContainer.appendChild(msgElem);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    async function sendMessage() {
      const message = messageInput.value.trim();
      if (!message) return;
      
      addMessage('user', message);
      messageInput.value = '';
      sendButton.disabled = true;
      
      try {
        updateStatus('Sending message...');
        const response = await fetch('/api/generate/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            userInput: message,
            dialogueId: dialogueId,
            conversationHistory: JSON.stringify([
              {
                role: 'user',
                content: message
              }
            ]),
            personality: JSON.stringify({
              name: "Assistant",
              model: "grok-2",
              temperature: 0.7,
              systemPrompt: "You are a helpful assistant.",
              voices: {
                elevenLabs: {
                  voice_id: "pNInz6obpgDQGcFmaJgB",
                  model_id: "eleven_turbo_v2",
                  stability: 0.5,
                  similarity_boost: 0.75
                }
              }
            })
          })
        });
        
        const data = await response.json();
        console.log('Response:', data);
        
        if (data.success) {
          dialogueId = data.dialogueId;
          connectToEventStream(dialogueId);
        } else {
          updateStatus('Error: ' + (data.error || 'Unknown error'));
          addMessage('system', 'Error sending message');
        }
      } catch (error) {
        console.error('Error sending message:', error);
        updateStatus('Connection error');
        addMessage('system', 'Error sending message');
      } finally {
        sendButton.disabled = false;
      }
    }

    async function checkActiveDialogues() {
      try {
        updateStatus('Checking active dialogues...');
        const response = await fetch('/api/generate/active-dialogues');
        const data = await response.json();
        dialoguesInfo.textContent = JSON.stringify(data, null, 2);
        updateStatus(\`Found \${data.count} active dialogues\`);
      } catch (error) {
        console.error('Error checking dialogues:', error);
        dialoguesInfo.textContent = 'Error checking dialogues: ' + error.message;
      }
    }

    // Event handlers
    sendButton.addEventListener('click', sendMessage);
    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        sendMessage();
      }
    });
    checkDialoguesButton.addEventListener('click', checkActiveDialogues);

    // Initial status check
    checkActiveDialogues();
  </script>
</body>
</html>
  `;
}

/**
 * Update an existing record using its transaction ID
 * @param {string} txid - The transaction ID of the record to update
 * @param {object} updatedData - The updated data for the record
 * @param {string} recordType - The type of record
 * @returns {Promise<object>} - The updated record
 */
async function updateRecord(txid, updatedData, recordType) {
  try {
    console.log(`Updating record with txid ${txid} for record type ${recordType}`);
    
    // First, translate the JSON to OIP format
    const oipRecord = await translateJSONtoOIPData(updatedData, recordType);
    
    if (!oipRecord) {
      throw new Error(`Failed to translate updated record data for ${recordType}`);
    }
    
    // Get Arweave wallet for publishing
    const { getWallet } = require('./arweave');
    const wallet = await getWallet();
    
    if (!wallet) {
      throw new Error('Failed to get Arweave wallet');
    }
    
    // Create transaction with OIP record as data
    const Arweave = require('arweave');
    const arweaveConfig = require('../../config/arweave.config');
    const arweave = Arweave.init(arweaveConfig);
    
    // Create transaction with record data
    const transaction = await arweave.createTransaction({
      data: JSON.stringify(oipRecord)
    }, wallet);
    
    // Add OIP tags
    transaction.addTag('Content-Type', 'application/json');
    transaction.addTag('App-Name', 'OIP');
    transaction.addTag('App-Version', '1.0.0');
    transaction.addTag('Type', 'UPDATE');
    transaction.addTag('Original-TX', txid.replace('did:arweave:', ''));
    transaction.addTag('Record-Type', recordType);
    
    // Sign and post transaction
    await arweave.transactions.sign(transaction, wallet);
    
    // Submit transaction
    const response = await arweave.transactions.post(transaction);
    
    if (response.status !== 200) {
      throw new Error(`Failed to update record: ${response.statusText}`);
    }
    
    const txId = transaction.id;
    console.log(`Successfully updated record. New transaction ID: ${txId}`);
    
    // Return updated record
    return {
      oip: {
        didTx: `did:arweave:${txId}`,
        originalTx: txid
      },
      data: updatedData
    };
  } catch (error) {
    console.error(`Error updating record: ${error.message}`);
    throw error;
  }
}

module.exports = {
    resolveRecords,
    publishNewRecord,
    publishNewTemplate,
    publishNewTemplateV09,
    publishToGun,
    indexTemplate,
    publishVideoFiles,
    publishArticleText,
    publishImage,
    uploadToArFleet,
    getChatTestHtml,
    updateRecord
};