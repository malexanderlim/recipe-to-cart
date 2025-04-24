// backend/controllers/instacartController.js
// ----------------------------------------------------------------------------
//  FULL "/api/send-to-instacart" CONTROLLER – extracted from legacy server.js
// ----------------------------------------------------------------------------

const { sendToInstacart } = require('../services/instacartService');

/**
 * Handle request to send ingredients to Instacart API
 * Takes processed ingredient list and sends it to Instacart to create a shopping list
 */
async function sendToInstacartHandler(req, res) {
    const { ingredients, title = 'My Recipe Ingredients' } = req.body;
    console.log('Received request to send ingredients to Instacart.');
    
    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
        return res.status(400).json({ error: 'Invalid or empty ingredients list.' });
    }
    
    // Validate each item in the ingredients array
    for (let i = 0; i < ingredients.length; i++) {
        const item = ingredients[i];
        if (typeof item !== 'object' || item === null) {
             return res.status(400).json({ error: `Invalid ingredient item at index ${i}: Expected an object.` });
        }
        if (typeof item.name !== 'string' || !item.name.trim()) {
            return res.status(400).json({ error: `Invalid ingredient item at index ${i}: Missing or empty name.` });
        }
        if (!item.line_item_measurements || !Array.isArray(item.line_item_measurements)) {
            // Note: Service defaults to [] if missing, but explicit check is safer
            return res.status(400).json({ error: `Invalid ingredient item at index ${i}: Missing or invalid line_item_measurements array.` });
        }
        // Validate each measurement within the item
        for (let j = 0; j < item.line_item_measurements.length; j++) {
            const m = item.line_item_measurements[j];
            if (typeof m !== 'object' || m === null) {
                return res.status(400).json({ error: `Invalid measurement at index ${j} for ingredient ${i}: Expected an object.` });
            }
            // Allow null/undefined/empty string for unit? Instacart defaults to 'each'. Let's require it for clarity or allow specific null.
            // if (typeof m.unit !== 'string') { // Too strict? Instacart defaults...
            //     return res.status(400).json({ error: `Invalid measurement unit at index ${j} for ingredient ${i}.` });
            // }
            if (typeof m.quantity !== 'number' || !isFinite(m.quantity) || m.quantity <= 0) {
                 // Instacart API doc implies quantity must be > 0? Let's enforce it.
                 return res.status(400).json({ error: `Invalid measurement quantity at index ${j} for ingredient ${i}: Must be a positive number.` });
            }
        }
    }
    
    try {
        // Call the instacart service with the ingredients
        const result = await sendToInstacart(ingredients, title);
        
        // Return the Instacart URL to the client
        res.json({ instacartUrl: result.instacartUrl });
    } catch (error) {
        console.error('Error sending to Instacart:', error);

        // --- Specific 429 Handling ---
        if (error.response && error.response.status === 429) {
            console.warn('Instacart API rate limit (429) encountered.');
            return res.status(429).json({
                 error: 'Rate Limit Exceeded',
                 details: 'Too many requests sent to Instacart. Please wait a moment and try again.'
                 // Optionally include retry-after header info if Instacart provides it
                 // retryAfter: error.response.headers['retry-after'] 
            });
        }
        // --- End 429 Handling ---
        
        // Determine appropriate status code for other errors
        const statusCode = error.response ? error.response.status : 500;
        const errorMessage = statusCode === 500 
            ? 'An internal error occurred while creating the Instacart list.'
            : 'Failed to create Instacart list.'; // Generic for other client/server errors from Instacart

        res.status(statusCode).json({
            error: errorMessage,
            details: error.message, // Keep original error message for detailed logging/debugging
            instacart_error: error.response ? error.response.data : null, // Include Instacart's error payload if available
            ingredients_sent: ingredients // Include what was sent to help debug
        });
    }
}

module.exports = {
    sendToInstacart: sendToInstacartHandler
}; 