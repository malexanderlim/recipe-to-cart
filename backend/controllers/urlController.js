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

    try {
        // --- REMOVE Base URL Determination ---
        // const isVercel = ...
        // let baseUrl = ...
        // console.log(`[${jobId}] Determined base URL: ${baseUrl}`);
        // -----------------------------------

        // 1. Store initial job data in Redis (baseUrl no longer needed here)
        if (!redis) { throw new Error('Redis client not available'); }
        if (!qstashClient) { throw new Error('QStash client not initialized'); }

        const jobData = {
            status: 'pending',
            inputUrl: url,
            startTime: Date.now(),
            sourceType: 'url'
            // baseUrl: baseUrl // No longer storing baseUrl
        };

        console.log(`[${jobId}] Storing initial job data in Redis for URL: ${url}`);
        await redis.set(jobId, JSON.stringify(jobData), { ex: 86400 });
        console.log(`[${jobId}] Initial job data stored in Redis.`);

        // 2. Trigger background job via QStash Publish to Topic/Queue
        const urlTopicName = 'url-processing-jobs'; // Use topic/queue name

        console.log(`[${jobId}] Publishing job to QStash topic/queue: ${urlTopicName}`);
        try {
            // Use publishJSON with the topic name provided to the 'url' parameter
            await qstashClient.publishJSON({
                url: urlTopicName, // Target the topic/queue name via the URL parameter
                body: { jobId: jobId },
                retries: 3, // Use plan limit (max 3)
            });
            console.log(`[${jobId}] Job published successfully to QStash topic/queue.`);
        } catch (qstashError) {
            console.error(`[${jobId}] CRITICAL: Error publishing job to QStash topic/queue:`, qstashError);
            const publishFailData = { // Renamed from enqueueFailData
                 ...jobData,
                 status: 'failed',
                 error: 'Failed to publish URL job for processing via QStash topic/queue. Please try again.', // Updated error message
                 finishedAt: Date.now()
             };
             await redis.set(jobId, JSON.stringify(publishFailData));
             console.log(`[${jobId}] Updated Redis status to failed due to QStash publish error.`);
             return res.status(202).json({ jobId: jobId }); // Still return 202
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