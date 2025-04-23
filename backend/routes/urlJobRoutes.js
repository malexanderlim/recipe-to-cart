const express = require('express');
const urlJobController = require('../controllers/urlJobController');

const router = express.Router();

// POST /api/process-url-job
router.post('/', urlJobController.processUrlJob);

module.exports = router; 