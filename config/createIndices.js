require('dotenv').config();
const { Client } = require('@elastic/elasticsearch');
const { ensureIndexExists, ensureUserIndexExists } = require('../helpers/core/elasticsearch');

const client = new Client({
    node: process.env.ELASTICSEARCHHOST,
    auth: {
        username: process.env.ELASTICCLIENTUSERNAME,
        password: process.env.ELASTICCLIENTPASSWORD
    },
    maxRetries: 5,
    requestTimeout: 60000,
    ssl: {
        rejectUnauthorized: false
    }
});

async function createContentPaymentsIndex() {
    try {
        const indexExists = await client.indices.exists({
            index: 'content_payments'
        });

        if (!indexExists) {
            await client.indices.create({
                index: 'content_payments',
                body: {
                    mappings: {
                        properties: {
                            contentId: { type: 'keyword' },
                            videoTxId: { type: 'keyword' },
                            userId: { type: 'keyword' },
                            createdAt: { type: 'date' },
                            paymentAddresses: {
                                properties: {
                                    bitcoin: { type: 'keyword' }
                                    // Add other currencies here
                                }
                            },
                            payments: {
                                type: 'nested',
                                properties: {
                                    currency: { type: 'keyword' },
                                    amount: { type: 'float' },
                                    txid: { type: 'keyword' },
                                    receivedAt: { type: 'date' },
                                    confirmedAt: { type: 'date' },
                                    status: { type: 'keyword' }
                                }
                            },
                            price: { type: 'float' },
                            currency: { type: 'keyword' }
                        }
                    }
                }
            });
            console.log('Content payments index created successfully');
        }
    } catch (error) {
        console.error('Error creating content payments index:', error);
        throw error;
    }
}

async function createNotificationsIndex() {
    try {
        const indexExists = await client.indices.exists({
            index: 'notifications'
        });

        if (!indexExists) {
            await client.indices.create({
                index: 'notifications',
                body: {
                    mappings: {
                        properties: {
                            userId: { type: 'keyword' },
                            type: { type: 'keyword' },
                            contentId: { type: 'keyword' },
                            amount: { type: 'float' },
                            currency: { type: 'keyword' },
                            txid: { type: 'keyword' },
                            createdAt: { type: 'date' },
                            read: { type: 'boolean' }
                        }
                    }
                }
            });
            console.log('Notifications index created successfully');
        }
    } catch (error) {
        console.error('Error creating notifications index:', error);
        throw error;
    }
}

/**
 * Creates the index for storing cryptocurrency swap data
 */
async function createSwapsIndex() {
    try {
        const indexName = 'swaps';
        
        console.log(`Checking if ${indexName} index exists...`);
        
        // Use the exists API with proper error handling
        const indexExists = await client.indices.exists({
            index: indexName
        }).catch(err => {
            console.error(`Error checking if index exists: ${err.message}`);
            return { body: false }; // Return a default value in case of error
        });
        
        // Check if the index exists based on the statusCode
        if (indexExists.statusCode === 404 || indexExists.body === false) {
            console.log(`Creating ${indexName} index...`);
            
            try {
                await client.indices.create({
                    index: indexName,
                    body: {
                        mappings: {
                            properties: {
                                swapId: { type: 'keyword' },
                                status: { type: 'keyword' },
                                fromCurrency: { type: 'keyword' },
                                toCurrency: { type: 'keyword' },
                                fromAmount: { type: 'float' },
                                toAmount: { type: 'float' },
                                depositAddress: { type: 'keyword' },
                                depositAmount: { type: 'float' },
                                toAddress: { type: 'keyword' },
                                userId: { type: 'keyword' },
                                tradeId: { type: 'keyword' },
                                expectedRate: { type: 'float' },
                                created: { type: 'date' },
                                updated: { type: 'date' },
                                completed: { type: 'date' },
                                logs: {
                                    type: 'nested',
                                    properties: {
                                        time: { type: 'date' },
                                        status: { type: 'keyword' },
                                        message: { type: 'text' }
                                    }
                                },
                                customData: { type: 'object', enabled: false }
                            }
                        },
                        settings: {
                            number_of_shards: 1,
                            number_of_replicas: 0
                        }
                    }
                });
                console.log(`Index ${indexName} created successfully`);
            } catch (createError) {
                // Check if it's just because the index already exists
                if (createError.meta && createError.meta.body && 
                    createError.meta.body.error && 
                    createError.meta.body.error.type === 'resource_already_exists_exception') {
                    console.log(`Index ${indexName} already exists (created by another process)`);
                } else {
                    // If it's a different error, rethrow it
                    throw createError;
                }
            }
        } else {
            console.log(`Index ${indexName} already exists`);
        }
    } catch (error) {
        console.warn(`Warning: Error during swaps index creation: ${error.message}`);
        // Don't throw the error, just log it to avoid stopping the server startup
    }
}

/**
 * Creates the index for Alfred Meeting Notes
 */
async function createNotesIndex() {
    try {
        const indexName = 'notes';
        console.log(`Checking if ${indexName} index exists...`);
        
        const indexExists = await client.indices.exists({
            index: indexName
        }).catch(err => {
            console.error(`Error checking if index exists: ${err.message}`);
            return { body: false };
        });
        
        if (indexExists.statusCode === 404 || indexExists.body === false) {
            console.log(`Creating ${indexName} index...`);
            
            try {
                await client.indices.create({
                    index: indexName,
                    body: {
                        mappings: {
                            properties: {
                                // OIP metadata
                                did: { type: 'keyword' },
                                noteHash: { type: 'keyword' },
                                userPublicKey: { type: 'keyword' },
                                storage: { type: 'keyword' },
                                indexedAt: { type: 'date' },
                                
                                // Note metadata
                                note_type: { type: 'keyword' },
                                created_at: { type: 'date' },
                                ended_at: { type: 'date' },
                                device_type: { type: 'keyword' },
                                capture_location: { type: 'text' },
                                
                                // Transcription
                                transcription_status: { type: 'keyword' },
                                transcript_did: { type: 'keyword' },
                                transcription_engine_did: { type: 'keyword' },
                                
                                // Summary fields
                                summary_key_points: { type: 'text' },
                                summary_decisions: { type: 'text' },
                                summary_action_item_texts: { type: 'text' },
                                summary_action_item_assignees: { type: 'keyword' },
                                summary_action_item_due_texts: { type: 'text' },
                                summary_open_questions: { type: 'text' },
                                summary_version: { type: 'integer' },
                                sentiment_overall: { type: 'keyword' },
                                
                                // Participants
                                participant_display_names: { type: 'keyword' },
                                participant_roles: { type: 'keyword' },
                                
                                // Calendar
                                calendar_event_id: { type: 'keyword' },
                                calendar_start_time: { type: 'date' },
                                calendar_end_time: { type: 'date' },
                                
                                // Chunking
                                chunking_strategy: { type: 'keyword' },
                                chunk_count: { type: 'integer' },
                                
                                // Auto-generated
                                topics_auto: { type: 'keyword' },
                                keywords_auto: { type: 'keyword' },
                                
                                // Flags
                                is_archived: { type: 'boolean' },
                                is_pinned: { type: 'boolean' },
                                user_edits_present: { type: 'boolean' }
                            }
                        },
                        settings: {
                            number_of_shards: 1,
                            number_of_replicas: 0
                        }
                    }
                });
                console.log(`Index ${indexName} created successfully`);
            } catch (createError) {
                if (createError.meta?.body?.error?.type === 'resource_already_exists_exception') {
                    console.log(`Index ${indexName} already exists (created by another process)`);
                } else {
                    throw createError;
                }
            }
        } else {
            console.log(`Index ${indexName} already exists`);
        }
    } catch (error) {
        console.warn(`Warning: Error during ${indexName} index creation: ${error.message}`);
    }
}

/**
 * Creates the index for note chunks
 */
async function createNoteChunksIndex() {
    try {
        const indexName = 'noteChunks';
        console.log(`Checking if ${indexName} index exists...`);
        
        const indexExists = await client.indices.exists({
            index: indexName
        }).catch(err => {
            console.error(`Error checking if index exists: ${err.message}`);
            return { body: false };
        });
        
        if (indexExists.statusCode === 404 || indexExists.body === false) {
            console.log(`Creating ${indexName} index...`);
            
            try {
                await client.indices.create({
                    index: indexName,
                    body: {
                        mappings: {
                            properties: {
                                // OIP metadata
                                did: { type: 'keyword' },
                                localId: { type: 'keyword' },
                                noteHash: { type: 'keyword' },
                                noteDid: { type: 'keyword' },
                                userPublicKey: { type: 'keyword' },
                                storage: { type: 'keyword' },
                                indexedAt: { type: 'date' },
                                
                                // Chunk data
                                chunk_index: { type: 'integer' },
                                start_time_ms: { type: 'long' },
                                end_time_ms: { type: 'long' },
                                text: { type: 'text' },
                                speaker_label: { type: 'keyword' },
                                
                                // Metadata
                                is_marked_important: { type: 'boolean' },
                                sentiment: { type: 'keyword' },
                                confidence_score: { type: 'float' },
                                
                                // Derived from parent note (for filtering)
                                note_type: { type: 'keyword' },
                                participant_display_names: { type: 'keyword' },
                                calendar_event_id: { type: 'keyword' }
                            }
                        },
                        settings: {
                            number_of_shards: 1,
                            number_of_replicas: 0,
                            // Enable best_fields for text search on chunks
                            index: {
                                max_result_window: 10000
                            }
                        }
                    }
                });
                console.log(`Index ${indexName} created successfully`);
            } catch (createError) {
                if (createError.meta?.body?.error?.type === 'resource_already_exists_exception') {
                    console.log(`Index ${indexName} already exists (created by another process)`);
                } else {
                    throw createError;
                }
            }
        } else {
            console.log(`Index ${indexName} already exists`);
        }
    } catch (error) {
        console.warn(`Warning: Error during ${indexName} index creation: ${error.message}`);
    }
}

/**
 * Initialize all indices without exiting the process
 * @returns {Promise} Promise that resolves when all indices are initialized
 */
async function initializeIndices() {
    try {
        const arweaveSyncEnabled = process.env.ARWEAVE_SYNC_ENABLED !== 'false';
        
        if (!arweaveSyncEnabled) {
            console.log('Initializing Elasticsearch indices (web server + login mode)...');
            console.log('⏭️  Skipping Arweave-related indices (ARWEAVE_SYNC_ENABLED=false)');
        } else {
            console.log('Initializing Elasticsearch indices...');
        }
        
        // Always initialize users index (needed for authentication/login)
        await ensureUserIndexExists();
        console.log('Users index initialized');
        
        // Only initialize Arweave-related indices if syncing is enabled
        if (arweaveSyncEnabled) {
            // Initialize core OIP indices (records, templates, creatorregistrations)
            await ensureIndexExists();
            console.log('Core OIP indices (records, templates, creatorregistrations) initialized');
            
            // Initialize additional indices
            await Promise.all([
                createContentPaymentsIndex(),
                createNotificationsIndex(),
                createSwapsIndex(),
                createNotesIndex(),
                createNoteChunksIndex()
            ]);
            
            console.log('All indices initialized successfully');
        } else {
            console.log('✅ Indices initialized (users index only - web server + login mode)');
        }
        
        return true;
    } catch (error) {
        console.error('Error initializing indices:', error);
        throw error;
    }
}

module.exports = {
    createContentPaymentsIndex,
    createNotificationsIndex,
    createSwapsIndex,
    createNotesIndex,
    createNoteChunksIndex,
    initializeIndices
}; 