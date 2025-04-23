const express = require('express');
const processTextController = require('../controllers/processTextController');

const router = express.Router();

router.post('/', processTextController.processText);

module.exports = router; 