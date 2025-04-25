const { redis } = require('../services/redisService');
const { qstashClient } = require('../services/qstashService');
const { visionClient } = require('../services/googleVisionService'); // Import Vision client
const heicConvert = require('heic-convert'); // Import heic-convert
// Use built-in fetch for downloading from blob

async function handleProcessImageJob(req, res) {
    console.log('[Process Image Worker] Received job via QStash.');

    const { jobId } = req.body;
    if (!jobId) {
        console.error('[Process Image Worker] Missing jobId in request body.');
        return res.status(400).send('Bad Request: Missing jobId');
    }

    console.log(`[Process Image Worker Job ${jobId}] Processing job...`);
    let jobData; // For storing retrieved job data

    try {
        // 1. Retrieve job details (blobUrl) from Redis
        console.log(`[Process Image Worker Job ${jobId}] Retrieving job data from Redis...`);
        if (!redis) { throw new Error('Redis client not initialized'); }
        const jobDataStr = await redis.get(jobId);
        if (!jobDataStr) {
            console.error(`[Process Image Worker Job ${jobId}] Job data not found in Redis.`);
            return res.status(404).send('Not Found: Job data missing'); // Don't retry
        }
        jobData = JSON.parse(jobDataStr);
        const { blobUrl, originalFilename } = jobData;

        // Check if job is already processed or failed
        if (jobData.status !== 'pending') {
             console.warn(`[Process Image Worker Job ${jobId}] Job status is already '${jobData.status}'. Skipping processing.`);
             // Acknowledge QStash message, but don't proceed
             return res.status(200).json({ message: `Job already processed or failed: ${jobData.status}`});
        }
        console.log(`[Process Image Worker Job ${jobId}] Found blobUrl: ${blobUrl}`);

        // 2. Download image from Blob
        console.log(`[Process Image Worker Job ${jobId}] Downloading image from ${blobUrl}...`);
        const imageResponse = await fetch(blobUrl);
        if (!imageResponse.ok) {
            const errorText = await imageResponse.text();
            throw new Error(`Failed to download image from Blob. Status: ${imageResponse.status} ${imageResponse.statusText}. Body: ${errorText}`);
        }
        let imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        console.log(`[Process Image Worker Job ${jobId}] Image downloaded. Size: ${imageBuffer.length} bytes.`);

        // 3. Perform HEIC conversion if necessary
        const lowerFilename = (originalFilename || '').toLowerCase();
        let imageToSendToVision = imageBuffer;
        if (lowerFilename.endsWith('.heic') || lowerFilename.endsWith('.heif')) {
            console.log(`[Process Image Worker Job ${jobId}] HEIC/HEIF file detected, attempting conversion...`);
            try {
                const convertedBuffer = await heicConvert({
                    buffer: imageBuffer,
                    format: 'JPEG',
                    quality: 0.9
                });
                imageToSendToVision = convertedBuffer;
                console.log(`[Process Image Worker Job ${jobId}] Successfully converted HEIC to JPEG.`);
            } catch (conversionError) {
                console.error(`[Process Image Worker Job ${jobId}] HEIC conversion failed:`, conversionError);
                 if (conversionError.message.includes('Input buffer is not') || conversionError.message.includes('Could not find \'ftyp\' box')) {
                     console.warn(`[Process Image Worker Job ${jobId}] Not a HEIC file or known conversion issue, proceeding with original buffer.`);
                 } else {
                    throw new Error(`HEIC/HEIF conversion failed: ${conversionError.message}`); // Re-throw other errors
                }
            }
        }

        // 4. Call Google Vision API
        console.log(`[Process Image Worker Job ${jobId}] Calling Google Cloud Vision API... (Timestamp: ${Date.now()})`);
        const visionStartTime = Date.now();
        if (!visionClient) {
            console.error(`[Process Image Worker Job ${jobId}] Vision client is not initialized!`);
            throw new Error('Vision client failed to initialize.');
        }
        let extractedText = '';
        try {
            const [result] = await visionClient.textDetection({
                image: { content: imageToSendToVision },
            });
            const detections = result.textAnnotations;
            extractedText = detections && detections.length > 0 ? detections[0].description : '';
            const visionEndTime = Date.now();
            console.log(`[Process Image Worker Job ${jobId}] Vision API call finished. Duration: ${visionEndTime - visionStartTime}ms.`);
        } catch (visionError) {
            console.error(`[Process Image Worker Job ${jobId}] Google Vision API call failed:`, visionError);
            // Update Redis and re-throw to be caught by the main catch block
            const failedData = { ...jobData, status: 'failed', error: 'Could not read text from the image.', finishedAt: Date.now() };
            await redis.set(jobId, JSON.stringify(failedData)); // Update before throwing
            throw visionError;
        }
        console.log(`[Process Image Worker Job ${jobId}] Extracted text length: ${extractedText.length}.`);

        // 5. Basic Validation (Quick-Fail)
        const MIN_TEXT_LENGTH = 50;
        if (!extractedText || extractedText.trim().length < MIN_TEXT_LENGTH) {
            console.log(`[Process Image Worker Job ${jobId}] Failed validation: Extracted text too short (${extractedText?.trim().length || 0} chars).`);
            const validationFailData = {
                ...jobData,
                status: 'failed',
                error: `Image does not contain enough readable text (${MIN_TEXT_LENGTH}+ characters) to be a recipe.`,
                finishedAt: Date.now()
            };
            await redis.set(jobId, JSON.stringify(validationFailData));
            console.log(`[Process Image Worker Job ${jobId}] Updated Redis status to failed (validation).`);
            // Return 200 OK to QStash, job is considered handled (failed validation)
            return res.status(200).send('OK: Job failed validation (text too short)');
        }
        console.log(`[Process Image Worker Job ${jobId}] Text validation passed.`);

        // 6. On Vision Success: Update Redis & Trigger Next Step (Text Processing Worker) via QStash
        console.log(`[Process Image Worker Job ${jobId}] Vision successful. Updating Redis and triggering text processor...`);
        const visionCompleteData = {
            ...jobData,
            status: 'vision_completed',
            extractedText: extractedText, // Store extracted text for the next step
            visionFinishedAt: Date.now()
        };
        await redis.set(jobId, JSON.stringify(visionCompleteData));
        console.log(`[Process Image Worker Job ${jobId}] Redis status updated to vision_completed.`);

        // Trigger the next worker (/api/process-text-worker)
        const textWorkerUrl = process.env.QSTASH_TEXT_WORKER_URL;
        if (!textWorkerUrl) {
            // This is a server configuration error, should fail critically
            throw new Error('QSTASH_TEXT_WORKER_URL environment variable not set.');
        }
        if (!qstashClient) {
            throw new Error('QStash client not initialized');
        }

        console.log(`[Process Image Worker Job ${jobId}] Publishing job to QStash text worker queue targeting: ${textWorkerUrl}`);
        try {
            await qstashClient.publishJSON({
                url: textWorkerUrl,
                body: { jobId: jobId },
                retries: 3
            });
            console.log(`[Process Image Worker Job ${jobId}] Job published successfully to QStash text worker.`);
        } catch (qstashError) {
            console.error(`[Process Image Worker Job ${jobId}] CRITICAL: Error publishing job to QStash text worker:`, qstashError);
            // If trigger fails, update Redis status to reflect the failure
            const triggerFailData = {
                ...visionCompleteData, // Start with the data we *had* before trigger failure
                status: 'failed',
                error: `Processing Error: Failed to trigger the text analysis step. Reason: ${qstashError.message}`,
                finishedAt: Date.now()
            };
            await redis.set(jobId, JSON.stringify(triggerFailData)); // Update redis
            console.log(`[Process Image Worker Job ${jobId}] Updated Redis status to failed due to QStash trigger error.`);
            // Rethrow the error to be caught by the main catch block -> respond 500 to QStash
            throw qstashError;
        }

        // 7. Return 200 OK to QStash
        console.log(`[Process Image Worker Job ${jobId}] Job processed successfully, triggered next step.`);
        res.status(200).send('OK: Image processed, text analysis triggered');

    } catch (error) {
        console.error(`[Process Image Worker Job ${jobId}] Error processing job:`, error);

        // Update Redis status to 'failed' if not already done
        try {
            // Check if jobData exists and status isn't already failed
            if (redis && jobId && jobData && jobData.status !== 'failed') {
                 const errorData = {
                     ...jobData, // Preserve existing data
                     status: 'failed',
                     error: `Image processing failed unexpectedly: ${error.message}`,
                     finishedAt: Date.now()
                 };
                 await redis.set(jobId, JSON.stringify(errorData));
                 console.log(`[Process Image Worker Job ${jobId}] Updated Redis status to failed due to caught error.`);
            } else if (jobData && jobData.status === 'failed') {
                 console.log(`[Process Image Worker Job ${jobId}] Redis status already marked as failed.`);
            }
        } catch (redisError) {
            console.error(`[Process Image Worker Job ${jobId}] CRITICAL: Failed to update Redis status after processing error:`, redisError);
        }

        // Return 500 to QStash to indicate failure, allowing retries
        res.status(500).send(`Internal Server Error: ${error.message}`);
    }
}

module.exports = {
    handleProcessImageJob
}; 