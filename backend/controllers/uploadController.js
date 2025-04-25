// backend/controllers/uploadController.js
// ----------------------------------------------------------------------------
//  FULL "/api/upload" CONTROLLER – extracted from legacy server.js
// ----------------------------------------------------------------------------

const crypto = require('crypto');
const { put } = require('@vercel/blob');
const { redis } = require('../services/redisService');
const { qstashClient } = require('../services/qstashService');

/**
 * Handle image upload and initiate asynchronous processing
 * Creates a job ID, stores the image in Vercel Blob, and triggers background processing via QStash
 */
async function handleUpload(req, res) {
    console.log(`[Async Upload] Received ${req.files?.length || 0} files.`);
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded.' });
    }

    // --- Process only the first file for simplicity ---
    const file = req.files[0];
    const originalFilename = file.originalname;
    const buffer = file.buffer; // Get the file buffer directly

    console.log(`[Async Upload] Processing file: ${originalFilename}, size: ${file.size} bytes`);

    const jobId = crypto.randomUUID();
    console.log(`[Async Upload] Generated Job ID: ${jobId}`);

    try {
        // --- Determine Base URL ---
        const isVercel = process.env.VERCEL === '1';
        let baseUrl;
        if (isVercel && process.env.VERCEL_URL) {
            // Ensure VERCEL_URL starts with https://
            baseUrl = process.env.VERCEL_URL.startsWith('http') 
                ? process.env.VERCEL_URL 
                : `https://${process.env.VERCEL_URL}`;
        } else {
            // Fallback for local development or other environments
            baseUrl = `${req.protocol}://${req.get('host')}`;
        }
        console.log(`[Async Upload Job ${jobId}] Determined base URL: ${baseUrl}`);
        // --------------------------

        // 1. Upload image buffer to Vercel Blob
        console.log(`[Async Upload Job ${jobId}] Uploading image to Vercel Blob...`);
        const blobResult = await put(originalFilename, buffer, {
            access: 'public',
            addRandomSuffix: true
        });
        const blobUrl = blobResult.url;
        console.log(`[Async Upload Job ${jobId}] Image uploaded to: ${blobUrl}`);

        // 2. Store initial job state in Upstash Redis (including baseUrl)
        console.log(`[Async Upload Job ${jobId}] Storing initial job state in Redis...`);
        if (!redis) { throw new Error('Redis client not initialized'); }
        if (!qstashClient) { throw new Error('QStash client not initialized'); }
        const initialJobData = {
            status: 'pending',
            originalFilename: originalFilename,
            blobUrl: blobUrl,
            createdAt: Date.now(),
            baseUrl: baseUrl // Store the determined base URL
        };
        await redis.set(jobId, JSON.stringify(initialJobData), { ex: 86400 });
        console.log(`[Async Upload Job ${jobId}] Initial job state stored (including base URL).`);

        // 3. Trigger background processing via QStash (using dynamic URL)
        const imageWorkerUrl = `${baseUrl}/api/process-image-worker`; // Construct dynamically

        console.log(`[Async Upload Job ${jobId}] Publishing job to QStash queue targeting dynamically constructed URL: ${imageWorkerUrl}`);

        try {
            await qstashClient.publishJSON({
                url: imageWorkerUrl, // Use dynamically constructed URL
                body: { jobId: jobId },
                retries: 5,
                delay: '1s'
            });
            console.log(`[Async Upload Job ${jobId}] Job published successfully to QStash.`);
        } catch (qstashError) {
            console.error(`[Async Upload Job ${jobId}] CRITICAL: Error publishing job to QStash:`, qstashError);
            const publishFailData = {
                ...initialJobData, // Use the data we just stored
                status: 'failed',
                error: 'Failed to queue job for processing via QStash. Please try again.',
                finishedAt: Date.now()
             };
             await redis.set(jobId, JSON.stringify(publishFailData));
             console.log(`[Async Upload Job ${jobId}] Updated Redis status to failed due to QStash publish error.`);
             return res.status(202).json({ jobId: jobId }); // Still return 202
        }

        // 4. Return 202 Accepted with the Job ID
        res.status(202).json({ jobId: jobId });
        console.log(`[Async Upload Job ${jobId}] Sent 202 Accepted to client.`);

    } catch (error) {
        console.error(`[Async Upload Job ${jobId}] Error during initial upload/setup:`, error);
        // Attempt to clean up Redis entry if setup failed badly
        try {
             if (redis) { await redis.del(jobId); } // Use redis.del
        } catch (redisDelError) {
             console.error(`[Async Upload Job ${jobId}] Failed to clean up Redis on error:`, redisDelError);
        }
        // Maybe attempt blob cleanup if `blobResult` exists? More complex.
        const blobUrlToDelete = error?.blobResult?.url; // Hypothetical error object enrichment
        if (blobUrlToDelete) {
             try { await del(blobUrlToDelete); } catch (blobDelError) { console.error(`[Async Upload Job ${jobId}] Failed to clean up Blob on error: ${blobDelError.message}`); }
        }

        res.status(500).json({ error: 'Failed to initiate image processing.', details: error.message });
    }
}

module.exports = {
    handleUpload
}; 