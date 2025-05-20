const axios = require('axios');

/**
 * Send ingredients to Instacart API
 * @param {Array} ingredients - List of ingredients to send to Instacart
 * @param {string} title - Optional recipe title
 * @returns {Promise<Object>} - Response from Instacart API
 */
async function sendToInstacart(ingredients, title = 'My Recipe Ingredients') {
    console.log('Sending ingredients to Instacart API');
    
    const instacartApiKey = process.env.INSTACART_API_KEY_PROD;
    
    if (!ingredients || !Array.isArray(ingredients)) {
        throw new Error('Invalid or missing ingredients data for Instacart API call.');
    }
    
    if (!instacartApiKey) {
        throw new Error('Server configuration error: Instacart API key not found.');
    }
    
    // Construct the request body for Instacart API
    const instacartApiUrl = 'https://connect.instacart.com/idp/v1/products/products_link'; // Production URL
    const instacartRequestBody = {
        title: title,
        link_type: 'shopping_list',
        line_items: ingredients.map(item => {
            // Ensure item and measurements are valid before mapping
            const lineItemMeasurements = (item.line_item_measurements && Array.isArray(item.line_item_measurements))
                ? item.line_item_measurements.map(m => ({
                    unit: m.unit,
                    quantity: m.quantity
                  }))
                : []; // Send empty array if measurements are missing/invalid

            return {
                name: item.name || 'Unknown Ingredient',
                line_item_measurements: lineItemMeasurements
            };
        })
    };
    
    try {
        console.log('Sending request to Instacart API:', JSON.stringify(instacartRequestBody, null, 2));
        
        const response = await axios.post(instacartApiUrl, instacartRequestBody, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${instacartApiKey}`
            }
        });
        
        if (response.data && response.data.products_link_url) {
            return {
                success: true,
                instacartUrl: response.data.products_link_url
            };
        } else {
            throw new Error('Instacart API did not return a products_link_url.');
        }
    } catch (error) {
        console.error('Error creating Instacart list:', error);
        throw error;
    }
}

module.exports = {
    sendToInstacart
}; 