// backend/controllers/urlJobController.js
// ----------------------------------------------------------------------------
//  FULL “/api/process-url-job” WORKER  – restored from legacy server.js
// ----------------------------------------------------------------------------

/* External / helper deps  */
const fetch = (...args) =>
    import('node-fetch').then(({ default: fetchFn }) => fetchFn(...args));
  const { JSDOM } = require('jsdom');
  const { Readability } = require('@mozilla/readability');
  const cheerio = require('cheerio');
  
  /* Internal shared services / utils */
  const { redis } = require('../services/redisService');
  const { kvClient, updateJobStatus } = require('../services/kvService');
  const { callAnthropic } = require('../services/anthropicService');
  const { parseAndCorrectJson } = require('../utils/jsonUtils');
  
  /* -------------------------------------------------------------------------- */
  /* Utility copied from legacy server.js                                       */
  /* -------------------------------------------------------------------------- */
  function parseYieldString(yieldStr) {
    if (!yieldStr || typeof yieldStr !== 'string') return null;
  
    // Regex: optional non-digits, capture number, capture text
    const match = yieldStr.match(/^[^\d]*?(\d+(?:[.,]\d+)?)\s*([\w\s-]+)/);
    if (match && match[1]) {
      const quantity = parseFloat(match[1].replace(',', '.')) || null;
      const unitRaw = match[2]
        ? match[2]
            .trim()
            .replace(/^[()[\]]+|[()[\]]+$/g, '')
            .trim()
            .toLowerCase()
        : null;
  
      if (quantity) {
        const unitSingular =
          unitRaw && unitRaw.endsWith('s') && !['servings'].includes(unitRaw)
            ? unitRaw.slice(0, -1)
            : unitRaw;
        return { quantity, unit: quantity === 1 ? unitSingular : unitRaw || null };
      }
    }
    // Fallback: quantity only
    const qtyOnly = yieldStr.match(/^[^\d]*?(\d+(?:[.,]\d+)?)/);
    if (qtyOnly && qtyOnly[1]) {
      return { quantity: parseFloat(qtyOnly[1].replace(',', '.')) || null, unit: null };
    }
    return null;
  }
  
  /* -------------------------------------------------------------------------- */
  /* Main background worker                                                     */
  /* -------------------------------------------------------------------------- */
  async function processUrlJob(req, res) {
    const { jobId } = req.body;
    if (!jobId) {
      console.error('Received process-url-job request without jobId');
      return res.status(400).json({ error: 'Job ID is required' });
    }
  
    console.log(`[${jobId}] Starting URL background processing…`);
    let jobData;
  
    try {
      /* ------------------------------------------------------------------ */
      /* 1) Load job record from KV                                         */
      /* ------------------------------------------------------------------ */
      jobData = await kvClient.get(jobId);
      if (!jobData || ['completed', 'failed'].includes(jobData.status)) {
        console.warn(`[${jobId}] Job not found or already processed (${jobData?.status}).`);
        return res.status(200).json({ message: 'Job already processed or not found.' });
      }
  
      const { inputUrl } = jobData;
      await updateJobStatus(jobId, 'processing_started');
      console.log(`[${jobId}] Processing URL: ${inputUrl}`);
  
      /* ------------------------------------------------------------------ */
      /* 2) Fetch HTML (with redirects, headers, timeout, login-wall check) */
      /* ------------------------------------------------------------------ */
      let htmlContent = '';
      let finalUrl = inputUrl;
  
      try {
        await updateJobStatus(jobId, 'fetching_html');
        console.log(`[${jobId}] Fetching HTML…`);
  
        const response = await fetch(inputUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            Connection: 'keep-alive',
            DNT: '1',
            'Upgrade-Insecure-Requests': '1'
          },
          redirect: 'follow',
          timeout: 15000
        });
  
        finalUrl = response.url;
        console.log(`[${jobId}] Fetch status ${response.status} – finalURL: ${finalUrl}`);
  
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  
        const cType = response.headers.get('content-type') || '';
        if (!cType.toLowerCase().includes('text/html')) {
          throw new Error(`Expected HTML but got “${cType}”`);
        }
  
        htmlContent = await response.text();
        console.log(`[${jobId}] HTML fetched (${htmlContent.length} bytes)`);
  
        // rudimentary login-wall detector
        const lower = htmlContent.toLowerCase();
        const lURL = finalUrl.toLowerCase();
        if (
          lower.includes('log in') ||
          lower.includes('sign in') ||
          lURL.includes('/login') ||
          lURL.includes('/signin')
        ) {
          throw new Error('Potential login-wall detected; authentication required.');
        }
      } catch (fetchErr) {
        console.error(`[${jobId}] Fetching HTML failed:`, fetchErr);
        await updateJobStatus(jobId, 'failed', {
          error: `Failed to fetch URL: ${fetchErr.message}`
        });
        return res.status(200).json({ message: 'Fetch failed, job status updated.' });
      }
  
      /* ------------------------------------------------------------------ */
      /* 3) Attempt JSON-LD extraction                                      */
      /* ------------------------------------------------------------------ */
      let recipeResult = null;
      try {
        await updateJobStatus(jobId, 'parsing_jsonld');
        const $ = cheerio.load(htmlContent);
        let recipeJson = null;
  
        const findRecipe = (data) => {
          if (Array.isArray(data)) {
            for (const item of data) {
              const found = findRecipe(item);
              if (found) return found;
            }
          } else if (data && typeof data === 'object') {
            if (
              data['@type'] === 'Recipe' ||
              (Array.isArray(data['@type']) && data['@type'].includes('Recipe'))
            )
              return data;
            if (data['@graph']) return findRecipe(data['@graph']);
          }
          return null;
        };
  
        $('script[type="application/ld+json"]').each((_, el) => {
          if (recipeJson) return; // already found
          try {
            const parsed = JSON.parse($(el).html() || '{}');
            const found = findRecipe(parsed);
            if (found) recipeJson = found;
          } catch {}
        });
  
        if (
          recipeJson &&
          recipeJson.recipeIngredient &&
          Array.isArray(recipeJson.recipeIngredient) &&
          recipeJson.recipeIngredient.length
        ) {
          const title = recipeJson.name || 'Recipe from URL';
  
          // ---------------- parse yield ----------------
          let parsedYield = null;
          if (recipeJson.recipeYield) {
            const rawYield = recipeJson.recipeYield;
            if (typeof rawYield === 'string') parsedYield = parseYieldString(rawYield);
            else if (Array.isArray(rawYield) && rawYield.length) {
              const best =
                rawYield.find((el) => /\d/.test(el) && /[a-zA-Z]/.test(el)) || rawYield[0];
              parsedYield = parseYieldString(best);
            } else if (typeof rawYield === 'object' && rawYield !== null) {
              const q =
                rawYield.value ??
                rawYield.yieldValue ??
                rawYield.valueReference?.value ??
                null;
              const u =
                rawYield.unitText ??
                rawYield.unitCode ??
                rawYield.valueReference?.unitText ??
                null;
              if (q != null) parsedYield = { quantity: Number(q), unit: u || null };
            }
          }
          // ------------------------------------------------
  
          // ingredient strings → ask LLM to parse
          const ingredientStrings = recipeJson.recipeIngredient
            .map((line) => String(line).trim())
            .filter(Boolean);
          if (ingredientStrings.length) {
            await updateJobStatus(jobId, 'llm_parsing_ingredients');
  
            const sysPrompt =
              'You are an expert ingredient parser assisting with grocery lists. ' +
              'Convert raw ingredient strings into a JSON array of objects ' +
              '[{quantity, unit, name}]. Use null for missing fields. Respond ONLY with that JSON.';
            const userPrompt =
              'Ingredient List:\n' +
              ingredientStrings.map((s) => `- ${s}`).join('\n');
  
            const llmResp = await callAnthropic(sysPrompt, userPrompt);
            const parsed = await parseAndCorrectJson(jobId, llmResp, 'array');
  
            if (parsed && parsed.length) {
              const clean = parsed
                .filter((o) => o && typeof o === 'object' && 'name' in o)
                .map((o) => ({
                  quantity: o.quantity ?? null,
                  unit: o.unit ?? null,
                  name: o.name
                }));
  
              if (clean.length) {
                recipeResult = {
                  title,
                  yield: parsedYield,
                  ingredients: clean,
                  sourceUrl: finalUrl
                };
                console.log(
                  `[${jobId}] Parsed ${clean.length} ingredients via JSON-LD + LLM`
                );
              }
            }
          }
        }
      } catch (jsonLdErr) {
        console.error(`[${jobId}] JSON-LD phase error:`, jsonLdErr);
      }
  
      /* ------------------------------------------------------------------ */
      /* 4) Fallback: Readability + LLM                                      */
      /* ------------------------------------------------------------------ */
      if (!recipeResult) {
        try {
          await updateJobStatus(jobId, 'parsing_readability');
  
          const doc = new JSDOM(htmlContent, { url: finalUrl });
          const article = new Readability(doc.window.document).parse();
          if (!article || !article.textContent || article.textContent.trim().length < 100)
            throw new Error('Readability could not extract sufficient content.');
  
          const fallbackTitle = article.title || 'Recipe from URL';
          const mainText = article.textContent.substring(0, 18000); // leave room for prompt
  
          const sysPrompt =
            'You are an expert recipe parser. Extract title, yield object, and a JSON array ' +
            "of ingredients [{quantity, unit, name}] from the user's text. Return ONLY JSON.";
          const userPrompt = `---\n${mainText}\n---`;
  
          await updateJobStatus(jobId, 'llm_parsing_fallback');
          const raw = await callAnthropic(sysPrompt, userPrompt);
          const parsed = await parseAndCorrectJson(jobId, raw, 'object');
  
          if (parsed && Array.isArray(parsed.ingredients)) {
            const clean = parsed.ingredients
              .filter((o) => o && typeof o === 'object' && 'name' in o && o.name.trim())
              .map((o) => ({
                quantity: o.quantity ?? null,
                unit: o.unit ?? null,
                name: o.name
              }));
  
            if (clean.length) {
              const y =
                parsed.yield && typeof parsed.yield === 'object'
                  ? {
                      quantity: parsed.yield.quantity ?? null,
                      unit: parsed.yield.unit ?? null
                    }
                  : null;
  
              recipeResult = {
                title: parsed.title || fallbackTitle,
                yield: y,
                ingredients: clean,
                sourceUrl: finalUrl
              };
              console.log(
                `[${jobId}] Parsed ${clean.length} ingredients via Readability fallback`
              );
            } else {
              throw new Error('LLM returned no valid ingredients.');
            }
          } else {
            throw new Error('LLM response lacked expected structure.');
          }
        } catch (fallbackErr) {
          console.error(`[${jobId}] Readability / fallback error:`, fallbackErr);
          await updateJobStatus(jobId, 'failed', {
            error: `Fallback extraction failed: ${fallbackErr.message}`
          });
          return res.status(200).json({ message: 'Fallback failed, job updated.' });
        }
      }
  
      /* ------------------------------------------------------------------ */
      /* 5) Final KV update + response                                       */
      /* ------------------------------------------------------------------ */
      if (recipeResult) {
        await updateJobStatus(jobId, 'completed', { result: recipeResult });
        console.log(`[${jobId}] Processing complete, result stored.`);
      } else {
        await updateJobStatus(jobId, 'failed', {
          error: 'Finished without extracting a valid recipe.'
        });
        console.error(`[${jobId}] Finished unexpectedly without result.`);
      }
  
      return res
        .status(200)
        .json({ message: 'Background processing finished (acknowledged).' });
    } catch (err) {
      /* Unhandled fatal error */
      console.error(`[${jobId}] CRITICAL worker error:`, err);
      await updateJobStatus(jobId, 'failed', {
        error: `Unexpected worker error: ${err.message}`
      });
      return res.status(500).json({ error: 'Worker crashed.' });
    }
  }
  
  module.exports = { processUrlJob };