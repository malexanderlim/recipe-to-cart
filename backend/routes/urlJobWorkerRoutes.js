const express = require('express');
const { 
    verifyQstashSignature, 
    processUrlJobWorkerHandler 
} = require('../controllers/urlJobWorkerController');

const router = express.Router();

// Apply QStash verification middleware first, then the handler
router.post('/process-url-job-worker', verifyQstashSignature, processUrlJobWorkerHandler);

module.exports = router; 