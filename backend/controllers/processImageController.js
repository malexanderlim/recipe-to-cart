const heicConvert = require('heic-convert');
const { redis } = require('../services/redisService');
const { visionClient } = require('../services/googleVisionService');
const { Client } = require("@upstash/qstash");
const { del: VercelBlobDelete } = require('@vercel/blob'); // Import del function

// Initialize QStash Client
const qstashClient = process.env.QSTASH_TOKEN ? new Client({ token: process.env.QSTASH_TOKEN }) : null;
if (!qstashClient) {
    console.warn("QSTASH_TOKEN environment variable not set. QStash functionality for triggering next step will be disabled.");
}

// Helper to update Redis status consistently, especially on failure
async function updateRedisJobStatus(jobId, jobData, status, error = null, additionalData = {}) {
    const finalData = {
        ...jobData,
        status: status,
        error: error,
        updatedAt: new Date().toISOString(),
        ...additionalData
    };
    try {
        await redis.set(jobId, JSON.stringify(finalData), { ex: 3600 }); // Use object { ex: seconds }
        console.log(`[Job ${jobId}] Updated Redis status to '${status}'${error ? ' (Error: ' + error + ')' : ''}`);
    } catch (redisError) {
        console.error(`[Job ${jobId}] CRITICAL: Failed to update Redis status to '${status}'. Error:`, redisError);
        // We probably can't recover from this, but the job might continue/fail anyway
    }
}

// Main QStash Handler Logic for Image Processing
async function processImage(req, res) {
    const { jobId } = req.body;
    if (!jobId) {
        console.error('[Process Image QStash Job ${jobId}] Received request without Job ID.');
        // QStash expects 2xx or 5xx. 4xx might prevent retries.
        // Returning 500 signals QStash to retry.
        return res.status(500).json({ error: 'Missing Job ID.' });
    }

    console.log(`[Process Image QStash Job ${jobId}] Handler invoked.`);

    let jobData = null;
    let imageUrl = null; // Keep track of imageUrl for potential cleanup

    try {
        // --- 1. Retrieve Job Details & Idempotency Check ---
        console.log(`[Process Image QStash Job ${jobId}] Fetching job details from Redis...`);
        const jobDataStrOrObj = await redis.get(jobId);
        if (!jobDataStrOrObj) {
            console.warn(`[Process Image QStash Job ${jobId}] Job data not found in Redis. Assuming expired or already processed fully. Acknowledging message.`);
            return res.status(200).json({ message: `Job data not found for ${jobId}, acknowledging.` });
        }

        // FIX: Check if redis.get returned an object or string before parsing
        if (typeof jobDataStrOrObj === 'string') {
            try {
                jobData = JSON.parse(jobDataStrOrObj);
            } catch (parseError) {
                console.error(`[Process Image QStash Job ${jobId}] Failed to parse job data string from Redis: ${jobDataStrOrObj}`, parseError);
                // Treat as fatal error for this attempt, update Redis & signal QStash to retry (or fail)
                await updateRedisJobStatus(jobId, { jobId }, 'failed', 'Invalid job data format in Redis');
                return res.status(500).json({ message: 'Invalid job data format' });
            }
        } else if (typeof jobDataStrOrObj === 'object' && jobDataStrOrObj !== null) {
            jobData = jobDataStrOrObj; // Assume it's the correct object
        } else {
            // Handle unexpected type from redis.get
            console.error(`[Process Image QStash Job ${jobId}] Unexpected data type received from Redis: ${typeof jobDataStrOrObj}`);
            await updateRedisJobStatus(jobId, { jobId }, 'failed', 'Unexpected job data format in Redis');
            return res.status(500).json({ message: 'Unexpected job data format' });
        }

        imageUrl = jobData.imageUrl; // Store for cleanup - ensure jobData is valid first
        if (!imageUrl) {
             console.error(`[Process Image QStash Job ${jobId}] Job data from Redis is missing imageUrl.`);
             await updateRedisJobStatus(jobId, jobData, 'failed', 'Job data missing image URL');
             return res.status(500).json({ message: 'Job data missing image URL' });
        }

        console.log(`[Process Image QStash Job ${jobId}] Retrieved job status: ${jobData.status}`);
        if (jobData.status !== 'pending') {
            console.warn(`[Process Image QStash Job ${jobId}] Job status is '${jobData.status}', not 'pending'. Acknowledging message.`);
            // Acknowledge QStash message (200 OK) as it's already been picked up or failed
            return res.status(200).json({ message: `Job ${jobId} already processed or in progress: ${jobData.status}` });
        }

        // Mark job as actively processing this stage
        await updateRedisJobStatus(jobId, jobData, 'processing_vision');
        // Update local jobData copy as well
        jobData.status = 'processing_vision';

        // --- 2. Download Image from Blob ---
        console.log(`[Process Image QStash Job ${jobId}] Downloading image from Blob: ${imageUrl}...`);
        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) {
            const errorText = await imageResponse.text();
            throw new Error(`Blob download failed (${imageResponse.status}): ${errorText}`);
        }
        let imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        console.log(`[Process Image QStash Job ${jobId}] Image downloaded (${imageBuffer.length} bytes).`);

        // --- 3. Convert HEIC/HEIF if needed ---
        const lowerFilename = (jobData.originalFilename || '').toLowerCase();
        let imageToSendToVision = imageBuffer;
        if (lowerFilename.endsWith('.heic') || lowerFilename.endsWith('.heif')) {
            console.log(`[Process Image QStash Job ${jobId}] HEIC/HEIF detected, converting...`);
            try {
                const convertedBuffer = await heicConvert({ buffer: imageBuffer, format: 'JPEG', quality: 0.9 });
                imageToSendToVision = convertedBuffer;
                console.log(`[Process Image QStash Job ${jobId}] Converted HEIC to JPEG.`);
            } catch (conversionError) {
                if (conversionError.message.includes('Input buffer is not') || conversionError.message.includes('Could not find \'ftyp\' box')) {
                     console.warn(`[Process Image QStash Job ${jobId}] Not a HEIC/HEIF, proceeding with original.`);
                } else {
                    throw new Error(`HEIC conversion failed: ${conversionError.message}`); // Let general catch handle Redis update
                }
            }
        }

        // --- 4. Google Cloud Vision API Call ---
        console.log(`[Process Image QStash Job ${jobId}] Calling Google Vision API...`);
        if (!visionClient) throw new Error('Vision client not initialized');
        let extractedText = '';
        try {
            const [result] = await visionClient.textDetection({ image: { content: imageToSendToVision } });
            const detections = result.textAnnotations;
            extractedText = detections && detections.length > 0 ? detections[0].description : '';
            console.log(`[Process Image QStash Job ${jobId}] Vision API success. Text length: ${extractedText.length}.`);
        } catch (visionError) {
            // Throw specific error for outer catch block to handle Redis status
            throw new Error(`Vision API call failed: ${visionError.message || 'Unknown Vision error'}`);
        }

        // --- 5. Quick Fail Check ---
        if (!extractedText || extractedText.trim().length < 50) {
            console.warn(`[Process Image QStash Job ${jobId}] Quick Fail: Text empty or too short.`);
            await updateRedisJobStatus(jobId, jobData, 'failed', 'Image does not contain enough readable text.');
            // Attempt Blob cleanup on quick fail
            if (imageUrl && process.env.BLOB_READ_WRITE_TOKEN) {
                 await VercelBlobDelete(imageUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });
                 console.log(`[Process Image QStash Job ${jobId}] Blob deleted due to quick fail.`);
            }
            return res.status(200).json({ message: `Job ${jobId} failed: Not enough text.` }); // Acknowledge QStash
        }

        // --- 6. Trigger Next Step via QStash ---  // PORTED LOGIC
        console.log(`[Process Image QStash Job ${jobId}] Vision success. Updating Redis & triggering next step.`);
        const visionCompletedData = { extractedText: extractedText, visionFinishedAt: new Date().toISOString() };

        if (!qstashClient) {
            throw new Error('QStash client not initialized. Cannot trigger next step.');
        }

        // FIX: Construct base URL correctly, adding protocol for VERCEL_URL
        let baseUrl;
        if (process.env.APP_BASE_URL) {
            baseUrl = process.env.APP_BASE_URL; // Use local tunnel URL if provided
        } else if (process.env.VERCEL_URL) {
            baseUrl = `https://${process.env.VERCEL_URL}`; // Add https:// for Vercel deployments
        } else {
            // Throw a configuration error if neither is set
            console.error("[Process Image QStash Job ${jobId}] CRITICAL: Cannot determine base URL. APP_BASE_URL and VERCEL_URL are missing.");
            throw new Error('Server configuration error: Base URL not set.');
        }

        const targetWorkerUrl = `${baseUrl}/api/process-text-worker`;
        
        // This check should now pass, but remains as a safeguard
        if (!targetWorkerUrl.startsWith('http')) {
            throw new Error(`Invalid QStash target URL constructed: ${targetWorkerUrl}`);
        }

        try {
            console.log(`[Process Image QStash Job ${jobId}] Publishing job to QStash URL: ${targetWorkerUrl}`);
            await qstashClient.publishJSON({
                url: targetWorkerUrl,
                body: { jobId: jobId },
            });
            console.log(`[Process Image QStash Job ${jobId}] Successfully published job to QStash for text worker.`);

            // Attempt Blob cleanup after successful processing and QStash publish
            if (imageUrl && process.env.BLOB_READ_WRITE_TOKEN) {
                try {
                    console.log(`[Process Image QStash Job ${jobId}] Attempting Blob cleanup after successful processing...`);
                    await VercelBlobDelete(imageUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });
                    console.log(`[Process Image QStash Job ${jobId}] Blob deleted successfully after processing.`);
                } catch (blobDeleteError) {
                    console.error(`[Process Image QStash Job ${jobId}] Failed to delete Blob after successful processing (continuing job):`, blobDeleteError);
                    // Log error but do not let this failure prevent the job from being marked as vision_completed
                }
            }

            // --- 7. Final Redis Update on Success ---
            // Only update to 'vision_completed' AFTER successfully publishing the next job
            await updateRedisJobStatus(jobId, jobData, 'vision_completed', null, visionCompletedData);
            return res.status(200).json({ message: 'Vision processing completed, analysis step triggered.' });

        } catch (qstashError) {
            // Throw specific error for outer catch block to handle Redis status
            throw new Error(`QStash publish failed: ${qstashError.message || 'Unknown QStash error'}`);
        }

    } catch (error) {
        console.error(`[Process Image QStash Job ${jobId}] Error during processing:`, error);
        // --- 8. Centralized Failure Handling ---
        // Update Redis status to 'failed' with the specific error message
        await updateRedisJobStatus(jobId, jobData || { jobId }, 'failed', error.message || 'An unexpected error occurred.');

        // Attempt to clean up Blob on failure
        if (imageUrl && process.env.BLOB_READ_WRITE_TOKEN) {
            try {
                console.log(`[Process Image QStash Job ${jobId}] Attempting Blob cleanup due to failure...`);
                await VercelBlobDelete(imageUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });
                console.log(`[Process Image QStash Job ${jobId}] Blob deleted successfully.`);
            } catch (blobDeleteError) {
                console.error(`[Process Image QStash Job ${jobId}] Failed to delete Blob after error:`, blobDeleteError);
            }
        }

        // Signal QStash to retry based on error type (optional - for now, signal retry for most)
        // Consider returning 200 for non-retryable errors if needed later.
        if (!res.headersSent) {
            // Return 500 to indicate failure and potentially trigger QStash retries
            res.status(500).json({ message: `Processing failed for Job ID ${jobId}: ${error.message}` });
        }
    }
}

module.exports = {
    processImage // Export the new handler name
}; 