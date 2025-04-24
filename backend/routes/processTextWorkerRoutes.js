const express = require('express');
const { verifySignature } = require('@upstash/qstash/nextjs'); // Using nextjs helper for Express too
const processTextWorkerController = require('../controllers/processTextWorkerController');

const router = express.Router();

// IMPORTANT: Use express.raw({ type: 'application/json' }) middleware BEFORE
// the QStash verifySignature middleware to ensure req.body is a buffer
// for signature verification, but is parsed as JSON for the controller.
router.post('/',
    express.raw({ type: 'application/json' }), // Read body as buffer first
    async (req, res, next) => { // QStash verification middleware
        try {
            console.log('[QStash Verify] Verifying QStash signature...');
            // Note: verifySignature modifies req.body back to parsed JSON if successful
            await verifySignature(async (req, res) => {
                console.log('[QStash Verify] Signature verified successfully. Proceeding to controller.');
                next(); // Proceed to the actual controller logic if signature is valid
            })(req, res);
        } catch (error) {
            console.error('[QStash Verify] Signature verification failed:', error);
            res.status(401).send('Unauthorized: Invalid QStash Signature');
        }
    },
    processTextWorkerController.handleProcessText // Actual controller logic
);

module.exports = router; 