// backend/controllers/uploadController.js
// ----------------------------------------------------------------------------
//  FULL "/api/upload" CONTROLLER – extracted from legacy server.js
// ----------------------------------------------------------------------------

const crypto = require('crypto');
const { put } = require('@vercel/blob');
const { redis } = require('../services/redisService');
const { Client } = require('@upstash/qstash'); // Import QStash Client

// Initialize QStash Client
const qstashClient = new Client({ token: process.env.QSTASH_TOKEN });

/**
 * Handle image upload and initiate asynchronous processing
 * Creates a job ID, stores the image in Vercel Blob, and triggers background processing
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
        const blobResult = await put(`${jobId}-${originalFilename}`, buffer, {
            access: 'public',
            token: process.env.BLOB_READ_WRITE_TOKEN
        });
        const blobUrl = blobResult.url;
        console.log(`[Async Upload Job ${jobId}] Image uploaded to: ${blobUrl}`);

        // 2. Store initial job state in Upstash Redis
        console.log(`[Async Upload Job ${jobId}] Storing initial job state in Redis...`);
        if (!redis) { throw new Error('Redis client not initialized'); }
        const initialJobData = {
            status: 'pending',
            originalFilename: originalFilename,
            blobUrl: blobUrl, // Store the URL to the image in Blob
            createdAt: Date.now()
        };
        await redis.set(jobId, JSON.stringify(initialJobData), { ex: 86400 }); // Use redis.set with stringify
        console.log(`[Async Upload Job ${jobId}] Initial job state stored.`);

        // 3. Asynchronously trigger the background processing function
        // Construct the absolute URL for the API endpoint
        // IMPORTANT: Use VERCEL_URL or similar for production, fallback for local
        const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `${req.protocol}://${req.get('host')}`;
        const processImageUrl = `${baseUrl}/api/process-image`;
        console.log(`[Async Upload Job ${jobId}] Triggering background processing at: ${processImageUrl}`);
        console.log(`[Async Upload Job ${jobId}] Trigger URL used: ${processImageUrl}`); // Log full URL for verification

        // Use QStash for triggering /api/process-image
        try {
            await qstashClient.publishJSON({
                url: processImageUrl,
                body: { jobId },
                headers: { 'Content-Type': 'application/json' },
                // Default QStash retries will apply
            });
            console.log(`Published job ${jobId} to QStash targeting ${processImageUrl}`);
        } catch (qstashError) {
            console.error(`Failed to publish job ${jobId} to QStash:`, qstashError);
            // Update Redis to failed status if QStash publish fails critically
             await redis.set(jobId, JSON.stringify({
                ...initialJobData,
                 status: 'failed',
                 error: 'Failed to initiate recipe processing via QStash.',
                 updatedAt: new Date().toISOString()
             }), 'EX', 3600);
            // Still return 202 to frontend, but job won't process
            return res.status(202).json({ jobId });
        }

        // Add log *after* dispatch attempt
        console.log(`[Async Upload Job ${jobId}] Background process fetch dispatched (fire-and-forget).`);

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