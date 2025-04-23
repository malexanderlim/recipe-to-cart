// backend/controllers/jobStatusController.js
// const { kvClient } = require('../services/kvService'); // Switch to Redis
const { redis } = require('../services/redisService'); // Use Redis service

async function getJobStatus(req, res) {
    const { jobId } = req.query;
    if (!jobId) {
        return res.status(400).json({ error: 'Missing Job ID query parameter.' });
    }

    try {
        // Use Redis client
        if (!redis) { 
            throw new Error('Redis client not available in jobStatusController'); 
        }

        const jobDataString = await redis.get(jobId); // Redis get returns string or null

        if (!jobDataString) {
            console.warn(`[Job Status] Job data not found in Redis for Job ID: ${jobId}`);
            return res.status(404).json({ status: 'not_found', error: 'Job not found or expired.' });
        }

        // Parse the JSON string retrieved from Redis
        const jobData = JSON.parse(jobDataString);

        res.json({
            status: jobData.status,
            result: jobData.result, 
            error: jobData.error
        });

    } catch (error) {
        console.error(`[Job Status] Error fetching status for Job ID ${jobId} from Redis:`, error);
        if (error instanceof SyntaxError) {
            console.error(`[Job Status] Failed to parse job data from Redis for Job ID: ${jobId}. Data: ${jobDataString}`);
            // Optionally return a specific error or the raw string for debugging
            return res.status(500).json({ error: 'Failed to parse job status data.' });
        }
        res.status(500).json({ error: 'Failed to retrieve job status.', details: error.message });
    }
}

module.exports = {
    getJobStatus
}; 