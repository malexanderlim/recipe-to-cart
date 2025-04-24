// backend/controllers/processTextWorkerController.js
// ----------------------------------------------------------------------------
//  WORKER CONTROLLER for processing text via QStash Trigger
// ----------------------------------------------------------------------------

/* Internal services & utils */
const { redis } = require('../services/redisService');
const { callAnthropic } = require('../services/anthropicService');

// --- Helper for Anthropic retry (Moved from old controller) ---
async function callAnthropicWithRetry(systemPrompt, userPrompt, jobId, model = 'claude-3-haiku-20240307', maxRetries = 2, delay = 2000) {
    let attempts = 0;
    while (attempts <= maxRetries) {
        attempts++;
        try {
            console.log(`[AnthropicRetry Job ${jobId}] Attempt ${attempts} to call Anthropic model ${model}`);
            const response = await callAnthropic(systemPrompt, userPrompt, model);
            console.log(`[AnthropicRetry Job ${jobId}] Attempt ${attempts} successful.`);
            return response; // Return successful response
        } catch (error) {
            console.warn(`[AnthropicRetry Job ${jobId}] Attempt ${attempts} failed. Error:`, error);
            const isRetryable = error.status >= 500 || error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET';
            
            if (isRetryable && attempts <= maxRetries) {
                console.log(`[AnthropicRetry Job ${jobId}] Retryable error detected. Retrying in ${delay}ms... (${maxRetries - attempts} retries left)`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                console.error(`[AnthropicRetry Job ${jobId}] Not retrying or retries exhausted. Throwing error.`);
                throw error;
            }
        }
    }
    throw new Error(`[AnthropicRetry Job ${jobId}] Exceeded max retries (${maxRetries}) without success calling Anthropic.`);
}
// --- END Helper ---

/**
 * Process text extracted from images (triggered by QStash)
 * This function assumes the request has already been verified by QStash middleware.
 */
async function handleProcessText(req, res) {
    console.log(`---> /api/process-text-worker FUNCTION ENTRY <---`); // Updated log
    const { jobId } = req.body; // Job ID comes from QStash message body
    
    if (!jobId) {
        console.error('[Process Text Worker] Received QStash message without Job ID in body.');
        // QStash expects a 2xx response to signal success, or non-2xx/timeout for retry.
        // Sending 400 will cause QStash to retry, which might not be desired here.
        // Sending 200 but logging the error is safer to prevent infinite retries for bad messages.
        return res.status(200).json({ error: 'Missing Job ID in request body.' }); 
    }

    console.log(`[Process Text Worker Job ${jobId}] Starting text processing (Anthropic Stage 1)...`);
    let jobData;
    try {
        // --- Retrieve Job Details (including extractedText) from Redis ---
        console.log(`[Process Text Worker Job ${jobId}] Fetching job details from Redis...`);
        if (!redis) { throw new Error('Redis client not initialized'); }
        jobData = await redis.get(jobId);
        if (!jobData) {
            console.warn(`[Process Text Worker Job ${jobId}] Job data not found in Redis. Aborting task.`);
            // Acknowledge QStash message, job state is handled by timeout/frontend logic.
            return res.status(200).json({ message: `Job data not found for ${jobId}, likely expired or invalid.` });
        }

        if (jobData.status !== 'vision_completed') {
            console.warn(`[Process Text Worker Job ${jobId}] Job status is '${jobData.status}', not 'vision_completed'. Skipping text processing.`);
            // Acknowledge QStash message, job is already processed or in an unexpected state.
            return res.status(200).json({ message: `Job status (${jobData.status}) prevents text processing.` });
        }

        const { extractedText, originalFilename } = jobData; 
        if (!extractedText || extractedText.trim().length === 0) {
            console.warn(`[Process Text Worker Job ${jobId}] No extracted text found in job data. Cannot proceed.`);
            const failedData = { ...jobData, status: 'failed', error: 'Could not find text data passed from the previous step.', finishedAt: Date.now() };
            await redis.set(jobId, JSON.stringify(failedData));
            // Acknowledge QStash, status updated.
            return res.status(200).json({ message: 'No text to process.'});
        }
        console.log(`[Process Text Worker Job ${jobId}] Retrieved extracted text. Length: ${extractedText.length}`);
        // -------------------------------------------------------------

        // --- Anthropic API Call (Stage 1 - Initial Extraction) ---
        console.log(`[Process Text Worker Job ${jobId}] Sending extracted text to Anthropic...`);
        const systemPromptStage1 = `You are an expert recipe parser. Analyze the following recipe text extracted via OCR and extract key information. Output ONLY a valid JSON object.`;
        const userPromptStage1 = `Recipe Text:\n---\n${extractedText}\n---\n\nFocus ONLY on the main ingredient list section(s) and yield/servings information of the text. Extract the recipe title, yield information, and a list of ingredients.\nFor the **yield**, provide an object containing:\n- quantity: The primary numerical value associated with the yield (e.g., 4, 2). Use the lower number if a range (e.g., 4-6 serves -> 4). Use null if no clear number.\n- unit: The most relevant unit associated with the quantity (e.g., 'servings', 'cups', 'persons'). Use null if not applicable.\n- original_yield_string: The exact phrase describing the yield/servings as written in the text (e.g., "4 to 6 as a side dish", "MAKES 2 cups", "Serves 4"). Use null if none found.\n\nFor each **ingredient**, provide an object containing:\n- quantity: The numerical value (e.g., 0.5, 30, 1). Use null if not specified or implied (like '1 lemon').\n- unit: The unit as written in the text (e.g., 'cup', 'cloves', 'tsp', 'sprigs', 'each', 'lb'). Use null if not specified.\n- ingredient: The name of the ingredient as written, including descriptive words (e.g., 'extra-virgin olive oil', 'garlic cloves, peeled', 'kosher salt'). Do NOT include quantities or units in this field.\n\nOutput ONLY a single valid JSON object with keys "title", "yield" (an object with "quantity", "unit", and "original_yield_string"), and "ingredients" (an array of objects with "quantity", "unit", "ingredient").`; 

        let rawJsonResponse = '';
        const anthropicStartTime = Date.now();
        console.log(`[Process Text Worker Job ${jobId}] Calling Anthropic API... (Timestamp: ${anthropicStartTime})`);
        try {
            rawJsonResponse = await callAnthropicWithRetry(systemPromptStage1, userPromptStage1, jobId); 
            const anthropicEndTime = Date.now();
            const anthropicDuration = anthropicEndTime - anthropicStartTime;
            console.log(`[Process Text Worker Job ${jobId}] Received response from Anthropic (potentially after retries). Total Duration: ${anthropicDuration}ms. (Timestamp: ${anthropicEndTime})`);
        } catch (anthropicError) {
            console.error(`[Process Text Worker Job ${jobId}] Anthropic API call failed AFTER retries:`, anthropicError);
            const failedData = { 
                ...jobData, 
                status: 'failed', 
                error: 'Could not understand ingredients from the text after multiple attempts.',
                extractedText: extractedText, 
                finishedAt: Date.now() 
            };
            await redis.set(jobId, JSON.stringify(failedData));
            // Let QStash retry based on its policy by returning a non-2xx status
            // throw anthropicError; // Option 1: Let original error propagate (might cause retry)
            return res.status(500).json({ error: 'Anthropic API call failed after retries.' }); // Option 2: Explicit 500 for retry
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
                console.log(`[Process Text Worker Job ${jobId}] Anthropic response appears to be direct JSON.`);
            } else {
                const jsonStartIndex = rawJsonResponse.indexOf('{');
                const jsonEndIndex = rawJsonResponse.lastIndexOf('}');
                if (jsonStartIndex !== -1 && jsonEndIndex !== -1 && jsonEndIndex > jsonStartIndex) {
                    jsonString = rawJsonResponse.substring(jsonStartIndex, jsonEndIndex + 1);
                    console.log(`[Process Text Worker Job ${jobId}] Extracted potential JSON substring.`);
                } else {
                    throw new Error("Response does not contain ```json block or a valid JSON structure.");
                }
            }

            const parsedData = JSON.parse(jsonString);
            console.log(`[Process Text Worker Job ${jobId}] Successfully parsed ${parsedData.ingredients?.length || 0} ingredients.`);

            finalResult = { 
                extractedText,
                title: parsedData.title,
                yield: parsedData.yield,
                ingredients: parsedData.ingredients
            };

        } catch (parseError) {
            console.error(`[Process Text Worker Job ${jobId}] Error parsing Stage 1 JSON response:`, parseError);
            console.error(`[Process Text Worker Job ${jobId}] Raw Response causing parse error:\n---\n${rawJsonResponse}\n---`);
            const failedData = {
                ...jobData,
                status: 'failed',
                error: 'Could not organize the extracted ingredients.',
                rawResponse: rawJsonResponse, 
                finishedAt: Date.now()
            };
            await redis.set(jobId, JSON.stringify(failedData));
            // Respond 500 to potentially trigger QStash retry if parsing is intermittent?
            // Or 200 if parsing failure is likely permanent for this input?
            // Let's go with 500 for now, assuming parsing might be fixable or retryable.
            return res.status(500).json({ message: 'Processing finished with parsing errors.' }); 
        }
        // ---------------------------

        // --- Deduplicate quantity-less ingredients ---
        const uniqueIngredients = new Map();
        const deduplicatedIngredients = [];
        if (finalResult.ingredients && Array.isArray(finalResult.ingredients)) {
            finalResult.ingredients.forEach(item => {
                const key = item.ingredient?.toLowerCase().trim();
                if (item.quantity == null && item.unit == null && key) {
                    if (!uniqueIngredients.has(key)) {
                        uniqueIngredients.set(key, item);
                        deduplicatedIngredients.push(item);
                    }
                } else {
                    deduplicatedIngredients.push(item);
                }
            });
            finalResult.ingredients = deduplicatedIngredients;
            console.log(`[Process Text Worker Job ${jobId}] Deduplicated ingredient list size: ${finalResult.ingredients.length}`);
        }
        // ------------------------------------------------------------------

        // --- Update Redis with FINAL Completed Status and Result ---
        console.log(`[Process Text Worker Job ${jobId}] Text processing successful. Updating Redis status to 'completed'.`);
        const completedData = {
            ...jobData,
            status: 'completed',
            result: finalResult,
            anthropicFinishedAt: Date.now()
        };
        await redis.set(jobId, JSON.stringify(completedData));
        console.log(`[Process Text Worker Job ${jobId}] Redis updated successfully with final result.`);
        console.log(`[Process Text Worker Job ${jobId}] Final Parsed Result:`, JSON.stringify(finalResult, null, 2));
        // ---------------------------------------------------------

        // Signal success to QStash
        res.status(200).json({ message: 'Text processing completed successfully.' });

    } catch (error) {
        console.error(`[Process Text Worker Job ${jobId}] Error during background text processing:`, error);
        // Ensure Redis is updated to 'failed' if not already done
        if (jobData && jobData.status !== 'failed') {
            try {
                const updatePayload = { ...jobData, status: 'failed', error: 'An error occurred while analyzing the text.', finishedAt: Date.now() };
                await redis.set(jobId, JSON.stringify(updatePayload));
                console.log(`[Process Text Worker Job ${jobId}] Updated Redis status to 'failed' due to processing error.`);
            } catch (redisError) {
                console.error(`[Process Text Worker Job ${jobId}] CRITICAL: Failed to update Redis status to 'failed' after error:`, redisError);
            }
        }
        // Respond with 500 to signal failure to QStash and potentially trigger retry
        if (!res.headersSent) {
            res.status(500).json({ message: `Text processing failed for Job ID ${jobId}, status updated in Redis.` });
        }
    }
}

module.exports = {
    handleProcessText
}; 