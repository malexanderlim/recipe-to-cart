const express = require('express');
const { Receiver } = require('@upstash/qstash');
const processUrlJobWorkerController = require('../controllers/processUrlJobWorkerController');

const router = express.Router();

// Instantiate QStash Receiver
const receiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
});

// Verification middleware (Replicated pattern)
const verifyQstashSignature = async (req, res, next) => {
    console.log('[QStash Verify Middleware - URL Worker] Checking environment...');
    if (process.env.NODE_ENV !== 'production') {
        console.log('[QStash Verify Middleware - URL Worker] Skipping verification in non-production environment.');
        return next();
    }

    try {
        console.log('[QStash Verify - URL Worker] Verifying QStash signature...');
        const signature = req.headers['upstash-signature'];
        if (!signature) {
            console.error('[QStash Verify - URL Worker] Missing Upstash-Signature header.');
            return res.status(401).send('Unauthorized: Missing Signature');
        }

        console.log('[QStash Verify - URL Worker] Type of req.body received:', typeof req.body);
        let bodyAsString;
        try {
            // Re-serialize assuming express.json() ran first
            bodyAsString = JSON.stringify(req.body);
             console.log('[QStash Verify - URL Worker] Body re-serialized for verification.');
        } catch (stringifyError) {
            console.error('[QStash Verify - URL Worker] Failed to re-stringify req.body:', stringifyError);
            return res.status(400).send('Bad Request: Could not process request body.');
        }

        const isValid = await receiver.verify({
            signature: signature,
            body: bodyAsString,
        });

        if (isValid) {
            console.log('[QStash Verify - URL Worker] Signature verified successfully.');
            next();
        } else {
            console.error('[QStash Verify - URL Worker] Invalid signature detected.');
            res.status(401).send('Unauthorized: Invalid Signature');
        }
    } catch (error) {
        console.error('[QStash Verify - URL Worker] Error during verification:', error);
        res.status(500).send('Internal Server Error during signature verification');
    }
};

// Mount route with verification
router.post('/',
    verifyQstashSignature, // Apply verification middleware
    processUrlJobWorkerController.handleProcessUrlJob
);

module.exports = router; 