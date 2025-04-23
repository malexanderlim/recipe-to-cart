// Import the KV service if running on Vercel
let kvClient;
try {
    const { kv } = require('@vercel/kv');
    kvClient = kv;
    console.log('Using Vercel KV for storage.');
} catch (error) {
    console.log('Vercel KV not available, using mock KV for local development.');
    // Create a mock KV client with the same interface
    const mockKvStore = new Map();
    
    kvClient = {
        get: async (key) => {
            console.log(`[Mock KV] Getting value for key: ${key}`);
            return mockKvStore.get(key);
        },
        set: async (key, value) => {
            console.log(`[Mock KV] Setting value for key: ${key}`);
            mockKvStore.set(key, value);
            return 'OK';
        },
        delete: async (key) => {
            console.log(`[Mock KV] Deleting key: ${key}`);
            return mockKvStore.delete(key);
        }
    };
}

/**
 * Updates the status of a job in KV storage
 * @param {string} jobId - The ID of the job to update
 * @param {string} status - The new status (pending, processing, completed, failed)
 * @param {Object} additionalData - Additional data to merge with the job data
 * @returns {Promise<void>}
 */
async function updateJobStatus(jobId, status, additionalData = {}) {
    try {
        // Get current job data
        const jobData = await kvClient.get(jobId);
        
        if (!jobData) {
            console.warn(`[Job Status Update] Job data not found for ID: ${jobId}`);
            return;
        }
        
        // Update job data with new status and additional data
        const updatedJobData = {
            ...jobData,
            status,
            ...additionalData,
            updatedAt: Date.now()
        };
        
        // If status is 'completed' or 'failed', add finishedAt timestamp
        if (status === 'completed' || status === 'failed') {
            updatedJobData.finishedAt = Date.now();
        }
        
        // Save updated job data back to KV
        await kvClient.set(jobId, updatedJobData);
        console.log(`[Job ${jobId}] Status updated to '${status}'`);
        
    } catch (error) {
        console.error(`[Job Status Update] Error updating job status for ID ${jobId}:`, error);
        // Throw error to be handled by caller
        throw error;
    }
}

module.exports = {
    kvClient,
    updateJobStatus
}; 