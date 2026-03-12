const express = require('express');
const router = express.Router();
const { checkTemplateUsage, getTemplatesInDB } = require('../../helpers/core/elasticsearch');
const { publishNewRecord } = require('../../helpers/core/templateHelper');
const { authenticateToken } = require('../../helpers/utils');

// Clear cache and reload config to ensure we get the latest version
delete require.cache[require.resolve('../../config/templates.config')];
const templatesConfig = require('../../config/templates.config');

/**
 * GET /api/cleanup/analyze-templates
 * Analyze template usage to identify unused templates
 */
router.get('/analyze-templates', authenticateToken, async (req, res) => {
    try {
        console.log('🔍 Starting template usage analysis...');
        
        // Get all templates
        const templatesData = await getTemplatesInDB();
        const templates = templatesData.templatesInDB;
        
        console.log(`📋 Found ${templates.length} templates in database`);
        
        const unusedTemplates = [];
        const usedTemplates = [];
        let totalFields = 0;
        let unusedFields = 0;
        
        // Get list of default template transaction IDs to protect
        console.log(`🔍 Config file path:`, require.resolve('../../config/templates.config'));
        console.log(`🔍 Config exists:`, require('fs').existsSync(require.resolve('../../config/templates.config')));
        
        // Test direct require
        const testConfig = require('../../config/templates.config');
        console.log(`🔍 Test config load:`, JSON.stringify(testConfig, null, 2));
        
        // Test file system directly
        const fs = require('fs');
        const path = require('path');
        const configPath = path.join(__dirname, '../config/templates.config.js');
        console.log(`🔍 Config file exists:`, fs.existsSync(configPath));
        if (fs.existsSync(configPath)) {
            const fileContent = fs.readFileSync(configPath, 'utf8');
            console.log(`🔍 Config file content:`, fileContent);
            console.log(`🔍 File contains "organization":`, fileContent.includes('organization'));
            console.log(`🔍 File contains "multiResolutionGif":`, fileContent.includes('multiResolutionGif'));
        }
        
        console.log(`🔍 Full templates config:`, JSON.stringify(templatesConfig, null, 2));
        console.log(`🔍 Default templates object:`, JSON.stringify(templatesConfig.defaultTemplates, null, 2));
        console.log(`🔍 Config keys:`, Object.keys(templatesConfig.defaultTemplates || {}));
        console.log(`🔍 Config values:`, Object.values(templatesConfig.defaultTemplates || {}));
        const defaultTemplateTxIds = Object.values(templatesConfig.defaultTemplates || {});
        console.log(`🔒 Protecting ${defaultTemplateTxIds.length} default templates from deletion`);
        console.log(`🔍 Full default template IDs array:`, defaultTemplateTxIds);
        
        // Manual check for the specific organization template
        const orgTxId = "NQi19GjOw-Iv8PzjZ5P-XcFkAYu50cl5V_qceT2xlGM";
        console.log(`🔍 Manual check - organization in config:`, templatesConfig.defaultTemplates.organization);
        console.log(`🔍 Manual check - organization matches:`, templatesConfig.defaultTemplates.organization === orgTxId);
        console.log(`🔍 Manual check - includes org:`, defaultTemplateTxIds.includes(orgTxId));
        
        // Check usage for each template
        for (const template of templates) {
            const templateTxId = template.data.TxId;
            const templateName = template.data.template;
            const templateDid = template.oip.did || template.oip.didTx;
            const fieldCount = template.data.fieldsInTemplateCount || 0;
            
            totalFields += fieldCount;
            
            console.log(`🔍 Checking template: ${templateName} (${fieldCount} fields)`);
            console.log(`🔍 Template TxId: "${templateTxId}" | Type: ${typeof templateTxId}`);
            console.log(`🔍 Default templates array:`, defaultTemplateTxIds);
            console.log(`🔍 Includes check: ${defaultTemplateTxIds.includes(templateTxId)}`);
            
            // Check if this is a default template (always consider as "in use")
            const isDefaultTemplate = defaultTemplateTxIds.includes(templateTxId);
            const isInUse = isDefaultTemplate || await checkTemplateUsage(templateTxId);
            
            const templateInfo = {
                name: templateName,
                txId: templateTxId,
                did: templateDid,
                creator: template.oip.creator?.creatorHandle || 'Unknown',
                createdAt: template.oip.indexedAt,
                fieldCount: fieldCount,
                blockHeight: template.oip.inArweaveBlock,
                isDefault: isDefaultTemplate
            };
            
            if (isInUse) {
                usedTemplates.push(templateInfo);
                if (isDefaultTemplate) {
                    console.log(`🔒 Template "${templateName}" is a DEFAULT template (protected)`);
                } else {
                    console.log(`✅ Template "${templateName}" is in use`);
                }
            } else {
                unusedTemplates.push(templateInfo);
                unusedFields += fieldCount;
                console.log(`❌ Template "${templateName}" is NOT in use (${fieldCount} fields)`);
            }
        }
        
        // Sort unused templates by field count (highest first) to prioritize deletion
        unusedTemplates.sort((a, b) => b.fieldCount - a.fieldCount);
        
        const analysis = {
            totalTemplates: templates.length,
            usedTemplates: usedTemplates.length,
            unusedTemplates: unusedTemplates.length,
            totalFields: totalFields,
            unusedFields: unusedFields,
            potentialSavings: `${unusedFields} fields (${Math.round(unusedFields/totalFields*100)}% reduction)`,
            templates: {
                used: usedTemplates,
                unused: unusedTemplates
            }
        };
        
        res.json({
            success: true,
            message: 'Template analysis completed',
            analysis: analysis
        });
        
    } catch (error) {
        console.error('Error analyzing templates:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to analyze templates',
            details: error.message
        });
    }
});

/**
 * POST /api/cleanup/delete-unused-templates
 * Delete all unused templates (requires confirmation)
 */
router.post('/delete-unused-templates', authenticateToken, async (req, res) => {
    try {
        const { confirm, maxToDelete } = req.body;
        
        if (!confirm) {
            return res.status(400).json({
                success: false,
                error: 'Confirmation required. Send {"confirm": true} to proceed.'
            });
        }
        
        console.log('🗑️  Starting unused template deletion...');
        
        // Get all templates and find unused ones
        const templatesData = await getTemplatesInDB();
        const templates = templatesData.templatesInDB;
        
        // Get list of default template transaction IDs to protect
        const defaultTemplateTxIds = Object.values(templatesConfig.defaultTemplates || {});
        console.log(`🔒 Protecting ${defaultTemplateTxIds.length} default templates from deletion`);
        
        const unusedTemplates = [];
        
        for (const template of templates) {
            const templateTxId = template.data.TxId;
            const templateName = template.data.template;
            const templateDid = template.oip.did || template.oip.didTx;
            const fieldCount = template.data.fieldsInTemplateCount || 0;
            
            // Check if this is a default template (always consider as "in use")
            const isDefaultTemplate = defaultTemplateTxIds.includes(templateTxId);
            const isInUse = isDefaultTemplate || await checkTemplateUsage(templateTxId);
            
            if (!isInUse) {
                unusedTemplates.push({
                    name: templateName,
                    txId: templateTxId,
                    did: templateDid,
                    fieldCount: fieldCount,
                    creator: template.oip.creator?.creatorHandle || 'Unknown',
                    isDefault: false // These are confirmed not default since they passed the filter
                });
            } else if (isDefaultTemplate) {
                console.log(`🔒 Skipping default template: ${templateName} (${templateTxId})`);
            }
        }
        
        // Limit deletion count if specified
        const templatesToDelete = maxToDelete ? 
            unusedTemplates.slice(0, maxToDelete) : 
            unusedTemplates;
        
        console.log(`🗑️  Found ${unusedTemplates.length} unused templates, deleting ${templatesToDelete.length}...`);
        
        const deletionResults = [];
        let totalFieldsFreed = 0;
        
        for (const template of templatesToDelete) {
            try {
                console.log(`🗑️  Deleting template: ${template.name} (${template.fieldCount} fields)`);
                
                const deleteMessage = {
                    deleteTemplate: {
                        didTx: template.did,
                        version: "1.0.0"
                    }
                };
                
                // Publish delete template message to Arweave
                const result = await publishNewRecord(
                    deleteMessage, 
                    'deleteTemplate', 
                    false, // publishFiles
                    true,  // addMediaToArweave
                    false, // addMediaToIPFS
                    null,  // youtubeUrl
                    'arweave' // blockchain
                );
                
                if (result && result.transactionId) {
                    // Also immediately delete the template from Elasticsearch
                    try {
                        const { deleteTemplateFromDB } = require('../../helpers/core/elasticsearch');
                        const creatorDid = `did:arweave:${req.user.publisherPubKey || req.user.creatorAddress}`;
                        const mockTransaction = {
                            transactionId: result.transactionId,
                            creator: req.user.publisherPubKey || req.user.creatorAddress,
                            data: deleteMessage
                        };
                        await deleteTemplateFromDB(creatorDid, mockTransaction);
                        console.log(`✅ Template immediately deleted from Elasticsearch: ${template.name}`);
                    } catch (deleteError) {
                        console.warn(`⚠️ Delete message published but failed to immediately delete template ${template.name}:`, deleteError.message);
                    }
                    
                    deletionResults.push({
                        template: template.name,
                        did: template.did,
                        fieldCount: template.fieldCount,
                        deleteTransactionId: result.transactionId,
                        status: 'success'
                    });
                    totalFieldsFreed += template.fieldCount;
                    console.log(`✅ Delete message published: ${result.transactionId}`);
                } else {
                    deletionResults.push({
                        template: template.name,
                        did: template.did,
                        fieldCount: template.fieldCount,
                        status: 'failed',
                        error: 'No transaction ID returned'
                    });
                    console.log(`❌ Failed to publish delete message for ${template.name}`);
                }
                
                // Wait between deletions to avoid overwhelming the system
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                deletionResults.push({
                    template: template.name,
                    did: template.did,
                    fieldCount: template.fieldCount,
                    status: 'error',
                    error: error.message
                });
                console.error(`❌ Error deleting template ${template.name}:`, error);
            }
        }
        
        const successCount = deletionResults.filter(r => r.status === 'success').length;
        
        res.json({
            success: true,
            message: `Template deletion process completed. ${successCount}/${templatesToDelete.length} templates deleted.`,
            results: {
                totalUnused: unusedTemplates.length,
                attempted: templatesToDelete.length,
                successful: successCount,
                totalFieldsFreed: totalFieldsFreed,
                deletions: deletionResults
            }
        });
        
    } catch (error) {
        console.error('Error deleting unused templates:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete unused templates',
            details: error.message
        });
    }
});

/**
 * POST /api/cleanup/delete-template
 * Delete a specific template by DID (requires confirmation)
 */
router.post('/delete-template', authenticateToken, async (req, res) => {
    try {
        const { templateDid, confirm } = req.body;
        
        if (!templateDid) {
            return res.status(400).json({
                success: false,
                error: 'templateDid is required'
            });
        }
        
        if (!confirm) {
            return res.status(400).json({
                success: false,
                error: 'Confirmation required. Send {"confirm": true} to proceed.'
            });
        }
        
        console.log(`🗑️  Deleting specific template: ${templateDid}`);
        
        const deleteMessage = {
            deleteTemplate: {
                didTx: templateDid,
                version: "1.0.0"
            }
        };
        
        // Publish delete template message to Arweave
        const result = await publishNewRecord(
            deleteMessage, 
            'deleteTemplate', 
            false, // publishFiles
            true,  // addMediaToArweave
            false, // addMediaToIPFS
            null,  // youtubeUrl
            'arweave' // blockchain
        );
        
        if (result && result.transactionId) {
            // Also immediately delete the template from Elasticsearch
            try {
                const { deleteTemplateFromDB } = require('../../helpers/core/elasticsearch');
                const creatorDid = `did:arweave:${req.user.publisherPubKey || req.user.creatorAddress}`;
                const mockTransaction = {
                    transactionId: result.transactionId,
                    creator: req.user.publisherPubKey || req.user.creatorAddress,
                    data: deleteMessage
                };
                await deleteTemplateFromDB(creatorDid, mockTransaction);
                console.log(`✅ Template immediately deleted from Elasticsearch: ${templateDid}`);
            } catch (deleteError) {
                console.warn(`⚠️ Delete message published but failed to immediately delete template ${templateDid}:`, deleteError.message);
            }
            
            res.json({
                success: true,
                message: 'Template deletion message published successfully',
                templateDid: templateDid,
                deleteTransactionId: result.transactionId
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to publish delete message',
                templateDid: templateDid
            });
        }
        
    } catch (error) {
        console.error('Error deleting specific template:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete template',
            details: error.message
        });
    }
});

module.exports = router;
