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
        // 1. Upload image buffer to Vercel Blob
        console.log(`[Async Upload Job ${jobId}] Uploading image to Vercel Blob...`);
        const blobResult = await put(originalFilename, buffer, {
            access: 'public',
            addRandomSuffix: true
        });
        const blobUrl = blobResult.url;
        console.log(`[Async Upload Job ${jobId}] Image uploaded to: ${blobUrl}`);

        // 2. Store initial job state in Upstash Redis
        console.log(`[Async Upload Job ${jobId}] Storing initial job state in Redis...`);
        if (!redis) { throw new Error('Redis client not initialized'); }
        if (!qstashClient) { throw new Error('QStash client not initialized'); }
        const initialJobData = {
            status: 'pending',
            originalFilename: originalFilename,
            blobUrl: blobUrl, // Store the URL to the image in Blob
            createdAt: Date.now()
        };
        await redis.set(jobId, JSON.stringify(initialJobData), { ex: 86400 }); // Use redis.set with stringify
        console.log(`[Async Upload Job ${jobId}] Initial job state stored.`);

        // 3. Trigger background processing via QStash
        const imageWorkerUrl = process.env.QSTASH_IMAGE_WORKER_URL;
        if (!imageWorkerUrl) {
            console.error(`[Async Upload Job ${jobId}] CRITICAL: QSTASH_IMAGE_WORKER_URL environment variable not set.`);
            // Update Redis status to failed, but still return 202 to the user for consistency? Or return 500?
            // For now, update Redis and proceed with 202, but log critical error.
             const configFailData = {
                 status: 'failed',
                 error: 'Server configuration error preventing job start.', // More generic internal error
                 originalFilename: originalFilename,
                 createdAt: initialJobData.createdAt,
                 finishedAt: Date.now()
             };
             await redis.set(jobId, JSON.stringify(configFailData));
             console.log(`[Async Upload Job ${jobId}] Updated Redis status to failed due to missing QStash URL.`);
             // Still return 202 as the initial request *was* accepted, even if backend fails immediately
             return res.status(202).json({ jobId: jobId });
             // Alternatively, could return 500:
             // return res.status(500).json({ error: 'Server configuration error preventing job start.' });
        }

        console.log(`[Async Upload Job ${jobId}] Publishing job to QStash queue targeting: ${imageWorkerUrl}`);

        try {
            await qstashClient.publishJSON({
                url: imageWorkerUrl,
                // topic: 'process-image-jobs', // Or use a topic name if defined
                body: { jobId: jobId },
                // Optional: Set headers if needed by the worker for verification beyond signature
                // headers: { 'Content-Type': 'application/json' },
                 retries: 5, // Example: configure retries
                 delay: '1s' // Example: slight delay
            });
            console.log(`[Async Upload Job ${jobId}] Job published successfully to QStash.`);
        } catch (qstashError) {
            console.error(`[Async Upload Job ${jobId}] CRITICAL: Error publishing job to QStash:`, qstashError);
            // Update Redis status to failed if QStash publish fails critically
             const publishFailData = {
                 status: 'failed',
                 error: 'Failed to queue job for processing. Please try again.', // User-friendly message
                 originalFilename: originalFilename,
                 createdAt: initialJobData.createdAt,
                 finishedAt: Date.now()
             };
             await redis.set(jobId, JSON.stringify(publishFailData));
             console.log(`[Async Upload Job ${jobId}] Updated Redis status to failed due to QStash publish error.`);
             // Again, return 202 as the initial request was accepted, but log critical backend failure
             return res.status(202).json({ jobId: jobId });
             // Alternatively, return 500:
             // return res.status(500).json({ error: 'Failed to queue job for processing.' });
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