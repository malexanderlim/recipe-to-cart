require('dotenv').config({ path: require('path').resolve(__dirname, './.env') }); // Ensure .env is loaded relative to server.js
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { GoogleAuth } = require('google-auth-library');
const { ImageAnnotatorClient } = require('@google-cloud/vision');
const Anthropic = require('@anthropic-ai/sdk'); // <-- Ensure Anthropic SDK is required
const axios = require('axios');
const heicConvert = require('heic-convert');
const { put, del } = require('@vercel/blob');
const crypto = require('crypto');
const { kv } = require('@vercel/kv');
const { JSDOM } = require('jsdom'); // For Readability
const { Readability } = require('@mozilla/readability'); // For Readability
const cheerio = require('cheerio'); // For HTML parsing / JSON-LD extraction

// --- Upstash Redis Initialization --- 
const { Redis } = require("@upstash/redis");
let redis;
try {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    // If running locally and variables are missing, don't throw, just warn and disable Redis features
    if (!isVercel) {
      console.warn('Upstash Redis environment variables not set for local development. Image processing will fail.');
      redis = null;
    } else {
      // If on Vercel, these ARE required
      throw new Error('Upstash Redis environment variables (UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN) are not set on Vercel.');
    }
  } else {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log('Successfully initialized Upstash Redis client.');
  }
} catch (error) {
   console.error('Failed to initialize Upstash Redis client:', error);
   redis = null; // Ensure it's null if init failed
}
// ---------------------------------------

// --- KV Initialization (Real or Mock) ---
let kvClient;
const isVercel = process.env.VERCEL === '1'; // Vercel sets this environment variable

if (isVercel) {
    console.log("Running in Vercel environment, using real Vercel KV.");
    kvClient = kv; // Use the imported real client
} else {
    console.log("Running locally, using in-memory KV mock.");
    const localKvStore = {}; // Our simple in-memory store
    kvClient = {
        async get(key) {
            // console.log(`[Mock KV GET] ${key}`);
            return Promise.resolve(localKvStore[key] || null);
        },
        async set(key, value) {
            // console.log(`[Mock KV SET] ${key}:`, value);
            localKvStore[key] = value;
            return Promise.resolve('OK'); // Mimic Redis 'OK' response
        },
        // Add other methods like del, incr if needed, but get/set are primary for async job state
        async del(key) {
            delete localKvStore[key];
            return Promise.resolve(1); // Mimic Redis '1' for success
        }
    };
}
// --- End KV Initialization ---

// --- Setup Anthropic Client ---
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY, // Ensure this key is in your .env
});
// ----------------------------

// --- Middleware ---
const app = express();
const port = process.env.PORT || 3001;
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
// ------------------

// --- Google Cloud Setup ---
let visionClient;
try {
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialsPath) {
    // If the variable isn't set at all, throw an error.
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS environment variable is not set.');
  }
  // REMOVED: Manual parsing - let the client library handle the path from the env var.
  // const credentials = JSON.parse(credentialsPath);

  // Initialize the client - it will automatically use the GOOGLE_APPLICATION_CREDENTIALS env var path.
  visionClient = new ImageAnnotatorClient();
  console.log('Successfully initialized Google Cloud Vision client (using GOOGLE_APPLICATION_CREDENTIALS environment variable).');
} catch (error) {
  console.error('Failed to initialize Google Cloud Vision client:', error);
  // Log the problematic path if the error is related to it
  if (error.message.includes('Could not load the default credentials') || error.message.includes('Could not find file')) {
      console.error(`Check if the path specified in GOOGLE_APPLICATION_CREDENTIALS is correct: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
  }
  visionClient = null; // Ensure it's null if init failed
}
// ------------------------

// --- Helper Function for Anthropic Calls ---
async function callAnthropic(systemPrompt, userPrompt, model = 'claude-3-haiku-20240307', max_tokens = 4096) {
    console.log(`Calling Anthropic model ${model}...`);
    try {
        const response = await anthropic.messages.create({
            model: model,
            max_tokens: max_tokens,
            temperature: 0.1, // Keep low temp for consistency
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }]
        });
        console.log("Anthropic API response received.");

        // Check for valid response structure
        if (response.content && response.content.length > 0 && response.content[0].type === 'text') {
            // Return ONLY the raw text content
            return response.content[0].text;
        } else {
            console.error("Anthropic response format unexpected:", response);
            throw new Error("Anthropic response did not contain expected text content.");
        }
    } catch (error) {
        console.error("Error calling Anthropic API:", error);
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        throw new Error(`Anthropic API Error: ${errorMessage}`);
    }
}

// --- Job Status Update Helper ---
async function updateJobStatus(jobId, status, data = {}) {
    try {
        let currentData = await kvClient.get(jobId);
        // If job data doesn't exist when trying to update, log a warning and return.
        // This prevents errors if a status update arrives after a job was potentially deleted or failed very early.
        if (!currentData) {
             console.warn(`[${jobId}] Job data not found in KV when trying to update status to ${status}. Ignoring update.`);
            return;
        }
        currentData.status = status;
        Object.assign(currentData, data); // Merge new data (e.g., error message, result)
        
        // Set end time only on terminal statuses
        if (status === 'completed' || status === 'failed') {
             currentData.endTime = Date.now();
             // Optional: Log duration
             if (currentData.startTime) {
                 console.log(`[${jobId}] Job finished with status ${status} in ${currentData.endTime - currentData.startTime}ms`);
             } else {
                console.log(`[${jobId}] Job finished with status ${status}.`);
             }
        } else {
            console.log(`[${jobId}] Status updated to ${status}.`);
        }

        await kvClient.set(jobId, currentData);

    } catch (error) {
        console.error(`[${jobId}] Failed to update job status to ${status} in KV:`, error);
        // Consider if retrying KV set makes sense here depending on error type
    }
}

// --- NEW Helper: Parse JSON, with LLM correction fallback ---
// Tries to parse JSON. If it fails, asks the LLM to fix the syntax.
// Removed invalid type annotation from expectedType
async function parseAndCorrectJson(jobId, rawJsonResponse, expectedType) {
    // Default to 'object' if not specified or invalid
    if (expectedType !== 'array') {
        expectedType = 'object';
    }
    console.log(`[${jobId}] Attempting to parse JSON (expected type: ${expectedType}). Raw length: ${rawJsonResponse?.length}`);
    let parsedJson = null;
    let jsonString = rawJsonResponse?.trim() || '';

    // Initial attempt: Strict extraction and parsing
    try {
        let extractedString = null;
        if (expectedType === 'array') {
            // Try to find array strictly delimited by optional whitespace
            const arrayMatchStrict = jsonString.match(/^\\s*(\\[[\\s\\S]*\\])\\s*$/);
            if (arrayMatchStrict) {
                extractedString = arrayMatchStrict[1];
            } else {
                // Fallback: find first '[' and last ']'
                const firstBracket = jsonString.indexOf('[');
                const lastBracket = jsonString.lastIndexOf(']');
                if (firstBracket !== -1 && lastBracket > firstBracket) {
                    extractedString = jsonString.substring(firstBracket, lastBracket + 1);
                    console.log(`[${jobId}] Used fallback bracket finding for array.`);
                } else {
                    throw new Error(`Response does not appear to contain a JSON array.`);
                }
            }
        } else { // expectedType === 'object'
             // Try to find object strictly delimited by optional whitespace
            const objectMatchStrict = jsonString.match(/^\\s*(\\{[\\s\\S]*\\})\\s*$/);
            if (objectMatchStrict) {
                extractedString = objectMatchStrict[1];
            } else {
                // Fallback: find first '{' and last '}'
                 const firstBrace = jsonString.indexOf('{');
                 const lastBrace = jsonString.lastIndexOf('}');
                 if (firstBrace !== -1 && lastBrace > firstBrace) {
                     extractedString = jsonString.substring(firstBrace, lastBrace + 1);
                     console.log(`[${jobId}] Used fallback brace finding for object.`);
                 } else {
                    throw new Error(`Response does not appear to contain a JSON object.`);
                 }
            }
        }

        // Clean potential trailing commas before final bracket/brace
        extractedString = extractedString.replace(/,\\s*([}\\]])/g, '$1');

        parsedJson = JSON.parse(extractedString);
        console.log(`[${jobId}] Initial JSON parse successful.`);

        // Final type check
        if (expectedType === 'array' && !Array.isArray(parsedJson)) {
             throw new Error(`Parsed result is not an array, but expected one. Found: ${typeof parsedJson}`);
        }
        if (expectedType === 'object' && (typeof parsedJson !== 'object' || Array.isArray(parsedJson) || parsedJson === null)) {
             throw new Error(`Parsed result is not an object, but expected one. Found: ${typeof parsedJson}`);
        }
        return parsedJson; // SUCCESS

    } catch (initialParseError) {
        console.warn(`[${jobId}] Initial JSON parse failed: ${initialParseError.message}. Attempting LLM correction.`);
        // Use the original potentially messy jsonString for correction attempt
        console.warn(`[${jobId}] Faulty JSON string being sent for correction: ${jsonString.substring(0, 500)}...`);

        // --- Correction Attempt ---
        try {
            const correctionSystemPrompt = "You are a JSON syntax correction expert. The user will provide a string that is *supposed* to be valid JSON, but contains syntax errors. Your ONLY task is to fix the syntax errors (missing commas, brackets, quotes, etc.) and return ONLY the corrected, valid JSON string. Do not add any explanations or change the data structure.";
            // Use the original rawJsonResponse in the prompt for correction
            const correctionUserPrompt = `Please fix the syntax errors in the following JSON string and return only the corrected JSON string:\\n\\n\\\`\\\`\\\`json\\n${jsonString}\\n\\\`\\\`\\\`\\n\\nCorrected JSON:`;

            // Use callAnthropic (assuming it returns raw string)
            const correctedJsonStringRaw = await callAnthropic(correctionSystemPrompt, correctionUserPrompt, 'claude-3-haiku-20240307', jsonString.length + 500); // Give some buffer

            console.log(`[${jobId}] Received potential corrected JSON string from LLM. Length: ${correctedJsonStringRaw?.length}`);

            // Re-attempt parsing on the *corrected* string, using similar extraction logic
            let correctedJsonString = correctedJsonStringRaw?.trim() || '';
            let finalCorrectedString = null;

             if (expectedType === 'array') {
                 const arrayMatchStrict = correctedJsonString.match(/^\\s*(\\[[\\s\\S]*\\])\\s*$/);
                 if (arrayMatchStrict) { finalCorrectedString = arrayMatchStrict[1]; }
                 else { const first = correctedJsonString.indexOf('['); const last = correctedJsonString.lastIndexOf(']'); if(first !== -1 && last > first) finalCorrectedString = correctedJsonString.substring(first, last+1); }
             } else { // object
                 const objectMatchStrict = correctedJsonString.match(/^\\s*(\\{[\\s\\S]*\\})\\s*$/);
                  if (objectMatchStrict) { finalCorrectedString = objectMatchStrict[1]; }
                  else { const first = correctedJsonString.indexOf('{'); const last = correctedJsonString.lastIndexOf('}'); if(first !== -1 && last > first) finalCorrectedString = correctedJsonString.substring(first, last+1); }
             }

             if (!finalCorrectedString) {
                 throw new Error("LLM correction response did not contain expected JSON structure.");
             }

             finalCorrectedString = finalCorrectedString.replace(/,\\s*([}\\]])/g, '$1'); // Clean trailing commas again
             parsedJson = JSON.parse(finalCorrectedString);

             console.log(`[${jobId}] Successfully parsed corrected JSON.`);

             // Final type check again
             if (expectedType === 'array' && !Array.isArray(parsedJson)) throw new Error("Corrected result is not an array.");
             if (expectedType === 'object' && (typeof parsedJson !== 'object' || Array.isArray(parsedJson) || parsedJson === null)) throw new Error("Corrected result is not an object.");

            return parsedJson; // SUCCESS after correction

        } catch (correctionError) {
            console.error(`[${jobId}] Failed to parse JSON even after LLM correction: ${correctionError.message}`);
            console.error(`[${jobId}] Original faulty JSON: ${jsonString.substring(0, 500)}...`);
            // console.error(`[${jobId}] Corrected attempt raw string: ${correctedJsonStringRaw?.substring(0, 500)}...`); // Optionally log corrected attempt
            return null; // FAILURE after correction attempt
        }
    }
}

// --- Routes ---

// Endpoint for image upload and initial parsing (Stage 1) ASYNCHRONOUS
app.post('/api/upload', upload.array('recipeImages'), async (req, res) => {
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
        const triggerSecretToSend = process.env.INTERNAL_TRIGGER_SECRET || 'default-secret'; // Get the secret being sent
        const processImageUrl = `${baseUrl}/api/process-image`;
        console.log(`[Async Upload Job ${jobId}] Triggering background processing at: ${processImageUrl}`);
        console.log(`[Async Upload Job ${jobId}] Trigger URL used: ${processImageUrl}`); // Log full URL for verification
        console.log(`[Async Upload Job ${jobId}] Sending trigger secret (masked): ...${triggerSecretToSend.slice(-4)}`); // Log masked secret

        // Use fetch for fire-and-forget - DO NOT await this
        fetch(processImageUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Internal-Trigger-Secret': triggerSecretToSend
            },
            body: JSON.stringify({ jobId: jobId })
        }).catch(async (fetchError) => { // Make catch async to allow await redis.set
            // Log the error, but don't fail the initial request.
            console.error(`[Async Upload Job ${jobId}] CRITICAL: Error triggering background process fetch:`, fetchError);
            // Optionally update Redis status to failed here if triggering fails critically
            if (redis) {
                 try {
                     const triggerFailData = { 
                         status: 'failed', 
                         error: 'Failed to start background processing. Please try again.', // User-friendly message
                         originalFilename: originalFilename, // Include some context
                         createdAt: initialJobData.createdAt, // Keep original creation time
                         finishedAt: Date.now()
                      };
                     await redis.set(jobId, JSON.stringify(triggerFailData));
                     console.log(`[Async Upload Job ${jobId}] Updated Redis status to failed due to trigger error.`);
                 } catch (redisError) {
                     console.error(`[Async Upload Job ${jobId}] Failed to update Redis after trigger error:`, redisError);
                 }
            }
        });

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
});

// Background processing endpoint (triggered by /api/upload)
app.post('/api/process-image', async (req, res) => {
    console.log(`[Process Image Handler] ===== FUNCTION HANDLER ENTERED =====`); // Log immediately
    console.log(`[Process Image Handler] ===== INVOKED =====`); // Restore original log
    const receivedTriggerSecret = req.headers['x-internal-trigger-secret']; // Restore variable

    // Basic security check (optional but recommended)
    console.log(`[Process Image Handler] Received Trigger Secret (masked): ...${receivedTriggerSecret ? receivedTriggerSecret.slice(-4) : 'MISSING'}`);

    // Basic security check (optional but recommended)
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

    let jobData;
    try {
        // --- Retrieve Job Details from Redis ---
        console.log(`[Process Image Job ${jobId}] Fetching job details from Redis...`);
        if (!redis) { throw new Error('Redis client not initialized'); }
        jobData = await redis.get(jobId); // Assign directly, no parsing needed
        if (!jobData) { // Check the object directly
            // Job might have expired or been deleted, or ID is invalid
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

        // --- HEIC Conversion (Moved from /api/upload) ---
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
                 // Update Redis to failed status
                 const failedData = { ...jobData, status: 'failed', error: 'Image conversion failed. Please try a standard JPEG or PNG.', finishedAt: Date.now() };
                 await redis.set(jobId, JSON.stringify(failedData)); // Use redis.set
                 throw convertError; // Propagate error to main catch block
            }
        }
        // ----------------------------------------------

        // --- Google Cloud Vision API Call (Moved from /api/upload) ---
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

        let finalResult = { extractedText: '', title: null, yield: null, ingredients: [] }; // Default empty result

        if (extractedText && extractedText.trim().length > 0) {
            // --- STOPPING POINT for this function --- 

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
                    // No Vercel Auth needed here assuming it's disabled globally
                },
                body: JSON.stringify({ jobId: jobId })
            }).catch(async (fetchTriggerError) => {
                // --- Enhanced Logging for Trigger Failure --- 
                console.error(`[Process Image Job ${jobId}] CRITICAL: fetch() call to /api/process-text failed. Error:`, fetchTriggerError);
                // Update status to failed if triggering the next step fails
                const triggerFailData = { 
                    ...visionCompletedData, // Keep data from successful vision step
                    status: 'failed', 
                    error: 'Processing Error: Failed to start the final analysis step.', // Updated user-friendly error
                    finishedAt: Date.now() 
                };
                try {
                    console.log(`[Process Image Job ${jobId}] Attempting to update Redis to 'failed' due to trigger error...`);
                    await redis.set(jobId, JSON.stringify(triggerFailData));
                    console.log(`[Process Image Job ${jobId}] Successfully updated Redis status to 'failed' after trigger error.`);
                } catch (redisSetError) {
                     console.error(`[Process Image Job ${jobId}] CRITICAL: Failed to update Redis status to 'failed' AFTER the /api/process-text trigger failed! Error:`, redisSetError);
                     // If this fails, the job might remain stuck in vision_completed
                }
            });

            res.status(200).json({ message: 'Processing completed successfully.' });
            return; // Exit successfully
        } else {
            console.log(`[Process Image Job ${jobId}] No text extracted by Vision API.`);
            // Store empty but successful result
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
        if (jobData && jobData.status !== 'failed') { // Avoid overwriting specific error messages
            try {
                 const updatePayload = jobData
                     ? { ...jobData, status: 'failed', error: 'An error occurred while processing the image.', finishedAt: Date.now() }
                     : { status: 'failed', error: 'An error occurred early in the processing pipeline.', finishedAt: Date.now() };

                await redis.set(jobId, JSON.stringify(updatePayload)); // Use redis.set
                 console.log(`[Process Image Job ${jobId}] Updated Redis status to 'failed' due to processing error.`);
             } catch (redisError) {
                 console.error(`[Process Image Job ${jobId}] CRITICAL: Failed to update Redis status to 'failed' after error:`, redisError);
             }
        }
         // Respond with 200 OK even on errors, as the status is updated in Redis.
         // This prevents Vercel/Redis from potentially retrying the function.
         if (!res.headersSent) {
             res.status(200).json({ message: `Processing failed for Job ID ${jobId}, status updated in Redis.` });
         }
    }
});

// Endpoint for frontend polling to check job status
app.get('/api/job-status', async (req, res) => {
    const { jobId } = req.query;
    if (!jobId) {
        return res.status(400).json({ error: 'Missing Job ID query parameter.' });
    }

    try {
        // if (!redis) { throw new Error('Redis client not initialized'); } // <-- Incorrect: Was using Redis for all jobs
        // const jobData = await redis.get(jobId); // <-- Incorrect: Was using Redis for all jobs

        // --- Corrected Logic: Use kvClient (mock or real KV) --- 
        const jobData = await kvClient.get(jobId);
        // --------------------------------------------------------

        if (!jobData) { // Check the object directly
            // If job isn't found, it might have expired or never existed
            // Updated log message to reflect kvClient usage
            console.warn(`[Job Status] Job data not found in KV for Job ID: ${jobId}`);
            return res.status(404).json({ status: 'not_found', error: 'Job not found or expired.' });
        }

        // Check if result needs parsing (needed if KV stores strings, but mock/real KV store objects)
        // Let's assume kvClient directly returns the object for now.
        // If errors occur later, we might need: const parsedResult = typeof jobData.result === 'string' ? JSON.parse(jobData.result) : jobData.result;

        res.json({
            status: jobData.status,
            result: jobData.result, // Send result directly
            error: jobData.error
        });

    } catch (error) {
        console.error(`[Job Status] Error fetching status for Job ID ${jobId} from KV:`, error); // Updated log
        res.status(500).json({ error: 'Failed to retrieve job status.', details: error.message });
    }
});

// Endpoint to create Instacart list (incorporating Stage 2 LLM)
// ********** V7: SINGLE LLM CALL FOR NORMALIZATION & CONVERSIONS, ALGO FOR MATH **********
app.post('/api/create-list', async (req, res) => {
    const { ingredients: rawIngredients, title = 'My Recipe Ingredients' } = req.body;
    console.log('V7: Received request for /api/create-list.');
    console.log('V7: Raw ingredients received:', JSON.stringify(rawIngredients, null, 2));

    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    if (!rawIngredients || !Array.isArray(rawIngredients) || rawIngredients.length === 0) {
        return res.status(400).json({ error: 'Invalid or missing ingredients data.' });
    }
    if (!anthropicApiKey) {
        console.error('Anthropic API key missing.');
        return res.status(500).json({ error: 'Server configuration error: Anthropic API key not found.' });
    }

    try {
        // --- Step 1: Single LLM Call for Normalization & Conversion Data ---
        console.log("V7 Step 1: Calling LLM for normalization and conversion data (Instacart Doc Examples)...");
        const systemPrompt = `You are an expert grocery shopping assistant simulating a shopper at a typical US grocery store. Your ONLY goal is to determine how recipe ingredients translate to standard PURCHASABLE units, using official Instacart unit guidance. Analyze the provided list of raw ingredients, identify unique conceptual items, and for each item, specify its common name, its PRIMARY PURCHASABLE unit, and conversion factors FROM that primary unit TO other relevant units. Respond ONLY with a single, valid JSON array containing objects for each unique ingredient. Do NOT include any introductory text, markdown formatting, or any other text outside the JSON array itself.`;

        const uniqueIngredientStrings = [...new Set(rawIngredients.map(item => item.ingredient).filter(Boolean))];
        
        // V7 User Prompt: Incorporates diverse examples based on Instacart documentation
        const userPrompt = `Raw Ingredient List Snapshot (for context):
\`\`\`json
${JSON.stringify(rawIngredients.slice(0, 20), null, 2)} ${rawIngredients.length > 20 ? '\n...' : ''}
\`\`\`

Unique Ingredient Strings Found:
${uniqueIngredientStrings.join('\n')}

Instructions:
Analyze the unique ingredients based on the snapshot and list provided. For each unique conceptual ingredient:
1.  **Determine Normalized Name:** Provide the best single, common, lowercase name (e.g., "garlic", "fresh thyme", "olive oil", "rolled oats", "chicken broth").
2.  **Identify PRIMARY PURCHASABLE Unit:** THIS IS CRITICAL. Reference the Instacart Units of Measurement guide. Determine the unit a shopper typically buys this item in at a standard US grocery store. THINK: Can you buy 'cloves' of garlic, or do you buy 'head'? Can you buy 'sprigs' of thyme, or 'bunch'/'package'? Can you buy 'ml' of milk, or 'gallon'/'quart'/'pint'? 
    *   Use standard Instacart units reflecting how items are SOLD: oz, fl oz, lb, g, kg, each, bunch, package, can, cup, pint, head, large, medium, small, gallon, quart, liter, milliliter, tablespoon, teaspoon. Consider common container types if applicable (e.g., 'fl oz can', 'lb bag').
    *   Examples of PRIMARY PURCHASABLE units: 'head' for garlic, 'bunch' or 'package' for fresh herbs, 'package' or 'oz' for dried bay leaves, 'each' for tomatoes/onions/lemons, 'lb' for apples/potatoes/chicken, 'oz' for cereal/butter, 'fl oz' or 'gallon'/'liter' for milk/juice, 'fl oz can' for soup, 'cup' or 'pint' for cream/yogurt.
    *   DO NOT select non-purchasable units like 'clove', 'sprig', 'leaf', 'slice' as the primary unit.
3.  **Provide Equivalent Units & Factors:** Create an 'equivalent_units' array relative to the PRIMARY PURCHASABLE unit.
    *   'unit': A common unit name (lowercase). Include the primary unit itself. Use standard Instacart units.
    *   'factor_from_primary': How many of this 'unit' are equivalent to ONE 'primary_unit'? (e.g., If primary is 'head' [garlic], for 'clove', factor_from_primary might be 10.0. If primary is 'gallon' [milk], for 'fl oz', factor_from_primary is 128.0. If primary is 'lb' [potatoes], for 'each' potato, factor_from_primary might be 2.5). Use null if conversion isn't practical.

Output Format: Respond ONLY with a single valid JSON array. Each object MUST have keys:
*   "normalized_name" (string)
*   "primary_unit" (string - MUST be the purchasable unit)
*   "equivalent_units" (array of objects with 'unit' [string] and 'factor_from_primary' [number | null])

Example Output Fragment (Based on Instacart Docs & Purchasable Units):
\`\`\`json
[
  {
    "normalized_name": "garlic", "primary_unit": "head",
    "equivalent_units": [ { "unit": "head", "factor_from_primary": 1.0 }, { "unit": "clove", "factor_from_primary": 10.0 }, { "unit": "oz", "factor_from_primary": 4.0 } ]
  },
  {
    "normalized_name": "fresh thyme", "primary_unit": "bunch", 
    "equivalent_units": [ { "unit": "bunch", "factor_from_primary": 1.0 }, { "unit": "package", "factor_from_primary": 1.0 }, { "unit": "sprig", "factor_from_primary": 15.0 }, { "unit": "oz", "factor_from_primary": 0.5 } ]
  },
   {
    "normalized_name": "rolled oats", "primary_unit": "oz", // Typically sold by weight
    "equivalent_units": [ { "unit": "oz", "factor_from_primary": 1.0 }, { "unit": "cup", "factor_from_primary": 0.125 }, { "unit": "lb", "factor_from_primary": 0.0625 } ] // 1 oz = 1/8 cup, 1 oz = 1/16 lb
  },
  {
    "normalized_name": "tomato", "primary_unit": "each", // Instacart recommendation
    "equivalent_units": [ { "unit": "each", "factor_from_primary": 1.0 }, { "unit": "lb", "factor_from_primary": 0.33 } ] // ~3 tomatoes per lb
  },
  {
    "normalized_name": "whole milk", "primary_unit": "gallon",
    "equivalent_units": [ { "unit": "gallon", "factor_from_primary": 1.0 }, { "unit": "quart", "factor_from_primary": 4.0 }, { "unit": "pint", "factor_from_primary": 8.0 }, { "unit": "cup", "factor_from_primary": 16.0 }, { "unit": "fl oz", "factor_from_primary": 128.0 }, { "unit": "liter", "factor_from_primary": 3.785 } ]
  },
  {
    "normalized_name": "bay leaf", "primary_unit": "package",
    "equivalent_units": [ { "unit": "package", "factor_from_primary": 1.0 }, { "unit": "leaf", "factor_from_primary": 20.0 }, { "unit": "oz", "factor_from_primary": 0.25 } ]
  }
]
\`\`\`
Final JSON Output:
`;

        const rawLlmResponse = await callAnthropic(systemPrompt, userPrompt);
        console.log("V7: Raw LLM Response:", rawLlmResponse);

        // ... (Parsing and Validation logic remains the same) ...
        let conversionDataList;
        try {
            let jsonString = rawLlmResponse.trim();
            let parsedJson = null;
 
            // Attempt 1: Strict ```json block extraction using regex
            const jsonMatch = jsonString.match(/```json\s*([\s\S]*?)\s*```/);
            if (jsonMatch && jsonMatch[1]) {
                jsonString = jsonMatch[1].trim();
                console.log("V7: Extracted JSON using regex match.");
                try {
                    parsedJson = JSON.parse(jsonString);
                } catch (e) {
                    console.warn("V7: Regex match content failed to parse:", e.message);
                    // Reset jsonString if parsing the extracted part failed, to allow other attempts
                    jsonString = rawLlmResponse.trim();
                    parsedJson = null;
                }
            }

            // Attempt 2: Manual stripping if regex failed but backticks seem present
            if (parsedJson === null && jsonString.startsWith("```json") && jsonString.endsWith("```")) {
                 console.warn("V7: Regex failed or its content was invalid, attempting manual backtick stripping.");
                 jsonString = jsonString.substring(7, jsonString.length - 3).trim(); // Remove ```json and ```
                 try {
                      parsedJson = JSON.parse(jsonString);
                      console.log("V7: Successfully parsed JSON after manual stripping.");
                 } catch (e) {
                      console.warn("V7: Manual stripping content failed to parse:", e.message);
                      parsedJson = null; // Reset on failure
                 }
            }

            // Attempt 3: Updated: Check for start bracket only, as end bracket might be missing if truncated
            if (parsedJson === null && jsonString.startsWith("[")) {
                 console.warn("V7: No backticks found/parsed, attempting to parse raw string as array.");
                 try {
                     parsedJson = JSON.parse(jsonString);
                     console.log("V7: Successfully parsed raw string as JSON.");
                 } catch (e) {
                     console.warn("V7: Raw string parsing failed:", e.message);
                     parsedJson = null;
                 }
            }

            // Attempt 4: Find the first '[' or '{' and parse from there
            if (parsedJson === null) {
                 console.warn("V7: Previous attempts failed, finding first '[' or '{' to parse from.");
                 const jsonStartIndex = jsonString.search(/\s*[{\[]/); // Find first { or [
                 if (jsonStartIndex !== -1) {
                     jsonString = jsonString.substring(jsonStartIndex);
                     try {
                         parsedJson = JSON.parse(jsonString);
                         console.log("V7: Successfully parsed JSON after finding start bracket/brace.");
                     } catch (e) {
                         console.warn("V7: Parsing after finding start bracket/brace failed:", e.message);
                         parsedJson = null;
                     }
                 }
             }

            // Final check and assignment
            if (parsedJson === null) {
                 console.error("V7: Failed to parse JSON from LLM response after multiple attempts.");
                 console.error("V7: Raw Response causing failure:\n---\n" + rawLlmResponse + "\n---");
                 throw new Error("Could not parse conversion data from AI response."); // More specific error
            }

            conversionDataList = parsedJson; // Assign the successfully parsed JSON

            if (!Array.isArray(conversionDataList)) throw new Error("LLM output is not an array.");
            conversionDataList.forEach((item, index) => {
                if (!item.normalized_name || !item.primary_unit || !Array.isArray(item.equivalent_units)) {
                    throw new Error(`Item at index ${index} missing required keys.`);
                }
                item.equivalent_units.forEach((eq, eqIndex) => {
                    if (!eq.unit || eq.factor_from_primary === undefined) { 
                         throw new Error(`Equivalent unit at index ${eqIndex} for item ${item.normalized_name} is invalid.`);
                    }
                });
            });
            console.log("V7: Successfully parsed conversion data from LLM.");
        } catch (parseError) {
            console.error("V7: Error parsing LLM JSON response:", parseError);
            throw new Error(`AI Processing Failed: ${parseError.message}`); // Throw the specific parse error
        }

        // --- Step 2: Algorithmic Consolidation using LLM Data ---
        console.log("V7 Step 2: Consolidating ingredients using LLM conversion data...");
        // ... (Building conversionMap remains the same) ...
        const conversionMap = new Map();
        conversionDataList.forEach(item => {
            const eqUnitsMap = new Map();
            item.equivalent_units.forEach(eq => {
                if (eq.unit && eq.factor_from_primary != null) {
                     eqUnitsMap.set(eq.unit.toLowerCase(), eq.factor_from_primary);
                }
            });
            conversionMap.set(item.normalized_name, {
                primaryUnit: item.primary_unit.toLowerCase(),
                equivalentUnits: eqUnitsMap
            });
        });
        console.log("V7: Built conversion map:", conversionMap);
        
        // V7: simpleNormalize remains the same as V5 (can be improved later if needed)
        const simpleNormalize = (name) => name ? name.toLowerCase().replace(/\(.*?\)/g, '').replace(/\bleaves\b/g, 'leaf').replace(/\btomatoes\b/g, 'tomato').replace(/\bpotatoes\b/g, 'potato').replace(/\bonions\b/g, 'onion').replace(/\bcloves\b/g, 'clove').replace(/\bheads\b/g, 'head').replace(/,( smashed| minced| peeled| separated| chopped| stemmed| fresh| dried| bruised| whole| sliced| diced)/g, '').replace(/\'s$/, '').trim() : 'unknown';
        
        // ... (nameMapping logic remains the same) ...
        const nameMapping = {};
        rawIngredients.forEach(rawItem => {
            if (!rawItem.ingredient) return;
            const simpleRawName = simpleNormalize(rawItem.ingredient);
            let foundMatch = false;
            for (const normName of conversionMap.keys()) {
                if (simpleRawName.includes(normName) || normName.includes(simpleRawName)) {
                    nameMapping[rawItem.ingredient] = normName;
                    foundMatch = true;
                    break;
                }
            }
            if (!foundMatch) {
                 console.warn(`V7: Could not map raw ingredient '${rawItem.ingredient}' (simplified: '${simpleRawName}') to a normalized name from LLM output.`);
                 nameMapping[rawItem.ingredient] = simpleRawName; 
            }
        });
        
        const consolidatedTotals = {}; 

        for (const rawItem of rawIngredients) {
            if (!rawItem.ingredient || rawItem.quantity == null) continue;
            
            const normalizedName = nameMapping[rawItem.ingredient] || simpleNormalize(rawItem.ingredient);
            const conversionData = conversionMap.get(normalizedName);
            let rawUnit = rawItem.unit ? rawItem.unit.toLowerCase().trim() : null;
            const rawQuantity = rawItem.quantity;

            // V7: Refined fallback/error handling during consolidation
            if (!conversionData) {
                console.warn(`V7: No conversion data for '${normalizedName}'. Adding raw: ${rawQuantity} ${rawUnit || '(no unit)'}.`);
                if (!consolidatedTotals[normalizedName]) consolidatedTotals[normalizedName] = { units: {}, failed: true }; // Mark as failed
                 const unitToAdd = rawUnit || 'unknown_unit'; 
                 consolidatedTotals[normalizedName].units[unitToAdd] = (consolidatedTotals[normalizedName].units[unitToAdd] || 0) + rawQuantity;
                continue;
            }

            const primaryUnit = conversionData.primaryUnit;
            const eqUnitsMap = conversionData.equivalentUnits;
            let quantityInPrimary = 0;
            let conversionSuccessful = false;

            if (!rawUnit) {
                if (primaryUnit === 'each') { 
                     quantityInPrimary = rawQuantity;
                     conversionSuccessful = true;
                     console.log(`  V7: ${rawItem.ingredient} - Assuming unitless as primary unit 'each'`);
                } else if (eqUnitsMap.has('leaf') && normalizedName.includes('leaf')) {
                    rawUnit = 'leaf'; // Treat as leaf and proceed to lookup below
                     console.log(`  V7: ${rawItem.ingredient} - Treating unitless as 'leaf' for conversion attempt.`);
                } else {
                    console.warn(`  V7: Cannot convert unitless '${rawItem.ingredient}' to primary unit '${primaryUnit}'. Adding raw.`);
                    // Keep track of raw quantity if conversion fails
                }
            }

            if (rawUnit && !conversionSuccessful) { // Attempt conversion only if needed and not already handled
                if (rawUnit === primaryUnit) {
                    quantityInPrimary = rawQuantity;
                    conversionSuccessful = true;
                } else {
                    let factorFromPrimary = null;
                    const singularRawUnit = rawUnit.endsWith('s') && !rawUnit.endsWith('ss') ? rawUnit.slice(0, -1) : null; 
                    
                    if (eqUnitsMap.has(rawUnit)) {
                        factorFromPrimary = eqUnitsMap.get(rawUnit);
                    } else if (singularRawUnit && eqUnitsMap.has(singularRawUnit)) { 
                        factorFromPrimary = eqUnitsMap.get(singularRawUnit);
                        console.log(`  V7: Matched plural raw unit '${rawUnit}' to singular map key '${singularRawUnit}' for ${normalizedName}`);
                    }
                    
                    if (factorFromPrimary != null && factorFromPrimary > 0) {
                        const factorToPrimary = 1.0 / factorFromPrimary;
                        quantityInPrimary = rawQuantity * factorToPrimary;
                        conversionSuccessful = true;
                        console.log(`  V7: Converted ${rawQuantity} ${rawUnit} of ${normalizedName} to ${quantityInPrimary.toFixed(3)} ${primaryUnit}`);
                    } else {
                        console.warn(`  V7: Unit '${rawUnit}' (or singular) not found/invalid factor for ${normalizedName}. Cannot convert to primary '${primaryUnit}'. Adding raw.`);
                    }
                }
            }
            
            // Accumulate totals
            if (!consolidatedTotals[normalizedName]) consolidatedTotals[normalizedName] = { units: {}, primaryUnit: primaryUnit }; // Store primary unit
            
            if (conversionSuccessful) {
                consolidatedTotals[normalizedName].units[primaryUnit] = (consolidatedTotals[normalizedName].units[primaryUnit] || 0) + quantityInPrimary;
                // Calculate secondary units only if primary conversion worked
                ['oz', 'fl oz'].forEach(secondaryUnit => {
                     if (secondaryUnit === primaryUnit) return;
                     if (eqUnitsMap.has(secondaryUnit)) {
                         const factorFromPrimaryForSecondary = eqUnitsMap.get(secondaryUnit);
                         if (factorFromPrimaryForSecondary > 0) {
                              const quantityInSecondary = quantityInPrimary * factorFromPrimaryForSecondary;
                              if (quantityInSecondary > 0) {
                                   consolidatedTotals[normalizedName].units[secondaryUnit] = (consolidatedTotals[normalizedName].units[secondaryUnit] || 0) + quantityInSecondary;
                              }
                         }
                     }
                });
            } else {
                 // Add raw quantity if conversion failed
                 const unitToAdd = rawUnit || 'unknown_unit';
                 consolidatedTotals[normalizedName].units[unitToAdd] = (consolidatedTotals[normalizedName].units[unitToAdd] || 0) + rawQuantity;
                 consolidatedTotals[normalizedName].failed = true; // Mark that at least one conversion failed
            }
        }
        console.log("V7: Consolidated totals before adjustments:", JSON.stringify(consolidatedTotals, null, 2));
        // --- End Step 2 ---

        // --- Step 3: Final Adjustments & Formatting ---
        console.log("V7 Step 3: Applying final adjustments...");
        const finalAdjustedItems = [];
        const countableUnits = ['bunch', 'can', 'head', 'each', 'large', 'medium', 'small', 'package', 'pint'];
        const freshHerbs = ['basil', 'thyme', 'mint', 'parsley', 'cilantro', 'rosemary', 'dill', 'oregano'];

        for (const normalizedName in consolidatedTotals) {
            const itemData = consolidatedTotals[normalizedName];
            const measurements = itemData.units;
            const primaryUnit = itemData.primaryUnit || Object.keys(measurements)[0] || 'each'; // Use stored primary or fallback
            let finalMeasurements = [];

            for (const [unit, quantity] of Object.entries(measurements)) {
                if (quantity <= 0 || unit === 'unknown_unit') continue; // Skip zero/negative/unknown
                
                let adjustedQuantity = quantity;
                const isCountable = countableUnits.includes(unit);
                const isHerb = freshHerbs.some(herb => normalizedName.includes(herb));

                // Adjustment 1: Round up countable units
                if (isCountable) {
                    const rounded = Math.ceil(adjustedQuantity);
                    if (rounded > adjustedQuantity) {
                         console.log(`  Adjusting ${normalizedName} ${unit}: ${adjustedQuantity.toFixed(3)} -> ${rounded} (Ceiling)`);
                         adjustedQuantity = rounded;
                    }
                    adjustedQuantity = Math.max(1, Math.round(adjustedQuantity)); 
                }

                // Adjustment 2: Minimum 1 for fresh herbs in bunch/package
                 if (isHerb && (unit === 'bunch' || unit === 'package') && adjustedQuantity > 0 && adjustedQuantity < 1) {
                     console.log(`  Adjusting ${normalizedName} ${unit}: ${adjustedQuantity.toFixed(3)} -> 1 (Herb Minimum)`);
                     adjustedQuantity = 1; 
                 }
                 
                 // Ensure reasonable precision for non-countable
                 if (!isCountable) adjustedQuantity = parseFloat(adjustedQuantity.toFixed(2));
                 
                 if (quantity > 0 && adjustedQuantity <= 0) adjustedQuantity = 0.01; 

                 if (adjustedQuantity > 0) {
                    finalMeasurements.push({ unit, quantity: adjustedQuantity });
                 }
            }
            
            // Sort measurements: primary unit first, then alpha
            finalMeasurements.sort((a, b) => {
                 if (a.unit === primaryUnit) return -1; 
                 if (b.unit === primaryUnit) return 1;
                 return a.unit.localeCompare(b.unit); 
            });

            if (finalMeasurements.length > 0) {
                 // If conversion failed for any part of this item, maybe add a note?
                 // For now, just use the normalized name.
                 finalAdjustedItems.push({ name: normalizedName, line_item_measurements: finalMeasurements });
            }
        }
        console.log("V7: Final adjusted items ready for review:", JSON.stringify(finalAdjustedItems, null, 2));
        // --- End Step 3 ---

        res.json({ 
            processedIngredients: finalAdjustedItems, 
            originalTitle: title
        }); 

    } catch (error) {
        console.error("V7: Error during /api/create-list processing:", error);
        return res.status(500).json({
            error: 'Failed to process ingredients list.',
            details: error.message
        });
    }
});

// Endpoint to create Instacart list (incorporating Stage 2 LLM)
// ********** THIS IS THE REFACTORED ENDPOINT BASED ON THE REVISED HYBRID PLAN **********
app.post('/api/send-to-instacart', async (req, res) => {
    const { ingredients, title } = req.body; // Expect final list and title
    console.log('Received request to send final list to Instacart.');
    console.log('Final ingredients received for Instacart:', JSON.stringify(ingredients, null, 2));

    // --- Initial Checks ---
    const instacartApiKey = process.env.INSTACART_API_KEY;
    if (!ingredients || !Array.isArray(ingredients)) { // Allow empty list if user deselects all
        return res.status(400).json({ error: 'Invalid or missing ingredients data for Instacart API call.' });
    }
    if (!instacartApiKey) {
        console.error('Instacart API key missing in environment variables.');
        return res.status(500).json({ error: 'Server configuration error: Instacart API key not found.' });
    }
    // ---------------------
    
    // --- Prepare and Call Instacart API ---
    const instacartApiUrl = 'https://connect.dev.instacart.tools/idp/v1/products/products_link'; // Use DEV URL for testing
    const instacartRequestBody = {
        title: title || 'My Recipe Ingredients', 
        link_type: 'shopping_list',
        line_items: ingredients // Pass the structure directly
    };

    try {
        console.log('Sending final request to Instacart API...');
        console.log('Instacart Request Body:', JSON.stringify(instacartRequestBody, null, 2));
        console.log('Using Instacart API Key (masked):', `***${instacartApiKey.slice(-4)}`);

        const response = await axios.post(instacartApiUrl, instacartRequestBody, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${instacartApiKey}`
            }
        });

        console.log('Instacart API Response Status:', response.status);

        if (response.data && response.data.products_link_url) {
            res.json({ instacartUrl: response.data.products_link_url });
        } else {
            console.error('Instacart API response missing products_link_url:', response.data);
            throw new Error('Instacart API did not return a products_link_url.');
        }

    } catch (instacartError) {
        console.error('Error creating Instacart list:', instacartError.response ? JSON.stringify(instacartError.response.data) : instacartError.message);
        const errorDetails = instacartError.response ? instacartError.response.data : instacartError.message;
        const statusCode = instacartError.response ? instacartError.response.status : 500;
         res.status(statusCode).json({
            error: 'Failed to create Instacart list.',
            details: errorDetails,
            ingredients_sent: ingredients // Include what was sent to help debug
        });
    }
    // ------------------------------------
});

// --- NEW Function: Process Text (Anthropic Stage 1) ---
app.post('/api/process-text', async (req, res) => {
    console.log(`[Process Text Handler] ===== FUNCTION HANDLER ENTERED =====`);
    const { jobId } = req.body;
    if (!jobId) {
        console.error('[Process Text] Received request without Job ID.');
        return res.status(400).json({ error: 'Missing Job ID.' });
    }

    // Security Check
    const receivedTriggerSecret = req.headers['x-internal-trigger-secret'];
    const expectedSecret = process.env.INTERNAL_TRIGGER_SECRET || 'default-secret';
    console.log(`[Process Text Job ${jobId}] Received Trigger Secret (masked): ...${receivedTriggerSecret ? receivedTriggerSecret.slice(-4) : 'MISSING'}`);
    if (receivedTriggerSecret !== expectedSecret) {
        console.warn(`[Process Text Job ${jobId}] Invalid or missing trigger secret.`);
        return res.status(403).json({ error: 'Forbidden' });
    }

    console.log(`[Process Text Job ${jobId}] Starting text processing (Anthropic Stage 1)...`);
    let jobData;
    try {
        // --- Retrieve Job Details (including extractedText) from Redis ---
        console.log(`[Process Text Job ${jobId}] Fetching job details from Redis...`);
        if (!redis) { throw new Error('Redis client not initialized'); }
        jobData = await redis.get(jobId);
        if (!jobData) {
            console.warn(`[Process Text Job ${jobId}] Job data not found in Redis. Aborting.`);
            return res.status(200).json({ message: `Job data not found for ${jobId}, likely expired or invalid.` });
        }

        if (jobData.status !== 'vision_completed') {
            console.warn(`[Process Text Job ${jobId}] Job status is '${jobData.status}', not 'vision_completed'. Skipping text processing.`);
            return res.status(200).json({ message: `Job status (${jobData.status}) prevents text processing.` });
        }

        const { extractedText, originalFilename } = jobData; // Get extracted text
        if (!extractedText || extractedText.trim().length === 0) {
             console.warn(`[Process Text Job ${jobId}] No extracted text found in job data. Cannot proceed.`);
             // Should not happen if vision_completed status is set correctly, but handle defensively
             const failedData = { ...jobData, status: 'failed', error: 'Could not find text data passed from the previous step.', finishedAt: Date.now() };
             await redis.set(jobId, JSON.stringify(failedData));
             return res.status(200).json({ message: 'No text to process.'});
        }
        console.log(`[Process Text Job ${jobId}] Retrieved extracted text. Length: ${extractedText.length}`);
        // -------------------------------------------------------------

        // --- Anthropic API Call (Stage 1 - Initial Extraction) ---
        console.log(`[Process Text Job ${jobId}] Sending extracted text to Anthropic...`);
        const systemPromptStage1 = `You are an expert recipe parser. Analyze the following recipe text extracted via OCR and extract key information. Output ONLY a valid JSON object.`;
        const userPromptStage1 = `Recipe Text:\n---\n${extractedText}\n---\n\nFocus ONLY on the main ingredient list section(s) of the text. Extract the recipe title, yield (quantity and unit, e.g., "4 servings", "2 cups"), and a list of ingredients.\nFor each ingredient, provide:\n- quantity: The numerical value (e.g., 0.5, 30, 1). Use null if not specified or implied (like '1 lemon').\n- unit: The unit as written in the text (e.g., 'cup', 'cloves', 'tsp', 'sprigs', 'each', 'lb'). Use null if not specified.\n- ingredient: The name of the ingredient as written, including descriptive words (e.g., 'extra-virgin olive oil', 'garlic cloves, peeled', 'kosher salt'). Do NOT include quantities or units in this field.\n\nOutput ONLY a single valid JSON object with keys "title", "yield" (an object with "quantity" and "unit"), and "ingredients" (an array of objects with "quantity", "unit", "ingredient").`; // Slightly refined prompt

        let rawJsonResponse = '';
        const anthropicStartTime = Date.now(); // Start timer
        console.log(`[Process Text Job ${jobId}] Calling Anthropic API... (Timestamp: ${anthropicStartTime})`);
        try {
            rawJsonResponse = await callAnthropic(systemPromptStage1, userPromptStage1); // Using existing helper
            const anthropicEndTime = Date.now(); // End timer
            const anthropicDuration = anthropicEndTime - anthropicStartTime;
            console.log(`[Process Text Job ${jobId}] Received response from Anthropic. Duration: ${anthropicDuration}ms. (Timestamp: ${anthropicEndTime})`);
        } catch (anthropicError) {
            console.error(`[Process Text Job ${jobId}] Anthropic API call failed:`, anthropicError);
            const failedData = { ...jobData, status: 'failed', error: 'Could not understand ingredients from the text.', extractedText: extractedText, finishedAt: Date.now() };
            await redis.set(jobId, JSON.stringify(failedData));
            throw anthropicError; // Propagate to main catch
        }
        // ------------------------------------------------------

        // --- Parse Stage 1 Response ---
        let finalResult;
         try {
            const jsonMatch = rawJsonResponse.match(/```json\s*([\s\S]*?)\s*```/);
            let jsonString = rawJsonResponse.trim();
            if (jsonMatch && jsonMatch[1]) {
                jsonString = jsonMatch[1].trim();
            } else if (rawJsonResponse.startsWith('{') && rawJsonResponse.endsWith('}')) {
                 console.log(`[Process Text Job ${jobId}] Anthropic response appears to be direct JSON.`);
             } else {
                const jsonStartIndex = rawJsonResponse.indexOf('{');
                const jsonEndIndex = rawJsonResponse.lastIndexOf('}');
                if (jsonStartIndex !== -1 && jsonEndIndex !== -1 && jsonEndIndex > jsonStartIndex) {
                    jsonString = rawJsonResponse.substring(jsonStartIndex, jsonEndIndex + 1);
                    console.log(`[Process Text Job ${jobId}] Extracted potential JSON substring.`);
                } else {
                    throw new Error("Response does not contain ```json block or a valid JSON structure.");
                }
             }

            const parsedData = JSON.parse(jsonString);
            console.log(`[Process Text Job ${jobId}] Successfully parsed ${parsedData.ingredients?.length || 0} ingredients.`);

            finalResult = { // Store the successful result
                extractedText, // Keep extracted text for context if needed
                title: parsedData.title,
                yield: parsedData.yield,
                ingredients: parsedData.ingredients
            };

        } catch (parseError) {
            console.error(`[Process Text Job ${jobId}] Error parsing Stage 1 JSON response:`, parseError);
            console.error(`[Process Text Job ${jobId}] Raw Response causing parse error:\n---\n${rawJsonResponse}\n---`);
            const failedData = {
                ...jobData,
                status: 'failed',
                error: 'Could not organize the extracted ingredients.',
                rawResponse: rawJsonResponse, // Include raw response for debugging
                finishedAt: Date.now()
             };
             await redis.set(jobId, JSON.stringify(failedData));
             res.status(200).json({ message: 'Processing finished with parsing errors.' });
             return; // Exit after setting failed status
        }
        // ---------------------------

        // --- Deduplicate quantity-less ingredients (e.g., salt, pepper) ---
        const uniqueIngredients = new Map();
        const deduplicatedIngredients = [];
        if (finalResult.ingredients && Array.isArray(finalResult.ingredients)) {
            finalResult.ingredients.forEach(item => {
                const key = item.ingredient?.toLowerCase().trim();
                // Only deduplicate if quantity and unit are null/undefined
                if (item.quantity == null && item.unit == null && key) {
                    if (!uniqueIngredients.has(key)) {
                        uniqueIngredients.set(key, item);
                        deduplicatedIngredients.push(item);
                    }
                } else {
                    deduplicatedIngredients.push(item); // Keep items with quantity/unit
                }
            });
            finalResult.ingredients = deduplicatedIngredients; // Replace with deduplicated list
            console.log(`[Process Text Job ${jobId}] Deduplicated ingredient list size: ${finalResult.ingredients.length}`);
        }
        // ------------------------------------------------------------------

        // --- Update Redis with FINAL Completed Status and Result ---
        console.log(`[Process Text Job ${jobId}] Text processing successful. Updating Redis status to 'completed'.`);
        const completedData = {
            status: 'completed',
            result: finalResult, // Store the parsed recipe data
            anthropicFinishedAt: Date.now()
        };
        await redis.set(jobId, JSON.stringify(completedData));
        console.log(`[Process Text Job ${jobId}] Redis updated successfully with final result.`);
        // ---------------------------------------------------------

        // --- Added Log for Parsed Result ---
        console.log(`[Process Text Job ${jobId}] Final Parsed Result:`, JSON.stringify(finalResult, null, 2));

        res.status(200).json({ message: 'Text processing completed successfully.' });

    } catch (error) {
        console.error(`[Process Text Job ${jobId}] Error during background text processing:`, error);
        // Ensure Redis is updated to 'failed' if not already done
        if (jobData && jobData.status !== 'failed') {
            try {
                 const updatePayload = { ...jobData, status: 'failed', error: 'An error occurred while analyzing the text.', finishedAt: Date.now() };
                 await redis.set(jobId, JSON.stringify(updatePayload));
                 console.log(`[Process Text Job ${jobId}] Updated Redis status to 'failed' due to processing error.`);
             } catch (redisError) {
                 console.error(`[Process Text Job ${jobId}] CRITICAL: Failed to update Redis status to 'failed' after error:`, redisError);
             }
        }
        // Respond with 200 OK even on errors
        if (!res.headersSent) {
            res.status(200).json({ message: `Text processing failed for Job ID ${jobId}, status updated in Redis.` });
        }
    }
});

// --- End NEW Function ---

// --- New URL Processing Routes ---

// POST /api/process-url (Trigger)
app.post('/api/process-url', async (req, res) => {
    const { url } = req.body;
    let jobId = `url-${crypto.randomUUID()}`; // Define jobId early for logging
    console.log(`[${jobId}] Received request for /api/process-url`);

    if (!url) {
        console.log(`[${jobId}] Invalid request: URL is missing.`);
        return res.status(400).json({ error: 'URL is required' });
    }

    let validatedUrl;
    try {
        validatedUrl = new URL(url);
        if (!['http:', 'https:'].includes(validatedUrl.protocol)) {
             throw new Error('URL must use http or https protocol');
        }
    } catch (error) {
        console.log(`[${jobId}] Invalid request: URL format error - ${error.message}`);
        return res.status(400).json({ error: `Invalid URL format: ${error.message}` });
    }

    const jobData = {
        status: 'pending',
        inputUrl: url,
        startTime: Date.now(),
        sourceType: 'url'
    };

    try {
        console.log(`[${jobId}] Step 1: Attempting kvClient.set...`);
        await kvClient.set(jobId, jobData);
        console.log(`[${jobId}] Step 2: Initial job data set in KV for URL: ${url}`);

        // Use 3001 as the default port to match server listen
        const port = process.env.PORT || 3001; 
        console.log(`[${jobId}] Step 3: Determined port: ${port}, isVercel: ${isVercel}`);
        const triggerUrl = isVercel
            ? '/api/process-url-job'
            : `http://localhost:${port}/api/process-url-job`;
        console.log(`[${jobId}] Step 4: Constructed triggerUrl: ${triggerUrl}`);

        console.log(`[${jobId}] Step 5: Initiating fire-and-forget fetch using top-level import...`);
        // REMOVE the local require: const nodeFetch = require('node-fetch'); 
        // Use the 'fetch' variable required at the top of the file
        fetch(triggerUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ jobId }),
        }).catch(fetchError => {
            console.error(`[${jobId}] ASYNC CATCH: Error triggering background job (fetch failed):`, fetchError);
            updateJobStatus(jobId, 'failed', { error: `Failed to trigger background processing task: ${fetchError.message}` });
        });
        console.log(`[${jobId}] Step 6: Fire-and-forget fetch dispatched.`);

        console.log(`[${jobId}] Step 7: Attempting to send 202 response...`);
        res.status(202).json({ jobId });
        console.log(`[${jobId}] Step 8: Successfully sent 202 response.`);

    } catch (error) { // Catch block for SYNCHRONOUS errors in the try block
        console.error(`[${jobId}] SYNC CATCH: Error in /api/process-url try block:`, error);
        if (!res.headersSent) {
             console.log(`[${jobId}] Sending 500 error response to client.`);
             res.status(500).json({ error: 'Failed to initiate URL processing job' });
        } else {
             console.error(`[${jobId}] Headers already sent, could not send 500 error response.`);
        }
    }
});

// Helper function to parse yield strings (e.g., "16 servings", "makes 1 loaf")
function parseYieldString(yieldStr) {
    if (!yieldStr || typeof yieldStr !== 'string') return null;
    // Regex: Optional non-digits at start, capture first number (int/float), capture subsequent words/hyphens as unit
    const match = yieldStr.match(/^[^\d]*?(\d+(?:[.,]\d+)?)\s*([\w\s-]+)/);
    if (match && match[1]) {
        const quantity = parseFloat(match[1].replace(',', '.')) || null;
        // Clean up unit: trim whitespace, remove leading/trailing punctuation often used ("(makes...)")
        const unit = match[2] ? match[2].trim().replace(/^[()[\]]+|[()[\]]+$/g, '').trim().toLowerCase() : null;
        if (quantity) {
            // Basic pluralization check for common units
            const unitSingular = (unit?.endsWith('s') && !['servings'].includes(unit)) ? unit.slice(0, -1) : unit;
            return { quantity, unit: (quantity === 1 ? unitSingular : unit) || null };
        }
    }
    // Fallback: If no unit found after number, just return quantity
    const quantityOnlyMatch = yieldStr.match(/^[^\d]*?(\d+(?:[.,]\d+)?)/);
    if (quantityOnlyMatch && quantityOnlyMatch[1]) {
        return { quantity: parseFloat(quantityOnlyMatch[1].replace(',', '.')) || null, unit: null };
    }
    return null; // Could not parse
}

// POST /api/process-url-job (Background Worker)
app.post('/api/process-url-job', async (req, res) => {
    const { jobId } = req.body;
    if (!jobId) {
        console.error('Received process-url-job request without jobId');
        return res.status(400).json({ error: 'Job ID is required' });
    }

    console.log(`[${jobId}] Starting URL background processing...`);
    let jobData;
    try {
        jobData = await kvClient.get(jobId);
        // Check if job exists and hasn't already finished
        if (!jobData || jobData.status === 'completed' || jobData.status === 'failed') {
             console.warn(`[${jobId}] Job not found or already processed (${jobData?.status}). Skipping.`);
             return res.status(200).json({ message: 'Job already processed or not found' }); // Acknowledge request but do nothing
        }

        const { inputUrl } = jobData;
        await updateJobStatus(jobId, 'processing_started'); // New status
        console.log(`[${jobId}] Processing URL: ${inputUrl}`);

        // --- Step 1: Fetch HTML ---
        let htmlContent = '';
        let finalUrl = inputUrl; // Track final URL after redirects
        try {
             await updateJobStatus(jobId, 'fetching_html');
             console.log(`[${jobId}] Fetching HTML from ${inputUrl}...`);
             const response = await fetch(inputUrl, {
                 headers: {
                     // Add a realistic User-Agent to reduce chance of being blocked
                     'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                     'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                     'Accept-Language': 'en-US,en;q=0.9',
                     'Connection': 'keep-alive',
                     'DNT': '1', // Do Not Track header
                     'Upgrade-Insecure-Requests': '1'
                 },
                 redirect: 'follow', // Follow redirects
                 timeout: 15000 // Add a timeout (15 seconds)
             });
             finalUrl = response.url; // Store final URL after redirects

             console.log(`[${jobId}] Fetch response status: ${response.status}, Final URL: ${finalUrl}`);

             if (!response.ok) {
                 throw new Error(`HTTP error ${response.status} ${response.statusText}`);
             }
             const contentType = response.headers.get('content-type');
             if (!contentType || !contentType.toLowerCase().includes('text/html')) {
                 throw new Error(`Expected HTML content, but got ${contentType}`);
             }
             htmlContent = await response.text();
             console.log(`[${jobId}] HTML content fetched (${htmlContent.length} bytes).`);

             // Basic Login Wall Check (Refined slightly)
             const lowerHtml = htmlContent.toLowerCase();
             const lowerFinalUrl = finalUrl.toLowerCase();
             if (lowerHtml.includes('log in') || lowerHtml.includes('sign in') || lowerHtml.includes('create account') || lowerFinalUrl.includes('/login') || lowerFinalUrl.includes('/signin') || lowerFinalUrl.includes('/account') ) {
                 // More specific checks might be needed based on common login page patterns
                 console.warn(`[${jobId}] Potential login wall detected.`);
                  throw new Error('Potential login wall detected on page. Authentication required.');
             }

        } catch (fetchError) {
             console.error(`[${jobId}] Error fetching or validating HTML:`, fetchError);
             await updateJobStatus(jobId, 'failed', { error: `Failed to fetch or validate URL: ${fetchError.message}` });
             return res.status(200).json({ message: 'Fetch failed, job updated.' }); // Acknowledge worker request
        }

        let recipeResult = null; // Variable to hold the final extracted recipe data

        // --- Step 2: Attempt JSON-LD Extraction ---
        try {
             await updateJobStatus(jobId, 'parsing_jsonld');
             console.log(`[${jobId}] Attempting JSON-LD extraction...`);
             const $ = cheerio.load(htmlContent);
             let recipeJson = null;

             $('script[type="application/ld+json"]').each((index, element) => {
                 try {
                     const scriptContent = $(element).html();
                     if (!scriptContent) return;
                     const jsonData = JSON.parse(scriptContent);

                     function findRecipe(data) { /* ... (findRecipe function from previous attempt) ... */
                         if (Array.isArray(data)) {
                             for (const item of data) {
                                 const found = findRecipe(item);
                                 if (found) return found;
                             }
                         } else if (typeof data === 'object' && data !== null) {
                             if (data['@type'] === 'Recipe' || (Array.isArray(data['@type']) && data['@type'].includes('Recipe'))) {
                                 return data;
                             }
                             if (data['@graph']) { // Check within @graph array
                                 return findRecipe(data['@graph']);
                             }
                         }
                         return null;
                     }


                     recipeJson = findRecipe(jsonData);
                     if (recipeJson) {
                         console.log(`[${jobId}] Found Recipe JSON-LD object.`);
                         return false; // Stop iterating once found
                     }
                 } catch (parseError) {
                     console.warn(`[${jobId}] Error parsing JSON-LD script tag:`, parseError.message);
                 }
             });

             if (recipeJson && recipeJson.recipeIngredient && Array.isArray(recipeJson.recipeIngredient) && recipeJson.recipeIngredient.length > 0) {
                 console.log(`[${jobId}] Extracting title, yield, and ingredients from JSON-LD.`);
                 const title = recipeJson.name || 'Recipe from URL';

                 // --- Updated Yield Parsing Logic ---
                 let parsedYield = null; // Default to null object
                 if (recipeJson.recipeYield) {
                     const rawYield = recipeJson.recipeYield;
                     console.log(`[${jobId}] Raw JSON-LD yield:`, rawYield);

                     if (typeof rawYield === 'object' && rawYield !== null && !Array.isArray(rawYield)) {
                        // Try common object patterns (schema.org examples)
                         const quant = rawYield.value ?? rawYield.yieldValue ?? rawYield.valueReference?.value ?? null;
                         const unit = rawYield.unitText ?? rawYield.unitCode ?? rawYield.valueReference?.unitText ?? null;
                         if (quant !== null) {
                             const quantityNum = parseFloat(String(quant).replace(',', '.')) || null;
                             if (quantityNum) { // Check if parsing was successful
                                 parsedYield = { quantity: quantityNum, unit: unit || null };
                             }
                         }
                         // If parsing object failed, maybe it has a string representation?
                         if (!parsedYield && typeof rawYield.description === 'string') { 
                             parsedYield = parseYieldString(rawYield.description);
                         }
                     } else if (typeof rawYield === 'string') {
                        parsedYield = parseYieldString(rawYield);
                     } else if (Array.isArray(rawYield) && rawYield.length > 0) {
                        // --- Refined Array Handling: Prioritize element with digits and letters ---
                        let elementToParse = rawYield[0]; // Default to first
                        const bestElement = rawYield.find(el => typeof el === 'string' && /\d/.test(el) && /[a-zA-Z]/.test(el));
                        if (bestElement) {
                            elementToParse = bestElement; // Use the element with both numbers and text
                            console.log(`[${jobId}] Prioritizing yield element with text: "${elementToParse}"`);
                        }
                        // ----------------------------------------------------------------------

                        // Now parse the selected element
                        if (typeof elementToParse === 'string') {
                            parsedYield = parseYieldString(elementToParse);
                        } else if (typeof elementToParse === 'object' && elementToParse !== null) {
                            // (Keep object parsing logic if needed for non-string array elements)
                            const quant = elementToParse.value ?? elementToParse.yieldValue ?? null;
                            const unit = elementToParse.unitText ?? elementToParse.unitCode ?? null;
                            if (quant !== null) {
                                 const quantityNum = parseFloat(String(quant).replace(',', '.')) || null;
                                 if (quantityNum) {
                                     parsedYield = { quantity: quantityNum, unit: unit || null };
                                 }
                            }
                        }
                     }
                 }
                 console.log(`[${jobId}] Parsed JSON-LD yield object:`, parsedYield);
                 // --- End Updated Yield Parsing Logic ---

                 const ingredientStrings = recipeJson.recipeIngredient.filter(s => typeof s === 'string' && s.trim() !== ''); // Ensure strings

                 if (ingredientStrings.length > 0) {
                    // ** Use updated prompt **
                    // Changed key 'name' to 'ingredient' for consistency
                    const ingredientsPrompt = `The following ingredient strings were extracted from a recipe's structured data (JSON-LD). Parse them for grocery shopping list creation. For each string, identify the quantity (number or null), unit (string or null, using common units like cup, tsp, tbsp, oz, lb, g, kg, each, etc.), and the ingredient description (string). Ingredient List:\\n${ingredientStrings.map(s => `- ${s}`).join('\\n')}\\n\\nCRITICAL INSTRUCTION: Respond ONLY with a single **valid** JSON array [{quantity, unit, ingredient}]. Do NOT include ANY other text, explanations, or markdown formatting. Ensure the JSON syntax is perfect.`;
                    // Changed key 'name' to 'ingredient' for consistency
                    const ingredientsSystemPrompt = "You are an expert ingredient parser assisting with grocery list creation for Instacart. Convert raw ingredient strings into a JSON array of objects [{quantity, unit, ingredient}]. Use null for missing quantity or unit. Respond ONLY with the **valid** JSON array itself, starting with [ and ending with ].";

                    await updateJobStatus(jobId, 'llm_parsing_ingredients');
                    const llmIngredientsResponse = await callAnthropic(ingredientsSystemPrompt, ingredientsPrompt);

                    // ** Use Correction Helper **
                    const llmIngredientsResult = await parseAndCorrectJson(jobId, llmIngredientsResponse, 'array'); // <-- INTEGRATED CALL

                    if (llmIngredientsResult) { // Check if correction helper returned a result
                        // Changed mapping from 'name' to 'ingredient'
                        const validIngredients = llmIngredientsResult.filter(item => typeof item === 'object' && item !== null && 'ingredient' in item)
                            .map(item => ({ quantity: item.quantity ?? null, unit: item.unit ?? null, ingredient: item.ingredient })); // Ensure nulls and use 'ingredient' key
                        if (validIngredients.length > 0) {
                            // Use the parsedYield from above
                            recipeResult = { title, yield: parsedYield, ingredients: validIngredients, sourceUrl: finalUrl };
                            console.log(`[${jobId}] Successfully parsed ${validIngredients.length} ingredients via LLM from JSON-LD (after potential correction).`);
                        } else { console.warn(`[${jobId}] LLM JSON-LD result was valid array, but content lacked required structure (missing 'ingredient' key?).`); } // Updated warning
                    } else { console.warn(`[${jobId}] Could not get valid ingredient array from LLM for JSON-LD, even after correction attempt.`); }
                 } else { console.log(`[${jobId}] No valid ingredient strings found in JSON-LD.`); }
             } else { console.log(`[${jobId}] No valid Recipe JSON-LD found or ingredients missing/empty.`); }
        } catch (jsonLdError) { console.error(`[${jobId}] Error during JSON-LD processing phase:`, jsonLdError); }

        // --- Step 3: Fallback to Readability + LLM ---
        if (!recipeResult) { // Only run if JSON-LD didn't yield a result
            try {
                 await updateJobStatus(jobId, 'parsing_readability');
                 console.log(`[${jobId}] JSON-LD failed or insufficient. Falling back to Readability + LLM...`);
                 const doc = new JSDOM(htmlContent, { url: finalUrl }); // Provide URL for relative path resolution
                 const reader = new Readability(doc.window.document);
                 const article = reader.parse();

                 if (!article || !article.textContent || article.textContent.trim().length < 100) { // Add length check
                     throw new Error(`Readability could not extract sufficient main content (Length: ${article?.textContent?.trim()?.length || 0}).`);
                 }

                 console.log(`[${jobId}] Readability extracted content (Title: ${article.title}, Length: ${article.textContent.length}).`);
                 // Limit text length to avoid excessive token usage and cost
                 const maxContentLength = 18000; // Approx limit for Haiku context, leaving room for prompt
                 const mainTextContent = article.textContent.substring(0, maxContentLength);
                 const fallbackTitle = article.title || 'Recipe from URL'; // Use title from Readability

                 // ** Use updated prompt **
                 // Updated prompt to request yield as an object and ingredient key
                 const fallbackPrompt = `Please analyze the following text content from a recipe webpage to extract information for a grocery list. Identify: \\n1. The recipe title (string).\\n2. The recipe yield as a JSON object { "quantity": number|null, "unit": string|null } (e.g., { "quantity": 4, "unit": "servings" }, { "quantity": 1, "unit": "dozen" }, or null if unclear).\\n3. A list of ingredients. For each ingredient, determine the quantity (number or null), unit (string or null, use common units like cup, tsp, tbsp, oz, lb, g, kg, each, etc.), and the ingredient description (string, use key 'ingredient'). \\nIgnore cooking instructions, comments, ads, and other non-essential text. \\nRecipe Text:\\n---\\n${mainTextContent}\\n---\\n\\nCRITICAL INSTRUCTION: Respond ONLY with a single **valid** JSON object containing the keys "title", "yield" (object or null), and "ingredients" (array of objects with keys {quantity, unit, ingredient}). Ensure the JSON syntax is perfect. Do NOT include ANY other text, explanations, or markdown formatting.`;
                 // Updated system prompt for yield object and ingredient key
                 const fallbackSystemPrompt = "You are an expert recipe parser assisting with grocery list creation for Instacart. Extract the recipe title, yield, and ingredients from the provided text. Output ONLY a **valid** JSON object with keys `title` (string), `yield` (object `{ quantity, unit }` or null), and `ingredients` (array of objects `[{quantity, unit, ingredient}]`). Use null for missing quantity or unit values.";

                 await updateJobStatus(jobId, 'llm_parsing_fallback');
                 const llmFallbackResponse = await callAnthropic(fallbackSystemPrompt, fallbackPrompt);

                 // ** Use Correction Helper **
                 const llmFallbackResult = await parseAndCorrectJson(jobId, llmFallbackResponse, 'object'); // <-- INTEGRATED CALL

                 if (llmFallbackResult && Array.isArray(llmFallbackResult.ingredients)) { // Check if correction helper returned a result
                     // Changed filter/map to use 'ingredient' key
                     const validIngredients = llmFallbackResult.ingredients.filter(item => typeof item === 'object' && item !== null && 'ingredient' in item && item.ingredient.trim() !== '')
                         .map(item => ({ quantity: item.quantity ?? null, unit: item.unit ?? null, ingredient: item.ingredient })); // Ensure nulls and use 'ingredient' key
                     if (validIngredients.length > 0) {
                         // --- Correctly assign yield object --- 
                         const parsedYield = (typeof llmFallbackResult.yield === 'object' && llmFallbackResult.yield !== null) 
                                               ? { quantity: llmFallbackResult.yield.quantity ?? null, unit: llmFallbackResult.yield.unit ?? null }
                                               : null; // Default to null if not a valid object
                         recipeResult = { 
                             title: llmFallbackResult.title || fallbackTitle, 
                             yield: parsedYield, // Assign the parsed object or null
                             ingredients: validIngredients, 
                             sourceUrl: finalUrl 
                         };
                         // -------------------------------------
                         console.log(`[${jobId}] Successfully parsed ${validIngredients.length} ingredients via LLM fallback (after potential correction). Yield:`, parsedYield);
                     } else {
                         console.warn(`[${jobId}] LLM fallback returned ingredients array, but items lacked structure or the 'ingredient' key. Result:`, llmFallbackResult); // Updated warning
                         throw new Error('LLM fallback extracted no valid ingredients.');
                     }
                 } else {
                     console.warn(`[${jobId}] LLM fallback failed to return valid structured data (missing ingredients array?). Result:`, llmFallbackResult); // Updated warning
                     throw new Error('Failed to extract recipe details using fallback LLM method.');
                 }
            } catch (fallbackError) {
                 console.error(`[${jobId}] Error during Readability/Fallback LLM processing:`, fallbackError);
                 await updateJobStatus(jobId, 'failed', { error: `Fallback extraction failed: ${fallbackError.message}` });
                 return res.status(200).json({ message: 'Fallback failed, job updated.' });
            }
        }

        // --- Final Update ---
        if (recipeResult) {
             await updateJobStatus(jobId, 'completed', { result: recipeResult });
             console.log(`[${jobId}] Processing complete. Final result saved:`, recipeResult);
        } else {
             // This path should ideally not be reached if fallback error handling is correct
             console.error(`[${jobId}] Reached end of processing unexpectedly without a result or explicit failure.`);
             await updateJobStatus(jobId, 'failed', { error: 'Processing finished unexpectedly without extracting a valid recipe.' });
        }

        res.status(200).json({ message: 'Processing finished acknowledged.' }); // Acknowledge worker request

    } catch (error) {
        // Catch unexpected errors during the overall worker process setup/logic flow
        console.error(`[${jobId}] CRITICAL error during URL background processing:`, error);
        // Attempt to update KV status if jobData was retrieved
        if (jobId) { // Check if jobId exists before trying to update status
            await updateJobStatus(jobId, 'failed', { error: `Unexpected server error during processing: ${error.message}` });
        }
        // Respond with error, mainly for server logs as client isn't waiting
        res.status(500).json({ error: 'Background processing failed critically' });
    }
});

// Basic route
app.get('/', (req, res) => {
    res.send('Recipe-to-Cart Backend is running!');
});

// Start server
app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
    if (!isVercel) {
        console.log(`Local development mode active (using mock KV).`);
    }
});