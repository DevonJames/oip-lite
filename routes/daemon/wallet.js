const express = require('express');
const router = express.Router();
const { upfrontFunding, lazyFunding, checkBalance } = require('../../helpers/core/arweave');
const paymentManager = require('../../helpers/payment-manager');
const { authenticateToken, txidToDid } = require('../../helpers/utils');
const arweaveWallet = require('../../helpers/core/arweave-wallet');
const paymentVerification = require('../../helpers/payment-verification');
const { Client } = require('@elastic/elasticsearch');
const { getUserNotifications, markNotificationsAsRead } = require('../../helpers/notification');

const client = new Client({
    node: process.env.ELASTICSEARCHHOST,
    auth: {
        username: process.env.ELASTICCLIENTUSERNAME,
        password: process.env.ELASTICCLIENTPASSWORD
    },
    maxRetries: 5,
    requestTimeout: 60000,
    ssl: { rejectUnauthorized: false }
});

// Endpoint to check wallet balance
router.get('/checkbalance', authenticateToken, async (req, res) => {
    console.log('GET /api/wallet/checkbalance');
    try {
        const balance = await checkBalance();
        console.log('Balance retrieved successfully:', balance);
        res.status(200).json({ balance });
    } catch (error) {
        console.error('Error retrieving balance:', error);
        res.status(500).json({ error: 'Failed to retrieve balance' });
    }
});

// Endpoint to fund wallet with a specific amount upfront
// router.post('/fund/upfront', async (req, res) => {
//     console.log('POST /api/wallet/fund/upfront');
//     const { amount, multiplier } = req.body;
//     try {
//         const response = await upfrontFunding(amount, multiplier || 1); // Default multiplier is 1 if not provided
//         console.log('Upfront funding successful:', response);
//         res.status(200).json({ message: 'Upfront funding successful', response });
//     } catch (error) {
//         console.error('Error during upfront funding:', error);
//         res.status(500).json({ error: 'Upfront funding failed' });
//     }
// });

// // Endpoint to fund wallet lazily based on data size
// router.post('/fund/lazy', async (req, res) => {
//     console.log('POST /api/wallet/fund/lazy');
//     const { size, multiplier } = req.body;
//     try {
//         const response = await lazyFunding(size, multiplier || 1); // Default multiplier is 1 if not provided
//         console.log('Lazy funding successful:', response);
//         res.status(200).json({ message: 'Lazy funding successful', response });
//     } catch (error) {
//         console.error('Error during lazy funding:', error);
//         res.status(500).json({ error: 'Lazy funding failed' });
//     } 
// });

// Get a new payment address
router.post('/address', authenticateToken, async (req, res) => {
    try {
        const { currency } = req.body;
        
        if (!currency) {
            return res.status(400).json({ error: 'Currency type required' });
        }

        const addressInfo = await paymentManager.getPaymentAddress(currency);
        
        // Store the address info in database with user association
        // This will help prevent address reuse and track payments
        await storeAddressInfo({
            userId: req.user.id,
            currency,
            address: addressInfo.address,
            path: addressInfo.path,
            publicKey: addressInfo.publicKey,
            createdAt: new Date()
        });

        res.json({
            status: 'success',
            data: addressInfo
        });

    } catch (error) {
        console.error('Error generating payment address:', error);
        res.status(500).json({ error: 'Failed to generate payment address' });
    }
});

// Get wallet balances
router.get('/balances', authenticateToken, async (req, res) => {
    try {
        const balances = {
            arweave: await arweaveWallet.getBalance(),
            bitcoin: await getBitcoinBalance(req.user.id),
            zcash: await getZcashBalance(req.user.id)
        };

        res.json({
            status: 'success',
            data: balances
        });

    } catch (error) {
        console.error('Error fetching balances:', error);
        res.status(500).json({ error: 'Failed to fetch wallet balances' });
    }
});

// Get transaction history
router.get('/transactions', authenticateToken, async (req, res) => {
    try {
        const { currency, limit = 10, offset = 0 } = req.query;
        
        const transactions = await getTransactionHistory({
            userId: req.user.id,
            currency,
            limit,
            offset
        });

        res.json({
            status: 'success',
            data: transactions
        });

    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Failed to fetch transaction history' });
    }
});

// Verify payment for content
router.post('/verify-payment', authenticateToken, async (req, res) => {
    try {
        const { contentId, currency, txid } = req.body;

        if (!contentId || !currency || !txid) {
            return res.status(400).json({
                error: 'Missing required parameters'
            });
        }

        const verificationResult = await paymentVerification.verifyPayment(
            contentId,
            currency,
            txid
        );

        res.json({
            status: 'success',
            data: verificationResult
        });

    } catch (error) {
        console.error('Payment verification error:', error);
        res.status(500).json({
            error: 'Payment verification failed',
            details: error.message
        });
    }
});

// Get payment status for content
router.get('/payment-status/:contentId', authenticateToken, async (req, res) => {
    try {
        const { contentId } = req.params;
        const content = await paymentVerification.getContentPaymentInfo(contentId);

        res.json({
            status: 'success',
            data: {
                contentId,
                price: content.price,
                currency: content.currency,
                payments: content.payments || [],
                addresses: content.paymentAddresses
            }
        });

    } catch (error) {
        console.error('Error fetching payment status:', error);
        res.status(500).json({
            error: 'Failed to fetch payment status',
            details: error.message
        });
    }
});

// Webhook endpoint for payment notifications
router.post('/payment-webhook', async (req, res) => {
    try {
        const { currency, txid, address } = req.body;
        
        // Find content associated with this address
        const { body } = await client.search({
            index: 'content_payments',
            body: {
                query: {
                    bool: {
                        must: [
                            {
                                bool: {
                                    should: [
                                        { match: { "paymentAddresses.bitcoin": address } },
                                        { match: { "paymentAddresses.zcash": address } }
                                    ]
                                }
                            },
                            {
                                exists: {
                                    field: "contentId"
                                }
                            }
                        ]
                    }
                }
            }
        });

        if (body.hits.total.value === 0) {
            return res.status(404).json({
                error: 'No content found for this payment address'
            });
        }

        const content = body.hits.hits[0]._source;
        
        // Ensure contentId is in DID format
        const contentId = content.contentId.startsWith('did:') 
            ? content.contentId 
            : txidToDid(content.contentId);

        // Verify the payment
        const verificationResult = await paymentVerification.verifyPayment(
            contentId,
            currency,
            txid
        );

        // Send notification to user if payment confirmed
        if (verificationResult.status === 'confirmed') {
            await notifyUser(content.userId, {
                type: 'payment_confirmed',
                contentId: contentId,
                amount: verificationResult.amountPaid,
                currency: currency,
                txid: txid
            });
        }

        res.json({
            status: 'success',
            data: {
                ...verificationResult,
                contentId: contentId
            }
        });

    } catch (error) {
        console.error('Webhook processing error:', error);
        res.status(500).json({
            error: 'Failed to process payment webhook',
            details: error.message
        });
    }
});

// Get user notifications
router.get('/notifications', authenticateToken, async (req, res) => {
    try {
        const { limit, offset, unreadOnly } = req.query;
        const notifications = await getUserNotifications(req.user.id, {
            limit: parseInt(limit) || 10,
            offset: parseInt(offset) || 0,
            unreadOnly: unreadOnly === 'true'
        });

        res.json({
            status: 'success',
            data: notifications
        });

    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({
            error: 'Failed to fetch notifications',
            details: error.message
        });
    }
});

// Mark notifications as read
router.post('/notifications/mark-read', authenticateToken, async (req, res) => {
    try {
        const { notificationIds } = req.body;
        
        if (!Array.isArray(notificationIds)) {
            return res.status(400).json({
                error: 'notificationIds must be an array'
            });
        }

        await markNotificationsAsRead(req.user.id, notificationIds);

        res.json({
            status: 'success',
            message: 'Notifications marked as read'
        });

    } catch (error) {
        console.error('Error marking notifications as read:', error);
        res.status(500).json({
            error: 'Failed to mark notifications as read',
            details: error.message
        });
    }
});

// Helper functions
async function storeAddressInfo(addressData) {
    // TO DO: Implement database storage
    // This should use your existing database setup
    console.log('Storing address info:', addressData);
}

async function getBitcoinBalance(userId) {
    // TO DO: Implement Bitcoin balance checking
    // This should aggregate balances across all addresses for the user
    return 0;
}

async function getZcashBalance(userId) {
    // TO DO: Implement Zcash balance checking
    return 0;
}

async function getTransactionHistory({ userId, currency, limit, offset }) {
    // TO DO: Implement transaction history retrieval
    return [];
}

module.exports = router;