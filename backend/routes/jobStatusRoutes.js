const express = require('express');
const jobStatusController = require('../controllers/jobStatusController');

const router = express.Router();

// Use the controller function for GET requests
router.get('/', jobStatusController.getJobStatus);

module.exports = router; 