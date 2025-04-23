const express = require('express');
const processImageController = require('../controllers/processImageController');

const router = express.Router();

// No specific middleware like multer needed here, just the controller logic
router.post('/', processImageController.handleProcessImage);

module.exports = router; 