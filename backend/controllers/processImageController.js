const heicConvert = require('heic-convert');
const { redis } = require('../services/redisService');
const { visionClient } = require('../services/googleVisionService');
// Note: 'fetch' is globally available in recent Node versions, or use 'node-fetch' if needed.

async function handleProcessImage(req, res) {
    console.log(`[Process Image Handler] ===== FUNCTION HANDLER ENTERED =====`); // Log immediately
    console.log(`[Process Image Handler] ===== INVOKED =====`); // Restore original log
    const receivedTriggerSecret = req.headers['x-internal-trigger-secret']; // Restore variable

    // Basic security check (optional but recommended)
    console.log(`[Process Image Handler] Received Trigger Secret (masked): ...${receivedTriggerSecret ? receivedTriggerSecret.slice(-4) : 'MISSING'}`);

    if (receivedTriggerSecret !== (process.env.INTERNAL_TRIGGER_SECRET || 'default-secret')) { // Compare received vs expected
        console.warn('[Process Image] Received request with invalid or missing trigger secret.');
        return res.status(403).json({ error: 'Forbidden' });
    }

    const { jobId } = req.body;
    if (!jobId) {
        console.error('[Process Image] Received request without Job ID.');
        return res.status(400).json({ error: 'Missing Job ID.' });
    }

    console.log(`[Process Image Job ${jobId}] Starting background processing...`);

    let jobData; // Defined here to be accessible in the final catch block
    try {
        // --- Retrieve Job Details from Redis ---
        console.log(`[Process Image Job ${jobId}] Fetching job details from Redis...`);
        if (!redis) { throw new Error('Redis client not initialized'); }
        jobData = await redis.get(jobId); // Assign directly, no parsing needed
        if (!jobData) { // Check the object directly
            console.warn(`[Process Image Job ${jobId}] Job data not found in Redis. Aborting.`);
            return res.status(200).json({ message: `Job data not found for ${jobId}, likely expired or invalid.` });
        }
        console.log(`[Process Image Job ${jobId}] Retrieved job data status: ${jobData.status}`);
        // -------------------------------------

        if (jobData.status !== 'pending') {
             console.warn(`[Process Image Job ${jobId}] Job status is already '${jobData.status}'. Skipping processing.`);
             return res.status(200).json({ message: `Job already processed or failed: ${jobData.status}`});
        }
        const { blobUrl, originalFilename } = jobData;
        console.log(`[Process Image Job ${jobId}] Retrieved blobUrl: ${blobUrl}`);
        // ------------------------------------

        // --- Download Image from Blob ---
        console.log(`[Process Image Job ${jobId}] Downloading image from Blob...`);
        const imageResponse = await fetch(blobUrl);
        if (!imageResponse.ok) {
            const errorText = await imageResponse.text();
            throw new Error(`Failed to download image from Blob. Status: ${imageResponse.status} ${imageResponse.statusText}. Body: ${errorText}`);
        }
        let imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        console.log(`[Process Image Job ${jobId}] Image downloaded. Size: ${imageBuffer.length} bytes.`);
        // --------------------------------

        // --- HEIC Conversion ---
        const isHeic = originalFilename && (originalFilename.toLowerCase().endsWith('.heic') || originalFilename.toLowerCase().endsWith('.heif'));
        if (isHeic) {
            console.log(`[Process Image Job ${jobId}] HEIC/HEIF file detected, attempting conversion...`);
            try {
                imageBuffer = await heicConvert({
                    buffer: imageBuffer,
                    format: 'JPEG',
                    quality: 0.8
                });
                 console.log(`[Process Image Job ${jobId}] Successfully converted HEIC to JPEG.`);
            } catch (convertError) {
                 console.error(`[Process Image Job ${jobId}] HEIC conversion failed:`, convertError);
                 const failedData = { ...jobData, status: 'failed', error: 'Image conversion failed. Please try a standard JPEG or PNG.', finishedAt: Date.now() };
                 await redis.set(jobId, JSON.stringify(failedData)); // Use redis.set
                 throw convertError; // Propagate error to main catch block
            }
        }
        // ----------------------------------------------

        // --- Google Cloud Vision API Call ---
        console.log(`[Process Image Job ${jobId}] Calling Google Cloud Vision API... (Timestamp: ${Date.now()})`);
        const visionStartTime = Date.now(); // Start timer
        if (!visionClient) {
           console.error(`[Process Image Job ${jobId}] Vision client is not initialized!`);
           throw new Error('Vision client failed to initialize. Cannot call Vision API.');
        }
        let extractedText = '';
        try {
            const [result] = await visionClient.textDetection({
                image: { content: imageBuffer },
            });
            const detections = result.textAnnotations;
            extractedText = detections && detections.length > 0 ? detections[0].description : '';
            const visionEndTime = Date.now(); // End timer
            const visionDuration = visionEndTime - visionStartTime;
            console.log(`[Process Image Job ${jobId}] Successfully extracted text from Vision API. Length: ${extractedText.length}. Duration: ${visionDuration}ms. (Timestamp: ${Date.now()})`);
        } catch (visionError) {
             console.error(`[Process Image Job ${jobId}] Google Vision API call failed:`, visionError);
             const failedData = { ...jobData, status: 'failed', error: 'Could not read text from the image.', finishedAt: Date.now() };
             await redis.set(jobId, JSON.stringify(failedData)); // Use redis.set
             throw visionError;
        }
        // ---------------------------------------------------------

        if (extractedText && extractedText.trim().length > 0) {
            // --- Update Redis with Intermediate Status and Trigger Next Step ---
            console.log(`[Process Image Job ${jobId}] Vision processing successful. Updating Redis status to 'vision_completed'.`);
            const visionCompletedData = {
                ...jobData,
                status: 'vision_completed',
                extractedText: extractedText, // Store extracted text for the next step
                visionFinishedAt: Date.now() // Mark vision completion time
            };

            await redis.set(jobId, JSON.stringify(visionCompletedData));
            console.log(`[Process Image Job ${jobId}] Redis updated successfully. Triggering /api/process-text.`);

            // Asynchronously trigger the next processing function (/api/process-text)
            const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `${req.protocol}://${req.get('host')}`;
            const processTextUrl = `${baseUrl}/api/process-text`;
            const triggerSecretToSend = process.env.INTERNAL_TRIGGER_SECRET || 'default-secret';
            fetch(processTextUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Internal-Trigger-Secret': triggerSecretToSend
                },
                body: JSON.stringify({ jobId: jobId })
            }).catch(async (fetchTriggerError) => {
                console.error(`[Process Image Job ${jobId}] CRITICAL: fetch() call to /api/process-text failed. Error:`, fetchTriggerError);
                const triggerFailData = {
                    ...visionCompletedData,
                    status: 'failed',
                    error: 'Processing Error: Failed to start the final analysis step.',
                    finishedAt: Date.now()
                };
                try {
                    console.log(`[Process Image Job ${jobId}] Attempting to update Redis to 'failed' due to trigger error...`);
                    await redis.set(jobId, JSON.stringify(triggerFailData));
                    console.log(`[Process Image Job ${jobId}] Successfully updated Redis status to 'failed' after trigger error.`);
                } catch (redisSetError) {
                     console.error(`[Process Image Job ${jobId}] CRITICAL: Failed to update Redis status to 'failed' AFTER the /api/process-text trigger failed! Error:`, redisSetError);
                }
            });

            res.status(200).json({ message: 'Processing completed successfully.' });
            return; // Exit successfully
        } else {
            console.log(`[Process Image Job ${jobId}] No text extracted by Vision API.`);
            // Update Redis to completed with empty result and exit
            const completedData = {
                ...jobData,
                status: 'completed',
                result: { extractedText: '', title: null, yield: null, ingredients: [] }, // Empty result
                finishedAt: Date.now()
            };
            await redis.set(jobId, JSON.stringify(completedData));
            console.log(`[Process Image Job ${jobId}] Redis updated to 'completed' (no text extracted).`);
            res.status(200).json({ message: 'Processing completed (no text extracted).' });
            return; // Exit successfully
        }

    } catch (error) {
        console.error(`[Process Image Job ${jobId}] Error during background processing:`, error);
        // Ensure Redis is updated to 'failed' if not already done in specific catch blocks
        // Use the jobData retrieved at the start of the try block
        if (jobData && jobData.status !== 'failed') { // Avoid overwriting specific error messages
            try {
                 // Use the already retrieved jobData object
                 const updatePayload = {
                     ...jobData,
                     status: 'failed',
                     error: error.message || 'An error occurred while processing the image.', // Use specific error message if available
                     finishedAt: Date.now()
                 };
                 await redis.set(jobId, JSON.stringify(updatePayload)); // Use redis.set
                 console.log(`[Process Image Job ${jobId}] Updated Redis status to 'failed' due to processing error.`);
             } catch (redisError) {
                 console.error(`[Process Image Job ${jobId}] CRITICAL: Failed to update Redis status to 'failed' after error:`, redisError);
             }
        }
         // Respond with 200 OK even on errors, as the status is updated in Redis.
         if (!res.headersSent) {
             res.status(200).json({ message: `Processing failed for Job ID ${jobId}, status updated in Redis.` });
         }
    }
}

module.exports = {
    handleProcessImage
}; 