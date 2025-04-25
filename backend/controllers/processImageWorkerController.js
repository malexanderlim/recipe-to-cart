const { Receiver } = require("@upstash/qstash");
const { redis } = require("../services/redisService");
const { visionClient } = require('../services/googleVisionService');
const { Client: QStashClient } = require("@upstash/qstash"); // Renamed for clarity
const heicConvert = require('heic-convert');
const { del: deleteBlob } = require('@vercel/blob'); // For deleting blob on final failure

// --- Initialize QStash Receiver ---
const qstashReceiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
});

// --- Initialize QStash Client (for publishing to the *next* worker) ---
if (!process.env.QSTASH_TOKEN) {
    console.warn("QSTASH_TOKEN environment variable not set. QStash publishing will be disabled.");
}
const qstashPublisher = process.env.QSTASH_TOKEN ? new QStashClient({ token: process.env.QSTASH_TOKEN }) : null;

// Define the target QStash URL for the *text* processing worker
const TEXT_WORKER_QSTASH_TARGET_URL = process.env.QSTASH_TEXT_WORKER_URL; // Needs to be defined!
if (!TEXT_WORKER_QSTASH_TARGET_URL && qstashPublisher) {
    console.warn("QSTASH_TEXT_WORKER_URL environment variable not set. Cannot publish to text worker.");
}

// Helper to update Redis status, simplifying error handling
async function updateRedisStatus(jobId, status, data = {}) {
    try {
        const currentData = await redis.get(jobId) || {};
        const updatedData = { ...currentData, status, ...data, lastUpdatedAt: Date.now() };
        if (status === 'failed' || status === 'completed') {
            updatedData.finishedAt = Date.now();
        }
        await redis.set(jobId, JSON.stringify(updatedData));
        console.log(`[Worker - Image Job ${jobId}] Updated Redis status to '${status}'`);
    } catch (redisError) {
        console.error(`[Worker - Image Job ${jobId}] Failed to update Redis status to '${status}':`, redisError);
    }
}

const processImageWorker = async (req, res) => {
    // --- QStash Verification --- (Moved inline for now, consider middleware)
    let jobId;
    try {
        const signature = req.headers["upstash-signature"];
        // IMPORTANT: Pass the raw body string if possible, or re-stringify
        // Vercel might automatically parse JSON, adjust if needed based on platform behavior
        const rawBody = req.body; // Assuming Vercel provides parsed body
        const isValid = await qstashReceiver.verify({ signature, body: JSON.stringify(rawBody) });

        if (!isValid) {
            console.error("[Worker - Image] QStash signature verification failed");
            return res.status(401).send("Unauthorized");
        }
        console.log("[Worker - Image] QStash signature verified.");

        jobId = rawBody.jobId;
        if (!jobId) {
            console.error("[Worker - Image] Missing jobId in request body");
            return res.status(400).send("Missing jobId");
        }
        console.log(`[Worker - Image Job ${jobId}] Processing...`);

    } catch (verifyError) {
         console.error("[Worker - Image] Error during QStash verification:", verifyError);
         return res.status(500).send("Verification Error");
    }
    // --- End QStash Verification ---

    let jobData;
    try {
        // --- 1. Retrieve Job Data from Redis ---
        jobData = await redis.get(jobId);
        if (!jobData || !jobData.blobUrl) {
            console.error(`[Worker - Image Job ${jobId}] Job data not found or invalid blobUrl in Redis.`);
            // Don't update status here, as the job might have been processed by another instance
            return res.status(200).send("Job data not found or invalid, perhaps already processed."); // Acknowledge QStash
        }
        const { blobUrl, originalFilename, status: currentStatus } = jobData;
        console.log(`[Worker - Image Job ${jobId}] Retrieved job data. Current status: ${currentStatus}`);

        // Prevent reprocessing if status is not 'pending'
        if (currentStatus !== 'pending') {
            console.warn(`[Worker - Image Job ${jobId}] Job status is '${currentStatus}', not 'pending'. Skipping.`);
            return res.status(200).send(`Job already processed or failed: ${currentStatus}`); // Acknowledge QStash
        }

        // --- 2. Download Image from Blob ---
        console.log(`[Worker - Image Job ${jobId}] Downloading image from: ${blobUrl}`);
        const imageResponse = await fetch(blobUrl);
        if (!imageResponse.ok) {
            const errorText = await imageResponse.text();
            throw new Error(`Failed to download image from Blob. Status: ${imageResponse.status} ${imageResponse.statusText}. Body: ${errorText}`);
        }
        let imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        console.log(`[Worker - Image Job ${jobId}] Image downloaded. Size: ${imageBuffer.length} bytes.`);

        // --- 3. Convert HEIC/HEIF if needed ---
        const lowerFilename = (originalFilename || '').toLowerCase();
        let imageToSendToVision = imageBuffer;
        if (lowerFilename.endsWith('.heic') || lowerFilename.endsWith('.heif')) {
            console.log(`[Worker - Image Job ${jobId}] HEIC/HEIF detected, attempting conversion...`);
            try {
                const convertedBuffer = await heicConvert({ buffer: imageBuffer, format: 'JPEG', quality: 0.9 });
                imageToSendToVision = convertedBuffer;
                console.log(`[Worker - Image Job ${jobId}] Successfully converted HEIC to JPEG.`);
            } catch (conversionError) {
                console.warn(`[Worker - Image Job ${jobId}] HEIC conversion failed: ${conversionError.message}. Proceeding with original buffer.`);
                // Only throw if it's an unexpected error, otherwise use original buffer
                if (!conversionError.message.includes('Input buffer is not') && !conversionError.message.includes('Could not find \'ftyp\' box')) {
                     throw new Error(`Unexpected HEIC/HEIF conversion error: ${conversionError.message}`);
                }
            }
        }

        // --- 4. Call Google Vision API ---
        console.log(`[Worker - Image Job ${jobId}] Calling Google Cloud Vision API...`);
        const visionStartTime = Date.now();
        if (!visionClient) {
           throw new Error('Vision client failed to initialize. Cannot call Vision API.');
        }
        const [result] = await visionClient.textDetection({ image: { content: imageToSendToVision } });
        const detections = result.textAnnotations;
        const extractedText = detections && detections.length > 0 ? detections[0].description : '';
        const visionEndTime = Date.now();
        const visionDuration = visionEndTime - visionStartTime;
        console.log(`[Worker - Image Job ${jobId}] Vision API successful. Length: ${extractedText.length}. Duration: ${visionDuration}ms.`);

        // --- 5. Quick Fail Check ---
        if (!extractedText || extractedText.trim().length < 50) {
            console.warn(`[Worker - Image Job ${jobId}] Quick Fail: Extracted text empty or too short (${extractedText?.length || 0} chars).`);
            await updateRedisStatus(jobId, 'failed', { error: 'Image does not contain enough readable text to be a recipe.' });
            // Optionally delete the blob here if it's definitely not useful
            // await deleteBlob(blobUrl);
            return res.status(200).send(`Job ${jobId} failed: Not enough readable text.`); // Acknowledge QStash
        }

        // --- 6. Update Redis Status & Trigger Next Step via QStash ---
        console.log(`[Worker - Image Job ${jobId}] Vision successful. Updating Redis status to 'vision_completed'.`);
        // Store extracted text directly or reference? Storing directly for now, watch size limits.
        await updateRedisStatus(jobId, 'vision_completed', { extractedText: extractedText, visionFinishedAt: visionEndTime });

        if (!qstashPublisher) {
            throw new Error("QStash publisher client not initialized. Cannot trigger text processing job.");
        }
        // --- Dynamically construct the target URL for the TEXT worker ---
        let textWorkerTargetUrl;
        if (process.env.VERCEL_URL) {
            textWorkerTargetUrl = `https://${process.env.VERCEL_URL}/api/process-text-worker`;
        } else if (process.env.NODE_ENV !== 'production') {
            // For local dev, assume it runs on the same origin (needs req context or fixed localhost URL)
            // Since we don't have access to `req` here, we might need a different strategy for local dev
            // Option 1: Use a fixed localhost URL (less flexible)
            // Option 2: Pass the base URL from the initial request through Redis (more complex)
            // Option 3: Require a specific ENV VAR for local text worker URL
            // Using fixed localhost for simplicity FOR NOW, but this is fragile:
             const localPort = process.env.PORT || 3001;
             textWorkerTargetUrl = `http://localhost:${localPort}/api/process-text-worker`;
             console.warn(`[Worker - Image Job ${jobId}] Local Dev: Using fixed target URL for text worker: ${textWorkerTargetUrl}`);
        } else {
             throw new Error("VERCEL_URL is not set in production. Cannot determine QStash target URL for text worker.");
        }
        // --- End Dynamic URL Construction ---
        console.log(`[Worker - Image Job ${jobId}] Publishing job for text worker to QStash target: ${textWorkerTargetUrl}`);
        const publishResponse = await qstashPublisher.publishJSON({
            url: textWorkerTargetUrl, // Use dynamically constructed URL
            body: { jobId: jobId }, 
        });
        console.log(`[Worker - Image Job ${jobId}] QStash publish response for text worker: ${publishResponse.messageId}`);

        // --- 7. Success Response to QStash ---
        console.log(`[Worker - Image Job ${jobId}] Successfully processed and triggered next step.`);
        res.status(200).send("Vision processing complete, next step triggered.");

    } catch (error) {
        console.error(`[Worker - Image Job ${jobId}] CRITICAL ERROR processing job:`, error);
        // Attempt to update KV status to failed, including the original blobUrl for potential cleanup
        if (jobId) { // Ensure jobId is available
            await updateRedisStatus(jobId, 'failed', { 
                error: error.message || 'Image worker failed unexpectedly.',
                blobUrl: jobData?.blobUrl // Include blobUrl if available
            });
            // Consider deleting the blob if the worker fails critically
            // if (jobData?.blobUrl) { try { await deleteBlob(jobData.blobUrl); } catch(e){ console.error('Failed blob cleanup', e); } }
        }
        // Return 500, QStash will retry based on its policy
        res.status(500).send("Internal Server Error during image processing");
    }
};

module.exports = {
    processImageWorker,
}; 