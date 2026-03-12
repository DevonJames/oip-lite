const { Client } = require('@elastic/elasticsearch');
const axios = require('axios');
const { didToTxid, txidToDid } = require('./utils');

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

class PaymentVerification {
    constructor() {
        this.CONFIRMATION_THRESHOLD = 3; // Number of confirmations needed
    }

    async verifyPayment(contentId, currency, txid) {
        switch (currency.toLowerCase()) {
            case 'btc':
                return this.verifyBitcoinPayment(contentId, txid);
            case 'zec':
                throw new Error('Zcash payments not yet implemented');
            default:
                throw new Error(`Unsupported currency: ${currency}`);
        }
    }

    async verifyBitcoinPayment(contentId, txid) {
        try {
            // Get content payment requirements
            const content = await this.getContentPaymentInfo(contentId);
            
            // Get transaction details from Blockstream API
            const txInfo = await axios.get(`https://blockstream.info/api/tx/${txid}`);
            
            // Find output matching our address
            const relevantOutput = txInfo.data.vout.find(
                output => output.scriptpubkey_address === content.paymentAddresses.bitcoin
            );

            if (!relevantOutput) {
                throw new Error('No payment to content address found in transaction');
            }

            // Convert satoshis to BTC
            const amountBTC = relevantOutput.value / 100000000;
            
            // Convert BTC to USD for price comparison
            const btcPrice = await this.getBTCPrice();
            const amountUSD = amountBTC * btcPrice;

            // Verify payment amount meets minimum
            if (amountUSD < content.price) {
                throw new Error(`Payment amount ${amountUSD} USD insufficient. Required: ${content.price} USD`);
            }

            // Get confirmation count
            const confirmations = txInfo.data.status.block_height 
                ? await this.getConfirmations(txInfo.data.status.block_height)
                : 0;

            // Update payment status in Elasticsearch
            await this.updatePaymentStatus(contentId, {
                currency: 'btc',
                amount: amountBTC,
                txid,
                receivedAt: new Date(),
                confirmedAt: confirmations >= this.CONFIRMATION_THRESHOLD ? new Date() : null,
                status: confirmations >= this.CONFIRMATION_THRESHOLD ? 'confirmed' : 'pending'
            });

            return {
                status: confirmations >= this.CONFIRMATION_THRESHOLD ? 'confirmed' : 'pending',
                confirmations,
                amountPaid: amountUSD,
                requiredAmount: content.price
            };

        } catch (error) {
            console.error('Bitcoin payment verification error:', error);
            throw error;
        }
    }

    async getContentPaymentInfo(contentId) {
        const searchId = contentId.startsWith('did:') ? contentId : txidToDid(contentId);
        
        const { body } = await client.search({
            index: 'content_payments',
            body: {
                query: {
                    match: { contentId: searchId }
                }
            }
        });

        if (body.hits.total.value === 0) {
            throw new Error('Content not found');
        }

        return body.hits.hits[0]._source;
    }

    async getBTCPrice() {
        const response = await axios.get(
            'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'
        );
        return response.data.bitcoin.usd;
    }

    async getConfirmations(blockHeight) {
        const response = await axios.get('https://blockstream.info/api/blocks/tip/height');
        const currentHeight = parseInt(response.data);
        return currentHeight - blockHeight + 1;
    }

    async updatePaymentStatus(contentId, paymentInfo) {
        const searchId = contentId.startsWith('did:') ? contentId : txidToDid(contentId);
        
        await client.update({
            index: 'content_payments',
            id: searchId,
            body: {
                script: {
                    source: `
                        if (ctx._source.payments == null) {
                            ctx._source.payments = [];
                        }
                        ctx._source.payments.add(params.payment)
                    `,
                    params: {
                        payment: paymentInfo
                    }
                }
            }
        });
    }
}

module.exports = new PaymentVerification(); 