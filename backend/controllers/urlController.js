const crypto = require('crypto');
const { redis } = require('../services/redisService');
const { Client } = require('@upstash/qstash'); // Import QStash Client

// Initialize QStash Client
const qstashClient = new Client({ token: process.env.QSTASH_TOKEN });

async function processUrl(req, res) {
    const { url } = req.body;
    console.log(`[Process URL ${url}] Received request.`);

    // Basic validation (could be improved with a library like validator.js)
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
        console.error(`[Process URL] Invalid URL received: ${url}`);
        return res.status(400).json({ error: 'Invalid or missing URL.' });
    }
    if (!process.env.QSTASH_TOKEN) {
         return res.status(500).json({ message: 'Server configuration error: Missing QStash token.' });
    }

    const jobId = crypto.randomUUID();
    console.log(`[Process URL Job ${jobId}] Generated for URL: ${url}`);

    try {
        // 1. Store initial job state in Redis
        console.log(`[Process URL Job ${jobId}] Storing initial job state in Redis...`);
        if (!redis) { throw new Error('Redis client not initialized'); }
        const initialJobData = {
            status: 'pending',
            inputUrl: url, // Use key 'inputUrl'
            jobId: jobId,
            createdAt: new Date().toISOString()
        };
        // Use correct syntax for expiry
        await redis.set(jobId, JSON.stringify(initialJobData), { ex: 3600 }); 
        console.log(`[Process URL Job ${jobId}] Initial job state stored.`);

        // 2. Trigger /api/process-url-job via QStash
        // Construct base URL correctly (Rule #1)
        let baseUrl;
        if (process.env.APP_BASE_URL) {
            baseUrl = process.env.APP_BASE_URL;
        } else if (process.env.VERCEL_URL) {
            baseUrl = `https://${process.env.VERCEL_URL}`;
        } else {
            console.error(`[Process URL Job ${jobId}] CRITICAL: Cannot determine base URL. APP_BASE_URL and VERCEL_URL are missing.`);
            throw new Error('Server configuration error: Base URL not set.');
        }
        const targetWorkerUrl = `${baseUrl}/api/process-url-job`;

        // Safeguard check (Rule #1)
        if (!targetWorkerUrl.startsWith('http')) {
             console.error(`[Process URL Job ${jobId}] Invalid QStash target URL constructed: ${targetWorkerUrl}. Check APP_BASE_URL/VERCEL_URL.`);
             await redis.set(jobId, JSON.stringify({ 
                 ...initialJobData, 
                 status: 'failed', 
                 error: 'Server config error: Invalid callback URL.' 
             }), { ex: 3600 });
             return res.status(202).json({ jobId }); // Still 202, but job is marked failed
        }

        try {
            await qstashClient.publishJSON({
                url: targetWorkerUrl,
                body: { jobId },
                headers: { 'Content-Type': 'application/json' },
            });
            console.log(`[Process URL Job ${jobId}] Published job to QStash targeting ${targetWorkerUrl}`);
        } catch (qstashError) {
            console.error(`[Process URL Job ${jobId}] Failed to publish job to QStash:`, qstashError);
            await redis.set(jobId, JSON.stringify({ 
                ...initialJobData, 
                status: 'failed', 
                error: 'Failed to initiate URL processing via QStash.' 
            }), { ex: 3600 });
            return res.status(202).json({ jobId }); // Still 202, but job is marked failed
        }

        // 3. Respond 202 Accepted
        res.status(202).json({ jobId: jobId });
        console.log(`[Process URL Job ${jobId}] Sent 202 Accepted to client.`);

    } catch (error) {
        console.error(`[Process URL Job ${jobId}] Error during initial setup:`, error);
        // Attempt to clean up Redis entry if setup failed badly
        try {
             if (redis) { await redis.del(jobId); }
        } catch (redisDelError) {
             console.error(`[Process URL Job ${jobId}] Failed to clean up Redis on error:`, redisDelError);
        }
        res.status(500).json({ error: 'Failed to initiate URL processing.', details: error.message });
    }
}

module.exports = {
    processUrl
}; 