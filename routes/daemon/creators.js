// routes/creators.js
const express = require('express');
const { getCreatorsInDB } = require('../../helpers/core/elasticsearch');
const { publishNewRecord } = require('../../helpers/core/templateHelper');
const { authenticateToken } = require('../../helpers/utils'); // Import the authentication middleware
const { Client } = require('@elastic/elasticsearch');

require('dotenv').config();

const elasticClient = new Client({
    node: process.env.ELASTICSEARCHHOST || 'http://elasticsearch:9200',
    auth: {
        username: process.env.ELASTICCLIENTUSERNAME,
        password: process.env.ELASTICCLIENTPASSWORD
    }
});

const router = express.Router();

router.get('/', async (req, res) => {
    try {
        // const creators = await elasticClient.search({
        //     index: 'creatorregistrations',
        //     body: {
        //         query: {
        //             match_all: {}
        //         }
        //     }
        // });
        // creatorRecords = creators.hits.hits.map(hit => hit._source);
        const creators = await getCreatorsInDB()
        res.status(200).json(
            creators
            // {
            // qtyRecordsInDB: records.qtyRecordsInDB,
            // maxArweaveBlockInDB: records.maxArweaveBlockInDB,
            // qtyReturned: creatorRecords.length,
            // creators: creatorRecords
        // }
    );
        // res.status(200).json({ creators: creators.hits.hits });
    } catch (error) {
        console.error('Error retrieving creators:', error);
        res.status(500).json({ error: 'Failed to retrieve creators' });
    }
});

// router.post('/newRecord', async (req, res) => {
//     // router.post('/newRecord', authenticateToken, async (req, res) => {
//         try {
//             console.log('POST /api/records/newRecord', req.body)
//             const record = req.body;
//             let recordType = req.query.recordType;
//             // if (recordType = 'creatorRegistration') {
//             //     record.publicKey = req.query.publicKey;
//             // }
//             const publishFiles = req.query.publishFiles === 'true';
//             const addMediaToArweave = req.query.addMediaToArweave !== 'false'; // Default to true
//             const addMediaToIPFS = req.query.addMediaToIPFS === 'true';
//             const addMediaToArFleet = req.query.addMediaToArFleet === 'true'; // Default to false
//             const youtubeUrl = req.query.youtubeUrl || null;
//             const newRecord = await publishNewRecord(record, recordType, publishFiles, addMediaToArweave, addMediaToIPFS, youtubeUrl, blockchain, addMediaToArFleet);
//             const transactionId = newRecord.transactionId;
//             const dataForSignature = newRecord.dataForSignature;
//             const creatorSig = newRecord.creatorSig;
//             res.status(200).json({ transactionId, dataForSignature, creatorSig });
//         } catch (error) {
//             console.error('Error publishing record:', error);
//             res.status(500).json({ error: 'Failed to publish record' });
//         }
//     });

router.post('/newCreator', authenticateToken, async (req, res) => {
    try {
        console.log('POST /api/creators/newCreator', req.body)
        const record = req.body;
        // const blockchain = req.query.blockchain || req.body.blockchain || 'arweave'; // Accept from query or body
        let recordType = 'creatorRegistration';
        
        // Remove blockchain from record data if it exists to prevent template processing errors
        if (record.blockchain) {
            delete record.blockchain;
        }
        
        const newRecord = await publishNewRecord(record, recordType, false, false, false, null, blockchain);
        const transactionId = newRecord.transactionId;
        const recordToIndex = newRecord.recordToIndex;
        
        res.status(200).json({ transactionId, recordToIndex, blockchain });
    } catch (error) {
        console.error('Error publishing creator:', error);
        res.status(500).json({ error: 'Failed to publish creator' });
    }
});

module.exports = router;