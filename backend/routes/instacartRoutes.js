const express = require('express');
const instacartController = require('../controllers/instacartController');

const router = express.Router();

router.post('/', instacartController.sendToInstacart);

module.exports = router; 