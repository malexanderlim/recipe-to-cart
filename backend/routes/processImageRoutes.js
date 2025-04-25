const express = require('express');
const processImageController = require('../controllers/processImageController');
const { qstashReceiver } = require('../services/qstashService'); // Assuming receiver is exported

const router = express.Router();

// Apply QStash verification middleware
router.post(
    '/',
    async (req, res, next) => {
        try {
            // Verify QStash signature
            // Re-stringify the body because express.json() has already parsed it.
            await qstashReceiver.verify({
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
    processImageController.processImage // FIX: Use the correct exported handler name
);

module.exports = router; 