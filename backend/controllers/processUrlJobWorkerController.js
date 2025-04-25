const { redis } = require('../services/redisService');
const { callAnthropic } = require('../services/anthropicService'); // Import Anthropic service
const { parseAndCorrectJson } = require('../utils/jsonUtils'); // Import JSON util

// Import necessary libraries
const fetch = (...args) => import('node-fetch').then(({ default: fetchFn }) => fetchFn(...args));
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const cheerio = require('cheerio');

// Utility function copied from old urlJobController
function parseYieldString(yieldStr) {
    if (!yieldStr || typeof yieldStr !== 'string') return null;
    const match = yieldStr.match(/^[^\d]*?(\d+(?:[.,]\d+)?)\s*([\w\s-]+)/);
    if (match && match[1]) {
        const quantity = parseFloat(match[1].replace(',', '.')) || null;
        const unitRaw = match[2]?.trim().replace(/^[()[\]]+|[()[\]]+$/g, '').trim().toLowerCase() || null;
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

// Main worker function
async function handleProcessUrlJob(req, res) {
    console.log('[Process URL Worker] Received job via QStash.');

    const { jobId } = req.body;
    if (!jobId) {
        console.error('[Process URL Worker] Missing jobId in request body.');
        return res.status(400).send('Bad Request: Missing jobId');
    }

    console.log(`[Process URL Worker Job ${jobId}] Processing job...`);
    let jobData; // For storing retrieved job data
    let finalUrl; // To store the URL after potential redirects

    try {
        // 1. Retrieve job details (inputUrl) from Redis
        console.log(`[Process URL Worker Job ${jobId}] Retrieving job data from Redis...`);
        if (!redis) { throw new Error('Redis client not initialized'); }
        const jobDataStr = await redis.get(jobId);
        if (!jobDataStr) {
            console.error(`[Process URL Worker Job ${jobId}] Job data not found in Redis.`);
            return res.status(404).send('Not Found: Job data missing');
        }
        jobData = JSON.parse(jobDataStr);
        const { inputUrl } = jobData;

        if (jobData.status !== 'pending') {
            console.warn(`[Process URL Worker Job ${jobId}] Job status is already '${jobData.status}'. Skipping.`);
            return res.status(200).json({ message: `Job already processed/failed: ${jobData.status}` });
        }
        console.log(`[Process URL Worker Job ${jobId}] Found inputUrl: ${inputUrl}`);

        // --- Update status: processing started ---
        jobData.status = 'processing_started';
        jobData.processingStartedAt = Date.now();
        await redis.set(jobId, JSON.stringify(jobData), { ex: 86400 });
        // ------------------------------------------

        // 2. Fetch HTML
        console.log(`[Process URL Worker Job ${jobId}] Fetching HTML...`);
        let htmlContent = '';
        finalUrl = inputUrl; // Initialize finalUrl

        try {
            // --- Update status: fetching html --- 
            jobData.status = 'fetching_html';
            await redis.set(jobId, JSON.stringify(jobData), { ex: 86400 });
            // --------------------------------------
            const response = await fetch(inputUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    Connection: 'keep-alive',
                    DNT: '1',
                    'Upgrade-Insecure-Requests': '1'
                },
                redirect: 'follow',
                timeout: 15000
            });

            finalUrl = response.url; // Capture final URL after redirects
            console.log(`[Process URL Worker Job ${jobId}] Fetch status ${response.status} – finalURL: ${finalUrl}`);
            if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

            const cType = response.headers.get('content-type') || '';
            if (!cType.toLowerCase().includes('text/html')) {
                throw new Error(`Expected HTML but got "${cType}"`);
            }
            htmlContent = await response.text();
            console.log(`[Process URL Worker Job ${jobId}] HTML fetched (${htmlContent.length} bytes)`);

            // Login-wall check
            const lower = htmlContent.toLowerCase();
            const lURL = finalUrl.toLowerCase();
            if (lower.includes('log in') || lower.includes('sign in') || lURL.includes('/login') || lURL.includes('/signin')) {
                throw new Error('Potential login-wall detected; authentication required.');
            }
        } catch (fetchErr) {
            console.error(`[Process URL Worker Job ${jobId}] Fetching HTML failed:`, fetchErr);
            // Update Redis to failed and exit (return 200 OK to QStash)
            jobData.status = 'failed';
            jobData.error = `Failed to fetch URL: ${fetchErr.message}`;
            jobData.finishedAt = Date.now();
            await redis.set(jobId, JSON.stringify(jobData), { ex: 86400 });
            return res.status(200).send('OK: Job failed (fetch error)');
        }

        // 3. Attempt JSON-LD Extraction
        let recipeResult = null;
        try {
             // --- Update status: parsing jsonld --- 
             jobData.status = 'parsing_jsonld';
             await redis.set(jobId, JSON.stringify(jobData), { ex: 86400 });
             // ---------------------------------------
            const $ = cheerio.load(htmlContent);
            let recipeJson = null;

            const findRecipe = (data) => { // Nested helper function
                if (Array.isArray(data)) {
                    for (const item of data) {
                        const found = findRecipe(item);
                        if (found) return found;
                    }
                } else if (data && typeof data === 'object') {
                    if (data['@type'] === 'Recipe' || (Array.isArray(data['@type']) && data['@type'].includes('Recipe'))) return data;
                    if (data['@graph']) return findRecipe(data['@graph']);
                }
                return null;
            };

            $('script[type="application/ld+json"]').each((_, el) => {
                if (recipeJson) return;
                try {
                    const parsed = JSON.parse($(el).html() || '{}');
                    const found = findRecipe(parsed);
                    if (found) recipeJson = found;
                } catch { /* Ignore JSON parsing errors */ }
            });

            if (recipeJson && recipeJson.recipeIngredient && Array.isArray(recipeJson.recipeIngredient) && recipeJson.recipeIngredient.length) {
                const ingredientStrings = recipeJson.recipeIngredient.map(line => String(line).trim()).filter(Boolean);
                if (ingredientStrings.length > 0) {
                    const title = recipeJson.name || 'Recipe from URL';
                    let parsedYield = null;
                    if (recipeJson.recipeYield) { // Complex yield parsing logic from old controller
                         const rawYield = recipeJson.recipeYield;
                         if (typeof rawYield === 'string') parsedYield = parseYieldString(rawYield);
                         else if (Array.isArray(rawYield) && rawYield.length) {
                             const best = rawYield.find(el => typeof el === 'string' && /\d/.test(el) && /[a-zA-Z]/.test(el)) || rawYield[0];
                             if (best) parsedYield = parseYieldString(String(best));
                         } else if (typeof rawYield === 'object' && rawYield !== null) {
                             const q = rawYield.value ?? rawYield.yieldValue ?? rawYield.valueReference?.value ?? null;
                             const u = rawYield.unitText ?? rawYield.unitCode ?? rawYield.valueReference?.unitText ?? null;
                             if (q != null) {
                                 const qtyNum = parseFloat(String(q).replace(',', '.')) || null;
                                 if (qtyNum) parsedYield = { quantity: qtyNum, unit: u || null };
                             } else if (rawYield.description) {
                                 parsedYield = parseYieldString(String(rawYield.description));
                             }
                         }
                    }

                    // --- Update status: llm parsing ingredients --- 
                    jobData.status = 'llm_parsing_ingredients';
                    await redis.set(jobId, JSON.stringify(jobData), { ex: 86400 });
                    // ---------------------------------------------
                    const sysPrompt = 
                        'You are an expert ingredient parser assisting with grocery lists. ' + 
                        'Convert raw ingredient strings into a JSON array of objects ' + 
                        '[{quantity, unit, name}]. Use null for missing fields. Respond ONLY with that JSON.'; // Restore full prompt
                    const userPrompt = 'Ingredient List:\n' + ingredientStrings.map(s => `- ${s}`).join('\n');
                    const llmResp = await callAnthropic(sysPrompt, userPrompt);
                    const parsedIngredients = await parseAndCorrectJson(jobId, llmResp, 'array');

                    if (parsedIngredients && parsedIngredients.length) {
                        const cleanIngredients = parsedIngredients
                            .filter(o => o && typeof o === 'object' && (o.name || o.ingredient))
                            .map(o => ({ quantity: o.quantity ?? null, unit: o.unit ?? null, ingredient: o.ingredient || o.name }));

                        if (cleanIngredients.length) {
                            recipeResult = {
                                title,
                                yield: parsedYield,
                                ingredients: cleanIngredients,
                                sourceUrl: finalUrl,
                                extractedFrom: 'json-ld'
                            };
                            console.log(`[Process URL Worker Job ${jobId}] Parsed ${cleanIngredients.length} ingredients via JSON-LD + LLM`);
                        }
                    }
                } else {
                     console.warn(`[Process URL Worker Job ${jobId}] JSON-LD found, but recipeIngredient array was empty.`);
                }
            }
        } catch (jsonLdErr) {
            console.error(`[Process URL Worker Job ${jobId}] JSON-LD phase error:`, jsonLdErr);
            // Don't fail yet, proceed to fallback
        }

        // 4. Fallback: Readability + LLM Extraction (if JSON-LD failed)
        if (!recipeResult) {
            console.log(`[Process URL Worker Job ${jobId}] Attempting Readability + LLM fallback...`);
            try {
                // --- Update status: parsing readability --- 
                jobData.status = 'parsing_readability';
                await redis.set(jobId, JSON.stringify(jobData), { ex: 86400 });
                // -----------------------------------------
                const doc = new JSDOM(htmlContent, { url: finalUrl });
                const article = new Readability(doc.window.document).parse();
                if (!article || !article.textContent) {
                    throw new Error('Readability could not extract any text content.');
                }
                const fallbackTitle = article.title || 'Recipe from URL';
                const mainText = article.textContent.substring(0, 18000);

                // --- Update status: llm parsing fallback --- 
                jobData.status = 'llm_parsing_fallback';
                await redis.set(jobId, JSON.stringify(jobData), { ex: 86400 });
                // -----------------------------------------
                const sysPrompt = 
                    'You are an expert recipe parser assisting with grocery list creation. ' + 
                    'Extract the recipe title, yield object { quantity, unit }, and a JSON array ' + 
                    'of ingredients [{quantity, unit, ingredient}] from the provided text. ' + 
                    'Output ONLY a single valid JSON object with keys `title`, `yield`, and `ingredients`. Ensure perfect JSON syntax.'; // Restore full prompt
                const userPrompt = `Recipe Text:\n---\n${mainText}\n---`;
                const raw = await callAnthropic(sysPrompt, userPrompt);
                const parsed = await parseAndCorrectJson(jobId, raw, 'object');

                if (parsed && Array.isArray(parsed.ingredients)) {
                    const cleanIngredients = parsed.ingredients
                        .filter(o => o && typeof o === 'object' && o.ingredient && String(o.ingredient).trim())
                        .map(o => ({ quantity: o.quantity ?? null, unit: o.unit ?? null, ingredient: o.ingredient }));

                    if (cleanIngredients.length) {
                        const y = parsed.yield && typeof parsed.yield === 'object' ? { quantity: parsed.yield.quantity ?? null, unit: parsed.yield.unit ?? null } : null;
                        recipeResult = {
                            title: parsed.title || fallbackTitle,
                            yield: y,
                            ingredients: cleanIngredients,
                            sourceUrl: finalUrl,
                            extractedFrom: 'readability'
                        };
                        console.log(`[Process URL Worker Job ${jobId}] Parsed ${cleanIngredients.length} ingredients via Readability fallback`);
                    } else {
                        throw new Error('LLM fallback returned no valid ingredients.');
                    }
                } else {
                    throw new Error('LLM fallback response lacked expected structure.');
                }
            } catch (fallbackErr) {
                console.error(`[Process URL Worker Job ${jobId}] Readability / fallback error:`, fallbackErr);
                // Update Redis to failed and exit (return 200 OK to QStash)
                jobData.status = 'failed';
                jobData.error = `Fallback extraction failed: ${fallbackErr.message}`;
                jobData.finishedAt = Date.now();
                await redis.set(jobId, JSON.stringify(jobData), { ex: 86400 });
                return res.status(200).send('OK: Job failed (fallback extraction error)');
            }
        }

        // 5. Handle final result (Success or Failure)
        if (recipeResult) {
            console.log(`[Process URL Worker Job ${jobId}] Successfully extracted recipe data. Updating Redis to completed...`);
            jobData.status = 'completed';
            jobData.result = recipeResult;
            jobData.finishedAt = Date.now();
            await redis.set(jobId, JSON.stringify(jobData), { ex: 86400 });
            console.log(`[Process URL Worker Job ${jobId}] Redis status updated to completed.`);
            // Return 200 OK to QStash
            return res.status(200).send('OK: URL processed successfully');
        } else {
            // Should not happen if fallback error handling is correct, but as a safety net
            console.error(`[Process URL Worker Job ${jobId}] Finished processing without extracting a valid recipe.`);
            jobData.status = 'failed';
            jobData.error = 'Finished without extracting a valid recipe after all attempts.';
            jobData.finishedAt = Date.now();
            await redis.set(jobId, JSON.stringify(jobData), { ex: 86400 });
            // Return 200 OK to QStash, job is handled (failed)
            return res.status(200).send('OK: Job failed (extraction failed)');
        }

    } catch (error) {
        // Catch unexpected errors during the main processing flow
        console.error(`[Process URL Worker Job ${jobId}] CRITICAL Unhandled Error processing job:`, error);
        try {
            if (redis && jobId && jobData && jobData.status !== 'failed') {
                jobData.status = 'failed';
                jobData.error = `Unexpected worker error: ${error.message}`;
                jobData.finishedAt = Date.now();
                await redis.set(jobId, JSON.stringify(jobData), { ex: 86400 });
                console.log(`[Process URL Worker Job ${jobId}] Updated Redis status to failed due to critical error.`);
            } else {
                 console.log(`[Process URL Worker Job ${jobId}] Redis status already failed or jobData unavailable.`);
            }
        } catch (redisError) {
            console.error(`[Process URL Worker Job ${jobId}] CRITICAL: Failed to update Redis status after critical error:`, redisError);
        }
        // Return 500 to QStash to allow retries for unexpected errors
        res.status(500).send(`Internal Server Error: ${error.message}`);
    }
}

module.exports = {
    handleProcessUrlJob
}; 