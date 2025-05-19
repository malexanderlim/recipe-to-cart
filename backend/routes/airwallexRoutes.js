const express = require('express');
const router = express.Router();
const airwallexController = require('../controllers/airwallexController');

// Route to create an Airwallex payment link
router.post('/create-payment-link', airwallexController.createPaymentLink);

// Route to create an Airwallex payment intent for Apple Pay
router.post('/create-payment-intent', airwallexController.createPaymentIntent);

module.exports = router; 