const crypto = require('crypto');
// Dynamic import to avoid adding node-fetch to globals in all envs
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { redis } = require('../services/redisService');
const { qstashClient } = require('../services/qstashService');

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
        sourceType: 'url'
    };

    try {
        // 1. Store initial job data in Redis
        if (!redis) { throw new Error('Redis client not available'); }
        if (!qstashClient) { throw new Error('QStash client not initialized'); }

        console.log(`[${jobId}] Storing initial job data in Redis for URL: ${url}`);
        await redis.set(jobId, JSON.stringify(jobData), { ex: 86400 });
        console.log(`[${jobId}] Initial job data stored in Redis.`);

        // 2. Trigger background job via QStash
        const urlWorkerUrl = process.env.QSTASH_URL_WORKER_URL;
        if (!urlWorkerUrl) {
            console.error(`[${jobId}] CRITICAL: QSTASH_URL_WORKER_URL environment variable not set.`);
             const configFailData = {
                 ...jobData,
                 status: 'failed',
                 error: 'Server configuration error preventing job start.',
                 finishedAt: Date.now()
             };
             await redis.set(jobId, JSON.stringify(configFailData));
             console.log(`[${jobId}] Updated Redis status to failed due to missing QStash URL.`);
             // Return 202 as initial request accepted, log critical backend failure
             return res.status(202).json({ jobId: jobId });
        }

        console.log(`[${jobId}] Publishing job to QStash URL worker queue targeting: ${urlWorkerUrl}`);
        try {
            await qstashClient.publishJSON({
                url: urlWorkerUrl,
                body: { jobId: jobId },
                retries: 5, // Example retries
            });
            console.log(`[${jobId}] Job published successfully to QStash URL worker.`);
        } catch (qstashError) {
            console.error(`[${jobId}] CRITICAL: Error publishing job to QStash URL worker:`, qstashError);
            const publishFailData = {
                 ...jobData,
                 status: 'failed',
                 error: 'Failed to queue URL job for processing. Please try again.',
                 finishedAt: Date.now()
             };
             await redis.set(jobId, JSON.stringify(publishFailData));
             console.log(`[${jobId}] Updated Redis status to failed due to QStash publish error.`);
             // Return 202, log critical backend failure
             return res.status(202).json({ jobId: jobId });
        }

        // 3. Return 202 Accepted with Job ID
        console.log(`[${jobId}] Sending 202 Accepted response.`);
        res.status(202).json({ jobId });

    } catch (error) {
        console.error(`[${jobId}] Error in /api/process-url handler:`, error);
        if (!res.headersSent) {
             res.status(500).json({ error: 'Failed to initiate URL processing job' });
        }
    }
}

module.exports = {
    processUrl
}; 