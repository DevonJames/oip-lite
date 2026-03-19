const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../helpers/utils'); // Import the authentication middleware
const { getTemplatesInDB } = require('../../helpers/core/elasticsearch');
const { publishNewTemplate, publishNewTemplateV09, indexTemplate } = require('../../helpers/core/templateHelper');
const templatesConfig = require('../../config/templates.config');
const { V09_TEMPLATES } = require('../../config/templates-v09');

function buildFieldsInTemplateFromRawFields(rawFields = {}) {
    return Object.keys(rawFields).reduce((acc, key) => {
        if (!key.startsWith('index_')) return acc;
        const fieldName = key.replace('index_', '');
        acc[fieldName] = {
            type: rawFields[fieldName],
            index: rawFields[key]
        };

        // Include enum values if present in the raw template payload
        if (rawFields[fieldName] === 'enum') {
            const enumValuesKey = `${fieldName}Values`;
            if (rawFields[enumValuesKey]) {
                acc[fieldName].enumValues = rawFields[enumValuesKey];
            }
        }
        return acc;
    }, {});
}

function normalizeTemplateForResponse(template) {
    const normalized = JSON.parse(JSON.stringify(template));
    const rawFields = (typeof normalized?.data?.fields === 'string')
        ? JSON.parse(normalized.data.fields)
        : (normalized?.data?.fields || {});

    const fieldsInTemplate = buildFieldsInTemplateFromRawFields(rawFields);
    normalized.data.fieldsInTemplate = fieldsInTemplate;
    normalized.data.fieldsInTemplateCount = Object.keys(fieldsInTemplate).length;

    if (!normalized.oip) {
        normalized.oip = {};
    }
    normalized.oip.creator = {
        didAddress: normalized?.data?.creator,
        creatorSig: normalized?.data?.creatorSig
    };

    // Keep response shape consistent with existing behavior
    delete normalized.data.creator;
    delete normalized.data.creatorSig;

    return normalized;
}

function getHardcodedV09Templates() {
    return Object.entries(V09_TEMPLATES).map(([recordType, schema]) => {
        const fields = {};
        Object.entries(schema.fields).forEach(([index, field]) => {
            fields[field.name] = field.type;
            fields[`index_${field.name}`] = Number(index);
        });

        const rawTemplate = {
            data: {
                TxId: schema.templateDid.replace('did:arweave:', ''),
                template: recordType,
                recordType,
                fields: JSON.stringify(fields)
            },
            oip: {
                did: schema.templateDid,
                didTx: schema.templateDid,
                recordType: 'template',
                recordStatus: 'hardcoded fallback',
                indexedAt: new Date(0).toISOString(),
                creator: {
                    didAddress: 'did:arweave:hardcoded-v09'
                }
            }
        };

        return normalizeTemplateForResponse(rawTemplate);
    });
}


router.get('/', async (req, res) => {
    try {
        const currentTemplatesInDB = await getTemplatesInDB();
        console.log('currentTemplatesInDB:', currentTemplatesInDB);

        let templates = currentTemplatesInDB.templatesInDB;
        let qtyTemplatesInDB = currentTemplatesInDB.qtyTemplatesInDB;
        let finalMaxArweaveBlock = currentTemplatesInDB.finalMaxArweaveBlock;

        const { sortBy, creatorHandle, creatorDidAddress, didTx, templateName } = req.query;

        // New query params
        const parseBooleanQuery = (value) => {
            if (typeof value === 'boolean') return value;
            if (typeof value !== 'string') return false;
            const normalized = value.toLowerCase();
            return ['1', 'true', 'yes', 'on'].includes(normalized);
        };

        const selectedOnly = parseBooleanQuery(req.query.selectedOnly);
        const typeScriptTypes = parseBooleanQuery(req.query.typeScriptTypes);

        // Filter by creatorHandle
        // if (creatorHandle) {
        //     templates = templates.filter(template => template.oip.creatorHandle === creatorHandle);
        //     console.log('after filtering by creatorHandle, there are', templates.length, 'templates');
        // }

        // Filter by creatorDidAddress
        if (creatorDidAddress) {
            templates = templates.filter(template => template.oip.creator.didAddress === creatorDidAddress);
            console.log('after filtering by creatorDidAddress, there are', templates.length, 'templates');
        }

        // Filter by didTx
        if (didTx) {
            templates = templates.filter(template => 
                (template.oip.did || template.oip.didTx) === didTx
            );
            console.log('after filtering by didTx, there are', templates.length, 'templates');
        }

        // Filter by template name
        if (templateName) {
            templates = templates.filter(template => template.data.template.toLowerCase().includes(templateName.toLowerCase()));
            console.log('after filtering by templateName, there are', templates.length, 'templates');
        }

        // Filter to only templates explicitly selected in templates.config.js when requested
        if (selectedOnly) {
            try {
                const defaultTemplates = (templatesConfig && templatesConfig.defaultTemplates) ? templatesConfig.defaultTemplates : {};
                const selectedTxIds = new Set(Object.values(defaultTemplates || {})); // raw txids from config
                templates = templates.filter(template => {
                    const txId = template?.data?.TxId;
                    const didTx = template?.oip?.did || template?.oip?.didTx; // format: did:arweave:<txid>
                    if (txId && selectedTxIds.has(txId)) return true;
                    if (didTx && typeof didTx === 'string' && didTx.startsWith('did:arweave:')) {
                        const plain = didTx.replace('did:arweave:', '');
                        if (selectedTxIds.has(plain)) return true;
                    }
                    return false;
                });
                console.log('after selectedOnly filtering, there are', templates.length, 'templates');
            } catch (err) {
                console.error('Error applying selectedOnly filter:', err);
            }
        }

        // Sort by inArweaveBlock
        if (sortBy) {
            const [field, order] = sortBy.split(':');
            if (field === 'inArweaveBlock') {
                templates.sort((a, b) => {
                    if (order === 'asc') {
                        return a.oip.inArweaveBlock - b.oip.inArweaveBlock;
                    } else {
                        return b.oip.inArweaveBlock - a.oip.inArweaveBlock;
                    }
                });
            }
        }

        templates = templates.map(template => normalizeTemplateForResponse(template));

        // Add hardcoded v0.9 templates when they are not present in the DB.
        // This keeps registration and schema lookup functional during bootstrap/index lag.
        const existingTemplateNames = new Set(
            templates
                .map(template => template?.data?.template || template?.data?.recordType)
                .filter(Boolean)
        );
        const missingV09Fallbacks = getHardcodedV09Templates()
            .filter(template => !existingTemplateNames.has(template.data.template));
        templates.push(...missingV09Fallbacks);
        // If the caller requests TypeScript types, generate and return them instead of the standard payload
        if (typeScriptTypes) {
            const typeMap = (fieldInfo) => {
                const fieldType = (fieldInfo && typeof fieldInfo.type === 'string') ? fieldInfo.type.toLowerCase() : '';
                switch (fieldType) {
                    case 'string':
                        return 'string';
                    case 'long':
                    case 'uint64':
                    case 'float':
                    case 'number':
                    case 'integer':
                        return 'number';
                    case 'bool':
                    case 'boolean':
                        return 'boolean';
                    case 'enum':
                        // handled specially below (type alias)
                        return 'enum';
                    case 'dref':
                        return 'string';
                    case 'repeated string':
                        return 'string[]';
                    case 'repeated dref':
                        return 'string[]';
                    default:
                        return 'unknown';
                }
            };

            const toPascalCase = (name) => {
                if (!name || typeof name !== 'string') return 'Unknown';
                return name
                    .replace(/[-_\s]+/g, ' ')
                    .split(' ')
                    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
                    .join('')
                    .replace(/[^A-Za-z0-9]/g, '');
            };

            const lines = [];
            lines.push('// Auto-generated TypeScript types from OIP Arweave templates');
            lines.push(`// Generated on ${new Date().toISOString()}`);
            lines.push('');

            // Collect enum type aliases across all templates first
            const enumAliases = new Map(); // aliasName -> { template: string, field: string, values: array, isCodeName: boolean }

            for (const template of templates) {
                const templateNameRaw = (template?.data?.template) || (template?.data?.recordType) || 'unknown';
                const fieldsInTemplate = template?.data?.fieldsInTemplate || {};
                for (const [fieldName, info] of Object.entries(fieldsInTemplate)) {
                    if (!info || typeof info !== 'object') continue;
                    const t = (info.type || '').toLowerCase();
                    if (t !== 'enum') continue;

                    const values = info.enumValues || [];
                    const isCodeNameObjects = Array.isArray(values) && values.length > 0 && typeof values[0] === 'object' && (values[0].code !== undefined);
                    const aliasBase = toPascalCase(fieldName);
                    const aliasName = isCodeNameObjects ? `${aliasBase}Code` : aliasBase;

                    if (!enumAliases.has(aliasName)) {
                        enumAliases.set(aliasName, {
                            template: String(templateNameRaw).toLowerCase(),
                            field: fieldName,
                            values,
                            isCodeName: isCodeNameObjects
                        });
                    }
                }
            }

            // Emit enum aliases
            for (const [aliasName, def] of enumAliases.entries()) {
                lines.push(`// Enum from "${def.template}.${def.field}" template field`);
                lines.push(`export type ${aliasName} =`);
                if (def.isCodeName) {
                    for (const v of def.values) {
                        const code = String(v.code);
                        const name = (v.name !== undefined && v.name !== null) ? String(v.name) : '';
                        lines.push(`  | "${code}"${name ? ` // ${name}` : ''}`);
                    }
                } else if (Array.isArray(def.values)) {
                    for (const v of def.values) {
                        lines.push(`  | "${String(v)}"`);
                    }
                }
                lines.push(';');
                lines.push('');
            }

            // Build a stable list by unique template name, prefer the first occurrence
            const seenNames = new Set();
            for (const template of templates) {
                const templateNameRaw = (template?.data?.template) || (template?.data?.recordType) || 'unknown';
                const interfaceName = toPascalCase(templateNameRaw);
                if (seenNames.has(interfaceName)) continue;
                seenNames.add(interfaceName);

                const fieldsInTemplate = template?.data?.fieldsInTemplate || {};
                lines.push(`export interface ${interfaceName} {`);

                const fieldEntries = Object.entries(fieldsInTemplate);
                for (const [fieldName, info] of fieldEntries) {
                    const mapped = typeMap(info);
                    let tsType;
                    if (mapped === 'enum') {
                        const values = info.enumValues || [];
                        const isCodeNameObjects = Array.isArray(values) && values.length > 0 && typeof values[0] === 'object' && (values[0].code !== undefined);
                        const aliasBase = toPascalCase(fieldName);
                        const aliasName = isCodeNameObjects ? `${aliasBase}Code` : aliasBase;
                        tsType = aliasName;
                    } else {
                        tsType = mapped;
                    }
                    lines.push(`  ${fieldName}: ${tsType};`);
                }
                lines.push('}');
                lines.push('');
            }

            const generated = lines.join('\n');
            // Return as JSON containing the TypeScript source text
            return res.status(200).json({ typeScript: generated });
        }

        let searchResults = templates.length;
        res.status(200).json({ message: "Templates retreived successfully", latestArweaveBlockInDB: finalMaxArweaveBlock, totalTemplates: qtyTemplatesInDB, searchResults, templates });
        // res.status(200).json(templates);
    } catch (error) {
        console.error('Error retrieving templates:', error);
        res.status(500).json({ error: 'Failed to retrieve templates' });
    }
});

router.get('/:name', async (req, res) => {
    try {
        const lookupRaw = String(req.params.name || '').trim();
        const lookup = lookupRaw.toLowerCase();

        const { templatesInDB } = await getTemplatesInDB();
        const normalizedTemplates = (templatesInDB || []).map(template => normalizeTemplateForResponse(template));
        const fallbackTemplates = getHardcodedV09Templates();
        const allTemplates = [...normalizedTemplates];

        // Add fallback templates only when missing by name
        const existingNames = new Set(
            allTemplates
                .map(template => template?.data?.template || template?.data?.recordType)
                .filter(Boolean)
        );
        fallbackTemplates.forEach(template => {
            if (!existingNames.has(template.data.template)) {
                allTemplates.push(template);
            }
        });

        const match = allTemplates.find(template => {
            const templateName = String(template?.data?.template || template?.data?.recordType || '').toLowerCase();
            const txId = String(template?.data?.TxId || '').toLowerCase();
            const did = String(template?.oip?.did || template?.oip?.didTx || '').toLowerCase();
            const didTx = did.replace(/^did:arweave:/, '');

            return templateName === lookup || txId === lookup || did === lookup || didTx === lookup;
        });

        if (!match) {
            return res.status(404).json({
                error: 'Template not found',
                message: `No template found for "${lookupRaw}"`
            });
        }

        return res.status(200).json({
            message: 'Template retrieved successfully',
            template: match
        });
    } catch (error) {
        console.error('Error retrieving template by name:', error);
        return res.status(500).json({ error: 'Failed to retrieve template' });
    }
});


router.post('/newTemplate', authenticateToken, async (req, res) => {
// router.post('/newTemplate', async (req, res) => {
    try {
        console.log('POST /api/templates/newTemplate', req.body)
        const template = req.body;
        const blockchain = req.body.blockchain || 'arweave'; // Accept blockchain parameter
        
        // v0.9 is now the default. Only use v0.8 if explicitly requested
        const options = {
            version: req.body.version || '0.9' // Default to v0.9
        };
        
        // Publish template to Arweave (defaults to v0.9)
        const newTemplate = await publishNewTemplate(template, blockchain, options);
        
        // Index template to Elasticsearch with pending status
        if (newTemplate.templateToIndex) {
            await indexTemplate(newTemplate.templateToIndex);
            console.log('Template indexed with pending status:', newTemplate.did || newTemplate.didTx);
        }
        
        res.status(200).json({ 
            newTemplate: {
                transactionId: newTemplate.transactionId,
                did: newTemplate.did || newTemplate.didTx,
                didTx: newTemplate.didTx, // Backward compatibility
                blockchain: newTemplate.blockchain,
                provider: newTemplate.provider,
                url: newTemplate.url,
                indexedToPendingStatus: true
            }, 
            blockchain 
        });
    } catch (error) {
        console.error('Error publishing template:', error);
        res.status(500).json({ error: 'Failed to publish template' });
    }
});

router.post('/newTemplateRemap', authenticateToken, async (req, res) => {
// router.post('/newTemplateRemap', async (req, res) => {
    try {
        const templateRemap = req.body;
        if (!validateTemplateRemap(templateRemap)) {
            return res.status(400).send('Invalid template remap data');
        }
        const result = await saveTemplateRemap(templateRemap);
        res.status(201).json({
            message: "Template remap saved successfully",
            data: result
        });
    } catch (error) {
        console.error('Error handling templateRemap:', error);
        res.status(500).send('Internal Server Error');
    }
});

module.exports = router;