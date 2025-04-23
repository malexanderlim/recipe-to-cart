const express = require('express');
const listController = require('../controllers/listController');

const router = express.Router();

router.post('/', listController.createList);

module.exports = router; 