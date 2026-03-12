// routes/organizations.js
const express = require('express');
const { getOrganizationsInDB } = require('../../helpers/core/elasticsearch');
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
        // Support optional limit parameter (default 100, max 1000)
        const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
        const organizations = await getOrganizationsInDB(limit);
        res.status(200).json(
            organizations
        );
    } catch (error) {
        console.error('Error retrieving organizations:', error);
        res.status(500).json({ error: 'Failed to retrieve organizations' });
    }
});

router.post('/newOrganization', authenticateToken, async (req, res) => {
    try {
        console.log('POST /api/organizations/newOrganization', req.body)
        const record = req.body;
        const blockchain = req.query.blockchain || req.body.blockchain || 'arweave'; // Accept from query or body
        let recordType = 'organization';
        
        // Remove blockchain from record data if it exists to prevent template processing errors
        if (record.blockchain) {
            delete record.blockchain;
        }
        
        const newRecord = await publishNewRecord(record, recordType, false, false, false, null, blockchain);
        const transactionId = newRecord.transactionId;
        const recordToIndex = newRecord.recordToIndex;
        
        res.status(200).json({ transactionId, recordToIndex, blockchain });
    } catch (error) {
        console.error('Error publishing organization:', error);
        res.status(500).json({ error: 'Failed to publish organization' });
    }
});

module.exports = router;
