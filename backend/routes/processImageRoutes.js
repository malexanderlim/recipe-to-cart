const express = require('express');
const processImageController = require('../controllers/processImageController');
const { Receiver } = require('@upstash/qstash'); // Import Receiver directly

// Initialize QStash Receiver directly in the route file
// Ensure necessary environment variables are available
if (!process.env.QSTASH_CURRENT_SIGNING_KEY || !process.env.QSTASH_NEXT_SIGNING_KEY) {
    console.error("CRITICAL: QStash signing key environment variables not set. Verification will fail.");
    // Optional: throw an error during startup in development?
}
const receiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
});

const router = express.Router();

// Apply QStash verification middleware
router.post(
    '/',
    async (req, res, next) => {
        try {
            // Verify QStash signature using the locally initialized receiver
            // Re-stringify the body because express.json() has already parsed it.
            await receiver.verify({
                signature: req.headers['upstash-signature'],
                body: JSON.stringify(req.body)
            });
            console.log('QStash signature verified for /api/process-image');
            next(); // Proceed to controller if valid
        } catch (error) {
            console.error('QStash signature verification failed for /api/process-image:', error);
            res.status(401).send('Invalid signature');
        }
    },
    processImageController.processImage // Use the correct exported handler name
);

module.exports = router; 