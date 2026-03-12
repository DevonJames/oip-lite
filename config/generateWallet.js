require('dotenv').config();
const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
bitcoin.initEccLib(ecc);

// Use the direct require that should work with sub-dependency versions
const bip32 = require('bip32');

(async () => {
    try {
        // Generate mnemonic
        const mnemonic = bip39.generateMnemonic();
        console.log('\nMnemonic (save this securely):', mnemonic);

        // Generate seed
        const seed = bip39.mnemonicToSeedSync(mnemonic);
        
        // Generate master node
        const master = bip32.fromSeed(seed);
        
        // Derive the BIP44 path for Bitcoin: m/44'/0'/0'
        const accountPath = "m/44'/0'/0'";
        const account = master.derivePath(accountPath);
        
        // Get xpub
        const xpub = account.neutered().toBase58();
        
        console.log('\nBIP32 Extended Public Key (add this to .env as BTC_MASTER_PUBKEY):');
        console.log(xpub);
        
        // Test first address
        const child = account.derive(0).derive(0);
        const { address } = bitcoin.payments.p2pkh({
            pubkey: child.publicKey,
            network: bitcoin.networks.bitcoin
        });
        
        console.log('\nFirst derived address (for verification):', address);
        
        console.log('\nAdd these to your .env file:');
        console.log('BTC_SEED_PHRASE=' + mnemonic);
        console.log('BTC_MASTER_PUBKEY=' + xpub);

    } catch (error) {
        console.error('Error generating wallet:', error);
    }
})(); 