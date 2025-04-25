const crypto = require('crypto');
const { redis } = require('../services/redisService');
const { Client } = require("@upstash/qstash"); // Import QStash Client

// --- Initialize QStash Client ---
// Reuse initialization logic (consider moving to a shared service later)
if (!process.env.QSTASH_TOKEN) {
    console.warn("QSTASH_TOKEN environment variable not set. QStash publishing will be disabled.");
}
const qstashClient = process.env.QSTASH_TOKEN ? new Client({ token: process.env.QSTASH_TOKEN }) : null;

// Define the target QStash topic/URL for the URL worker
const URL_WORKER_QSTASH_TARGET_URL = process.env.QSTASH_URL_WORKER_URL; 
if (!URL_WORKER_QSTASH_TARGET_URL && qstashClient) {
    console.warn("QSTASH_URL_WORKER_URL environment variable not set. Cannot publish to URL worker.");
}

// --- Controller function for POST /api/process-url --- 
async function processUrl(req, res) {
    const { url } = req.body;
    let jobId = `url-${crypto.randomUUID()}`; 
    console.log(`[QStash URL ${jobId}] Received request for /api/process-url`);

    if (!url) {
        console.log(`[QStash URL ${jobId}] Invalid request: URL is missing.`);
        return res.status(400).json({ error: 'URL is required' });
    }

    let validatedUrl;
    try {
        // Use a library for more robust validation (see rules.md #13)
        // Basic check for now:
        validatedUrl = new URL(url);
        if (!['http:', 'https:'].includes(validatedUrl.protocol)) {
             throw new Error('URL must use http or https protocol');
        }
    } catch (error) {
        console.log(`[QStash URL ${jobId}] Invalid request: URL format error - ${error.message}`);
        return res.status(400).json({ error: `Invalid URL format: ${error.message}` });
    }

    const initialJobData = {
        status: 'pending',
        inputUrl: url, // Use the original validated URL string
        startTime: Date.now(),
        sourceType: 'url'
    };

    let redisKeySet = false;

    try {
        // Use Redis client
        if (!redis) { 
            throw new Error('Redis client not available in urlController'); 
        }
        
        console.log(`[QStash URL ${jobId}] Step 1: Attempting redis.set...`);
        await redis.set(jobId, JSON.stringify(initialJobData), { ex: 86400 }); 
        redisKeySet = true;
        console.log(`[QStash URL ${jobId}] Step 2: Initial job data set in Redis for URL: ${url}`);

        // Publish job to QStash instead of calling triggerBackgroundJob
        if (!qstashClient) {
            throw new Error("QStash client not initialized. Cannot trigger background job.");
        }
        // --- Dynamically construct the target URL ---
        let urlWorkerTargetUrl;
        if (process.env.VERCEL_URL) {
            urlWorkerTargetUrl = `https://${process.env.VERCEL_URL}/api/process-url-job-worker`;
        } else if (process.env.NODE_ENV !== 'production') {
            // Fallback for local development (use req object)
            const host = req.get('host');
            const protocol = req.protocol;
            if (host && protocol) {
                urlWorkerTargetUrl = `${protocol}://${host}/api/process-url-job-worker`;
                console.log(`[QStash URL Job ${jobId}] Local Dev: Constructed target URL: ${urlWorkerTargetUrl}`);
            } else {
                throw new Error("Cannot determine local target URL for URL worker.");
            }
         } else {
            throw new Error("VERCEL_URL is not set in production. Cannot determine QStash target URL.");
         }
        // --- End Dynamic URL Construction ---
        console.log(`[QStash URL ${jobId}] Step 3: Publishing job to QStash target: ${urlWorkerTargetUrl}`);
        const publishResponse = await qstashClient.publishJSON({
            url: urlWorkerTargetUrl, // Use dynamically constructed URL
            body: { jobId: jobId },
        });
        console.log(`[QStash URL ${jobId}] QStash publish response: ${publishResponse.messageId}`);

        console.log(`[QStash URL ${jobId}] Step 4: Attempting to send 202 response...`);
        res.status(202).json({ jobId });
        console.log(`[QStash URL ${jobId}] Step 5: Successfully sent 202 response.`);

    } catch (error) { 
        console.error(`[QStash URL ${jobId}] Error in /api/process-url handler during setup/publish:`, error);

        // Enhanced Cleanup Logic
        if (redisKeySet) {
            try {
                // Update Redis status to failed if publish failed after setting key
                await redis.set(jobId, JSON.stringify({ 
                    ...initialJobData, // Keep original data like inputUrl
                    status: 'failed', 
                    error: 'Failed to schedule URL processing. Please try again.', 
                    finishedAt: Date.now()
                }));
                console.log(`[QStash URL ${jobId}] Updated Redis to failed due to setup/publish error.`);
            } catch (redisSetError) {
                console.error(`[QStash URL ${jobId}] Failed to update Redis status to failed on error:`, redisSetError);
                 try { await redis.del(jobId); } catch (redisDelError) { /* Ignore */ }
            }
        } // No need for else, if key wasn't set, nothing to clean up

        if (!res.headersSent) {
             console.log(`[QStash URL ${jobId}] Sending 500 error response to client.`);
             res.status(500).json({ error: 'Failed to initiate URL processing job', details: error.message });
        } else {
             console.error(`[QStash URL ${jobId}] Headers already sent, could not send 500 error response.`);
        }
    }
}

module.exports = {
    processUrl
}; 