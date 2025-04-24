const express = require('express');
// const { verifySignature } = require('@upstash/qstash/nextjs'); // REMOVE Next.js helper
const { Receiver } = require('@upstash/qstash'); // IMPORT Receiver
const processTextWorkerController = require('../controllers/processTextWorkerController');

const router = express.Router();

// Instantiate the QStash Receiver
const receiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
});

router.post('/',
    // IMPORTANT: Still use express.raw() to get the body as a Buffer
    express.raw({ type: 'application/json' }), 
    async (req, res, next) => { // Middleware to perform verification
        try {
            console.log('[QStash Verify - Receiver] Verifying QStash signature...');
            const signature = req.headers['upstash-signature'];
            if (!signature) {
                console.error('[QStash Verify - Receiver] Missing Upstash-Signature header.');
                return res.status(401).send('Unauthorized: Missing Signature');
            }
            
            // req.body should be a Buffer here thanks to express.raw()
            const isValid = await receiver.verify({
                signature: signature,
                body: req.body, // Pass the raw buffer body
                // Optional: Provide the full URL for extra verification against 'url' claim in JWT
                // url: `${req.protocol}://${req.get('host')}${req.originalUrl}` 
            });

            if (isValid) {
                console.log('[QStash Verify - Receiver] Signature verified successfully.');
                // If valid, parse the JSON body *manually* before passing to the controller
                try {
                     // Ensure req.body is treated as utf-8 string before parsing
                     req.body = JSON.parse(req.body.toString('utf-8'));
                     next(); // Proceed to the controller
                 } catch (parseError) {
                     console.error('[QStash Verify - Receiver] Failed to parse JSON body after verification:', parseError);
                     return res.status(400).send('Bad Request: Invalid JSON body');
                 }
            } else {
                console.error('[QStash Verify - Receiver] Invalid signature detected.');
                res.status(401).send('Unauthorized: Invalid Signature');
            }
        } catch (error) {
            // Log the specific error from receiver.verify if it throws
            console.error('[QStash Verify - Receiver] Error during verification:', error);
            res.status(500).send('Internal Server Error during signature verification');
        }
    },
    processTextWorkerController.handleProcessText // Actual controller logic
);

module.exports = router; 