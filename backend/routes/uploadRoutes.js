const express = require('express');
const multer = require('multer');
const uploadController = require('../controllers/uploadController');

const router = express.Router();

// Configure multer for memory storage (as it was in server.js)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Apply multer middleware specifically to this route
// The controller function expects req.files to be populated by multer
router.post('/', upload.array('recipeImages'), uploadController.handleUpload);

module.exports = router; 