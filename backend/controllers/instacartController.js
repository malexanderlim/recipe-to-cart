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
    
    try {
        // Call the instacart service with the ingredients
        const result = await sendToInstacart(ingredients, title);
        
        // Return the Instacart URL to the client
        res.json({ instacartUrl: result.instacartUrl });
    } catch (error) {
        console.error('Error sending to Instacart:', error);
        
        // Determine appropriate status code
        const statusCode = error.response ? error.response.status : 500;
        
        res.status(statusCode).json({
            error: 'Failed to create Instacart list.',
            details: error.message,
            ingredients_sent: ingredients // Include what was sent to help debug
        });
    }
}

module.exports = {
    sendToInstacart: sendToInstacartHandler
}; 