/**
 * Canonical Template Resolver
 * 
 * Resolves field type conflicts between historical template versions and the
 * canonical (latest/correct) template defined in templates.config.js.
 * 
 * Problem: When building the index from scratch, templates are processed chronologically.
 * If an early version had incorrect field types (e.g., `ingredient_unit: repeated float`
 * instead of `repeated string`), the ES mapping gets created with the wrong type.
 * Later corrected templates can't change the mapping, and records using correct types fail.
 * 
 * Solution: When generating ES mappings for a template, check templates.config.js for
 * the canonical version. If field types differ, use the canonical version's types.
 * The template itself is still indexed as-is (preserving block height tracking).
 * 
 * If the canonical template isn't in ES yet, we fetch it directly from Arweave.
 */

const templatesConfig = require('../config/templates.config');
const axios = require('axios');
const https = require('https');

// Use the centralized gateway registry for robust failover
const { requestWithFailover } = require('./core/gateway-registry');

// MEMORY LEAK FIX: Create agent that closes sockets after use
const httpsAgent = new https.Agent({
    keepAlive: false,
    maxSockets: 5,
    timeout: 15000
});

// Cache for canonical template fields to avoid repeated lookups
const canonicalFieldsCache = new Map();

/**
 * Gets the canonical template txid for a template name from templates.config.js
 * 
 * @param {string} templateName - Template name (e.g., 'recipe', 'exercise')
 * @returns {string|null} - Canonical template txid or null if not in config
 */
function getCanonicalTemplateTxid(templateName) {
    return templatesConfig.defaultTemplates[templateName] || null;
}

/**
 * Checks if a template name has a canonical version in templates.config.js
 * 
 * @param {string} templateName - Template name to check
 * @returns {boolean}
 */
function hasCanonicalTemplate(templateName) {
    return templateName in templatesConfig.defaultTemplates;
}

/**
 * Fetches template data directly from Arweave by txid.
 * Used when the canonical template isn't in ES yet during initial sync.
 * Uses the centralized gateway registry with 20+ gateways for robust failover.
 * 
 * @param {string} txid - Arweave transaction ID
 * @returns {Promise<object|null>} - Parsed template fields or null
 */
async function fetchTemplateFromArweave(txid) {
    try {
        // Use the centralized failover system
        const fields = await requestWithFailover(async (gatewayUrl) => {
            const response = await axios.get(`${gatewayUrl}/${txid}`, {
                timeout: 15000,
                headers: { 'Accept': 'application/json' },
                httpsAgent: httpsAgent
            });
            
            if (response.data) {
                const rawFields = typeof response.data === 'string' 
                    ? JSON.parse(response.data) 
                    : response.data;
                
                // Parse fields into our standard format
                const parsedFields = {};
                for (const [fieldName, fieldValue] of Object.entries(rawFields)) {
                    if (fieldName.startsWith('index_') || fieldName.endsWith('Values')) {
                        continue;
                    }
                    parsedFields[fieldName] = {
                        type: typeof fieldValue === 'object' ? fieldValue.type : fieldValue,
                        index: typeof fieldValue === 'object' ? fieldValue.index : rawFields[`index_${fieldName}`]
                    };
                }
                
                console.log(`[CanonicalResolver] Fetched template ${txid} from ${gatewayUrl}`);
                return parsedFields;
            }
            throw new Error('No data in response');
        }, { maxRetries: 2, timeout: 20000 });
        
        return fields;
    } catch (error) {
        console.warn(`[CanonicalResolver] Failed to fetch ${txid} from all gateways: ${error.message}`);
        return null;
    }
}

/**
 * Fetches the canonical template's field definitions.
 * First tries Elasticsearch, then falls back to Arweave if not yet indexed.
 * 
 * @param {string} templateName - Template name
 * @param {function} searchTemplateByTxId - Function to search ES for templates
 * @returns {Promise<object|null>} - Field definitions { fieldName: { type, index }, ... } or null
 */
async function getCanonicalTemplateFields(templateName, searchTemplateByTxId) {
    // Check cache first
    if (canonicalFieldsCache.has(templateName)) {
        return canonicalFieldsCache.get(templateName);
    }
    
    const canonicalTxid = getCanonicalTemplateTxid(templateName);
    if (!canonicalTxid) {
        return null;
    }
    
    let fields = null;
    
    // First, try to get from Elasticsearch
    try {
        const template = await searchTemplateByTxId(canonicalTxid);
        if (template && template.data) {
            // Get fieldsInTemplate (processed format) or parse from fields (raw format)
            fields = template.data.fieldsInTemplate;
            
            if (!fields && template.data.fields) {
                // Parse from raw JSON string
                const rawFields = typeof template.data.fields === 'string' 
                    ? JSON.parse(template.data.fields) 
                    : template.data.fields;
                    
                fields = {};
                for (const [fieldName, fieldValue] of Object.entries(rawFields)) {
                    if (fieldName.startsWith('index_') || fieldName.endsWith('Values')) {
                        continue;
                    }
                    fields[fieldName] = {
                        type: typeof fieldValue === 'object' ? fieldValue.type : fieldValue,
                        index: typeof fieldValue === 'object' ? fieldValue.index : rawFields[`index_${fieldName}`]
                    };
                }
            }
            
            if (fields) {
                console.log(`[CanonicalResolver] Got canonical fields for '${templateName}' from Elasticsearch`);
            }
        }
    } catch (error) {
        console.warn(`[CanonicalResolver] ES lookup failed for ${templateName}: ${error.message}`);
    }
    
    // If not in ES, fetch directly from Arweave
    if (!fields) {
        console.log(`[CanonicalResolver] Canonical template for '${templateName}' not in ES, fetching from Arweave...`);
        fields = await fetchTemplateFromArweave(canonicalTxid);
    }
    
    // Cache if we got fields
    if (fields) {
        canonicalFieldsCache.set(templateName, fields);
        console.log(`[CanonicalResolver] Cached canonical fields for '${templateName}' with ${Object.keys(fields).length} fields`);
    } else {
        console.warn(`[CanonicalResolver] Could not get canonical fields for '${templateName}'`);
    }
    
    return fields;
}

/**
 * Checks if a given txid matches the canonical template txid for a template name.
 * 
 * @param {string} templateName - Template name
 * @param {string} txid - Transaction ID to check
 * @returns {boolean} - True if this IS the canonical template
 */
function isCanonicalTemplate(templateName, txid) {
    const canonicalTxid = getCanonicalTemplateTxid(templateName);
    return canonicalTxid && canonicalTxid === txid;
}

/**
 * Merges field types from a template being indexed with canonical field types.
 * If the canonical template has a different type for a field, use the canonical type.
 * 
 * This ensures ES mappings are created with correct types even when processing
 * historical templates with incorrect field definitions.
 * 
 * @param {string} templateName - Name of the template
 * @param {object} fieldsInTemplate - Fields from the template being indexed
 * @param {function} searchTemplateByTxId - Function to search ES for templates
 * @param {string} currentTxid - Optional: txid of template being indexed (to detect if this IS canonical)
 * @returns {Promise<object>} - Merged fields with canonical types where applicable
 */
async function mergeWithCanonicalFieldTypes(templateName, fieldsInTemplate, searchTemplateByTxId, currentTxid = null) {
    // If no canonical template exists, return fields as-is
    if (!hasCanonicalTemplate(templateName)) {
        return fieldsInTemplate;
    }
    
    // If the template being indexed IS the canonical one, use its types directly
    // and update the cache so future templates use these correct types
    if (currentTxid && isCanonicalTemplate(templateName, currentTxid)) {
        console.log(`[CanonicalResolver] 🎯 Template ${currentTxid} IS the canonical '${templateName}' - using its types as authoritative`);
        canonicalFieldsCache.set(templateName, fieldsInTemplate);
        return fieldsInTemplate;
    }
    
    const canonicalFields = await getCanonicalTemplateFields(templateName, searchTemplateByTxId);
    
    // If canonical couldn't be fetched (neither from ES nor Arweave), return fields as-is
    if (!canonicalFields) {
        console.log(`[CanonicalResolver] No canonical fields available for '${templateName}', using template's own types`);
        return fieldsInTemplate;
    }
    
    // Merge: use canonical types where they differ
    const mergedFields = {};
    const typeOverrides = [];
    
    for (const [fieldName, fieldInfo] of Object.entries(fieldsInTemplate)) {
        const templateType = typeof fieldInfo === 'object' ? fieldInfo.type : fieldInfo;
        const templateIndex = typeof fieldInfo === 'object' ? fieldInfo.index : undefined;
        
        // Check if canonical has this field with a different type
        const canonicalFieldInfo = canonicalFields[fieldName];
        if (canonicalFieldInfo) {
            const canonicalType = typeof canonicalFieldInfo === 'object' ? canonicalFieldInfo.type : canonicalFieldInfo;
            
            if (canonicalType !== templateType) {
                // Type mismatch! Use canonical type for mapping
                typeOverrides.push({
                    field: fieldName,
                    from: templateType,
                    to: canonicalType
                });
                
                mergedFields[fieldName] = {
                    type: canonicalType,
                    index: templateIndex
                };
            } else {
                // Types match, use as-is
                mergedFields[fieldName] = {
                    type: templateType,
                    index: templateIndex
                };
            }
        } else {
            // Field not in canonical (new field in older template version)
            mergedFields[fieldName] = {
                type: templateType,
                index: templateIndex
            };
        }
    }
    
    // Also add any fields from canonical that aren't in this template version
    // (they'll have correct types for when records use them)
    for (const [fieldName, fieldInfo] of Object.entries(canonicalFields)) {
        if (!(fieldName in mergedFields)) {
            mergedFields[fieldName] = fieldInfo;
            console.log(`[CanonicalResolver] Added missing field '${fieldName}' from canonical template`);
        }
    }
    
    // Log any type overrides
    if (typeOverrides.length > 0) {
        console.log(`\n🔄 [CanonicalResolver] Field type overrides for template '${templateName}':`);
        for (const override of typeOverrides) {
            console.log(`   📋 ${override.field}: ${override.from} → ${override.to} (using canonical)`);
        }
        console.log('');
    }
    
    return mergedFields;
}

/**
 * Clears the canonical fields cache (useful for testing or after reindexing)
 */
function clearCanonicalFieldsCache() {
    canonicalFieldsCache.clear();
    console.log('[CanonicalResolver] Cache cleared');
}

/**
 * Gets all template names that have canonical versions defined
 * 
 * @returns {string[]} - Array of template names
 */
function getCanonicalTemplateNames() {
    return Object.keys(templatesConfig.defaultTemplates);
}

module.exports = {
    getCanonicalTemplateTxid,
    hasCanonicalTemplate,
    isCanonicalTemplate,
    getCanonicalTemplateFields,
    mergeWithCanonicalFieldTypes,
    clearCanonicalFieldsCache,
    getCanonicalTemplateNames,
    fetchTemplateFromArweave
};

