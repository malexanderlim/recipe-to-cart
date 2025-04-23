const { kvClient } = require('../services/kvService'); // Import kvClient

async function getJobStatus(req, res) {
    const { jobId } = req.query;
    if (!jobId) {
        return res.status(400).json({ error: 'Missing Job ID query parameter.' });
    }

    try {
        // Use the imported kvClient
        const jobData = await kvClient.get(jobId);

        if (!jobData) {
            console.warn(`[Job Status] Job data not found in KV for Job ID: ${jobId}`);
            // Return 404 for not found
            return res.status(404).json({ status: 'not_found', error: 'Job not found or expired.' });
        }

        // Assuming kvClient returns the object directly (no parsing needed for KV)
        res.json({
            status: jobData.status,
            result: jobData.result, // Send result directly
            error: jobData.error   // Send error directly
        });

    } catch (error) {
        console.error(`[Job Status] Error fetching status for Job ID ${jobId} from KV:`, error);
        res.status(500).json({ error: 'Failed to retrieve job status.', details: error.message });
    }
}

module.exports = {
    getJobStatus
}; 