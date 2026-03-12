const axios = require('axios');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
// const bip39 = require('bip39');

bitcoin.initEccLib(ecc);

// Use the direct require that should work with sub-dependency versions
// const bip32 = require('bip32');

// class PaymentManager {
//     constructor() {
//         this.exchangeRates = {};
//         this.lastUpdate = 0;
//         this.UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes
        
//         // Initialize HD wallet
//         this.initHDWallet();
        
//         // Keep track of used addresses
//         this.addressIndex = 0;
//     }

//     initHDWallet() {
//         // If we have a seed phrase in env, use it, otherwise generate new one
//         let mnemonic = process.env.BTC_SEED_PHRASE;
//         if (!mnemonic) {
//             mnemonic = bip39.generateMnemonic();
//             console.log('Generated new seed phrase:', mnemonic);
//             console.log('Please save this in your .env as BTC_SEED_PHRASE');
//         }

//         // Generate seed from mnemonic
//         const seed = bip39.mnemonicToSeedSync(mnemonic);
        
//         // Generate master node (m)
//         const master = bip32.fromSeed(seed);
        
//         // Derive purpose/coin/account (m/44'/0'/0')
//         this.btcAccount = master.derivePath("m/44'/0'/0'");
        
//         // Get external chain (m/44'/0'/0'/0)
//         this.btcExternalChain = this.btcAccount.derive(0);
//     }

//     async updateExchangeRates() {
//         if (Date.now() - this.lastUpdate < this.UPDATE_INTERVAL) {
//             return this.exchangeRates;
//         }

//         try {
//             // Using CoinGecko API for exchange rates
//             const response = await axios.get(
//                 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,zcash&vs_currencies=usd'
//             );

//             this.exchangeRates = {
//                 BTC: response.data.bitcoin.usd,
//                 ZEC: response.data.zcash.usd
//             };
            
//             this.lastUpdate = Date.now();
//             return this.exchangeRates;
//         } catch (error) {
//             console.error('Failed to update exchange rates:', error);
//             throw error;
//         }
//     }

//     async convertPrice(price, fromUnits, magnitude, toCurrency) {
//         await this.updateExchangeRates();
        
//         // Convert to USD first
//         let usdAmount = price * Math.pow(10, -magnitude);
//         if (fromUnits !== 'USD') {
//             usdAmount = price * this.exchangeRates[fromUnits];
//         }

//         // Convert USD to target currency
//         switch (toCurrency) {
//             case 'BTC':
//                 return Math.floor((usdAmount / this.exchangeRates.BTC) * 100000000); // Convert to satoshis
//             case 'ZEC':
//                 return Math.floor((usdAmount / this.exchangeRates.ZEC) * 100000000); // Convert to zats
//             default:
//                 throw new Error(`Unsupported currency: ${toCurrency}`);
//         }
//     }

//     generateBitcoinAddress() {
//         // Derive next address (m/44'/0'/0'/0/i)
//         const keyPair = this.btcExternalChain.derive(this.addressIndex++);
        
//         // Generate P2PKH address
//         const { address } = bitcoin.payments.p2pkh({
//             pubkey: keyPair.publicKey,
//             network: bitcoin.networks.bitcoin
//         });

//         return {
//             address,
//             path: `m/44'/0'/0'/0/${this.addressIndex - 1}`,
//             publicKey: keyPair.publicKey.toString('hex')
//         };
//     }

//     async getPaymentAddress(currency) {
//         switch (currency) {
//             case 'btc':
//                 return this.generateBitcoinAddress();
//             case 'zcash':
//                 throw new Error('Zcash payments not yet implemented');
//             case 'lightning':
//                 throw new Error('Lightning payments not yet implemented');
//             default:
//                 throw new Error(`Unsupported currency: ${currency}`);
//         }
//     }
// }

// // Create singleton instance
// const paymentManager = new PaymentManager();

// module.exports = paymentManager; 