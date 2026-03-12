/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * OIP CLIENT - Alexandria to Daemon Communication
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This client is used by alexandria-service to communicate with oip-daemon-service.
 * It handles all data operations including:
 *   - Record CRUD (via /api/records)
 *   - Publishing (via /api/publish)
 *   - Media operations (via /api/media)
 *   - Template access (via /api/templates)
 *   - Organization management (via /api/organizations)
 *   - User operations (via /api/user)
 * 
 * MEMORY LEAK PREVENTION:
 *   - Response data is nulled after extraction
 *   - Large responses trigger GC
 *   - Error responses are cleaned up
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

'use strict';

const axios = require('axios');
const FormData = require('form-data');

const OIP_DAEMON_URL = process.env.OIP_DAEMON_URL || 'http://oip-daemon-service:3005';

// Axios instance with memory-safe configuration
const axiosInstance = axios.create({
    baseURL: OIP_DAEMON_URL,
    timeout: 30000,
    headers: {
        'Content-Type': 'application/json'
    }
});

/**
 * OIPClient - HTTP client for communicating with oip-daemon-service
 */
class OIPClient {
    /**
     * Create a new OIPClient
     * @param {string} userToken - JWT token for authenticated requests (optional)
     */
    constructor(userToken = null) {
        this.baseURL = OIP_DAEMON_URL;
        this.token = userToken;
    }

    /**
     * Make an HTTP request to the daemon
     * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
     * @param {string} endpoint - API endpoint path
     * @param {object} data - Request body data (for POST/PUT)
     * @param {object} params - Query parameters
     * @returns {Promise<any>} Response data
     */
    async request(method, endpoint, data = null, params = null) {
        let response = null;
        
        try {
            const config = {
                method,
                url: `${this.baseURL}${endpoint}`,
                headers: {}
            };
            
            if (this.token) {
                config.headers['Authorization'] = `Bearer ${this.token}`;
            }
            
            if (data) config.data = data;
            if (params) config.params = params;
            
            response = await axiosInstance(config);
            
            // MEMORY LEAK FIX: Extract data and null response
            const responseData = response.data;
            response.data = null;
            response = null;
            
            return responseData;
            
        } catch (error) {
            // MEMORY LEAK FIX: Clean up error response
            if (response) {
                response.data = null;
                response = null;
            }
            if (error.response) {
                const errorData = error.response.data;
                const errorStatus = error.response.status;
                error.response.data = null;
                error.response = null;
                
                // Rethrow with cleaned error
                const cleanError = new Error(errorData?.error || error.message);
                cleanError.status = errorStatus;
                cleanError.response = { status: errorStatus, data: errorData };
                throw cleanError;
            }
            throw error;
        }
    }

    /**
     * Proxy a request from Alexandria to Daemon (for unified API access)
     * @param {string} method - HTTP method
     * @param {string} path - Full API path
     * @param {object} body - Request body
     * @param {object} query - Query parameters
     * @returns {Promise<any>} Response data
     */
    async proxyRequest(method, path, body = null, query = null) {
        return this.request(method, path, body, query);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CARD CATALOG - Record Operations
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Get records from the index
     * @param {object} params - Query parameters (recordType, search, limit, etc.)
     * @returns {Promise<{records: Array, total: number}>}
     */
    async getRecords(params) {
        return this.request('GET', '/api/records', null, params);
    }

    /**
     * Get a single record by DID
     * @param {string} did - Record DID
     * @param {object} options - Options like resolveDepth
     * @returns {Promise<object>} Record data
     */
    async getRecord(did, options = {}) {
        return this.request('GET', '/api/records', null, { 
            did, 
            ...options 
        });
    }

    /**
     * Publish a new record
     * @param {object} recordData - Record data
     * @param {object} options - Publishing options
     * @returns {Promise<{did: string, txId: string}>}
     */
    async publishRecord(recordData, options = {}) {
        const queryParams = new URLSearchParams();
        if (options.recordType) queryParams.append('recordType', options.recordType);
        if (options.storage) queryParams.append('storage', options.storage);
        if (options.localId) queryParams.append('localId', options.localId);
        
        const queryString = queryParams.toString();
        const endpoint = `/api/records/newRecord${queryString ? '?' + queryString : ''}`;
        
        return this.request('POST', endpoint, recordData);
    }

    /**
     * Delete a record
     * @param {string} did - Record DID
     * @returns {Promise<{success: boolean}>}
     */
    async deleteRecord(did) {
        return this.request('POST', '/api/records/deleteRecord', { did });
    }

    /**
     * Get record types summary
     * @returns {Promise<object>} Record types with counts
     */
    async getRecordTypes() {
        return this.request('GET', '/api/records/recordTypes');
    }

    /**
     * Index a record directly to Elasticsearch
     * Used when Alexandria creates records that need to be indexed
     * @param {object} record - The record to index (must have oip.did or oip.didTx)
     * @returns {Promise<{success: boolean, recordId: string}>}
     */
    async indexRecord(record) {
        return this.request('POST', '/api/records/index', record);
    }

    /**
     * Search for a creator by DID address
     * @param {string} didAddress - The creator's DID address (e.g., did:arweave:xxx)
     * @returns {Promise<{success: boolean, creator: object}>}
     */
    async getCreatorByAddress(didAddress) {
        return this.request('GET', `/api/records/creator/${encodeURIComponent(didAddress)}`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CARD CATALOG - Template Operations
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Get all templates
     * @returns {Promise<Array>} List of templates
     */
    async getTemplates() {
        return this.request('GET', '/api/templates');
    }

    /**
     * Get a specific template by name
     * @param {string} name - Template name
     * @returns {Promise<object>} Template definition
     */
    async getTemplate(name) {
        return this.request('GET', `/api/templates/${name}`);
    }

    /**
     * Get publishing schema for a record type
     * @param {string} recordType - Record type name
     * @returns {Promise<object>} Schema definition
     */
    async getSchema(recordType) {
        return this.request('GET', `/api/publish/schema?recordType=${recordType}`);
    }

    /**
     * Get all available schemas
     * @returns {Promise<Array>} List of schemas
     */
    async getSchemas() {
        return this.request('GET', '/api/publish/schemas');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SHELVES - Media Operations
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Upload a media file
     * @param {FormData} formData - Form data with file
     * @returns {Promise<{mediaId: string, url: string}>}
     */
    async uploadMedia(formData) {
        let response = null;
        
        try {
            response = await axios.post(`${this.baseURL}/api/media/upload`, formData, {
                headers: {
                    ...formData.getHeaders(),
                    'Authorization': this.token ? `Bearer ${this.token}` : undefined
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                timeout: 300000 // 5 minute timeout for large uploads
            });
            
            const data = response.data;
            response.data = null;
            response = null;
            
            return data;
            
        } catch (error) {
            if (response) {
                response.data = null;
                response = null;
            }
            throw error;
        }
    }

    /**
     * Create an OIP record for media
     * @param {object} mediaData - Media metadata
     * @returns {Promise<{did: string}>}
     */
    async createMediaRecord(mediaData) {
        return this.request('POST', '/api/media/createRecord', mediaData);
    }

    /**
     * Get media info
     * @param {string} mediaId - Media ID
     * @returns {Promise<object>} Media metadata
     */
    async getMediaInfo(mediaId) {
        return this.request('GET', `/api/media/${mediaId}/info`);
    }

    /**
     * Get media stream URL
     * @param {string} mediaId - Media ID
     * @returns {string} Stream URL
     */
    getMediaStreamUrl(mediaId) {
        return `${this.baseURL}/api/media/${mediaId}`;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ACCESS CONTROL - User Operations
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Register a new user
     * @param {string} email - User email
     * @param {string} password - User password
     * @returns {Promise<{token: string, user: object}>}
     */
    async register(email, password) {
        return this.request('POST', '/api/user/register', { email, password });
    }

    /**
     * Login user
     * @param {string} email - User email
     * @param {string} password - User password
     * @returns {Promise<{token: string, user: object}>}
     */
    async login(email, password) {
        return this.request('POST', '/api/user/login', { email, password });
    }

    /**
     * Import wallet from mnemonic
     * @param {string} mnemonic - BIP-39 mnemonic
     * @param {string} password - Account password
     * @returns {Promise<{token: string, user: object}>}
     */
    async importWallet(mnemonic, password) {
        return this.request('POST', '/api/user/import-wallet', { mnemonic, password });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ACCESS CONTROL - Organization Operations
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Get all organizations
     * @returns {Promise<Array>} List of organizations
     */
    async getOrganizations() {
        return this.request('GET', '/api/organizations');
    }

    /**
     * Get organization by ID
     * @param {string} id - Organization ID
     * @returns {Promise<object>} Organization details
     */
    async getOrganization(id) {
        return this.request('GET', `/api/organizations/${id}`);
    }

    /**
     * Register a new organization
     * @param {object} orgData - Organization data
     * @returns {Promise<{did: string}>}
     */
    async registerOrganization(orgData) {
        return this.request('POST', '/api/organizations/register', orgData);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLISHING - Convenience Methods
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Publish a post
     * @param {object} postData - Post data
     * @param {string} storage - Storage type ('arweave' or 'gun')
     * @returns {Promise<{did: string}>}
     */
    async publishPost(postData, storage = 'arweave') {
        return this.request('POST', `/api/publish/newPost?storage=${storage}`, postData);
    }

    /**
     * Publish a conversation session (private by default)
     * @param {object} sessionData - Session data
     * @returns {Promise<{did: string}>}
     */
    async publishSession(sessionData) {
        return this.request('POST', '/api/publish/newRecord?recordType=conversationSession&storage=gun', sessionData);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HEALTH - Status Checks
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Check daemon health
     * @returns {Promise<{status: string}>}
     */
    async health() {
        return this.request('GET', '/health');
    }

    /**
     * Check GUN sync status
     * @returns {Promise<object>} Sync status
     */
    async gunSyncStatus() {
        return this.request('GET', '/api/health/gun-sync');
    }

    /**
     * Check memory status
     * @returns {Promise<object>} Memory info
     */
    async memoryStatus() {
        return this.request('GET', '/api/health/memory');
    }
}

module.exports = OIPClient;

