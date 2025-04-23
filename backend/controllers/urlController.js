const crypto = require('crypto');
// Dynamic import to avoid adding node-fetch to globals in all envs
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { kvClient, updateJobStatus } = require('../services/kvService');

exports.processUrl = async (req, res) => {
  const { url } = req.body;
  const isVercel = process.env.VERCEL === '1';

  let jobId = `url-${crypto.randomUUID()}`;
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

    // Determine trigger URL for worker
    const port = process.env.PORT || 3001;
    const triggerUrl = isVercel ? '/api/process-url-job' : `http://localhost:${port}/api/process-url-job`;
    console.log(`[${jobId}] Step 3: Constructed triggerUrl: ${triggerUrl}`);

    // Fire-and-forget fetch
    fetch(triggerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId })
    }).catch(fetchError => {
      console.error(`[${jobId}] ASYNC CATCH: Error triggering background job (fetch failed):`, fetchError);
      updateJobStatus(jobId, 'failed', { error: `Failed to trigger background processing task: ${fetchError.message}` });
    });
    console.log(`[${jobId}] Step 4: Fire-and-forget fetch dispatched.`);

    res.status(202).json({ jobId });
    console.log(`[${jobId}] Successfully sent 202 response.`);

  } catch (error) {
    console.error(`[${jobId}] SYNC CATCH: Error in /api/process-url:`, error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to initiate URL processing job' });
    }
  }
}; 