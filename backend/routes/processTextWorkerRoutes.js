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
    // REMOVE express.raw() - Assume body is already parsed by Vercel/Express default
    async (req, res, next) => { 
        try {
            console.log('[QStash Verify - Receiver v2] Verifying QStash signature...');
            const signature = req.headers['upstash-signature'];
            if (!signature) {
                console.error('[QStash Verify - Receiver v2] Missing Upstash-Signature header.');
                return res.status(401).send('Unauthorized: Missing Signature');
            }
            
            // Log the type and content of req.body as received
            console.log('[QStash Verify - Receiver v2] Type of req.body received:', typeof req.body);
            console.log('[QStash Verify - Receiver v2] Value of req.body received:', req.body);

            // Re-stringify the already parsed body for verification
            let bodyAsString;
            try {
                 bodyAsString = JSON.stringify(req.body);
                 console.log('[QStash Verify - Receiver v2] Body re-serialized for verification:', bodyAsString);
            } catch (stringifyError) {
                console.error('[QStash Verify - Receiver v2] Failed to re-stringify req.body:', stringifyError);
                 return res.status(400).send('Bad Request: Could not process request body.');
            }
            
            const isValid = await receiver.verify({
                signature: signature,
                body: bodyAsString, // Use the re-serialized string
            });

            if (isValid) {
                console.log('[QStash Verify - Receiver v2] Signature verified successfully.');
                // No need to parse again, req.body is already an object
                next(); 
            } else {
                console.error('[QStash Verify - Receiver v2] Invalid signature detected.');
                res.status(401).send('Unauthorized: Invalid Signature');
            }
        } catch (error) {
            console.error('[QStash Verify - Receiver v2] Error during verification:', error);
            res.status(500).send('Internal Server Error during signature verification');
        }
    },
    processTextWorkerController.handleProcessText 
);

module.exports = router; 