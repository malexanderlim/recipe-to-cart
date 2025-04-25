const express = require('express');
const { 
    verifyQstashSignature, 
    processUrlJobWorkerHandler 
} = require('../controllers/urlJobWorkerController');

const router = express.Router();

// Apply QStash verification middleware first, then the handler
// The base path is already /api/process-url-job-worker from server.js
router.post('/', verifyQstashSignature, processUrlJobWorkerHandler);

module.exports = router; 