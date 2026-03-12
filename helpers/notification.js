const { Client } = require('@elastic/elasticsearch');
const { getIO } = require('../socket');

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

async function notifyUser(userId, notification) {
    try {
        // Store notification in Elasticsearch
        const { body } = await client.index({
            index: 'notifications',
            body: {
                userId,
                type: notification.type,
                contentId: notification.contentId,
                amount: notification.amount,
                currency: notification.currency,
                txid: notification.txid,
                createdAt: new Date().toISOString(),
                read: false
            }
        });

        // Send real-time notification via WebSocket if available
        try {
            const io = getIO();
            io.to(`user:${userId}`).emit('notification', {
                type: 'payment_confirmed',
                data: {
                    contentId: notification.contentId,
                    amount: notification.amount,
                    currency: notification.currency,
                    txid: notification.txid
                }
            });
        } catch (wsError) {
            console.warn('WebSocket notification failed:', wsError.message);
            // Continue even if WebSocket fails
        }

        return body._id;
        
    } catch (error) {
        console.error('Error sending notification:', error);
        throw error;
    }
}

// Add function to get user's notifications
async function getUserNotifications(userId, { limit = 10, offset = 0, unreadOnly = false } = {}) {
    try {
        const query = {
            bool: {
                must: [
                    { match: { userId } }
                ]
            }
        };

        if (unreadOnly) {
            query.bool.must.push({ match: { read: false } });
        }

        const { body } = await client.search({
            index: 'notifications',
            body: {
                query,
                sort: [{ createdAt: 'desc' }],
                from: offset,
                size: limit
            }
        });

        return body.hits.hits.map(hit => ({
            id: hit._id,
            ...hit._source
        }));

    } catch (error) {
        console.error('Error fetching notifications:', error);
        throw error;
    }
}

// Add function to mark notifications as read
async function markNotificationsAsRead(userId, notificationIds) {
    try {
        await client.updateByQuery({
            index: 'notifications',
            body: {
                query: {
                    bool: {
                        must: [
                            { match: { userId } },
                            { terms: { _id: notificationIds } }
                        ]
                    }
                },
                script: {
                    source: 'ctx._source.read = true'
                }
            }
        });
    } catch (error) {
        console.error('Error marking notifications as read:', error);
        throw error;
    }
}

module.exports = {
    notifyUser,
    getUserNotifications,
    markNotificationsAsRead
}; 