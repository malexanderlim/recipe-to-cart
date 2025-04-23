// backend/controllers/jobStatusController.js
// const { kvClient } = require('../services/kvService'); // Switch to Redis
const { redis } = require('../services/redisService'); // Use Redis service

async function getJobStatus(req, res) {
    const { jobId } = req.query;
    if (!jobId) {
        return res.status(400).json({ error: 'Missing Job ID query parameter.' });
    }

    let rawJobData = null; // Variable to hold raw data for error logging

    try {
        if (!redis) { 
            throw new Error('Redis client not available in jobStatusController'); 
        }

        rawJobData = await redis.get(jobId); // Use get which might return string or object

        if (rawJobData === null || rawJobData === undefined) { // Check for null or undefined
            console.warn(`[Job Status] Job data not found in Redis for Job ID: ${jobId}`);
            return res.status(404).json({ status: 'not_found', error: 'Job not found or expired.' });
        }

        let jobData;
        if (typeof rawJobData === 'object') {
            // If redis.get already returned an object, use it directly
            jobData = rawJobData;
            console.log(`[Job Status] Received parsed object directly from Redis for Job ID: ${jobId}`);
        } else if (typeof rawJobData === 'string') {
            // If it's a string, try to parse it
             console.log(`[Job Status] Received string from Redis, attempting JSON parse for Job ID: ${jobId}`);
            jobData = JSON.parse(rawJobData);
        } else {
             // Unexpected data type
             throw new Error(`Unexpected data type received from Redis for Job ID ${jobId}: ${typeof rawJobData}`);
        }

        // Now jobData should be a valid object
        res.json({
            status: jobData.status,
            result: jobData.result, 
            error: jobData.error
        });

    } catch (error) {
        console.error(`[Job Status] Error processing status for Job ID ${jobId} from Redis:`, error);
        if (error instanceof SyntaxError) {
            console.error(`[Job Status] Failed to parse job data string from Redis for Job ID: ${jobId}. Raw Data:`, rawJobData);
            return res.status(500).json({ error: 'Failed to parse job status data.' });
        }
        // Handle other potential errors (Redis connection, unexpected errors)
        res.status(500).json({ error: 'Failed to retrieve job status.', details: error.message });
    }
}

module.exports = {
    getJobStatus
}; 