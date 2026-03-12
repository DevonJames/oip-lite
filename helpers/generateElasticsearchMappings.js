/**
 * Generate Elasticsearch mappings from OIP templates
 * This ensures field types defined in templates are respected in Elasticsearch
 * 
 * IMPORTANT: When processing historical templates with incorrect field types,
 * this module uses the canonical template from templates.config.js to determine
 * the correct field types for ES mappings. This prevents mapping conflicts when
 * older templates had mistakes (e.g., 'repeated float' instead of 'repeated string').
 */

const { elasticClient, searchTemplateByTxId } = require('./core/elasticsearch');
const { mergeWithCanonicalFieldTypes, hasCanonicalTemplate } = require('./canonicalTemplateResolver');

/**
 * Map OIP field types to Elasticsearch types
 */
function mapOIPTypeToElasticsearchType(oipType) {
    const typeMap = {
        // Basic types
        'string': { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
        'long': { type: 'long' },
        'uint64': { type: 'long' },
        'uint32': { type: 'long' },  // Added missing uint32
        'int32': { type: 'long' },    // Added missing int32
        'float': { type: 'float' },
        'double': { type: 'double' }, // Added missing double
        'bool': { type: 'boolean' },
        'boolean': { type: 'boolean' }, // Added missing boolean
        'enum': { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
        'dref': { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
        
        // Repeated types
        'repeated string': { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
        'repeated float': { type: 'float' },
        'repeated double': { type: 'double' }, // Added missing repeated double
        'repeated long': { type: 'long' },
        'repeated uint64': { type: 'long' },
        'repeated uint32': { type: 'long' }, // Added missing repeated uint32
        'repeated int32': { type: 'long' },   // Added missing repeated int32
        'repeated bool': { type: 'boolean' },
        'repeated boolean': { type: 'boolean' }, // Added missing repeated boolean
        'repeated dref': { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } }
    };

    return typeMap[oipType] || { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } };
}

/**
 * Generate Elasticsearch mapping properties from template fieldsInTemplate
 */
function generateMappingFromTemplate(templateName, fieldsInTemplate) {
    const properties = {};
    
    for (const [fieldName, fieldInfo] of Object.entries(fieldsInTemplate)) {
        // Skip index mappings and enum values
        if (fieldName.startsWith('index_') || fieldName.endsWith('Values')) {
            continue;
        }
        
        const fieldType = typeof fieldInfo === 'object' ? fieldInfo.type : fieldInfo;
        properties[fieldName] = mapOIPTypeToElasticsearchType(fieldType);
    }
    
    return properties;
}

/**
 * Update records index mapping for a specific template
 * 
 * IMPORTANT: This function now checks templates.config.js for the canonical version
 * of the template. If field types differ between the template being indexed and the
 * canonical version, the canonical types are used for the ES mapping.
 * 
 * This allows historical templates with incorrect field types to still be indexed
 * while ensuring records using the corrected types can be properly stored.
 * 
 * @param {string} templateName - Name of the template
 * @param {object} fieldsInTemplate - Fields from the template being indexed
 * @param {object} options - Optional settings
 * @param {boolean} options.skipCanonicalMerge - If true, skip canonical type resolution
 * @param {string} options.templateTxid - Transaction ID of the template being indexed
 */
async function updateRecordsMappingForTemplate(templateName, fieldsInTemplate, options = {}) {
    try {
        // Check if we should use canonical field types for this mapping
        let fieldsForMapping = fieldsInTemplate;
        
        if (!options.skipCanonicalMerge && hasCanonicalTemplate(templateName)) {
            console.log(`📋 [Mapping] Template '${templateName}' has canonical version - checking for type overrides...`);
            fieldsForMapping = await mergeWithCanonicalFieldTypes(
                templateName, 
                fieldsInTemplate, 
                searchTemplateByTxId,
                options.templateTxid || null  // Pass txid to detect if this IS the canonical
            );
        }
        
        const properties = generateMappingFromTemplate(templateName, fieldsForMapping);
        
        // Must preserve the nested type for data field when updating
        const mappingUpdate = {
            properties: {
                data: {
                    type: 'nested',  // Critical: must specify nested type when updating
                    properties: {
                        [templateName]: {
                            properties: properties
                        }
                    }
                }
            }
        };
        
        console.log(`🔧 Updating records mapping for ${templateName}:`, JSON.stringify(properties, null, 2));
        
        const response = await elasticClient.indices.putMapping({
            index: 'records',
            body: mappingUpdate
        });
        
        console.log(`✅ Mapping updated for template: ${templateName}`);
        return response;
        
    } catch (error) {
        console.error(`❌ Error updating mapping for template ${templateName}:`, error.message);
        throw error;
    }
}

/**
 * Update mappings for ALL templates in the system
 */
async function updateAllRecordsMappings() {
    try {
        console.log('🚀 Starting automatic mapping generation from templates...');
        
        // Get all templates from Elasticsearch
        const templatesResult = await elasticClient.search({
            index: 'templates',
            body: {
                size: 1000,
                query: { match_all: {} }
            }
        });
        
        // Handle both response formats (with and without .body wrapper)
        const templates = templatesResult.body?.hits?.hits || templatesResult.hits?.hits || [];
        console.log(`📚 Found ${templates.length} templates to process`);
        
        let successCount = 0;
        let skipCount = 0;
        
        for (const templateDoc of templates) {
            const template = templateDoc._source;
            const templateName = template.data?.template;
            const fieldsInTemplate = template.data?.fieldsInTemplate;
            
            if (!templateName || !fieldsInTemplate) {
                console.log(`⏭️  Skipping template (missing data):`, templateDoc._id);
                skipCount++;
                continue;
            }
            
            // Skip basic template (it's in every record)
            if (templateName === 'basic') {
                skipCount++;
                continue;
            }
            
            try {
                await updateRecordsMappingForTemplate(templateName, fieldsInTemplate);
                successCount++;
            } catch (error) {
                console.error(`Failed to update mapping for ${templateName}:`, error.message);
            }
        }
        
        console.log(`\n✅ Mapping generation complete!`);
        console.log(`   📊 Templates processed: ${templates.length}`);
        console.log(`   ✅ Mappings updated: ${successCount}`);
        console.log(`   ⏭️  Skipped: ${skipCount}`);
        
        // After updating mappings, reindex to apply them
        console.log('\n🔄 Reindexing records to apply new mappings...');
        const reindexResult = await elasticClient.updateByQuery({
            index: 'records',
            body: {
                query: { match_all: {} }
            },
            refresh: true,
            conflicts: 'proceed'
        });
        
        // Handle both response formats
        const reindexCount = reindexResult.body?.updated || reindexResult.updated || 0;
        console.log(`✅ Reindexed ${reindexCount} records`);
        
        return {
            templatesProcessed: templates.length,
            mappingsUpdated: successCount,
            skipped: skipCount,
            recordsReindexed: reindexCount
        };
        
    } catch (error) {
        console.error('❌ Error updating all mappings:', error);
        throw error;
    }
}

/**
 * Hook to update mapping when a new template is published during indexing.
 * 
 * This automatically resolves field types against the canonical template
 * from templates.config.js to ensure correct ES mappings even when processing
 * historical templates with incorrect field definitions.
 * 
 * @param {string} templateName - Name of the template
 * @param {object} fieldsInTemplate - Fields from the template
 * @param {string} templateTxid - Optional: Transaction ID of the template being indexed
 */
async function updateMappingForNewTemplate(templateName, fieldsInTemplate, templateTxid = null) {
    try {
        // Let updateRecordsMappingForTemplate handle canonical resolution
        await updateRecordsMappingForTemplate(templateName, fieldsInTemplate, { templateTxid });
        console.log(`✅ Elasticsearch mapping auto-generated for new template: ${templateName}`);
    } catch (error) {
        console.warn(`⚠️  Could not auto-generate mapping for template ${templateName}:`, error.message);
        // Don't throw - template publishing should succeed even if mapping update fails
    }
}

/**
 * Update mapping for a single template by name (for testing/manual fixes)
 */
async function updateMappingForSingleTemplate(templateName, shouldReindex = false) {
    try {
        console.log(`🔍 Fetching template: ${templateName}`);
        
        // Search for the template by name (try multiple approaches)
        const templateResult = await elasticClient.search({
            index: 'templates',
            body: {
                size: 10,  // Get up to 10 templates with this name
                query: {
                    bool: {
                        should: [
                            { term: { 'data.template.keyword': templateName } },
                            { term: { 'data.template': templateName } },
                            { match: { 'data.template': templateName } }
                        ]
                    }
                }
            }
        });
        
        // Handle both response formats (with and without .body wrapper)
        const hits = templateResult.body?.hits?.hits || templateResult.hits?.hits || [];
        
        if (hits.length === 0) {
            throw new Error(`Template not found: ${templateName}`);
        }
        
        if (hits.length > 1) {
            console.log(`⚠️  Found ${hits.length} templates with name "${templateName}". Using the first one.`);
            console.log(`   Template IDs: ${hits.map(h => h._id).join(', ')}`);
        }
        
        const template = hits[0]._source;
        const fieldsInTemplate = template.data?.fieldsInTemplate;
        
        if (!fieldsInTemplate) {
            throw new Error(`Template ${templateName} has no fieldsInTemplate`);
        }
        
        console.log(`📋 Found template with ${Object.keys(fieldsInTemplate).length} fields`);
        
        // Update the mapping
        await updateRecordsMappingForTemplate(templateName, fieldsInTemplate);
        
        let recordsReindexed = 0;
        
        // Optionally reindex only records using this template
        if (shouldReindex) {
            console.log(`\n🔄 Reindexing records of type ${templateName}...`);
            
            const reindexResult = await elasticClient.updateByQuery({
                index: 'records',
                body: {
                    query: {
                        term: {
                            'oip.recordType.keyword': templateName
                        }
                    }
                },
                refresh: true,
                conflicts: 'proceed'
            });
            
            // Handle both response formats
            recordsReindexed = reindexResult.body?.updated || reindexResult.updated || 0;
            console.log(`✅ Reindexed ${recordsReindexed} ${templateName} records`);
        }
        
        return {
            templateName,
            fieldsMapped: Object.keys(fieldsInTemplate).filter(k => !k.startsWith('index_') && !k.endsWith('Values')).length,
            recordsReindexed
        };
        
    } catch (error) {
        console.error(`❌ Error updating mapping for template ${templateName}:`, error.message);
        throw error;
    }
}

module.exports = {
    mapOIPTypeToElasticsearchType,
    generateMappingFromTemplate,
    updateRecordsMappingForTemplate,
    updateAllRecordsMappings,
    updateMappingForNewTemplate,
    updateMappingForSingleTemplate
};
