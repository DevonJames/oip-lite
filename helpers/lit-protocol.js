const LitJsSdk = require('@lit-protocol/sdk-nodejs');
const ethers = require('ethers');

// Get PKP private key from environment
const PKP_PRIVATE_KEY = process.env.LIT_PKP_PRIVATE_KEY;

// Initialize the Lit client
const litNodeClient = new LitJsSdk.LitNodeClient({
  litNetwork: "serrano", // Use "cayenne" for mainnet
  debug: false
});

let clientReady = false;

// Connect to Lit Network
async function connectLitClient() {
    if (!clientReady) {
        await litNodeClient.connect();
        clientReady = true;
    }
    return litNodeClient;
}

// Create a PKP auth signature
async function getPkpAuthSig() {
    if (!PKP_PRIVATE_KEY) {
        throw new Error("LIT_PKP_PRIVATE_KEY environment variable not set");
    }
    
    // Create wallet from private key
    const wallet = new ethers.Wallet(PKP_PRIVATE_KEY);
    
    // Get the wallet address
    const address = wallet.address;
    
    // Current timestamp
    const timestamp = Math.floor(Date.now() / 1000);
    
    // Message to sign
    const message = `I am creating an auth signature with my PKP at ${timestamp}`;
    
    // Sign the message
    const signature = await wallet.signMessage(message);
    
    // Create the auth sig
    return {
        sig: signature,
        derivedVia: "web3.eth.personal.sign",
        signedMessage: message,
        address: address
    };
}

const chain = 'ethereum';

// Function to encrypt content
async function encryptContent(content, accessControlConditions) {
    await connectLitClient();
    
    // Get auth signature using PKP
    const authSig = await getPkpAuthSig();
    
    // Create an array from the conditions if not already
    const accessControlArray = Array.isArray(accessControlConditions) 
        ? accessControlConditions 
        : [accessControlConditions];
    
    // Encrypt the content
    const { encryptedString, symmetricKey } = await LitJsSdk.encryptString(content);
    
    // Store the encryption key on the Lit Network
    const encryptedSymmetricKey = await litNodeClient.saveEncryptionKey({
        accessControlConditions: accessControlArray,
        symmetricKey,
        authSig,
        chain
    });
    
    return {
        encryptedContent: encryptedString,
        encryptedSymmetricKey: LitJsSdk.uint8arrayToString(encryptedSymmetricKey, "base16")
    };
}

// Function to decrypt content
async function decryptContent(encryptedContent, encryptedSymmetricKey, accessControlConditions) {
    await connectLitClient();
    
    // Get auth signature using PKP
    const authSig = await getPkpAuthSig();
    
    const accessControlArray = Array.isArray(accessControlConditions) 
        ? accessControlConditions 
        : [accessControlConditions];
    
    // Get the decryption key from the Lit Network
    const symmetricKey = await litNodeClient.getEncryptionKey({
        accessControlConditions: accessControlArray,
        toDecrypt: encryptedSymmetricKey,
        chain,
        authSig
    });
    
    // Decrypt the content
    const decryptedString = await LitJsSdk.decryptString(
        encryptedContent,
        symmetricKey
    );
    
    return decryptedString;
}

// Create a Bitcoin payment condition
async function createBitcoinPaymentCondition(bitcoinAddress, requiredAmount) {
    // For now, return a simple condition that allows access with Ethereum balance
    // In production, you'd implement a Bitcoin payment verification
    return [{
        contractAddress: '',
        standardContractType: '',
        chain: 'ethereum', 
        method: 'eth_getBalance',
        parameters: [':userAddress'],
        returnValueTest: {
            comparator: '>',
            value: '0'
        }
    }];
}

module.exports = {
    encryptContent,
    decryptContent,
    connectLitClient,
    createBitcoinPaymentCondition
}; 