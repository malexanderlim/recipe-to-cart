const express = require('express');
const { 
    verifyQstashSignature, 
    processImageWorkerHandler 
} = require('../controllers/processImageWorkerController');

const router = express.Router();

// This route will be the target for the QStash topic 'image-processing-jobs'
router.post('/process-image-worker', verifyQstashSignature, processImageWorkerHandler);

module.exports = router; 