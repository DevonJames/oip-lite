// Arweave configuration with local AR.IO gateway support
// Uses local AR.IO gateway when enabled for Arweave client initialization
// Note: Application-level code (GraphQL queries, HTTP requests) automatically falls back to arweave.net
// if the local gateway is unavailable - see helpers/arweave.js and helpers/elasticsearch.js
const useLocalGateway = process.env.USE_LOCAL_ARIO_GATEWAY === 'true';
const gatewayAddress = process.env.LOCAL_ARIO_GATEWAY_ADDRESS || 'localhost:4000';

let config;

if (useLocalGateway && gatewayAddress) {
    // Parse the gateway address to extract host, port, and protocol
    try {
        // Handle addresses with or without protocol
        const addressWithProtocol = gatewayAddress.startsWith('http') 
            ? gatewayAddress 
            : `http://${gatewayAddress}`;
        const url = new URL(addressWithProtocol);
        config = {
            host: url.hostname,
            port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80),
            protocol: url.protocol.replace(':', ''), // Remove trailing colon
            timeout: 20000,
            logging: false,
        };
        console.log(`✅ Using local AR.IO gateway: ${addressWithProtocol}`);
    } catch (error) {
        console.warn(`⚠️  Invalid LOCAL_ARIO_GATEWAY_ADDRESS format, falling back to arweave.net: ${error.message}`);
        config = {
            host: 'arweave.net',
            port: 443,
            protocol: 'https',
            timeout: 20000,
            logging: false,
        };
    }
} else {
    config = {
        host: 'arweave.net',
        port: 443,
        protocol: 'https',
        timeout: 20000,
        logging: false,
    };
}

module.exports = config;