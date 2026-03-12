const { getTurboArweave } = require('./utils');
const arweaveWallet = require('./core/arweave-wallet');

class PublisherManager {
    constructor() {
        this.publishers = {
            arweave: 'turbo',
            irys: 'irys',
            gun: 'gun'
        };
    }

    /**
     * Publish data to the specified storage backend
     * @param {string|Buffer} data - The data to publish
     * @param {Object} options - Publishing options
     * @param {string} options.blockchain - 'arweave', 'irys', or 'gun'
     * @param {string} options.storage - Alias for blockchain (for GUN integration)
     * @param {Array} options.tags - Array of tags for the transaction
     * @param {boolean} options.waitForConfirmation - Whether to wait for confirmation
     * @param {string} options.publisherPubKey - Publisher's public key (for GUN)
     * @param {string} options.localId - Local identifier (for GUN)
     * @param {Object} options.accessControl - Access control settings (for GUN)
     * @returns {Promise<Object>} - The publishing result with transaction ID
     */
    async publish(data, options = {}) {
        const {
            blockchain = 'arweave', // Default to Arweave
            storage = blockchain, // Support storage alias
            tags = [],
            waitForConfirmation = true
        } = options;

        const targetStorage = storage || blockchain;

        try {
            if (targetStorage === 'arweave') {
                return await this.publishToArweave(data, tags, waitForConfirmation);
            } else if (targetStorage === 'irys') {
                return await this.publishToIrys(data, tags);
            } else if (targetStorage === 'gun') {
                return await this.publishToGun(data, options);
            } else {
                throw new Error(`Unsupported storage: ${targetStorage}. Use 'arweave', 'irys', or 'gun'`);
            }
        } catch (error) {
            console.error(`Error publishing to ${targetStorage}:`, error);
            throw error;
        }
    }

    /**
     * Publish to Arweave using Turbo via arweaveWallet wrapper
     */
    async publishToArweave(data, tags, waitForConfirmation) {
        console.log('Publishing to Arweave via Turbo...');
        
        try {
            const result = await arweaveWallet.uploadWithConfirmation(
                data,
                { tags },
                waitForConfirmation
            );
            
            return {
                id: result.id,
                blockchain: 'arweave',
                provider: 'turbo',
                url: `https://arweave.net/${result.id}`
            };
        } catch (error) {
            console.error('Error in Turbo upload:', error);
            console.error('Error details:', error.message);
            throw error;
        }
    }

    /**
     * Publish to Irys network
     */
    async publishToIrys(data, tags) {
        console.log('Publishing to Irys network...');
        const turbo = await getTurboArweave();
        
        // Ensure data is a buffer
        const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        
        // Convert tags to Irys format
        const irysTagsObject = {};
        tags.forEach(tag => {
            irysTagsObject[tag.name] = tag.value;
        });

        const receipt = await turbo.upload({
            data: dataBuffer,
            dataItemOpts: {
                tags: irysTagsObject
            }
        });

        return {
            id: receipt.id,
            blockchain: 'irys',
            provider: 'irys',
            url: `https://gateway.irys.xyz/${receipt.id}`
        };
    }

    /**
     * Get the balance for the specified blockchain
     */
    async getBalance(blockchain) {
        if (blockchain === 'arweave') {
            const turbo = await getTurboArweave();
            const balance = await turbo.getBalance();
            return {
                raw: balance.winc,
                formatted: balance.winc / 1000000000000 // Convert Winston to AR
            };
        } else if (blockchain === 'irys') {
            const turbo = await getTurboArweave();
            const balance = await turbo.getBalance();
            return {
                raw: balance.winc,
                formatted: balance.winc / 1000000000000
            };
        }
        throw new Error(`Unsupported blockchain: ${blockchain}`);
    }

    /**
     * Fund the wallet for the specified blockchain
     */
    async fundWallet(blockchain, amount) {
        if (blockchain === 'arweave') {
            const turbo = await getTurboArweave();
            const atomicAmount = Math.floor(amount * 1000000000000); // Convert AR to Winston
            return await turbo.topUpWithTokens({ tokenAmount: atomicAmount });
        } else if (blockchain === 'irys') {
            const turbo = await getTurboArweave();
            const atomicAmount = Math.floor(amount * 1000000000000);
            return await turbo.topUpWithTokens({ tokenAmount: atomicAmount });
        }
        throw new Error(`Unsupported blockchain: ${blockchain}`);
    }

    /**
     * Get price estimate for data size
     */
    async getPrice(blockchain, size) {
        if (blockchain === 'arweave') {
            const turbo = await getTurboArweave();
            const costs = await turbo.getUploadCosts({ bytes: [size] });
            return costs[0].winc;
        } else if (blockchain === 'irys') {
            const turbo = await getTurboArweave();
            const costs = await turbo.getUploadCosts({ bytes: [size] });
            return costs[0].winc;
        }
        throw new Error(`Unsupported blockchain: ${blockchain}`);
    }

    /**
     * Publish to GUN network
     * @param {Object} data - The record data to publish
     * @param {Object} options - Publishing options
     * @returns {Promise<Object>} - Publishing result with DID
     */
    async publishToGun(data, options) {
        
        try {
            const { GunHelper } = require('./core/gun');
            const gunHelper = new GunHelper();
            
            // Extract publisher info from options
            const publisherPubKey = options.publisherPubKey;
            const localId = options.localId || null;
            
            if (!publisherPubKey) {
                throw new Error('publisherPubKey is required for GUN publishing');
            }
            
            // Compute deterministic soul
            const soul = gunHelper.computeSoul(publisherPubKey, localId, data);
            console.log('Generated GUN soul:', soul);
            
            // Store in GUN with optional encryption
            const result = await gunHelper.putRecord(data, soul, {
                encrypt: options.accessControl?.private,
                readerPubKeys: options.accessControl?.readers,
                writerKeys: options.writerKeys,
                localId
            });
            
            return {
                id: soul,
                did: result.did,
                storage: 'gun',
                provider: 'gun',
                soul: result.soul,
                encrypted: result.encrypted,
                url: `gun://${soul}` // GUN-specific URL format
            };
        } catch (error) {
            console.error('Error in GUN publishing:', error);
            throw error;
        }
    }
}

module.exports = new PublisherManager(); 