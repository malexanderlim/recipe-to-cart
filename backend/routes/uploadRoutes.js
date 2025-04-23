const express = require('express');
const multer = require('multer'); // Re-add multer require
const uploadController = require('../controllers/uploadController');

const router = express.Router();

// Re-add Multer configuration specific to this route
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Apply multer middleware directly to the POST route handler
router.post('/', upload.array('recipeImages'), uploadController.handleUpload);

module.exports = router; 