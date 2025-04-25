// backend/controllers/jobStatusController.js
// const { kvClient } = require('../services/kvService'); // Switch to Redis
const { redis } = require('../services/redisService'); // Use Redis service

async function getJobStatus(req, res) {
    const { jobId } = req.query;
    console.log(`[Job Status ${jobId}] Received request.`);
    if (!jobId) {
        console.error(`[Job Status] Request missing Job ID.`);
        return res.status(400).json({ error: 'Missing Job ID query parameter.' });
    }

    let rawJobData = null; // Variable to hold raw data for error logging

    try {
        if (!redis) { 
            console.error(`[Job Status ${jobId}] Redis client not available.`);
            throw new Error('Redis client not available in jobStatusController'); 
        }
        console.log(`[Job Status ${jobId}] Fetching data from Redis...`);
        rawJobData = await redis.get(jobId); // Use get which might return string or object
        
        console.log(`[Job Status ${jobId}] Raw data from Redis:`, rawJobData);
        console.log(`[Job Status ${jobId}] Type of raw data: ${typeof rawJobData}`);

        if (rawJobData === null || rawJobData === undefined) { // Check for null or undefined
            console.warn(`[Job Status ${jobId}] Job data not found in Redis.`);
            return res.status(404).json({ status: 'not_found', error: 'Job not found or expired.' });
        }

        let jobData;
        try {
            if (typeof rawJobData === 'object') {
                // If redis.get already returned an object, use it directly
                jobData = rawJobData;
                console.log(`[Job Status ${jobId}] Received parsed object directly from Redis.`);
            } else if (typeof rawJobData === 'string') {
                // If it's a string, try to parse it
                 console.log(`[Job Status ${jobId}] Received string from Redis, attempting JSON parse...`);
                jobData = JSON.parse(rawJobData);
                console.log(`[Job Status ${jobId}] Successfully parsed string from Redis.`);
            } else {
                 // Unexpected data type
                 console.error(`[Job Status ${jobId}] Unexpected data type received from Redis: ${typeof rawJobData}`);
                 throw new Error(`Unexpected data type received from Redis for Job ID ${jobId}: ${typeof rawJobData}`);
            }
            console.log(`[Job Status ${jobId}] Processed jobData:`, jobData); 

            // Now jobData should be a valid object
            const responsePayload = {
                status: jobData.status,
                result: jobData.result, 
                error: jobData.error
            };
            console.log(`[Job Status ${jobId}] Sending response:`, JSON.stringify(responsePayload)); 
            res.json(responsePayload);

        } catch (processingError) {
             console.error(`[Job Status ${jobId}] Error processing data from Redis:`, processingError);
             // Log raw data again if processing failed
             console.error(`[Job Status ${jobId}] Raw data causing processing error:`, rawJobData);
             // Re-throw to be caught by the outer catch block which sends the 500 response
             throw processingError; 
        }

    } catch (error) {
        console.error(`[Job Status ${jobId}] Outer catch - Error retrieving/processing status for Job ID ${jobId}:`, error);
        if (error instanceof SyntaxError) {
            console.error(`[Job Status ${jobId}] SyntaxError during parse. Raw Data:`, rawJobData);
            // Ensure response hasn't been sent
            if (!res.headersSent) {
                return res.status(500).json({ error: 'Failed to parse job status data.' });
            }
        }
        // Handle other potential errors (Redis connection, unexpected errors)
        // Ensure response hasn't been sent
        if (!res.headersSent) {
             // FIX: Add safety check for error.message
             const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
             res.status(500).json({ error: 'Failed to retrieve job status.', details: errorMessage });
        }
    }
}

module.exports = {
    getJobStatus
}; 