#!/usr/bin/env node

/**
 * Update Elasticsearch mappings from OIP templates
 * Run this script to ensure all template field types are properly mapped in Elasticsearch
 * 
 * Usage:
 *   node config/updateElasticsearchMappings.js                  # Update all templates
 *   node config/updateElasticsearchMappings.js shoppingList     # Update single template
 *   
 * This will:
 * 1. Read template(s) from the templates index
 * 2. Extract field type definitions from each template
 * 3. Generate proper Elasticsearch mappings
 * 4. Update the records index with correct field types
 * 5. Reindex existing records to apply the new mappings (if --reindex flag)
 */

require('dotenv').config();
const { 
    updateAllRecordsMappings, 
    updateMappingForSingleTemplate 
} = require('../helpers/generateElasticsearchMappings');

console.log('🚀 OIP Elasticsearch Mapping Generator');
console.log('=====================================\n');

async function main() {
    const args = process.argv.slice(2);
    const templateName = args[0];
    const shouldReindex = args.includes('--reindex');
    
    try {
        if (templateName && templateName !== '--reindex') {
            // Single template mode
            console.log(`🎯 Updating mapping for single template: ${templateName}\n`);
            
            const result = await updateMappingForSingleTemplate(templateName, shouldReindex);
            
            console.log('\n🎉 Success!');
            console.log(`\n📊 Summary:`);
            console.log(`   Template: ${templateName}`);
            console.log(`   Fields mapped: ${result.fieldsMapped}`);
            if (shouldReindex) {
                console.log(`   Records reindexed: ${result.recordsReindexed || 0}`);
            }
            console.log(`\n✅ Elasticsearch mapping updated for template: ${templateName}`);
            
        } else {
            // All templates mode
            console.log('📚 Updating mappings for ALL templates...\n');
            console.log('This will process all templates in your system.');
            console.log('This ensures fields like "float" and "repeated float" are correctly typed.\n');
            
            const result = await updateAllRecordsMappings();
            
            console.log('\n🎉 Success!');
            console.log(`\n📊 Summary:`);
            console.log(`   Templates processed: ${result.templatesProcessed}`);
            console.log(`   Mappings updated: ${result.mappingsUpdated}`);
            console.log(`   Records reindexed: ${result.recordsReindexed}`);
            console.log(`\n✅ Elasticsearch mappings are now synchronized with your OIP templates!`);
        }
        
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
