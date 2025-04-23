// backend/controllers/processTextController.js
// ----------------------------------------------------------------------------
//  FULL "/api/process-text" CONTROLLER – restored from legacy server.js
// ----------------------------------------------------------------------------

/* Internal services & utils */
const { redis } = require('../services/redisService');
const { callAnthropic } = require('../services/anthropicService');

/**
 * Process text extracted from images by Google Vision (Stage 1 - Initial Extraction)
 * Called as background worker by /api/process-image
 */
async function processText(req, res) {
    console.log(`---> /api/process-text FUNCTION ENTRY <---`);
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
        const userPromptStage1 = `Recipe Text:\n---\n${extractedText}\n---\n\nFocus ONLY on the main ingredient list section(s) of the text. Extract the recipe title, yield (quantity and unit, e.g., "4 servings", "2 cups"), and a list of ingredients.\nFor each ingredient, provide:\n- quantity: The numerical value (e.g., 0.5, 30, 1). Use null if not specified or implied (like '1 lemon').\n- unit: The unit as written in the text (e.g., 'cup', 'cloves', 'tsp', 'sprigs', 'each', 'lb'). Use null if not specified.\n- ingredient: The name of the ingredient as written, including descriptive words (e.g., 'extra-virgin olive oil', 'garlic cloves, peeled', 'kosher salt'). Do NOT include quantities or units in this field.\n\nOutput ONLY a single valid JSON object with keys "title", "yield" (an object with "quantity" and "unit"), and "ingredients" (an array of objects with "quantity", "unit", "ingredient").`; 

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
            ...jobData,
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
}

module.exports = {
    processText
}; 