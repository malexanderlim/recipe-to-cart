const express = require('express');
const { 
    verifyQstashSignature, 
    processImageWorkerHandler 
} = require('../controllers/processImageWorkerController');

const router = express.Router();

// Apply QStash verification middleware first, then the handler
// The base path is already /api/process-image-worker from server.js
router.post('/', verifyQstashSignature, processImageWorkerHandler);

module.exports = router; 