/**
 * Socket Manager Module for streaming responses
 */
const WebSocket = require('ws');
// CRITICAL FIX: Use the same sharedState as Alexandria routes
// Previously used ../helpers/sharedState which is a DIFFERENT Map!
const { ongoingScrapes, ongoingDialogues } = require('../helpers/core/sharedState');
const { getBaseUrl } = require('../helpers/core/urlHelper');

// Store active connections
const connections = new Map();

/**
 * Initialize a WebSocket server
 * @param {Object} server - HTTP server instance
 */
function initSocketServer(server) {
    const wss = new WebSocket.Server({ server });
    
    wss.on('connection', (ws, req) => {
        const base = getBaseUrl();
        const url = new URL(req.url, `${base}/api/open-stream`);
        const id = url.searchParams.get('id');
        
        console.log(`Socket connection opened successfully`);
        
        if (!connections.has(id)) {
            connections.set(id, new Set());
        }
        connections.get(id).add(ws);
        
        // Send connection confirmation
        ws.send(JSON.stringify({ 
            message: `Stream connected for id: ${id}` 
        }));
        
        ws.on('close', () => {
            console.log(`Client disconnected for id: ${id}`);
            const clients = connections.get(id);
            if (clients) {
                clients.delete(ws);
                if (clients.size === 0) {
                    console.log(`No more clients for id: ${id}. Cleaning up.`);
                    connections.delete(id);
                }
            }
        });
    });
    
    return wss;
}

/**
 * Send messages to clients associated with a specific dialogue ID
 * @param {string} dialogueId - The dialogue ID
 * @param {Object} data - The data to send
 */
function sendToClients(dialogueId, data) {
    // console.log(`Socket Manager checking for clients: dialogueId=${dialogueId}`);
    
    // CRITICAL FIX: Check if ongoingDialogues is defined
    if (typeof ongoingDialogues === 'undefined') {
      console.error("ongoingDialogues is undefined in socketManager! Check imports.");
      return false;
    }
    
    // Get the dialogue stream from the open-stream endpoint
    if (ongoingDialogues.has(dialogueId)) {
        const stream = ongoingDialogues.get(dialogueId);
        
        if (stream.clients && stream.clients.size > 0) {
            // console.log(`Found ${stream.clients.size} clients for dialogueId=${dialogueId}`);
            
            stream.clients.forEach(client => {
                if (!client.writableEnded) {
                    try {
                        // Format the message correctly for SSE
                        client.write(`event: ${data.type}\n`);
                        // Make a copy of data without the type to avoid modifying the original
                        const eventData = {...data};
                        delete eventData.type;
                        client.write(`data: ${JSON.stringify(eventData)}\n\n`);
                    } catch (error) {
                        console.error(`Error sending to client: ${error.message}`);
                    }
                }
            });
        } else {
            console.log(`No clients found in the stream for dialogueId=${dialogueId}`);
        }
    } else {
        console.log(`No stream found for dialogueId=${dialogueId}`);
    }
    
    return true;
}

/**
 * Check if any clients exist for a specific ID
 */
function hasClients(id) {
    return connections.has(id) && connections.get(id).size > 0;
}

/**
 * Close all connections for a specific ID
 */
function closeConnections(id) {
    if (connections.has(id)) {
        const clients = connections.get(id);
        for (const client of clients) {
            client.close();
        }
        connections.delete(id);
        return true;
    }
    return false;
}

/**
 * Add a client to a stream
 * @param {string} id - The stream ID
 * @param {Object} client - The client object (response)
 */
function addClient(id, client) {
    // IMPORTANT FIX: Import the shared Map from your application
    const ongoingDialogues = require('../helpers/core/sharedState').ongoingDialogues;
    
    if (!ongoingDialogues.has(id)) {
        ongoingDialogues.set(id, {
            clients: [],
            data: []
        });
    }
    
    const stream = ongoingDialogues.get(id);
    stream.clients.push(client);
    
    console.log(`Client added to stream ${id}, total clients: ${stream.clients.length}`);
}

/**
 * Remove a client from a stream
 * @param {string} id - The stream ID
 * @param {Object} client - The client to remove
 */
function removeClient(id, client) {
    // IMPORTANT FIX: Import the shared Map from your application
    const ongoingDialogues = require('../helpers/core/sharedState').ongoingDialogues;
    
    if (!ongoingDialogues.has(id)) {
        return;
    }
    
    const stream = ongoingDialogues.get(id);
    const index = stream.clients.indexOf(client);
    
    if (index !== -1) {
        stream.clients.splice(index, 1);
        console.log(`Client removed from stream ${id}, remaining clients: ${stream.clients.length}`);
    }
    
    // Clean up if no more clients
    if (stream.clients.length === 0) {
        console.log(`No more clients for stream ${id}, removing...`);
        ongoingDialogues.delete(id);
    }
}

/**
 * Socket Manager for handling real-time connections
 */
class SocketManager {
    constructor() {
        // Global clients map to track all active connections
        this.dialogueClients = {};
        this.activeStreams = {}; // Track active streams for each dialogue
        console.log('Socket Manager initialized');
    }

    /**
     * Add a client to the dialogue
     * @param {string} dialogueId - The dialogue ID
     * @param {Object} client - The client response object
     */
    addClient(dialogueId, client) {
        if (!this.dialogueClients[dialogueId]) {
            this.dialogueClients[dialogueId] = [];
        }

        // Only add if not already present
        const existingIndex = this.dialogueClients[dialogueId].findIndex(c => c === client);
        if (existingIndex === -1) {
            this.dialogueClients[dialogueId].push(client);
            console.log(`Client added to dialogueId: ${dialogueId}, total clients: ${this.dialogueClients[dialogueId].length}`);
        }
    }

    /**
     * Check if clients exist for a dialogue ID
     * @param {string} dialogueId - The dialogue ID
     * @returns {boolean} - Whether clients exist
     */
    hasClients(dialogueId) {
        const hasClients = !!(this.dialogueClients[dialogueId] && this.dialogueClients[dialogueId].length > 0);
        console.log(`Socket Manager checking for clients: dialogueId=${dialogueId}, hasClients=${hasClients}, count=${this.dialogueClients[dialogueId]?.length || 0}`);
        return hasClients;
    }

    /**
     * Handle client disconnection
     * @param {string} dialogueId - The dialogue ID
     */
    removeClient(dialogueId, client) {
        if (this.dialogueClients[dialogueId]) {
            // Remove this specific client
            const initialCount = this.dialogueClients[dialogueId].length;
            this.dialogueClients[dialogueId] = this.dialogueClients[dialogueId].filter(c => c !== client);
            const newCount = this.dialogueClients[dialogueId].length;
            
            console.log(`Client removed from dialogueId: ${dialogueId}, clients before: ${initialCount}, after: ${newCount}`);
            
            if (this.dialogueClients[dialogueId].length === 0) {
                console.log(`No more clients for dialogueId: ${dialogueId}. Cleaning up.`);
                delete this.dialogueClients[dialogueId];
                this.clearStreams(dialogueId);
            }
        }
    }

    /**
     * Register an active stream for a dialogue
     * @param {string} dialogueId - The dialogue ID
     * @param {Object} stream - The stream object (e.g., AbortController)
     */
    registerStream(dialogueId, stream) {
        if (!this.activeStreams[dialogueId]) {
            this.activeStreams[dialogueId] = [];
        }
        this.activeStreams[dialogueId].push(stream);
        console.log(`Stream registered for dialogueId: ${dialogueId}, total streams: ${this.activeStreams[dialogueId].length}`);
    }

    /**
     * Clear all active streams for a dialogue ID
     * @param {string} dialogueId - The dialogue ID
     */
    clearStreams(dialogueId) {
        if (this.activeStreams[dialogueId]) {
            console.log(`Cancelling ${this.activeStreams[dialogueId].length} active streams for dialogueId: ${dialogueId}`);
            this.activeStreams[dialogueId].forEach(stream => {
                if (stream && typeof stream.abort === 'function') {
                    try {
                        stream.abort();
                    } catch (err) {
                        console.error(`Error aborting stream for ${dialogueId}:`, err.message);
                    }
                }
            });
            delete this.activeStreams[dialogueId];
        }
    }

    /**
     * Remove a specific stream from active streams
     * @param {string} dialogueId - The dialogue ID
     * @param {Object} stream - The stream to remove
     */
    removeStream(dialogueId, stream) {
        if (this.activeStreams[dialogueId]) {
            const initialCount = this.activeStreams[dialogueId].length;
            this.activeStreams[dialogueId] = this.activeStreams[dialogueId].filter(s => s !== stream);
            console.log(`Stream removed from dialogueId: ${dialogueId}, streams before: ${initialCount}, after: ${this.activeStreams[dialogueId].length}`);
            
            if (this.activeStreams[dialogueId].length === 0) {
                delete this.activeStreams[dialogueId];
            }
        }
    }

    /**
     * Send data to all clients for a dialogue ID
     * @param {string} dialogueId - The dialogue ID
     * @param {any} data - The data to send
     */
    sendToClients(dialogueId, data) {
        if (!this.hasClients(dialogueId)) {
            // Only log this message once per dialogue ID to avoid console spam
            if (!this._hasLoggedNoClients) {
                this._hasLoggedNoClients = {};
            }
            
            if (!this._hasLoggedNoClients[dialogueId]) {
                console.log(`No clients found for id: ${dialogueId}`);
                this._hasLoggedNoClients[dialogueId] = true;
                
                // Clear active streams for this dialogue since there are no clients
                this.clearStreams(dialogueId);
            }
            return;
        }
        
        // Reset the logging flag if we have clients again
        if (this._hasLoggedNoClients && this._hasLoggedNoClients[dialogueId]) {
            delete this._hasLoggedNoClients[dialogueId];
        }
        
        console.log(`Sending to ${this.dialogueClients[dialogueId].length} clients for id: ${dialogueId}`);
        this.dialogueClients[dialogueId].forEach(client => {
            try {
                // Format the data as an SSE event with proper format
                const eventName = data.type || 'message';
                const eventData = JSON.stringify(data);
                
                client.write(`event: ${eventName}\n`);
                client.write(`data: ${eventData}\n\n`);
            } catch (error) {
                console.error(`Error sending to client for dialogueId ${dialogueId}:`, error.message);
                // Remove problematic client
                this.removeClient(dialogueId, client);
            }
        });
    }
}

// Create a singleton instance
const socketManager = new SocketManager();

// Export both legacy functions and the class instance
module.exports = {
  sendToClients,
  hasClients: (dialogueId) => {
    // First check WebSocket connections
    if (connections.has(dialogueId) && connections.get(dialogueId).size > 0) {
      console.log(`✅ WebSocket clients found for dialogueId: ${dialogueId}`);
      return true;
    }
    
    // Then check EventSource connections (SSE)
    if (ongoingDialogues && ongoingDialogues.has(dialogueId)) {
      const stream = ongoingDialogues.get(dialogueId);
      if (stream && stream.clients && stream.clients.size > 0) {
        console.log(`✅ EventSource clients found for dialogueId: ${dialogueId}, count: ${stream.clients.size}`);
        return true;
      }
    }
    
    // Also check the class instance as fallback
    const classHasClients = socketManager.hasClients(dialogueId);
    if (classHasClients) {
      console.log(`✅ Class instance clients found for dialogueId: ${dialogueId}`);
      return true;
    }
    
    console.log(`❌ No clients found for dialogueId: ${dialogueId} in any connection system`);
    return false;
  },
  socketManager  // Export the class instance too
}; 