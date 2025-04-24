const heicConvert = require('heic-convert');
const { redis } = require('../services/redisService');
const { visionClient } = require('../services/googleVisionService');
const { Client } = require("@upstash/qstash"); // Import QStash Client

// Initialize QStash Client
const qstashClient = process.env.QSTASH_TOKEN ? new Client({ token: process.env.QSTASH_TOKEN }) : null;
if (!qstashClient) {
    console.warn("QSTASH_TOKEN environment variable not set. QStash functionality will be disabled.");
}

// Helper function for retrying fetch
// Removed fetchWithRetry function as it's replaced by QStash

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

        // --- Convert HEIC/HEIF if needed (Inline Logic) ---
        const lowerFilename = (originalFilename || '').toLowerCase();
        let imageToSendToVision = imageBuffer; // Start with original buffer
        if (lowerFilename.endsWith('.heic') || lowerFilename.endsWith('.heif')) {
            console.log(`[Process Image Job ${jobId}] HEIC/HEIF file detected, attempting conversion...`);
            try {
                // Use heicConvert directly
                const convertedBuffer = await heicConvert({
                    buffer: imageBuffer, 
                    format: 'JPEG', 
                    quality: 0.9 
                });
                imageToSendToVision = convertedBuffer; // Use converted buffer if successful
                console.log(`[Process Image Job ${jobId}] Successfully converted HEIC to JPEG.`);
            } catch (conversionError) {
                console.error(`[Process Image Job ${jobId}] HEIC conversion failed:`, conversionError);
                // If conversion fails (e.g., not a HEIC), maybe still try Vision with original?
                // For now, let's fail the job as before if conversion throws unexpected error
                if (conversionError.message.includes('Input buffer is not') || conversionError.message.includes('Could not find \'ftyp\' box')) {
                     console.warn(`[Process Image Job ${jobId}] Not a HEIC file or known conversion issue, proceeding with original buffer.`);
                     // imageToSendToVision remains the original imageBuffer
                } else {
                    // Re-throw other unexpected conversion errors
                    throw new Error(`HEIC/HEIF conversion failed: ${conversionError.message}`);
                }
            }
        }
        // -------------------------------------

        // --- Google Cloud Vision API Call (Inline Logic) ---
        console.log(`[Process Image Job ${jobId}] Calling Google Cloud Vision API... (Timestamp: ${Date.now()})`);
        const visionStartTime = Date.now();
        if (!visionClient) {
           console.error(`[Process Image Job ${jobId}] Vision client is not initialized!`);
           throw new Error('Vision client failed to initialize. Cannot call Vision API.');
        }
        let extractedText = '';
        try {
            // Use visionClient directly
            const [result] = await visionClient.textDetection({
                image: { content: imageToSendToVision }, // Use potentially converted buffer
            });
            const detections = result.textAnnotations;
            extractedText = detections && detections.length > 0 ? detections[0].description : '';
            const visionEndTime = Date.now();
            const visionDuration = visionEndTime - visionStartTime;
            console.log(`[Process Image Job ${jobId}] Successfully extracted text from Vision API. Length: ${extractedText.length}. Duration: ${visionDuration}ms. (Timestamp: ${visionEndTime})`); // Use visionEndTime
        } catch (visionError) {
             console.error(`[Process Image Job ${jobId}] Google Vision API call failed:`, visionError);
             const failedData = { ...jobData, status: 'failed', error: 'Could not read text from the image.', finishedAt: Date.now() };
             await redis.set(jobId, JSON.stringify(failedData));
             throw visionError; // Re-throw to be caught by outer catch
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
            console.log(`[Process Image Job ${jobId}] Redis updated successfully. Triggering next step via QStash.`);

            // --- Trigger the next processing step via QStash ---
            const qstashUrl = process.env.QSTASH_URL;

            if (qstashClient && qstashUrl) {
                 try {
                     console.log(`[Process Image Job ${jobId}] Publishing job to QStash URL: ${qstashUrl}`);
                     const publishResponse = await qstashClient.publishJSON({
                         url: qstashUrl,
                         body: { jobId: jobId },
                         // Optional: Add headers if needed by the worker, e.g., for a secret
                         // headers: { 'X-Internal-Trigger-Secret': process.env.INTERNAL_TRIGGER_SECRET || 'default-secret' }
                     });
                     console.log(`[Process Image Job ${jobId}] Successfully published job to QStash. Message ID: ${publishResponse.messageId}`);
                 } catch (qstashError) {
                     console.error(`[Process Image Job ${jobId}] CRITICAL: Failed to publish job to QStash. Error:`, qstashError);
                     // Update Redis status to 'failed' as the trigger failed
                     const triggerFailData = {
                         ...visionCompletedData, // Use the data we just stored
                         status: 'failed',
                         error: 'Processing Error: Failed to trigger the analysis step via QStash.',
                         finishedAt: Date.now()
                     };
                     try {
                         console.log(`[Process Image Job ${jobId}] Attempting to update Redis to 'failed' due to QStash publish error...`);
                         await redis.set(jobId, JSON.stringify(triggerFailData));
                         console.log(`[Process Image Job ${jobId}] Successfully updated Redis status to 'failed' after QStash error.`);
                     } catch (redisSetError) {
                          console.error(`[Process Image Job ${jobId}] CRITICAL: Failed to update Redis status to 'failed' AFTER QStash publish failed! Error:`, redisSetError);
                     }
                     // Respond 200 but log the internal error (job state handled in Redis)
                     return res.status(200).json({ message: `Processing failed for Job ID ${jobId} due to trigger issue, status updated.` });
                 }
            } else {
                 console.error(`[Process Image Job ${jobId}] CRITICAL: QStash client not initialized or QSTASH_URL not set. Cannot trigger next step.`);
                 // Update Redis status to 'failed' as we cannot proceed
                 const configFailData = {
                     ...visionCompletedData,
                     status: 'failed',
                     error: 'Processing Error: QStash configuration missing, cannot trigger analysis.',
                     finishedAt: Date.now()
                 };
                 // Similar error handling as above for Redis update failure
                 try {
                     await redis.set(jobId, JSON.stringify(configFailData));
                 } catch (redisSetError) {
                     console.error(`[Process Image Job ${jobId}] CRITICAL: Failed to update Redis status to 'failed' AFTER QStash config error! Error:`, redisSetError);
                 }
                 return res.status(200).json({ message: `Processing failed for Job ID ${jobId} due to configuration issue.` });
            }
            // --- End QStash Trigger ---

            // If publish was successful (or if QStash is disabled but we didn't hard-fail)
            res.status(200).json({ message: 'Vision processing completed, analysis step triggered.' }); // Updated success message
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