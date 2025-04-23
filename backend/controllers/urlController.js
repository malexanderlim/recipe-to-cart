const crypto = require('crypto');
// Dynamic import to avoid adding node-fetch to globals in all envs
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { redis } = require('../services/redisService');

// --- Helper function to trigger background job --- 
async function triggerBackgroundJob(jobId) {
    const port = process.env.PORT || 3001; 
    const isVercel = process.env.VERCEL === '1';
    
    // Construct absolute URL for fetch
    let triggerUrl;
    if (isVercel) {
        // Ensure VERCEL_URL starts with https://
        const baseUrl = process.env.VERCEL_URL.startsWith('http') 
            ? process.env.VERCEL_URL 
            : `https://${process.env.VERCEL_URL}`;
        triggerUrl = `${baseUrl}/api/process-url-job`;
    } else {
        triggerUrl = `http://localhost:${port}/api/process-url-job`;
    }

    console.log(`[${jobId}] Triggering background job at: ${triggerUrl}`);
    
    try {
        // Fire-and-forget fetch
        fetch(triggerUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // Add internal trigger secret header if needed for security
                // 'X-Internal-Trigger-Secret': process.env.INTERNAL_TRIGGER_SECRET || 'default-secret' 
            },
            body: JSON.stringify({ jobId }),
        }).catch(fetchError => {
            // Log the error but don't crash the main request
            console.error(`[${jobId}] ASYNC CATCH: Error triggering background job (fetch failed):`, fetchError);
            // Optionally: Update Redis status to failed here if trigger fails critically
            // updateJobStatusRedis(jobId, 'failed', { error: `Failed to trigger background processing task: ${fetchError.message}` });
        });
        console.log(`[${jobId}] Background job fetch dispatched.`);
    } catch (error) {
        // This catch block might not be strictly necessary for fire-and-forget
        // but kept for safety during refactor.
        console.error(`[${jobId}] Error initiating background job fetch:`, error);
        // Don't update status here as the initial request might succeed
    }
}

// --- Controller function for POST /api/process-url --- 
async function processUrl(req, res) {
    const { url } = req.body;
    let jobId = `url-${crypto.randomUUID()}`; 
    console.log(`[${jobId}] Received request for /api/process-url`);

    if (!url) {
        console.log(`[${jobId}] Invalid request: URL is missing.`);
        return res.status(400).json({ error: 'URL is required' });
    }

    let validatedUrl;
    try {
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

    try {
        // Use Redis client
        if (!redis) { 
            throw new Error('Redis client not available in urlController'); 
        }
        
        console.log(`[${jobId}] Step 1: Attempting redis.set...`);
        // Store as stringified JSON, set expiration (e.g., 24 hours)
        await redis.set(jobId, JSON.stringify(jobData), { ex: 86400 }); 
        console.log(`[${jobId}] Step 2: Initial job data set in Redis for URL: ${url}`);

        // Trigger background job (fire-and-forget)
        await triggerBackgroundJob(jobId);

        console.log(`[${jobId}] Step 3: Attempting to send 202 response...`);
        res.status(202).json({ jobId });
        console.log(`[${jobId}] Step 4: Successfully sent 202 response.`);

    } catch (error) { 
        console.error(`[${jobId}] SYNC CATCH: Error in /api/process-url handler:`, error);
        // Attempt to clean up Redis if the initial set succeeded but something else failed?
        // Potentially: await redis.del(jobId);
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