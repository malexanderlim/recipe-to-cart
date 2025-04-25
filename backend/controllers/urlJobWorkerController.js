const { Receiver } = require("@upstash/qstash");
const { redis } = require("../services/redisService");
const jsdom = require("jsdom");
const { Readability } = require("@mozilla/readability");
const cheerio = require("cheerio");
const axios = require("axios"); // Using axios as per original skeleton
const { callAnthropic } = require('../services/anthropicService');
const { parseAndCorrectJson } = require('../utils/jsonUtils');

// --- Initialize QStash Receiver ---
const qstashReceiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
});

// --- Helper Functions (Adapted from old controller) ---

// Helper to update Redis status
async function updateUrlJobStatus(jobId, status, data = {}) {
    try {
        const currentData = await redis.get(jobId) || {};
        const updatedData = { ...currentData, status, ...data, lastUpdatedAt: Date.now() };
        if (status === 'failed' || status === 'completed') {
            updatedData.finishedAt = Date.now();
            if (updatedData.startTime) {
                console.log(`[Worker - URL Job ${jobId}] Job finished with status ${status} in ${updatedData.finishedAt - updatedData.startTime}ms`);
            } else {
                console.log(`[Worker - URL Job ${jobId}] Job finished with status ${status}.`);
            }
        } else {
             console.log(`[Worker - URL Job ${jobId}] Status updated to ${status}.`);
        }
        await redis.set(jobId, JSON.stringify(updatedData), { ex: 86400 });
    } catch (redisError) {
        console.error(`[Worker - URL Job ${jobId}] Failed to update Redis status to '${status}':`, redisError);
    }
}

// Helper to parse yield string
function parseYieldString(yieldStr) {
    if (!yieldStr || typeof yieldStr !== 'string') return null;
    const match = yieldStr.match(/^[^\d]*?(\d+(?:[.,]\d+)?)\s*([\w\s-]+)/);
    if (match && match[1]) {
      const quantity = parseFloat(match[1].replace(',', '.')) || null;
      const unitRaw = match[2] ? match[2].trim().replace(/^[()[\]]+|[()[\]]+$/g, '').trim().toLowerCase() : null;
      if (quantity) {
        const unitSingular = unitRaw && unitRaw.endsWith('s') && !['servings'].includes(unitRaw) ? unitRaw.slice(0, -1) : unitRaw;
        return { quantity, unit: quantity === 1 ? unitSingular : unitRaw || null };
      }
    }
    const qtyOnly = yieldStr.match(/^[^\d]*?(\d+(?:[.,]\d+)?)/);
    if (qtyOnly && qtyOnly[1]) {
      return { quantity: parseFloat(qtyOnly[1].replace(',', '.')) || null, unit: null };
    }
    return null;
  }

// Helper to find Recipe object in JSON-LD
function findRecipeJsonLd(data) {
    if (Array.isArray(data)) {
      for (const item of data) {
        const found = findRecipeJsonLd(item);
        if (found) return found;
      }
    } else if (data && typeof data === 'object') {
      if (data['@type'] === 'Recipe' || (Array.isArray(data['@type']) && data['@type'].includes('Recipe'))) return data;
      if (data['@graph']) return findRecipeJsonLd(data['@graph']);
    }
    return null;
}

// --- Main Worker Logic ---
const processUrlJobWorker = async (req, res) => {
    // --- QStash Verification ---
    let jobId;
    try {
        const signature = req.headers["upstash-signature"];
        const rawBody = req.body;
        const isValid = await qstashReceiver.verify({ signature, body: JSON.stringify(rawBody) });
        if (!isValid) {
            console.error("[Worker - URL] QStash signature verification failed");
            return res.status(401).send("Unauthorized");
        }
        jobId = rawBody.jobId;
        if (!jobId) {
            console.error("[Worker - URL] Missing jobId in request body");
            return res.status(400).send("Missing jobId");
        }
        console.log(`[Worker - URL Job ${jobId}] Processing...`);
    } catch (verifyError) {
        console.error("[Worker - URL] Error during QStash verification:", verifyError);
        return res.status(500).send("Verification Error");
    }
    // --- End Verification ---

    let jobData;
    try {
        // --- 1. Retrieve Job Data from Redis ---
        jobData = await redis.get(jobId);
        if (!jobData || !jobData.inputUrl || jobData.status !== 'pending') {
            console.warn(`[Worker - URL Job ${jobId}] Job not found, invalid, or not pending (${jobData?.status}). Skipping.`);
            return res.status(200).send("Job not found, invalid, or already processed.");
        }
        const { inputUrl } = jobData;
        await updateUrlJobStatus(jobId, 'processing_started');
        console.log(`[Worker - URL Job ${jobId}] Processing URL: ${inputUrl}`);

        // --- 2. Fetch HTML ---
        let htmlContent = '';
        let finalUrl = inputUrl;
        await updateUrlJobStatus(jobId, 'fetching_html');
        try {
            const response = await axios.get(inputUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 Recipe-to-Cart Bot' }, // Simplified User-Agent
                maxRedirects: 5,
                timeout: 15000, // 15 seconds
            });
            finalUrl = response.request.res.responseUrl || finalUrl; // Get final URL after redirects
            htmlContent = response.data;
            console.log(`[Worker - URL Job ${jobId}] Fetch successful. Final URL: ${finalUrl}. Size: ${htmlContent.length} bytes.`);
            // Basic login wall check
             const lower = htmlContent.toLowerCase();
             const lURL = finalUrl.toLowerCase();
             if ( lower.includes('log in') || lower.includes('sign in') || lURL.includes('/login') || lURL.includes('/signin') ) {
               throw new Error('Potential login-wall detected.');
             }
        } catch (fetchError) {
            console.error(`[Worker - URL Job ${jobId}] Fetch failed:`, fetchError.message);
            await updateUrlJobStatus(jobId, 'failed', { error: `Failed to fetch or access URL: ${fetchError.message}` });
            return res.status(200).send("Fetch failed, job status updated."); // Acknowledge QStash
        }

        // --- 3. Attempt JSON-LD Extraction ---
        let recipeResult = null;
        await updateUrlJobStatus(jobId, 'parsing_jsonld');
        try {
            const $ = cheerio.load(htmlContent);
            let recipeJson = null;
            $('script[type="application/ld+json"]').each((_, el) => {
                if (recipeJson) return;
                try {
                    const parsed = JSON.parse($(el).html() || '{}');
                    recipeJson = findRecipeJsonLd(parsed);
                } catch { /* Ignore parsing errors */ }
            });

            if (recipeJson?.recipeIngredient?.length) {
                const ingredientStrings = recipeJson.recipeIngredient.map(String).filter(Boolean);
                if (ingredientStrings.length > 0) {
                    const title = recipeJson.name || 'Recipe from URL';
                    let parsedYield = null;
                    if (recipeJson.recipeYield) {
                        const rawYield = recipeJson.recipeYield;
                        if (typeof rawYield === 'string') parsedYield = parseYieldString(rawYield);
                        else if (Array.isArray(rawYield) && rawYield.length) parsedYield = parseYieldString(String(rawYield[0]));
                    }

                    // --- Reintroduce LLM call for JSON-LD ingredients --- 
                    console.log(`[Worker - URL Job ${jobId}] Found ${ingredientStrings.length} ingredients via JSON-LD. Parsing with LLM...`);
                    await updateUrlJobStatus(jobId, 'llm_parsing_jsonld_ingredients'); 
                    const sysPrompt = 'You are an expert ingredient parser... Respond ONLY with JSON array.'; // Use appropriate prompt
                    const userPrompt = 'Ingredient List:\n' + ingredientStrings.map((s) => `- ${s}`).join('\n');
                    
                    const llmResp = await callAnthropic(sysPrompt, userPrompt); // Use appropriate settings
                    const parsedIngredients = await parseAndCorrectJson(llmResp, 'array'); // Use jsonUtils

                    if (parsedIngredients && parsedIngredients.length) {
                        const cleanIngredients = parsedIngredients
                            .filter(o => o && typeof o === 'object' && (o.name || o.ingredient)) // Similar filter as old controller
                            .map(o => ({ 
                                quantity: o.quantity ?? null, 
                                unit: o.unit ?? null, 
                                ingredient: o.ingredient || o.name // Prefer ingredient, fallback name
                             }));

                        if (cleanIngredients.length) {
                            recipeResult = { 
                                title, 
                                yield: parsedYield, 
                                ingredients: cleanIngredients, 
                                sourceUrl: finalUrl, 
                                extractedVia: 'json-ld+llm' // Indicate LLM was used
                            };
                            console.log(`[Worker - URL Job ${jobId}] Parsed ${cleanIngredients.length} ingredients from JSON-LD via LLM.`);
                        } else {
                            console.warn(`[Worker - URL Job ${jobId}] LLM parsing of JSON-LD ingredients yielded no valid items.`);
                        }
                    } else {
                        console.warn(`[Worker - URL Job ${jobId}] LLM failed to parse ingredients from JSON-LD strings.`);
                    }
                     // --- End LLM Call --- 
                } else {
                     console.log(`[Worker - URL Job ${jobId}] JSON-LD found, but recipeIngredient was empty.`);
                }
            } else {
                console.log(`[Worker - URL Job ${jobId}] No usable JSON-LD recipe found.`);
            }
        } catch (jsonLdError) {
            console.warn(`[Worker - URL Job ${jobId}] Error during JSON-LD processing:`, jsonLdError.message);
            // Proceed to fallback
        }

        // --- 4. Fallback: Readability + LLM Extraction ---
        if (!recipeResult) {
            await updateUrlJobStatus(jobId, 'parsing_fallback_llm');
            try {
                const dom = new JSDOM(htmlContent, { url: finalUrl });
                const reader = new Readability(dom.window.document);
                const article = reader.parse();

                if (article && article.textContent) {
                    console.log(`[Worker - URL Job ${jobId}] Readability extracted content. Length: ${article.textContent.length}. Calling LLM...`);
                    const llmPrompt = `Extract the recipe title, yield (as quantity and unit, e.g., "4 servings", "1 loaf"), and ingredients (each as a string in an array) from the following text. Only return a JSON object with keys "title", "yield_string", "ingredients".\n\nTEXT:\n${article.textContent.substring(0, 15000)}`; // Limit context size
                    
                    const llmResponse = await callAnthropic(llmPrompt, 0.5); // Use imported helper
                    const parsedLlmJson = parseAndCorrectJson(llmResponse);

                    if (parsedLlmJson?.ingredients?.length > 0) {
                         const ingredients = parsedLlmJson.ingredients.map(ing => ({ raw: ing, source: 'llm' }));
                         recipeResult = {
                            title: parsedLlmJson.title || article.title || 'Recipe from URL',
                            yield: parseYieldString(parsedLlmJson.yield_string),
                            ingredients: ingredients,
                            sourceUrl: finalUrl,
                            extractedVia: 'fallback-llm'
                         };
                         console.log(`[Worker - URL Job ${jobId}] Extracted recipe via Readability + LLM.`);
                    } else {
                        console.warn(`[Worker - URL Job ${jobId}] LLM fallback did not return usable ingredients.`);
                        throw new Error("Fallback extraction via LLM failed to find ingredients.")
                    }
                } else {
                    console.warn(`[Worker - URL Job ${jobId}] Readability could not extract meaningful content.`);
                     throw new Error("Fallback extraction failed: Could not extract readable content.")
                }
            } catch (fallbackError) {
                console.error(`[Worker - URL Job ${jobId}] Fallback extraction failed:`, fallbackError.message);
                await updateUrlJobStatus(jobId, 'failed', { error: `Fallback extraction failed: ${fallbackError.message}` });
                return res.status(200).send("Fallback extraction failed, job status updated."); // Acknowledge QStash
            }
        }

        // --- 5. Final Success Update ---
        if (recipeResult) {
            console.log(`[Worker - URL Job ${jobId}] Recipe processing successful. Updating status to 'completed'.`);
            await updateUrlJobStatus(jobId, 'completed', { result: recipeResult });
            res.status(200).send("URL Processing completed successfully.");
        } else {
            // Should not happen if logic is correct, but as a safeguard
            console.error(`[Worker - URL Job ${jobId}] Processing finished but no recipeResult obtained. Failing job.`);
            await updateUrlJobStatus(jobId, 'failed', { error: 'Processing completed without extracting recipe data.' });
            res.status(200).send("Processing finished without result, job failed."); // Acknowledge QStash
        }

    } catch (error) {
        console.error(`[Worker - URL Job ${jobId}] CRITICAL ERROR processing URL job:`, error);
        if (jobId) {
            await updateUrlJobStatus(jobId, 'failed', { error: error.message || 'URL worker failed unexpectedly.' });
        }
        // Return 500, QStash will retry
        res.status(500).send("Internal Server Error during URL processing");
    }
};

module.exports = {
    processUrlJobWorker,
};