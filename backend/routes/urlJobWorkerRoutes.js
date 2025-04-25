const express = require('express');
const { processUrlJobWorker } = require('../controllers/urlJobWorkerController');

const router = express.Router();

// This route will be the target for the QStash topic 'url-processing-jobs'
router.post('/process-url-job-worker', processUrlJobWorker);

module.exports = router; 