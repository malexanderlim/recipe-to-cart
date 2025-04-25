const { Receiver } = require("@upstash/qstash");
const kv = require("../services/kvService"); // Use KV service

// --- Dependencies copied from urlJobController --- 
// Dynamic import for node-fetch (needed for HTML fetching)
const fetch = (...args) => import('node-fetch').then(({ default: fetchFn }) => fetchFn(...args)); 
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const cheerio = require('cheerio');
const { callAnthropic } = require('../services/anthropicService');
const { parseAndCorrectJson } = require('../utils/jsonUtils');
// -------------------------------------------------

// Initialize QStash Receiver
const qstashReceiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
});

// --- Helper function to update job status in KV --- (Adapted from urlJobController's Redis helper)
async function updateUrlJobStatusInKV(jobId, status, data = {}) {
    if (!kv) {
        console.error(`[${jobId}] KV client not available in updateUrlJobStatusInKV. Cannot update status to ${status}.`);
        return; // Or throw an error if critical
    }
    try {
        let currentData = await kv.get(jobId);
        if (!currentData) {
            console.warn(`[${jobId}] Job data not found in KV when trying to update status to ${status}. Initializing.`);
            currentData = { jobId: jobId, startTime: Date.now(), status: 'unknown' }; 
        }

        // Ensure data is an object before spreading
        const dataToMerge = (typeof data === 'object' && data !== null) ? data : {};
        const newData = { ...currentData, status, ...dataToMerge };

        if (status === 'completed' || status === 'failed') {
            newData.endTime = Date.now();
            if (newData.startTime) {
                console.log(`[${jobId}] Job finished with status ${status} in ${newData.endTime - newData.startTime}ms`);
            } else {
                console.log(`[${jobId}] Job finished with status ${status}.`);
            }
        } else {
            console.log(`[${jobId}] Status updated to ${status}.`);
        }

        // Use kv.set - assuming it handles stringification if needed, or pass object directly
        // Adjust if kvService expects specific format
        await kv.set(jobId, newData); 

    } catch (error) {
        console.error(`[${jobId}] Failed to update job status to ${status} in KV:`, error);
    }
}
// --- End KV Update Helper ---

// --- Helper: parseYieldString (Copied EXACTLY from urlJobController) ---
function parseYieldString(yieldStr) {
    if (!yieldStr || typeof yieldStr !== 'string') return null;
    const match = yieldStr.match(/^[^\d]*?(\d+(?:[.,]\d+)?)\s*([\w\s-]+)/);
    if (match && match[1]) {
      const quantity = parseFloat(match[1].replace(',', '.')) || null;
      const unitRaw = match[2]
        ? match[2].trim().replace(/^[()[\]]+|[()[\]]+$/g, '').trim().toLowerCase()
        : null;
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
// --- End parseYieldString ---

// Middleware for QStash verification
const verifyQstashSignature = async (req, res, next) => {
    try {
        const isValid = await qstashReceiver.verify({ 
            signature: req.headers["upstash-signature"],
            body: req.rawBody || JSON.stringify(req.body) // Fallback for safety
        });

        if (!isValid) {
            console.error("[Worker - URL] QStash signature verification failed");
            return res.status(401).send("Unauthorized");
        }
        console.log("[Worker - URL] QStash signature verified.");
        next(); // Proceed to the main handler
    } catch (error) {
        console.error("[Worker - URL] Error during QStash signature verification:", error);
        res.status(500).send("Internal Server Error during verification");
    }
};

// --- Main Worker Handler --- 
const processUrlJobWorkerHandler = async (req, res) => {
    console.log("[Worker - URL Handler] Received verified request");

    // 1. Extract Job ID (Signature already verified by middleware)
    const { jobId } = req.body;
    if (!jobId) {
        console.error("[Worker - URL Handler] Missing jobId in request body");
        // Acknowledge QStash message but log error
        return res.status(200).send("Missing jobId"); 
    }
    console.log(`[Worker - URL Handler Job ${jobId}] Processing job ID: ${jobId}`);

    let jobData;

    try {
        // --- Logic Copied & Adapted from urlJobController --- 
        
        /* 1) Load job record from KV */
        if (!kv) { throw new Error('KV client not available in processUrlJobWorkerHandler'); }
        jobData = await kv.get(jobId);

        if (!jobData || ['completed', 'failed'].includes(jobData.status)) {
            console.warn(`[Worker - URL Handler Job ${jobId}] Job not found in KV or already processed (${jobData?.status}).`);
            return res.status(200).json({ message: 'Job already processed or not found.' });
        }

        const { inputUrl } = jobData;
        if (!inputUrl) {
            throw new Error('Job data from KV is missing inputUrl.');
        }
        await updateUrlJobStatusInKV(jobId, 'processing_started'); 
        console.log(`[Worker - URL Handler Job ${jobId}] Processing URL: ${inputUrl}`);

        /* 2) Fetch HTML */
        let htmlContent = '';
        let finalUrl = inputUrl;
        try {
            await updateUrlJobStatusInKV(jobId, 'fetching_html'); 
            console.log(`[Worker - URL Handler Job ${jobId}] Fetching HTML…`);
            const response = await fetch(inputUrl, { /* headers, redirect, timeout */ 
                 headers: { /* Copied exactly from old controller */
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
            finalUrl = response.url;
            console.log(`[Worker - URL Handler Job ${jobId}] Fetch status ${response.status} – finalURL: ${finalUrl}`);
            if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
            const cType = response.headers.get('content-type') || '';
            if (!cType.toLowerCase().includes('text/html')) throw new Error(`Expected HTML but got “${cType}”`);
            htmlContent = await response.text();
            console.log(`[Worker - URL Handler Job ${jobId}] HTML fetched (${htmlContent.length} bytes)`);
            // rudimentary login-wall detector (Copied exactly)
            const lower = htmlContent.toLowerCase(); const lURL = finalUrl.toLowerCase();
            if (lower.includes('log in') || lower.includes('sign in') || lURL.includes('/login') || lURL.includes('/signin')) {
                throw new Error('Potential login-wall detected; authentication required.');
            }
        } catch (fetchErr) {
            console.error(`[Worker - URL Handler Job ${jobId}] Fetching HTML failed:`, fetchErr);
            await updateUrlJobStatusInKV(jobId, 'failed', { error: `Failed to fetch URL: ${fetchErr.message}` });
            return res.status(200).json({ message: 'Fetch failed, job status updated.' }); // Respond OK to QStash
        }

        /* 3) Attempt JSON-LD extraction */
        let recipeResult = null;
        try {
            await updateUrlJobStatusInKV(jobId, 'parsing_jsonld'); 
            const $ = cheerio.load(htmlContent);
            let recipeJson = null;
            // findRecipe helper (Copied exactly)
            const findRecipe = (data) => { /* ... exact same logic ... */ 
                if (Array.isArray(data)) { for (const item of data) { const found = findRecipe(item); if (found) return found; } }
                else if (data && typeof data === 'object') {
                    if (data['@type'] === 'Recipe' || (Array.isArray(data['@type']) && data['@type'].includes('Recipe'))) return data;
                    if (data['@graph']) return findRecipe(data['@graph']);
                } return null;
            };
            $('script[type="application/ld+json"]').each((_, el) => { /* ... exact same logic ... */ 
                if (recipeJson) return;
                try { const parsed = JSON.parse($(el).html() || '{}'); const found = findRecipe(parsed); if (found) recipeJson = found; } catch { /* Ignore */ }
            });

            if (recipeJson?.recipeIngredient?.length) { // Simplified check
                const ingredientStrings = recipeJson.recipeIngredient.map((line) => String(line).trim()).filter(Boolean);
                if (!ingredientStrings.length) {
                    console.warn(`[Worker - URL Handler Job ${jobId}] JSON-LD found, but recipeIngredient array was empty.`);
                } else {
                    const title = recipeJson.name || 'Recipe from URL';
                    let parsedYield = null; // Parse yield (Copied exactly)
                    if (recipeJson.recipeYield) { /* ... exact same yield parsing logic ... */ 
                        const rawYield = recipeJson.recipeYield;
                        if (typeof rawYield === 'string') parsedYield = parseYieldString(rawYield);
                        else if (Array.isArray(rawYield) && rawYield.length) { const best = rawYield.find((el) => typeof el === 'string' && /\d/.test(el) && /[a-zA-Z]/.test(el)) || rawYield[0]; if (best) parsedYield = parseYieldString(String(best)); }
                        else if (typeof rawYield === 'object' && rawYield !== null) { const q = rawYield.value ?? rawYield.yieldValue ?? rawYield.valueReference?.value ?? null; const u = rawYield.unitText ?? rawYield.unitCode ?? rawYield.valueReference?.unitText ?? null; if (q != null) { const qtyNum = parseFloat(String(q).replace(',', '.')) || null; if (qtyNum) parsedYield = { quantity: qtyNum, unit: u || null }; } else if (rawYield.description) { parsedYield = parseYieldString(String(rawYield.description)); } }
                    }
                    // LLM call for ingredients (Copied exactly)
                    await updateUrlJobStatusInKV(jobId, 'llm_parsing_ingredients'); 
                    const sysPrompt = 'You are an expert ingredient parser... Respond ONLY with that JSON.'; // Exact prompt
                    const userPrompt = 'Ingredient List:\n' + ingredientStrings.map((s) => `- ${s}`).join('\n');
                    const llmResp = await callAnthropic(sysPrompt, userPrompt);
                    const parsed = await parseAndCorrectJson(jobId, llmResp, 'array');
                    if (parsed?.length) {
                        const clean = parsed.filter((o) => o && typeof o === 'object' && (o.name || o.ingredient)).map((o) => ({ quantity: o.quantity ?? null, unit: o.unit ?? null, ingredient: o.ingredient || o.name }));
                        if (clean.length) {
                            recipeResult = { title, yield: parsedYield, ingredients: clean, sourceUrl: finalUrl, extractedFrom: 'json-ld' };
                            console.log(`[Worker - URL Handler Job ${jobId}] Parsed ${clean.length} ingredients via JSON-LD + LLM`);
                        }
                    }
                }
            }
        } catch (jsonLdErr) {
            console.error(`[Worker - URL Handler Job ${jobId}] JSON-LD phase error:`, jsonLdErr); // Log but continue to fallback
        }

        /* 4) Fallback: Readability + LLM */
        if (!recipeResult) {
            try {
                await updateUrlJobStatusInKV(jobId, 'parsing_readability'); 
                const doc = new JSDOM(htmlContent, { url: finalUrl });
                const article = new Readability(doc.window.document).parse();
                if (!article?.textContent) throw new Error('Readability could not extract any text content.');
                const fallbackTitle = article.title || 'Recipe from URL';
                const mainText = article.textContent.substring(0, 18000); // Use substring
                // LLM Call (Copied exactly)
                const sysPrompt = 'You are an expert recipe parser... Output ONLY a single valid JSON object...'; // Exact prompt
                const userPrompt = `Recipe Text:\n---\n${mainText}\n---`;
                await updateUrlJobStatusInKV(jobId, 'llm_parsing_fallback'); 
                const raw = await callAnthropic(sysPrompt, userPrompt);
                const parsed = await parseAndCorrectJson(jobId, raw, 'object');
                if (parsed?.ingredients?.length) {
                    const clean = parsed.ingredients.filter((o) => o?.ingredient && String(o.ingredient).trim()).map((o) => ({ quantity: o.quantity ?? null, unit: o.unit ?? null, ingredient: o.ingredient }));
                    if (clean.length) {
                        const y = parsed.yield && typeof parsed.yield === 'object' ? { quantity: parsed.yield.quantity ?? null, unit: parsed.yield.unit ?? null } : null;
                        recipeResult = { title: parsed.title || fallbackTitle, yield: y, ingredients: clean, sourceUrl: finalUrl, extractedFrom: 'readability' };
                        console.log(`[Worker - URL Handler Job ${jobId}] Parsed ${clean.length} ingredients via Readability fallback`);
                    } else { throw new Error('LLM returned no valid ingredients.'); }
                } else { throw new Error('LLM response lacked expected structure.'); }
            } catch (fallbackErr) {
                console.error(`[Worker - URL Handler Job ${jobId}] Readability / fallback error:`, fallbackErr);
                await updateUrlJobStatusInKV(jobId, 'failed', { error: `Fallback extraction failed: ${fallbackErr.message}` });
                return res.status(200).json({ message: 'Fallback failed, job updated.' }); // Respond OK to QStash
            }
        }

        /* 5) Final KV update + response */
        if (recipeResult) {
            await updateUrlJobStatusInKV(jobId, 'completed', { result: recipeResult }); 
            console.log(`[Worker - URL Handler Job ${jobId}] Processing complete, result stored in KV.`);
        } else {
            await updateUrlJobStatusInKV(jobId, 'failed', { error: 'Finished without extracting a valid recipe.' });
            console.error(`[Worker - URL Handler Job ${jobId}] Finished unexpectedly without result.`);
        }
        
        // --- End Copied Logic --- 
        
        console.log(`[Worker - URL Handler Job ${jobId}] Successfully processed job.`);
        res.status(200).send("URL Processing complete."); // Respond OK to QStash

    } catch (error) {
        console.error(`[Worker - URL Handler Job ${jobId}] CRITICAL worker error:`, error);
        const currentJobId = jobId || req.body?.jobId; // Ensure we have the jobId
        if (currentJobId && kv) {
            try {
                // Attempt to update KV status to failed
                const existingData = jobData || await kv.get(currentJobId) || {}; 
                await updateUrlJobStatusInKV(currentJobId, 'failed', { 
                     error: `Unexpected worker error: ${error.message}` 
                });
            } catch (kvError) {
                console.error(`[Worker - URL Handler Job ${currentJobId}] Failed to update KV status to 'failed' in catch block:`, kvError);
            }
        }
        // Return 500 to indicate failure to QStash (it might retry based on config)
        res.status(500).send("Internal Server Error during URL processing");
    }
};

module.exports = {
    verifyQstashSignature, // Export middleware
    processUrlJobWorkerHandler, // Export main handler
}; 