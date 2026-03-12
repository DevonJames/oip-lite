const express = require('express');
const path = require('path');
const fs = require('fs');
const { authenticateToken } = require('../../helpers/utils'); // Import the authentication middleware
const socketManager = require('../../socket/socketManager');

const router = express.Router();
const mediaDirectory = path.join(__dirname, '../media');
const { ongoingScrapes } = require('../../helpers/core/sharedState.js'); // Adjust the path to store.js

// Serve static files from the public directory
// Use custom public path if specified, otherwise default to OIP's public folder
const publicPath = process.env.CUSTOM_PUBLIC_PATH === 'true' 
  ? path.join(__dirname, '..', '..', 'public')  // Parent directory public folder
  : path.join(__dirname, '..', 'public');       // Default OIP public folder

router.use(express.static(publicPath));

router.get('/', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

// Job status polling endpoint
router.get('/publish-status/:jobId', (req, res) => {
    const { getJob } = require('../../helpers/jobTracker');
    const { jobId } = req.params;
    
    const job = getJob(jobId);
    
    if (!job) {
        return res.status(404).json({
            error: 'Job not found',
            message: 'Job may have expired or never existed'
        });
    }
    
    const response = {
        jobId: job.jobId,
        status: job.status,
        progress: job.progress,
        message: job.message
    };
    
    // Include result data when completed
    if (job.status === 'completed' && job.result) {
        response.transactionId = job.result.transactionId;
        response.recordToIndex = job.result.recordToIndex;
        response.blockchain = job.result.blockchain;
    }
    
    // Include error details when failed
    if (job.status === 'failed' && job.error) {
        response.error = job.error.message;
    }
    
    res.status(200).json(response);
});

// Job status streaming endpoint (SSE)
router.get('/publish-status/:jobId/stream', async (req, res) => {
    const { getJob } = require('../../helpers/jobTracker');
    const { getBaseUrl } = require('../../helpers/core/urlHelper');
    const axios = require('axios');
    const { jobId } = req.params;
    
    // Set up SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    
    // Send initial ping
    res.write(`event: ping\n`);
    res.write(`data: ${JSON.stringify({timestamp: Date.now()})}\n\n`);
    
    const sendUpdate = (event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    
    // Check if job exists
    const initialJob = getJob(jobId);
    if (!initialJob) {
        sendUpdate('error', {
            error: 'Job not found',
            message: 'Job may have expired or never existed'
        });
        res.end();
        return;
    }
    
    let jobCompleted = false;
    let pollAttempts = 0;
    const maxPollAttempts = 120; // 10 minutes max
    
    // Send initial job status
    sendUpdate('publishProgress', {
        jobId: initialJob.jobId,
        status: initialJob.status,
        progress: initialJob.progress || 0,
        message: initialJob.message
    });
    
    // Poll job status until completion
    while (!jobCompleted && pollAttempts < maxPollAttempts) {
        await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second intervals
        pollAttempts++;
        
        const job = getJob(jobId);
        
        if (!job) {
            sendUpdate('error', { message: 'Job expired or was removed' });
            break;
        }
        
        // Send progress update
        sendUpdate('publishProgress', {
            jobId: job.jobId,
            status: job.status,
            progress: job.progress || 0,
            message: job.message,
            transactionId: job.result?.transactionId || null
        });
        
        // Check if job completed
        if (job.status === 'completed') {
            jobCompleted = true;
            const did = job.result.transactionId;
            
            console.log('Recipe publishing completed, waiting for ingredient resolution...');
            
            // Wait for ingredients to be fully resolved
            let ingredientsResolved = false;
            let resolutionAttempts = 0;
            const maxResolutionAttempts = 30; // 2.5 minutes max
            
            sendUpdate('publishProgress', {
                jobId: job.jobId,
                status: 'resolving',
                progress: 90,
                message: 'Waiting for ingredients to resolve...',
                transactionId: did
            });
            
            while (!ingredientsResolved && resolutionAttempts < maxResolutionAttempts) {
                await new Promise(resolve => setTimeout(resolve, 5000));
                resolutionAttempts++;
                
                try {
                    console.log(`Checking ingredient resolution (attempt ${resolutionAttempts}/${maxResolutionAttempts})...`);
                    
                    // Fetch the record with ingredient resolution
                    const checkResponse = await axios.get(
                        `${getBaseUrl(req)}/api/records?did=${encodeURIComponent(did)}&resolveDepth=1&resolveNamesOnly=true&limit=1`,
                        {
                            headers: {
                                'Authorization': req.headers.authorization || ''
                            }
                        }
                    );
                    
                    if (checkResponse.data.records && checkResponse.data.records.length > 0) {
                        const resolvedRecipe = checkResponse.data.records[0];
                        const ingredients = resolvedRecipe.data?.recipe?.ingredient || [];
                        
                        // Check if all ingredients are resolved
                        const allResolved = ingredients.every(ingredient => {
                            if (typeof ingredient === 'string' && ingredient.startsWith('did:')) {
                                return false;
                            }
                            if (typeof ingredient === 'object' && ingredient.name) {
                                return true;
                            }
                            if (typeof ingredient === 'string' && !ingredient.startsWith('did:')) {
                                return true;
                            }
                            return false;
                        });
                        
                        if (allResolved && ingredients.length > 0) {
                            ingredientsResolved = true;
                            console.log(`✓ All ${ingredients.length} ingredients resolved successfully`);
                            
                            // Send final completion
                            sendUpdate('recipeCompleted', {
                                jobId: job.jobId,
                                status: 'completed',
                                progress: 100,
                                message: 'Recipe published and fully resolved',
                                transactionId: did,
                                did: did,
                                blockchain: job.result.blockchain,
                                recordToIndex: resolvedRecipe
                            });
                        } else {
                            console.log(`⏳ Ingredients not fully resolved yet (${ingredients.filter(i => typeof i === 'string' && !i.startsWith('did:')).length}/${ingredients.length} resolved)`);
                        }
                    } else {
                        console.log('⏳ Recipe not yet indexed in Elasticsearch');
                    }
                } catch (resolutionError) {
                    console.error('Error checking ingredient resolution:', resolutionError.message);
                }
            }
            
            // If max attempts reached, send completion anyway
            if (!ingredientsResolved) {
                console.warn('⚠️  Max resolution attempts reached, sending completion with partial resolution');
                sendUpdate('recipeCompleted', {
                    jobId: job.jobId,
                    status: 'completed',
                    progress: 100,
                    message: 'Recipe published (ingredients may still be resolving)',
                    transactionId: did,
                    did: did,
                    blockchain: job.result.blockchain,
                    recordToIndex: job.result.recordToIndex,
                    partialResolution: true
                });
            }
            
        } else if (job.status === 'failed') {
            sendUpdate('error', {
                message: 'Recipe publishing failed',
                details: job.error?.message || 'Unknown error',
                jobId: jobId
            });
            jobCompleted = true;
        }
    }
    
    // Timeout
    if (!jobCompleted) {
        sendUpdate('error', {
            message: 'Job status polling timed out',
            details: 'Maximum polling time exceeded'
        });
    }
    
    res.end();
});

// Note: RAG test endpoint moved to alexandria-service at /api/alfred/test-rag

// const ongoingScrapes = new Map();
// Route to serve media files with range request support
// router.get('/media', authenticateToken, (req, res) => {
router.get('/media', (req, res) => {
    const { id } = req.query;
    const filePath = path.join(mediaDirectory, id);
    console.log('filepath:', filePath);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).send("File not found");
    }
    
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    
    // Always set Accept-Ranges header to indicate range support
    res.setHeader('Accept-Ranges', 'bytes');
    
    if (range) {
        // Parse the range header
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        
        // Validate range
        if (start >= fileSize || end >= fileSize || start > end) {
            res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
            return res.send('Range Not Satisfiable');
        }
        
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        
        // Set headers for partial content
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', chunksize);
        res.setHeader('Content-Type', getContentType(filePath));
        
        // CRITICAL FIX: Add stream cleanup handlers to prevent buffer leaks
        file.on('error', (err) => {
            console.error('❌ Stream error for', id, err.message);
            if (!res.headersSent) {
                res.status(500).send('Stream error');
            }
            file.destroy();
        });
        
        file.on('end', () => {
            // Force GC for large files (> 100KB) to prevent buffer accumulation
            if (chunksize > 102400 && global.gc) {
                setImmediate(() => global.gc());
            }
        });
        
        // Clean up on client disconnect
        res.on('close', () => {
            if (!file.destroyed) {
                file.destroy();
            }
        });
        
        // Pipe the file stream
        file.pipe(res);
        
    } else {
        // No range requested, send entire file
        res.setHeader('Content-Length', fileSize);
        res.setHeader('Content-Type', getContentType(filePath));
        
        const file = fs.createReadStream(filePath);
        
        // CRITICAL FIX: Add stream cleanup handlers to prevent buffer leaks
        file.on('error', (err) => {
            console.error('❌ Stream error for', id, err.message);
            if (!res.headersSent) {
                res.status(500).send('Stream error');
            }
            file.destroy();
        });
        
        file.on('end', () => {
            // Force GC for large files (> 100KB) to prevent buffer accumulation
            if (fileSize > 102400 && global.gc) {
                setImmediate(() => global.gc());
            }
        });
        
        // Clean up on client disconnect
        res.on('close', () => {
            if (!file.destroyed) {
                file.destroy();
            }
        });
        
        file.pipe(res);
    }
});

// Helper function to determine content type based on file extension
function getContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.ogg': 'video/ogg',
        '.avi': 'video/x-msvideo',
        '.mov': 'video/quicktime',
        '.wmv': 'video/x-ms-wmv',
        '.flv': 'video/x-flv',
        '.mkv': 'video/x-matroska',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.flac': 'audio/flac',
        '.aac': 'audio/aac',
        '.m4a': 'audio/mp4',
        '.wma': 'audio/x-ms-wma',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain',
        '.json': 'application/json',
        '.xml': 'application/xml',
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript'
    };
    
    return contentTypes[ext] || 'application/octet-stream';
}


// Add or update the ping endpoint with a proper keepalive response
router.get('/ping', (req, res) => {
  // Set headers to prevent caching
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  // Send a simple response with timestamp
  res.json({ 
    status: 'active', 
    timestamp: Date.now(),
    message: 'Connection alive'
  });
});

/**
 * Open a Server-Sent Events (SSE) connection
 */
router.get('/open-stream', (req, res) => {
    const streamId = req.query.id;
    
    if (!streamId) {
        return res.status(400).json({ error: 'No dialogue ID provided' });
    }
    
    console.log(`Client connecting to open-stream for streamId: ${streamId}`);
    
    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    
    // Send initial connection message with proper SSE format
    res.write(`event: connected\n`);
    res.write(`data: ${JSON.stringify({ message: 'Stream connected' })}\n\n`);
    
    // Register client with the Socket Manager  
    socketManager.addClient(streamId, res);
    
    // Handle client disconnect
    req.on('close', () => {
        console.log(`Client disconnected from streamId: ${streamId}`);
        socketManager.removeClient(streamId, res);
    });
});

module.exports = router;