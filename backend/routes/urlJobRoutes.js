const express = require('express');
const urlJobController = require('../controllers/urlJobController');
const { Receiver } = require('@upstash/qstash');

// Initialize QStash Receiver directly
if (!process.env.QSTASH_CURRENT_SIGNING_KEY || !process.env.QSTASH_NEXT_SIGNING_KEY) {
    console.error("CRITICAL: QStash signing key environment variables not set for URL Job Route. Verification will fail.");
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
            // Verify QStash signature
            await receiver.verify({
                signature: req.headers['upstash-signature'],
                body: JSON.stringify(req.body)
            });
            console.log('QStash signature verified for /api/process-url-job');
            next();
        } catch (error) {
            console.error('QStash signature verification failed for /api/process-url-job:', error);
            res.status(401).send('Invalid signature');
        }
    },
    urlJobController.processUrlJob
);

module.exports = router; 