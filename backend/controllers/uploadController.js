// backend/controllers/uploadController.js
// ----------------------------------------------------------------------------
//  FULL "/api/upload" CONTROLLER – Refactored to use QStash for triggering worker
// ----------------------------------------------------------------------------

const crypto = require('crypto');
const { put, del } = require('@vercel/blob'); // Added del for potential cleanup
const { redis } = require('../services/redisService');
const { Client } = require("@upstash/qstash"); // Import QStash Client

// --- Initialize QStash Client ---
if (!process.env.QSTASH_TOKEN) {
    console.warn("QSTASH_TOKEN environment variable not set. QStash publishing will be disabled.");
}
const qstashClient = process.env.QSTASH_TOKEN ? new Client({ token: process.env.QSTASH_TOKEN }) : null;

/**
 * Handle image upload and initiate asynchronous processing via QStash
 * Creates a job ID, stores the image in Vercel Blob, and publishes a job to QStash
 */
async function handleUpload(req, res) {
    console.log(`[QStash Upload] Received ${req.files?.length || 0} files.`);
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded.' });
    }

    // --- Process only the first file for simplicity ---
    const file = req.files[0];
    const originalFilename = file.originalname;
    const buffer = file.buffer;

    console.log(`[QStash Upload] Processing file: ${originalFilename}, size: ${file.size} bytes`);

    const jobId = crypto.randomUUID();
    console.log(`[QStash Upload Job ${jobId}] Generated Job ID: ${jobId}`);

    let blobResult = null; // Define blobResult outside try block for cleanup access
    let redisKeySet = false;

    try {
        // 1. Upload image buffer to Vercel Blob
        console.log(`[QStash Upload Job ${jobId}] Uploading image to Vercel Blob...`);
        blobResult = await put(originalFilename, buffer, {
            access: 'public',
            addRandomSuffix: true
        });
        const blobUrl = blobResult.url;
        console.log(`[QStash Upload Job ${jobId}] Image uploaded to: ${blobUrl}`);

        // 2. Store initial job state in Upstash Redis
        console.log(`[QStash Upload Job ${jobId}] Storing initial job state in Redis...`);
        if (!redis) { throw new Error('Redis client not initialized'); }
        const initialJobData = {
            status: 'pending',
            originalFilename: originalFilename,
            blobUrl: blobUrl, // Store the URL to the image in Blob
            createdAt: Date.now()
        };
        await redis.set(jobId, JSON.stringify(initialJobData), { ex: 86400 });
        redisKeySet = true;
        console.log(`[QStash Upload Job ${jobId}] Initial job state stored.`);

        // 3. Publish job to QStash to trigger the background processing worker
        if (!qstashClient) {
            throw new Error("QStash client not initialized. Cannot trigger background job.");
        }
        
        // --- Dynamically Construct Target URL --- 
        let targetWorkerUrl;
        const isVercel = process.env.VERCEL === '1';
        const workerPath = '/api/process-image-worker';
        if (isVercel && process.env.VERCEL_URL) {
            targetWorkerUrl = `https://${process.env.VERCEL_URL}${workerPath}`;
        } else if (!isVercel) {
            // Construct URL from request headers for local development
            const host = req.get('host');
            const protocol = req.protocol;
            if (host && protocol) {
                 targetWorkerUrl = `${protocol}://${host}${workerPath}`;
            } else {
                 throw new Error("Could not determine host/protocol for local worker URL.");
            }
        } else { // Vercel environment but VERCEL_URL is missing (shouldn't happen)
            throw new Error("VERCEL_URL environment variable is missing in Vercel environment.");
        }
        // -----------------------------------------

        console.log(`[QStash Upload Job ${jobId}] Publishing job to QStash target: ${targetWorkerUrl}`);
        const publishResponse = await qstashClient.publishJSON({
            url: targetWorkerUrl, // Use dynamically constructed URL
            body: { jobId: jobId },
        });

        console.log(`[QStash Upload Job ${jobId}] QStash publish response: ${publishResponse.messageId}`);

        // 4. Return 202 Accepted with the Job ID
        res.status(202).json({ jobId: jobId });
        console.log(`[QStash Upload Job ${jobId}] Sent 202 Accepted to client.`);

    } catch (error) {
        console.error(`[QStash Upload Job ${jobId}] Error during initial upload/setup/publish:`, error);

        // Enhanced Cleanup Logic
        if (redisKeySet) {
            try {
                // If QStash publish failed AFTER setting Redis, update status to failed
                await redis.set(jobId, JSON.stringify({ 
                    status: 'failed', 
                    error: 'Failed to schedule background processing. Please try again.', // User-friendly
                    originalFilename: originalFilename, 
                    createdAt: Date.now() // Or use initialJobData.createdAt if available
                }));
                console.log(`[QStash Upload Job ${jobId}] Updated Redis to failed due to setup/publish error.`);
            } catch (redisSetError) {
                console.error(`[QStash Upload Job ${jobId}] Failed to update Redis status to failed on error:`, redisSetError);
                // Fallback to trying to delete if update fails
                try { await redis.del(jobId); } catch (redisDelError) { /* Ignore */ }
            }
        } else {
            // If Redis key wasn't even set, no need to update/delete
        }

        // Attempt Blob cleanup if blob was created
        if (blobResult?.url) {
            try {
                await del(blobResult.url);
                console.log(`[QStash Upload Job ${jobId}] Cleaned up Blob: ${blobResult.url}`);
            } catch (blobDelError) {
                console.error(`[QStash Upload Job ${jobId}] Failed to clean up Blob on error: ${blobDelError.message}`);
            }
        }

        res.status(500).json({ error: 'Failed to initiate image processing.', details: error.message });
    }
}

module.exports = {
    handleUpload
}; 