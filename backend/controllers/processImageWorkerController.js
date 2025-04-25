const { Receiver } = require("@upstash/qstash");
const kv = require("../services/kvService"); // Use KV service instead of Redis directly for consistency
const heicConvert = require('heic-convert');
const { visionClient } = require('../services/googleVisionService');
const { Client } = require("@upstash/qstash"); // Import QStash Client
const { put, del } = require('@vercel/blob'); // Needed for downloading

// Initialize QStash Receiver for verification
const qstashReceiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
});

// Initialize QStash Client for publishing the *next* job
if (!process.env.QSTASH_TOKEN) {
    console.warn("QSTASH_TOKEN environment variable not set. QStash publishing will be disabled.");
}
const qstashClient = process.env.QSTASH_TOKEN ? new Client({ token: process.env.QSTASH_TOKEN }) : null;

// Middleware for QStash verification
const verifyQstashSignature = async (req, res, next) => {
    try {
        const isValid = await qstashReceiver.verify({ 
            signature: req.headers["upstash-signature"],
            body: req.rawBody || JSON.stringify(req.body) // Fallback for safety
        });

        if (!isValid) {
            console.error("[Worker - Image] QStash signature verification failed");
            return res.status(401).send("Unauthorized");
        }
        console.log("[Worker - Image] QStash signature verified.");
        next(); // Proceed to the main handler if valid
    } catch (error) {
        console.error("[Worker - Image] Error during QStash signature verification:", error);
        res.status(500).send("Internal Server Error during verification");
    }
};

const processImageWorkerHandler = async (req, res) => {
    console.log("[Worker - Image Handler] Received verified request");

    // 1. Extract Job ID (Signature already verified by middleware)
    const { jobId } = req.body;
    if (!jobId) {
        console.error("[Worker - Image Handler] Missing jobId in request body");
        return res.status(400).send("Missing jobId");
    }
    console.log(`[Worker - Image Handler Job ${jobId}] Processing job ID: ${jobId}`);

    let jobData; // Define here for access in catch block

    try {
        // 2. Retrieve Job Data from KV
        console.log(`[Worker - Image Handler Job ${jobId}] Fetching job details from KV...`);
        if (!kv) { throw new Error('KV client not initialized'); }
        jobData = await kv.get(jobId);
        if (!jobData) {
            console.warn(`[Worker - Image Handler Job ${jobId}] Job data not found in KV. Aborting.`);
            // No need to update status if job doesn't exist
            return res.status(200).json({ message: `Job data not found for ${jobId}, likely expired or invalid.` });
        }
        console.log(`[Worker - Image Handler Job ${jobId}] Retrieved job data status: ${jobData.status}`);

        // Check if job is already processed or failed
        if (jobData.status !== 'pending') {
             console.warn(`[Worker - Image Handler Job ${jobId}] Job status is already '${jobData.status}'. Skipping processing.`);
             return res.status(200).json({ message: `Job already processed or failed: ${jobData.status}`});
        }
        const { blobUrl, originalFilename } = jobData;
        if (!blobUrl) {
            throw new Error('Job data fetched from KV is missing blobUrl.');
        }
        console.log(`[Worker - Image Handler Job ${jobId}] Retrieved blobUrl: ${blobUrl}`);

        // --- Download Image from Blob ---
        console.log(`[Worker - Image Handler Job ${jobId}] Downloading image from Blob...`);
        const imageResponse = await fetch(blobUrl);
        if (!imageResponse.ok) {
            const errorText = await imageResponse.text();
            throw new Error(`Failed to download image from Blob. Status: ${imageResponse.status} ${imageResponse.statusText}. Body: ${errorText}`);
        }
        let imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        console.log(`[Worker - Image Handler Job ${jobId}] Image downloaded. Size: ${imageBuffer.length} bytes.`);
        // --------------------------------

        // --- Convert HEIC/HEIF if needed (Exact Logic from Old Controller) ---
        const lowerFilename = (originalFilename || '').toLowerCase();
        let imageToSendToVision = imageBuffer; // Start with original buffer
        if (lowerFilename.endsWith('.heic') || lowerFilename.endsWith('.heif')) {
            console.log(`[Worker - Image Handler Job ${jobId}] HEIC/HEIF file detected, attempting conversion...`);
            try {
                const convertedBuffer = await heicConvert({
                    buffer: imageBuffer, 
                    format: 'JPEG', 
                    quality: 0.9 
                });
                imageToSendToVision = convertedBuffer;
                console.log(`[Worker - Image Handler Job ${jobId}] Successfully converted HEIC to JPEG.`);
            } catch (conversionError) {
                console.error(`[Worker - Image Handler Job ${jobId}] HEIC conversion failed:`, conversionError);
                if (conversionError.message.includes('Input buffer is not') || conversionError.message.includes('Could not find \'ftyp\' box')) {
                     console.warn(`[Worker - Image Handler Job ${jobId}] Not a HEIC file or known conversion issue, proceeding with original buffer.`);
                } else {
                    throw new Error(`HEIC/HEIF conversion failed: ${conversionError.message}`);
                }
            }
        }
        // -------------------------------------

        // --- Google Cloud Vision API Call (Exact Logic from Old Controller) ---
        console.log(`[Worker - Image Handler Job ${jobId}] Calling Google Cloud Vision API...`);
        const visionStartTime = Date.now();
        if (!visionClient) {
           throw new Error('Vision client failed to initialize. Cannot call Vision API.');
        }
        let extractedText = '';
        try {
            const [result] = await visionClient.textDetection({
                image: { content: imageToSendToVision },
            });
            const detections = result.textAnnotations;
            extractedText = detections && detections.length > 0 ? detections[0].description : '';
            const visionEndTime = Date.now();
            console.log(`[Worker - Image Handler Job ${jobId}] Vision API success. Length: ${extractedText.length}. Duration: ${visionEndTime - visionStartTime}ms.`);
        } catch (visionError) {
             console.error(`[Worker - Image Handler Job ${jobId}] Google Vision API call failed:`, visionError);
             // Update status specifically for Vision failure before re-throwing
             await kv.set(jobId, { ...jobData, status: 'failed', error: 'Could not read text from the image.', finishedAt: Date.now() });
             throw visionError; // Re-throw to be caught by outer catch for response handling
        }
        // ---------------------------------------------------------

        // --- Quick Fail Check (Exact Logic from Old Controller) ---
        if (!extractedText || extractedText.trim().length < 50) {
            console.warn(`[Worker - Image Handler Job ${jobId}] Quick Fail: Extracted text empty or too short (${extractedText?.length || 0} chars).`);
            const quickFailData = { 
                ...jobData,
                status: 'failed', 
                error: 'Image does not contain enough readable text to be a recipe.', 
                finishedAt: Date.now() 
            };
            await kv.set(jobId, JSON.stringify(quickFailData)); // Ensure data is stringified for KV if needed, or use kv.set directly
            console.log(`[Worker - Image Handler Job ${jobId}] Set KV status to 'failed' due to quick fail.`);
            return res.status(200).json({ message: `Job ${jobId} failed: Not enough readable text.` }); // Respond OK to QStash
        }
        // ------------------------------------------------------

        // --- Update KV Status and Trigger Next Step via QStash (Logic from Old Controller) ---
        console.log(`[Worker - Image Handler Job ${jobId}] Vision processing successful. Updating KV status to 'vision_completed'.`);
        const visionCompletedData = {
            ...jobData,
            status: 'vision_completed',
            extractedText: extractedText, // Store extracted text for the next step
            visionFinishedAt: Date.now()
        };
        await kv.set(jobId, JSON.stringify(visionCompletedData)); // Use kv.set, ensure data is stringified if needed
        console.log(`[Worker - Image Handler Job ${jobId}] KV updated. Triggering next step via QStash.`);

        if (!qstashClient) {
             throw new Error("QStash client not initialized (for publishing). Cannot trigger next step.");
        }

        // --- Dynamically Construct Target URL for TEXT Worker --- 
        let targetTextWorkerUrl;
        const isVercel = process.env.VERCEL === '1';
        const workerPath = '/api/process-text-worker'; // Correct worker path
        if (isVercel && process.env.VERCEL_URL) {
            targetTextWorkerUrl = `https://${process.env.VERCEL_URL}${workerPath}`;
        } else if (!isVercel && process.env.APP_BASE_URL) {
            // Use APP_BASE_URL for local development (must include protocol, e.g., http://localhost:3001 or ngrok URL)
            targetTextWorkerUrl = `${process.env.APP_BASE_URL}${workerPath}`;
        } else if (!isVercel) {
             throw new Error("APP_BASE_URL environment variable must be set for local development QStash triggers.");
        } else { // Vercel environment but VERCEL_URL is missing
            throw new Error("VERCEL_URL environment variable is missing in Vercel environment.");
        }
        // ---------------------------------------------------------

        try {
            console.log(`[Worker - Image Handler Job ${jobId}] Publishing job to QStash Text Worker URL: ${targetTextWorkerUrl}`);
            const publishResponse = await qstashClient.publishJSON({
                url: targetTextWorkerUrl, // Use dynamically constructed URL
                body: { jobId: jobId }, // Pass jobId to the next worker
            });
            console.log(`[Worker - Image Handler Job ${jobId}] Successfully published job to QStash Text Worker. Message ID: ${publishResponse.messageId}`);
        } catch (qstashError) {
            console.error(`[Worker - Image Handler Job ${jobId}] CRITICAL: Failed to publish job to QStash Text Worker. Error:`, qstashError);
            // Update KV status to 'failed' as the trigger failed
            const triggerFailData = {
                ...visionCompletedData,
                status: 'failed',
                error: 'Processing Error: Failed to trigger the text analysis step.',
                finishedAt: Date.now()
            };
            await kv.set(jobId, JSON.stringify(triggerFailData)); // Use kv.set
            console.log(`[Worker - Image Handler Job ${jobId}] Updated KV status to 'failed' due to QStash publish error.`);
            // Still respond 200 to the initial QStash message, but the job status reflects the failure.
            return res.status(200).json({ message: `Job ${jobId} failed during trigger to next step.` });
        }
        // --------------------------------------------------------------------------------

        console.log(`[Worker - Image Handler Job ${jobId}] Successfully processed image and triggered next step.`);
        res.status(200).send("Image processing complete, next step triggered."); // Respond OK to QStash

    } catch (error) {
        console.error(`[Worker - Image Handler Job ${jobId}] Error processing job:`, error);
        const currentJobId = jobId || req.body?.jobId; // Ensure we have the jobId
        if (currentJobId && kv) {
            try {
                // Attempt to update KV status to failed, merging with existing data if possible
                const existingData = jobData || await kv.get(currentJobId) || {}; 
                await kv.set(currentJobId, JSON.stringify({ 
                    ...existingData, 
                    status: 'failed', 
                    error: error.message || 'Image worker failed unexpectedly', 
                    finishedAt: Date.now()
                }));
                console.log(`[Worker - Image Handler Job ${currentJobId}] Updated KV status to 'failed' in catch block.`);
            } catch (kvError) {
                console.error(`[Worker - Image Handler Job ${currentJobId}] Failed to update KV status to 'failed' in catch block:`, kvError);
            }
        }
        // Return 500 to indicate failure to QStash (it might retry based on config)
        res.status(500).send("Internal Server Error during image processing");
    }
};

module.exports = {
    verifyQstashSignature, // Export middleware
    processImageWorkerHandler, // Export main handler
}; 