const express = require('express');
const { Receiver } = require('@upstash/qstash');
const processImageWorkerController = require('../controllers/processImageWorkerController');

const router = express.Router();

// Instantiate the QStash Receiver for this worker
// const receiver = new Receiver({ ... }); // Keep receiver instantiation commented out or remove if not debugging verification

// Define the verification middleware function (TEMPORARILY DISABLED FOR DEBUGGING)
const verifyQstashSignature = async (req, res, next) => {
    console.warn('[QStash Verify Middleware - Image Worker] VERIFICATION TEMPORARILY DISABLED FOR DEBUGGING!');
    return next(); // Immediately proceed without verification

    /* --- Original Verification Logic (Commented Out) ---
    console.log('[QStash Verify Middleware - Image Worker] Checking environment...');
    if (process.env.NODE_ENV !== 'production') {
        console.log('[QStash Verify Middleware - Image Worker] Skipping verification in non-production environment.');
        return next();
    }
    try {
        const receiver = new Receiver({ // Re-create receiver if needed here
             currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
             nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
        });
        console.log('[QStash Verify - Image Worker] Verifying QStash signature...');
        const signature = req.headers['upstash-signature'];
        if (!signature) {
            console.error('[QStash Verify - Image Worker] Missing Upstash-Signature header.');
            return res.status(401).send('Unauthorized: Missing Signature');
        }
        let bodyAsString = JSON.stringify(req.body);
        console.log('[QStash Verify - Image Worker] Body re-serialized for verification.');
        const isValid = await receiver.verify({ signature: signature, body: bodyAsString });
        if (isValid) {
            console.log('[QStash Verify - Image Worker] Signature verified successfully.');
            next();
        } else {
            console.error('[QStash Verify - Image Worker] Invalid signature detected.');
            res.status(401).send('Unauthorized: Invalid Signature');
        }
    } catch (error) {
        console.error('[QStash Verify - Image Worker] Error during verification:', error);
        res.status(500).send('Internal Server Error during signature verification');
    }
    */
};

// --- IMPORTANT --- 
// Ensure that Express's body parser (e.g., express.json()) runs *before* this route handler
// is defined or runs *before* the verifyQstashSignature middleware if it needs the parsed body.
// Typically, global middleware like express.json() is applied before routes are mounted.
// If raw body was needed, express.raw() would need to be applied specifically for this route *before* verification.
// Since we are re-serializing, we rely on express.json() having run first.

router.post('/',
    // Note: express.json() should have run BEFORE this point
    verifyQstashSignature, // Apply the verification middleware
    processImageWorkerController.handleProcessImageJob // The actual job handler
);

module.exports = router; 