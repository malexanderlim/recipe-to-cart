const crypto = require('crypto');
// Dynamic import removed as fetch is no longer used here
// const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { redis } = require('../services/redisService');
const { Client } = require("@upstash/qstash"); // Import QStash Client

// --- Initialize QStash Client (Copied from uploadController) ---
if (!process.env.QSTASH_TOKEN) {
    console.warn("QSTASH_TOKEN environment variable not set. QStash publishing will be disabled.");
}
const qstashClient = process.env.QSTASH_TOKEN ? new Client({ token: process.env.QSTASH_TOKEN }) : null;

// Define the target QStash topic/URL for the URL worker
// REMOVED: const URL_WORKER_QSTASH_TARGET_URL = process.env.QSTASH_URL_WORKER_URL;
// REMOVED: if (!URL_WORKER_QSTASH_TARGET_URL && qstashClient) { ... }

// --- Helper function to trigger background job --- 
// This function is no longer needed as we use QStash directly
/*
async function triggerBackgroundJob(jobId) {
    // ... old fetch logic ...
}
*/

// --- Controller function for POST /api/process-url --- 
async function processUrl(req, res) {
    const { url } = req.body;
    let jobId = `url-${crypto.randomUUID()}`;
    console.log(`[${jobId}] Received request for /api/process-url (QStash)`);

    if (!url) {
        console.log(`[${jobId}] Invalid request: URL is missing.`);
        return res.status(400).json({ error: 'URL is required' });
    }

    let validatedUrl;
    try {
        // Basic URL validation (consider using a library like 'validator')
        validatedUrl = new URL(url);
        if (!['http:', 'https:'].includes(validatedUrl.protocol)) {
             throw new Error('URL must use http or https protocol');
        }
    } catch (error) {
        console.log(`[${jobId}] Invalid request: URL format error - ${error.message}`);
        return res.status(400).json({ error: `Invalid URL format: ${error.message}` });
    }

    const jobData = {
        status: 'pending',
        inputUrl: url,
        startTime: Date.now(),
        sourceType: 'url' // Differentiate from image jobs
    };

    let redisKeySet = false;

    try {
        // Use Redis client
        if (!redis) {
            throw new Error('Redis client not available in urlController');
        }

        console.log(`[${jobId}] Step 1: Attempting redis.set...`);
        await redis.set(jobId, JSON.stringify(jobData), { ex: 86400 });
        redisKeySet = true;
        console.log(`[${jobId}] Step 2: Initial job data set in Redis for URL: ${url}`);

        // --- Publish job to QStash --- 
        if (!qstashClient) {
            throw new Error("QStash client not initialized. Cannot trigger background job.");
        }

        // --- Dynamically Construct Target URL --- 
        let targetWorkerUrl;
        const isVercel = process.env.VERCEL === '1';
        const workerPath = '/api/process-url-job-worker'; // Correct worker path
        if (isVercel && process.env.VERCEL_URL) {
            targetWorkerUrl = `https://${process.env.VERCEL_URL}${workerPath}`;
        } else if (!isVercel) {
            const host = req.get('host');
            const protocol = req.protocol;
            if (host && protocol) {
                 targetWorkerUrl = `${protocol}://${host}${workerPath}`;
            } else {
                 throw new Error("Could not determine host/protocol for local worker URL.");
            }
        } else {
            throw new Error("VERCEL_URL environment variable is missing in Vercel environment.");
        }
        // -----------------------------------------

        console.log(`[${jobId}] Step 3: Publishing job to QStash target: ${targetWorkerUrl}`);
        const publishResponse = await qstashClient.publishJSON({
            url: targetWorkerUrl, // Use dynamically constructed URL
            body: { jobId: jobId },
        });
        console.log(`[${jobId}] QStash publish response: ${publishResponse.messageId}`);

        // --- Send Response --- 
        console.log(`[${jobId}] Step 4: Attempting to send 202 response...`);
        res.status(202).json({ jobId });
        console.log(`[${jobId}] Step 5: Successfully sent 202 response.`);

    } catch (error) {
        console.error(`[${jobId}] Error in /api/process-url handler (QStash):`, error);
        
        // Cleanup logic similar to uploadController
        if (redisKeySet) {
             try {
                 await redis.set(jobId, JSON.stringify({ 
                     ...jobData, // Keep initial data like inputUrl
                     status: 'failed', 
                     error: 'Failed to schedule background processing. Please try again.'
                 }));
                 console.log(`[${jobId}] Updated Redis to failed due to setup/publish error.`);
             } catch (redisSetError) {
                 console.error(`[${jobId}] Failed to update Redis status to failed on error:`, redisSetError);
                 try { await redis.del(jobId); } catch (redisDelError) { /* Ignore */ }
             }
         } 

        if (!res.headersSent) {
             console.log(`[${jobId}] Sending 500 error response to client.`);
             res.status(500).json({ error: 'Failed to initiate URL processing job' });
        } else {
             console.error(`[${jobId}] Headers already sent, could not send 500 error response.`);
        }
    }
}

module.exports = {
    processUrl
}; 