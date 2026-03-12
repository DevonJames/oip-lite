const Arweave = require('arweave');
const { getTurboArweave, getWalletFilePath } = require('../utils');
const { createData, ArweaveSigner, JWKInterface } = require('arbundles');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const http = require('http');
const https = require('https');
const { crypto, createHash } = require('crypto');
const base64url = require('base64url');

// MEMORY LEAK FIX: Create agents that close sockets after use
const httpAgent = new http.Agent({ keepAlive: false, maxSockets: 10, timeout: 30000 });
const httpsAgent = new https.Agent({ keepAlive: false, maxSockets: 10, timeout: 30000 });

const arweaveConfig = require('../../config/arweave.config');
const arweave = Arweave.init(arweaveConfig);

// Import gateway registry for multi-gateway failover
const { getGatewayUrls, getGraphQLEndpoints, initializeGatewayRegistry } = require('./gateway-registry');

// Initialize gateway registry on module load (only if Arweave syncing is enabled)
// Skip initialization if ARWEAVE_SYNC_ENABLED=false (web server + login service mode)
if (process.env.ARWEAVE_SYNC_ENABLED !== 'false') {
    initializeGatewayRegistry().catch(err => {
        console.warn('⚠️  Gateway registry initialization failed:', err.message);
    });
} else {
    console.log('⏭️  Gateway registry initialization skipped (ARWEAVE_SYNC_ENABLED=false)');
}

// Hardcoded fallback data for critical creator registration transactions
// These are used when the Arweave gateway is unavailable
const HARDCODED_TRANSACTIONS = {
    // First creator registration - u4B6d5ddggsotOiG86D-KPkeW23qQNdqaXo_ZcdI3k0
    'eqUwpy6et2egkGlkvS7c5GKi0aBsCXT6Dhlydf3GA3Y': {
        transactionId: 'eqUwpy6et2egkGlkvS7c5GKi0aBsCXT6Dhlydf3GA3Y',
        blockHeight: 1463761,
        tags: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Index-Method', value: 'OIP' },
            { name: 'Ver', value: '0.7.2' },
            { name: 'Type', value: 'Record' },
            { name: 'Creator', value: 'u4B6d5ddggsotOiG86D-KPkeW23qQNdqaXo_ZcdI3k0' },
            { name: 'CreatorSig', value: 'kxaouVUFcvHDAPUT8xsLo7ilepwKuVNeR52Hsn/tEZwUK+TAeXb5JtszUeFBpbMy0nuYydBwFxgSmIofkwByVzOpe7j3n1QKZhGIKVGuq9HBiekNfWne/vw3kiPvl+T8bwTM+M6vvsfDTKiIqs+NYZVHWm9iebhWlfIHVdtbRmn6NxHAYtaosggep0XyOuwrVuJEsEMfl8AYS7AZPcClQxl8LMERCdeWRE6BTu0ZGMyFeV38xKOea5ccwV2A7kYfRf6iwdmpACzlh9CIkNfOQ3JC2NJK/Rs6f5sJMMjzIn84odt+7GqaBeitLI4rv6E64FSEdcPtOn0Rm2ICwuzg/jqxF4QUdRQ5t7diBPWKY0JITw+Fhw+DTL2WTYazd/1j4OlQJJefE4Of30oWGzlUvDhNui9yudc0MO/+nPBzHYxVNB6d+XZVGODgfgD/wDRH0DMtE7Fsq35s5m2JY424RSikUCyz354XY0JJuyzUCWxflKgMhL1q0/IHx4ASI7Go/wEE0H4q0F2Tutk/6F6hjyl7z5JUqnOOALPW4t5mqo53D6Milt/khaA97gLU1RO1xQdHX7LrHRWsgiulLayMN+ll6DLK+fSlISagf9yZ5f61QjxkMi8K8pEedckSwaM586RO1PJoS2pBlX2DpPl28/ZRpt/fT5Q2NfWFapNXRk=' }
        ],
        ver: '0.7.2',
        creator: 'u4B6d5ddggsotOiG86D-KPkeW23qQNdqaXo_ZcdI3k0',
        creatorSig: 'kxaouVUFcvHDAPUT8xsLo7ilepwKuVNeR52Hsn/tEZwUK+TAeXb5JtszUeFBpbMy0nuYydBwFxgSmIofkwByVzOpe7j3n1QKZhGIKVGuq9HBiekNfWne/vw3kiPvl+T8bwTM+M6vvsfDTKiIqs+NYZVHWm9iebhWlfIHVdtbRmn6NxHAYtaosggep0XyOuwrVuJEsEMfl8AYS7AZPcClQxl8LMERCdeWRE6BTu0ZGMyFeV38xKOea5ccwV2A7kYfRf6iwdmpACzlh9CIkNfOQ3JC2NJK/Rs6f5sJMMjzIn84odt+7GqaBeitLI4rv6E64FSEdcPtOn0Rm2ICwuzg/jqxF4QUdRQ5t7diBPWKY0JITw+Fhw+DTL2WTYazd/1j4OlQJJefE4Of30oWGzlUvDhNui9yudc0MO/+nPBzHYxVNB6d+XZVGODgfgD/wDRH0DMtE7Fsq35s5m2JY424RSikUCyz354XY0JJuyzUCWxflKgMhL1q0/IHx4ASI7Go/wEE0H4q0F2Tutk/6F6hjyl7z5JUqnOOALPW4t5mqo53D6Milt/khaA97gLU1RO1xQdHX7LrHRWsgiulLayMN+ll6DLK+fSlISagf9yZ5f61QjxkMi8K8pEedckSwaM586RO1PJoS2pBlX2DpPl28/ZRpt/fT5Q2NfWFapNXRk=',
        data: JSON.stringify([
            {
                "0": "u4B6d5ddggsotOiG86D-KPkeW23qQNdqaXo_ZcdI3k0",
                "1": "v2LPUKrpSnmzQzPr7Cfjb_vh9FD6GbRXQNqUk9miFmiWA6PtKj6gvOCiQXpr5o9u4PJcvD7jbMUNegIVj0YuOMd718qwQvXC75OZCyZlvd5Llr94pFFXhZGqlFy1ArdKhULeqgdkb-jB5dJg4u07BakmkJ8avxfKclV5jS825dw70A0lNx4R4GLD8e4-s4jp-BC9VHMR_6FAJHuGZMn2QtezF0jtmVLTKh3E6yHI2G75wwCBN5KZaOZfNNEazVAf6J-GT1H0JG1eTzH8jYIufTc9p99CX4Tzf8Ov8A8MOteM-pbJ8MQ0XDhw32F_AW9TjLqOkBprFZVaQRt8VC6Xe0r_g2ZFFokbCj8gYhF_Ezb4aRVDBhyC0Hmnwo7uFiISZrfb20iudYRM2vP7iUiZgG8wApufvKta6dByqEnuO6Jywp8vIZw0OZQMuzwCbV-3oXLWds1c8H0OkQuDOv51u14oo4720KjTW2F_eOWNTdqc2vM05K2aJg88eL7U2gUXjuLM7ZbJ3w64Mmg7FEdzNwT4K1-rbfdVjpmO6NHSgY_-j1KW2_bOWezRpWNBt4yW9csrk54YVjLDzgg2cX_jjXHaajHe27ljRV9nbBQINCOvaavMnJ8GZ-sgP0ZJttzXcrHtXCgj4JKl6RDdy6I7x1cShFb0IqaUoZSANRsGMAk",
                "2": "Player",
                "3": "James",
                "t": "creatorRegistration"
            },
            {
                "0": "Devon",
                "3": 37,
                "t": "basic"
            }
        ])
    },
    
    // Second creator registration - iZq_A50yy5YpHNZZfQ5E5Xres3fhMa-buPOlotxbEtU
    'iZq_A50yy5YpHNZZfQ5E5Xres3fhMa-buPOlotxbEtU': {
        transactionId: 'iZq_A50yy5YpHNZZfQ5E5Xres3fhMa-buPOlotxbEtU',
        blockHeight: 1579572,
        tags: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Index-Method', value: 'OIP' },
            { name: 'Ver', value: '0.8.0' },
            { name: 'Type', value: 'Record' },
            { name: 'RecordType', value: 'creatorRegistration' },
            { name: 'Creator', value: 'iZq_A50yy5YpHNZZfQ5E5Xres3fhMa-buPOlotxbEtU' },
            { name: 'CreatorSig', value: 'YGhI+1ZmIRW4AJSFx/RJ/8BsI9ABbp2XESRzIaAFibCAhv+B8FzAj5S/VnMzvPCRSSns+ciex64wXS1ebtuRzEF4FXzeQOd9SWpviJ1gv9q3CsDGWK3JTyijzvOOD3wfkrbT3AJvHcZ8z8aWGBbuP1DltHLamOBnxkX/imE2qoL/RCf/jbbYvDRpI76EFDueXRyz94lG7EwMVj4Vne2MFWCa0HU7N8RJKuAE8VhqG6aSp1tVRIRfjW1uQQHesQa7hA5T0WaVtEUSkLfpSjUEv3OvB66JVQ2AUx5kZIHhAVEViSvBucVZ3UTZbkZw8ip4q60c8XkJ/3MUBSBv4nS8cTU2mBJyLs8haW3/4uDgBpYxWBrB3EhwHhj/R3Z223ra/Flri6ydwnqwUpAyzEPtXwNC1LplovNS0qith6FRClgjKZuZ8Jx1OQZl+G09tf1XMiYRidnhD8zTSSCiFKXbqB7WCe2XQvfokBtXuK7EKpBGGQJBwkwhnqlhEPU3psJAcsKVvsfQtBsadiPjYJcOyD7kgbdVoP1SQGl9j3fCNhk03Bp7BFWsiWUtWZQXtkmoIY3Zbtz8kA/ayuesbZNGWmnHJhSr8Wh3n86khC54b0rvClGk+K1gGtDSM+09yKyRRDo3A+SL0KVc4MafSVPP27AUYdNpmNBT6d8JtMbkG5M=' }
        ],
        ver: '0.8.0',
        creator: 'iZq_A50yy5YpHNZZfQ5E5Xres3fhMa-buPOlotxbEtU',
        creatorSig: 'YGhI+1ZmIRW4AJSFx/RJ/8BsI9ABbp2XESRzIaAFibCAhv+B8FzAj5S/VnMzvPCRSSns+ciex64wXS1ebtuRzEF4FXzeQOd9SWpviJ1gv9q3CsDGWK3JTyijzvOOD3wfkrbT3AJvHcZ8z8aWGBbuP1DltHLamOBnxkX/imE2qoL/RCf/jbbYvDRpI76EFDueXRyz94lG7EwMVj4Vne2MFWCa0HU7N8RJKuAE8VhqG6aSp1tVRIRfjW1uQQHesQa7hA5T0WaVtEUSkLfpSjUEv3OvB66JVQ2AUx5kZIHhAVEViSvBucVZ3UTZbkZw8ip4q60c8XkJ/3MUBSBv4nS8cTU2mBJyLs8haW3/4uDgBpYxWBrB3EhwHhj/R3Z223ra/Flri6ydwnqwUpAyzEPtXwNC1LplovNS0qith6FRClgjKZuZ8Jx1OQZl+G09tf1XMiYRidnhD8zTSSCiFKXbqB7WCe2XQvfokBtXuK7EKpBGGQJBwkwhnqlhEPU3psJAcsKVvsfQtBsadiPjYJcOyD7kgbdVoP1SQGl9j3fCNhk03Bp7BFWsiWUtWZQXtkmoIY3Zbtz8kA/ayuesbZNGWmnHJhSr8Wh3n86khC54b0rvClGk+K1gGtDSM+09yKyRRDo3A+SL0KVc4MafSVPP27AUYdNpmNBT6d8JtMbkG5M=',
        data: JSON.stringify([
            {
                "0": "iZq_A50yy5YpHNZZfQ5E5Xres3fhMa-buPOlotxbEtU",
                "1": "g80XM1oE_GZVzpq6yTRVX0sCj1xisWhBAA31ANiqAl9-r6_5VMOT5SiX5ujLIh1GtLefb_BtNECoTSRbosndWrhypPFzEZutT6ttBi6lPrrDJGFYdAxE8Rucfw7aZyzfMNYQfEZC-vK6Wkw4HiVllwwp2ZG--XplJyYlKSQIDt78DmLUnkRIA0c0HhPC4pct3G0lHFz7-7ychn9HYNOmEYBsaIrqX4XIE1GGOzPieyAa5DiOkWqTDBwFVglRZ1bE4VSEl-TdEpizUC8SOuAsVvjiHIXkrCP3ugkZj2mpi3VaDN6T9GhI9BtP6duXa7fU5GUbYTkArxYU9bGCpvJKVE3hoeWAq-5coaG3tV5q_vXfGcVcwbm2tz1q292kpXnQ91HIBVzaOlJgEhC-f4UvHy_4dNvYlBc8wvdUFktkPK8tpQ17a3wNSN6_qRZemvbVobLXguSqWE9jxx4F3oXSoGoYQYL_UomWnIsNRr5Gre8fwrBOc8ZTl3wdKbqDV6SlSYq0q3y41KW2V6KI_csTXyE6boTWRIoFxGBG7Z1N8Fd3_GtdFKmevEkfNnlYYAM7pcMRfD-oz8ZMXHXwD86yed-b0kh6p4yqPnYpR_NyKsURlloVvpxBwOzZqIU9d_rsmsMZDY2ZIIowSYkqkjW7ug0597_LkCpA-eyyLaijbxE",
                "2": "Scribe",
                "t": "svZ3lRyzSpdjdG95o106Gpn4eVdpn8HMdos8RHaAd-c"
            }
        ])
    }
};

/**
 * Retrieves a transaction/data item from Arweave with its tags and data.
 * Handles both native Arweave transactions and bundled data items.
 * Uses GraphQL to get proper tags and block height information.
 * Falls back to hardcoded data for critical creator registrations if gateway is unavailable.
 * @param {string} transactionId 
 * @returns {Object} Transaction data and tags
 */
const getTransaction = async (transactionId) => {
    try {
        let transaction, tags, data, blockHeight;
        
        // First, try GraphQL to get transaction metadata including tags and block height
        try {
            const graphqlQuery = {
                query: `
                    query($id: ID!) {
                        transaction(id: $id) {
                            id
                            tags {
                                name
                                value
                            }
                            block {
                                height
                                timestamp
                            }
                            data {
                                size
                            }
                        }
                    }
                `,
                variables: { id: transactionId }
            };

            // Get all available GraphQL endpoints from gateway registry
            const graphqlEndpoints = await getGraphQLEndpoints();
            
            let graphqlResponse = null;
            let lastError = null;
            
            // Try each endpoint in order (with failover)
            for (const graphqlEndpoint of graphqlEndpoints) {
                try {
                    graphqlResponse = await axios.post(graphqlEndpoint, graphqlQuery, {
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 15000,
                        httpAgent, httpsAgent  // MEMORY LEAK FIX: Close sockets after use
                    });
                    if (graphqlEndpoint !== graphqlEndpoints[0]) {
                        console.log(`✅ Using fallback GraphQL endpoint: ${graphqlEndpoint}`);
                    }
                    break; // Success, exit loop
                } catch (error) {
                    lastError = error;
                    if (graphqlEndpoint !== graphqlEndpoints[graphqlEndpoints.length - 1]) {
                        console.warn(`⚠️  GraphQL query failed on ${graphqlEndpoint}: ${error.message}. Trying fallback...`);
                    }
                }
            }
            
            if (!graphqlResponse) {
                throw lastError || new Error('All GraphQL endpoints failed');
            }

            if (graphqlResponse.data && graphqlResponse.data.data && graphqlResponse.data.data.transaction) {
                const txData = graphqlResponse.data.data.transaction;
                tags = txData.tags || [];
                blockHeight = txData.block ? txData.block.height : null;
                // console.log(`GraphQL found ${tags.length} tags for ${transactionId}, block height: ${blockHeight}`);
            } else {
                console.log(`GraphQL returned no data for ${transactionId}`);
                tags = [];
                blockHeight = null;
            }
        } catch (graphqlError) {
            console.log(`GraphQL query failed for ${transactionId}:`, graphqlError.message);
            tags = [];
            blockHeight = null;
        }

        // Now get the actual data content
        try {
            // Get all available gateways from registry (with failover support)
            const gatewayUrls = await getGatewayUrls();
            
            let dataResponse = null;
            let gatewayError = null;
            
            // Try each gateway URL in order (with failover)
            for (const gatewayBaseUrl of gatewayUrls) {
                try {
                    // Try direct gateway fetch first for data items (avoids the native client bug)
                    dataResponse = await axios.get(`${gatewayBaseUrl}/${transactionId}`, {
                        responseType: 'text',
                        timeout: 30000,
                        httpAgent, httpsAgent  // MEMORY LEAK FIX: Close sockets after use
                    });
                    data = dataResponse.data;
                    if (gatewayBaseUrl !== gatewayUrls[0]) {
                        console.log(`✅ Using fallback gateway: ${gatewayBaseUrl}`);
                    }
                    // console.log(`Successfully fetched data from gateway for ${transactionId}`);
                    break; // Success, exit loop
                } catch (error) {
                    gatewayError = error;
                    if (gatewayBaseUrl !== gatewayUrls[gatewayUrls.length - 1]) {
                        console.log(`⚠️  Gateway fetch failed on ${gatewayBaseUrl}: ${error.message}. Trying fallback...`);
                    }
                }
            }
            
            if (!dataResponse) {
                throw gatewayError || new Error('All gateway URLs failed');
            }
        } catch (gatewayError) {
            console.log(`All gateway fetches failed for ${transactionId}, trying native client...`);
            
            // Fallback to native client if gateway fails
            try {
                data = await arweave.transactions.getData(transactionId, { decode: true, string: true });
                
                // If we didn't get tags from GraphQL, try to get them from native client
                if (tags.length === 0) {
                    try {
                        transaction = await arweave.transactions.get(transactionId);
                        tags = transaction.tags.map(tag => ({
                            name: tag.get('name', { decode: true, string: true }),
                            value: tag.get('value', { decode: true, string: true })
                        }));
                    } catch (nativeTagError) {
                        console.log(`Native client tags failed for ${transactionId}`);
                    }
                }
            } catch (nativeError) {
                console.error(`Both gateway and native client failed for ${transactionId}`);
                throw new Error(`${transactionId} data was not found!`);
            }
        }
        
        if (!data) {
            console.error(`No data found for ${transactionId}`);
            throw new Error(`${transactionId} data was not found!`);
        }
        
        // Extract OIP-specific tags from GraphQL or native response
        const ver = tags.find(tag => tag.name === 'Ver')?.value || tags.find(tag => tag.name === 'ver')?.value;
        const creator = tags.find(tag => tag.name === 'Creator')?.value;
        const creatorSigRaw = tags.find(tag => tag.name === 'CreatorSig')?.value;
        
        // Fix CreatorSig format - convert spaces back to + characters for proper base64
        const creatorSig = creatorSigRaw ? creatorSigRaw.replace(/ /g, '+') : undefined;
        
        // console.log(`Extracted from tags - Creator: ${creator ? 'found' : 'missing'}, CreatorSig: ${creatorSig ? 'found' : 'missing'}, Ver: ${ver || 'missing'}`);
        if (creatorSigRaw && creatorSigRaw !== creatorSig) {
            // console.log(`Fixed CreatorSig format: converted ${creatorSigRaw.split(' ').length - 1} spaces to + characters`);
        }
        
        return { 
            transactionId, 
            tags, 
            ver, 
            creator, 
            creatorSig, 
            data,
            blockHeight 
        };
        
    } catch (error) {
        // Check if we have hardcoded data for this transaction
        if (HARDCODED_TRANSACTIONS[transactionId]) {
            console.log(`⚠️  Gateway failed for ${transactionId}, using hardcoded fallback data`);
            console.log(`✅ This is a critical creator registration transaction with fallback support`);
            return HARDCODED_TRANSACTIONS[transactionId];
        }
        
        console.error('Error fetching transaction or transaction data:', error);
        throw error;
    }
};

/**
 * Checks the balance of the connected account using Turbo SDK.
 * @returns {Promise<number>} The account balance in standard units.
 */
const checkBalance = async () => {
    const turbo = await getTurboArweave();
    const balance = await turbo.getBalance();
    const convertedBalance = turbo.utils ? turbo.utils.fromAtomic(balance.winc) : balance.winc;
    const jwk = JSON.parse(fs.readFileSync(getWalletFilePath()));
            
    const myPublicKey = jwk.n;
    const myAddress = base64url(createHash('sha256').update(Buffer.from(myPublicKey, 'base64')).digest()); 
    // const creatorDid = `did:arweave:${myAddress}`;
    return {convertedBalance, myAddress};
};

/**
 * Retrieves the block height of a given transaction ID from the Arweave network.
 * @param {string} txId 
 * @returns {Promise<number>} The block height of the transaction.
 */
async function getBlockHeightFromTxId(txId) {
    try {
        // Use the txId to get the block height from Arweave network
        // Try local AR.IO gateway first, then fallback to arweave.net
        const useLocalGateway = process.env.USE_LOCAL_ARIO_GATEWAY === 'true';
        const gatewayAddress = process.env.LOCAL_ARIO_GATEWAY_ADDRESS || 'localhost:4000';
        const gatewayUrls = [];
        
        // Debug logging
        if (process.env.DEBUG_ARIO === 'true') {
            console.log(`🔍 [getBlockHeightFromTxId] USE_LOCAL_ARIO_GATEWAY=${process.env.USE_LOCAL_ARIO_GATEWAY}, useLocalGateway=${useLocalGateway}, gatewayAddress=${gatewayAddress}`);
        }
        
        // Add local gateway first if enabled
        if (useLocalGateway && gatewayAddress) {
            try {
                const addressWithProtocol = gatewayAddress.startsWith('http') 
                    ? gatewayAddress 
                    : `http://${gatewayAddress}`;
                const url = new URL(addressWithProtocol);
                const localGatewayUrl = `${url.protocol}//${url.host}`;
                gatewayUrls.push(localGatewayUrl);
                if (process.env.DEBUG_ARIO === 'true') {
                    console.log(`🔍 [getBlockHeightFromTxId] Added local gateway: ${localGatewayUrl}`);
                }
            } catch (error) {
                console.warn(`⚠️  Invalid LOCAL_ARIO_GATEWAY_ADDRESS format: ${error.message}`);
            }
        } else {
            if (process.env.DEBUG_ARIO === 'true') {
                console.log(`🔍 [getBlockHeightFromTxId] Local gateway disabled, skipping`);
            }
        }
        
        // Always add arweave.net as fallback
        gatewayUrls.push('https://arweave.net');
        
        let arweaveResponse = null;
        let lastError = null;
        
        // Try each gateway URL in order
        for (const gatewayBaseUrl of gatewayUrls) {
            try {
                const requestUrl = `${gatewayBaseUrl}/tx/${txId}/status`;
                if (process.env.DEBUG_ARIO === 'true') {
                    console.log(`🔍 [getBlockHeightFromTxId] Trying: ${requestUrl}`);
                }
                arweaveResponse = await axios.get(requestUrl, {
                    timeout: 10000,
                    httpAgent, httpsAgent  // MEMORY LEAK FIX: Close sockets after use
                });
                if (gatewayBaseUrl !== gatewayUrls[0]) {
                    console.log(`✅ Using fallback gateway for tx status: ${gatewayBaseUrl}`);
                } else if (process.env.DEBUG_ARIO === 'true') {
                    console.log(`✅ Successfully used local gateway: ${gatewayBaseUrl}`);
                }
                break; // Success, exit loop
            } catch (error) {
                lastError = error;
                // Only log warnings for non-404 errors (404 might be expected if tx doesn't exist)
                if (error.response?.status !== 404 && gatewayBaseUrl !== gatewayUrls[gatewayUrls.length - 1]) {
                    console.warn(`⚠️  Failed to get tx status from ${gatewayBaseUrl}: ${error.message} (status: ${error.response?.status || 'N/A'}). Trying fallback...`);
                } else if (process.env.DEBUG_ARIO === 'true') {
                    console.log(`🔍 [getBlockHeightFromTxId] Failed ${gatewayBaseUrl}: ${error.message} (status: ${error.response?.status || 'N/A'})`);
                }
            }
        }
        
        if (!arweaveResponse) {
            throw lastError || new Error('All gateway URLs failed');
        }
        const blockHeight = arweaveResponse.data.block_height;
        return blockHeight;
    } catch (error) {
        console.error(`Error fetching block height for TxId ${txId}:`, error);
        throw error; // Rethrow to handle it in the calling function
    }
}

// Cache for last successful block height to gracefully handle temporary network failures
let cachedBlockHeight = null;
let lastBlockHeightFetchTime = null;
// Cache TTL: 1 hour - block height updates ~every 2 min but exact value isn't critical for progress display
const BLOCK_HEIGHT_CACHE_TTL = parseInt(process.env.BLOCK_HEIGHT_CACHE_TTL) || 3600000; // 1 hour default

/**
 * Retrieves the cached block height without making a network call.
 * Used by API endpoints to avoid blocking on network requests.
 * @returns {number|null} The cached block height, or null if no cache available.
 */
const getCachedBlockHeight = () => {
    return cachedBlockHeight;
};

/**
 * Checks if the block height cache is stale (older than TTL).
 * @returns {boolean} True if cache is stale or empty
 */
const isBlockHeightCacheStale = () => {
    if (!cachedBlockHeight || !lastBlockHeightFetchTime) {
        return true;
    }
    const cacheAge = Date.now() - lastBlockHeightFetchTime;
    return cacheAge > BLOCK_HEIGHT_CACHE_TTL;
};

/**
 * Refreshes the block height cache only if it's stale (older than TTL).
 * This should be called at the start of sync cycles to avoid excessive network calls.
 * @returns {Promise<number|null>} The current block height
 */
const refreshBlockHeightIfStale = async () => {
    if (!isBlockHeightCacheStale()) {
        const cacheAgeMinutes = Math.floor((Date.now() - lastBlockHeightFetchTime) / 60000);
        // Only log occasionally to avoid spam
        if (cacheAgeMinutes % 10 === 0) {
            console.log(`📊 Using cached block height: ${cachedBlockHeight} (${cacheAgeMinutes}m old, TTL: ${BLOCK_HEIGHT_CACHE_TTL / 60000}m)`);
        }
        return cachedBlockHeight;
    }
    
    console.log('📊 Block height cache stale, refreshing from network...');
    return await getCurrentBlockHeight();
};

/**
 * Retrieves the current block height of the Arweave blockchain from the network.
 * Caches the last successful value to gracefully handle temporary network failures.
 * Should primarily be called by keepDBUpToDate to refresh the cache periodically.
 * @returns {Promise<number|null>} The current block height, or cached/null on failure.
 */
const getCurrentBlockHeight = async () => {
    try {
        // Try local AR.IO gateway first, then fallback to arweave.net
        const useLocalGateway = process.env.USE_LOCAL_ARIO_GATEWAY === 'true';
        const gatewayAddress = process.env.LOCAL_ARIO_GATEWAY_ADDRESS || 'localhost:4000';
        const gatewayUrls = [];
        
        // Add local gateway first if enabled
        if (useLocalGateway && gatewayAddress) {
            try {
                const addressWithProtocol = gatewayAddress.startsWith('http') 
                    ? gatewayAddress 
                    : `http://${gatewayAddress}`;
                const url = new URL(addressWithProtocol);
                gatewayUrls.push(`${url.protocol}//${url.host}`);
            } catch (error) {
                console.warn(`⚠️  Invalid LOCAL_ARIO_GATEWAY_ADDRESS format: ${error.message}`);
            }
        }
        
        // Always add arweave.net as fallback
        gatewayUrls.push('https://arweave.net');
        
        let response = null;
        let lastError = null;
        
        // Try each gateway URL in order
        for (const gatewayBaseUrl of gatewayUrls) {
            try {
                // AR.IO gateway uses /ar-io/info, arweave.net uses /info
                const infoEndpoint = gatewayBaseUrl.includes('arweave.net') 
                    ? `${gatewayBaseUrl}/info`
                    : `${gatewayBaseUrl}/ar-io/info`;
                
                response = await axios.get(infoEndpoint, {
                    httpAgent, httpsAgent  // MEMORY LEAK FIX: Close sockets after use
                });
                if (gatewayBaseUrl !== gatewayUrls[0]) {
                    console.log(`✅ Using fallback gateway for info: ${gatewayBaseUrl}`);
                }
                break; // Success, exit loop
            } catch (error) {
                lastError = error;
                if (gatewayBaseUrl !== gatewayUrls[gatewayUrls.length - 1]) {
                    console.warn(`⚠️  Failed to get info from ${gatewayBaseUrl}: ${error.message}. Trying fallback...`);
                }
            }
        }
        
        if (!response) {
            throw lastError || new Error('All gateway URLs failed');
        }
        const blockHeight = response.data.height;
        
        // Update cache on successful fetch
        cachedBlockHeight = blockHeight;
        lastBlockHeightFetchTime = Date.now();
        
        return blockHeight;
    } catch (error) {
        // Gracefully handle network failures by returning cached value
        const errorCode = error.code || error.errno;
        const isNetworkError = errorCode === 'EAI_AGAIN' || errorCode === 'ENOTFOUND' || errorCode === 'ETIMEDOUT';
        
        if (isNetworkError) {
            // Minimal logging for known network issues
            if (cachedBlockHeight) {
                const cacheAge = Date.now() - (lastBlockHeightFetchTime || 0);
                const cacheAgeMinutes = Math.floor(cacheAge / 60000);
                console.warn(`⚠️  Arweave network temporarily unreachable (${errorCode}). Using cached block height: ${cachedBlockHeight} (${cacheAgeMinutes}m old)`);
                return cachedBlockHeight;
            } else {
                console.warn(`⚠️  Arweave network temporarily unreachable (${errorCode}) and no cache available. Returning null.`);
                return null;
            }
        } else {
            // For unexpected errors, log more details but still don't throw
            console.error(`Error fetching current block height (${error.message}). Returning cached value or null.`);
            return cachedBlockHeight || null;
        }
    }
};

/**
 * Funds the account with a specified upfront amount using Turbo SDK.
 * @param {number} amount - The amount to fund in AR (will be converted to Winston).
 * @param {number} multiplier - Optional fee multiplier to prioritize processing.
 * @returns {Promise<Object>} The transaction response from the funding action.
 */
const upfrontFunding = async (amount, multiplier = 1) => {
    try {
        console.log(`Starting upfront funding for ${amount} AR...`);
        const turbo = await getTurboArweave();
        console.log('Turbo SDK obtained successfully for upfront funding');
        
        // Convert amount from AR to Winston (1 AR = 1000000000000 Winston)
        // Use the Turbo SDK's utility functions for proper conversion
        const arweaveLib = require('arweave/node'); // Import arweave for conversion utilities
        const arweave = arweaveLib.init({}); // Initialize for utilities
        const atomicAmount = arweave.ar.arToWinston(amount.toString());
        
        console.log(`Converting ${amount} AR to ${atomicAmount} Winston for funding`);
        console.log('Calling topUpWithTokens with:', { tokenAmount: atomicAmount, feeMultiplier: multiplier });
        
        const response = await turbo.topUpWithTokens({ 
            tokenAmount: atomicAmount, 
            feeMultiplier: multiplier 
        });
        console.log('Upfront funding successful:', response);
        return response;
    } catch (error) {
        console.error('Error in upfront funding at step:', error.message);
        console.error('Full upfront funding error:', error);
        throw error;
    }
};

/**
 * Funds the account lazily, based on the size of the data to be uploaded using Turbo SDK.
 * @param {number} size - Size of the data in bytes.
 * @param {number} multiplier - Optional fee multiplier to prioritize processing.
 * @returns {Promise<Object>} The transaction response from the funding action.
 */
const lazyFunding = async (size, multiplier = 1) => {
    try {
        console.log(`Starting lazy funding for ${size} bytes...`);
        const turbo = await getTurboArweave();
        console.log('Turbo SDK obtained successfully, getting upload costs...');
        
        // Get upload costs in Winston Credits
        console.log('Calling getUploadCosts with bytes:', [size]);
        const costs = await turbo.getUploadCosts({ bytes: [size] });
        console.log('Upload costs received:', costs);
        
        const requiredWinc = costs[0].winc;
        console.log(`Upload size: ${size} bytes, required credits: ${requiredWinc} Winston`);
        
        // For lazy funding, we use the required Winston credits directly
        // as the topUpWithTokens expects the amount in atomic units
        console.log('Calling topUpWithTokens with:', { tokenAmount: requiredWinc, feeMultiplier: multiplier });
        const response = await turbo.topUpWithTokens({ 
            tokenAmount: requiredWinc, 
            feeMultiplier: multiplier 
        });
        console.log('Lazy funding successful:', response);
        return response;
    } catch (error) {
        console.error('Error in lazy funding at step:', error.message);
        console.error('Full error:', error);
        throw error;
    }
};

module.exports = {
    getTransaction,
    checkBalance,
    getBlockHeightFromTxId,
    getCurrentBlockHeight,
    getCachedBlockHeight,
    refreshBlockHeightIfStale,
    upfrontFunding,
    lazyFunding,
    arweave,
};