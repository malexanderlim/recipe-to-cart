const express = require('express');
const { processImageWorker } = require('../controllers/processImageWorkerController');

const router = express.Router();

// This route will be the target for the QStash topic 'image-processing-jobs'
router.post('/process-image-worker', processImageWorker);

module.exports = router; 