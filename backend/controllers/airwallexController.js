const axios = require('axios');
const crypto = require('crypto');

// Store the token and its expiry to reuse
let airwallexAuthToken = null;
let tokenExpiresAt = 0;

/**
 * Fetches an Airwallex API authentication token.
 * Reuses a cached token if it's still valid.
 */
async function getAirwallexAuthToken() {
    if (airwallexAuthToken && Date.now() < tokenExpiresAt) {
        console.log('Using cached Airwallex token');
        return airwallexAuthToken;
    }

    console.log('Fetching new Airwallex token');
    const clientId = process.env.AIRWALLEX_CLIENT_ID;
    const apiKey = process.env.AIRWALLEX_API_KEY;
    const authUrl = `${process.env.AIRWALLEX_DEMO_API_BASE_URL}/api/v1/authentication/login`;

    if (!clientId || !apiKey) {
        throw new Error('Airwallex Client ID or API Key is not configured in .env');
    }
    if(!process.env.AIRWALLEX_DEMO_API_BASE_URL) {
        throw new Error('AIRWALLEX_DEMO_API_BASE_URL is not configured in .env');
    }

    try {
        const response = await axios.post(authUrl, {}, {
            headers: {
                'x-client-id': clientId,
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            }
        });
        airwallexAuthToken = response.data.token;
        // Set expiry a bit earlier than actual to be safe (e.g., 1 minute earlier)
        tokenExpiresAt = new Date(response.data.expires_at).getTime() - 60000;
        console.log('Successfully fetched Airwallex token');
        return airwallexAuthToken;
    } catch (error) {
        console.error('Error fetching Airwallex token:', error.response ? error.response.data : error.message);
        throw new Error('Failed to authenticate with Airwallex');
    }
}

/**
 * Creates an Airwallex Payment Link.
 */
async function createPaymentLink(req, res) {
    console.log('--- createPaymentLink controller function invoked ---');
    console.log('Request body:', req.body);

    const { amount, currency, description } = req.body;

    if (!amount || !currency || !description) {
        return res.status(400).json({ error: 'Missing required fields: amount, currency, or description' });
    }

    try {
        const authToken = await getAirwallexAuthToken();
        const paymentLinksUrl = `${process.env.AIRWALLEX_DEMO_API_BASE_URL}/api/v1/pa/payment_links/create`;

        const payload = {
            amount: parseFloat(amount), // Ensure amount is a number
            currency: currency,
            merchant_order_id: `${description.replace(/\s+/g, '_').toUpperCase()}_${Date.now()}`,
            title: description, // Use the dynamic description as title
            description: description, // And as description
            return_url: process.env.APP_BASE_URL ? `${process.env.APP_BASE_URL}/payment-success.html` : 'http://localhost:8000/payment-success.html',
            reusable: false
        };

        console.log('Creating Airwallex payment link with dynamic payload:', payload);

        const response = await axios.post(paymentLinksUrl, payload, {
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            }
        });

        console.log('Airwallex payment link created:', response.data);
        res.status(200).json({
            payment_link_url: response.data.url,
            payment_link_id: response.data.id
        });

    } catch (error) {
        console.error('Error creating Airwallex payment link:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to create payment link', details: error.response ? error.response.data : error.message });
    }
}

/**
 * Creates an Airwallex Payment Intent for Apple Pay.
 */
async function createPaymentIntent(req, res) {
    console.log('--- createPaymentIntent controller function invoked ---');
    console.log('Request body:', req.body);

    const { amount, currency, description } = req.body; // Added description for potential future use or logging

    if (!amount || !currency) { // Description is not strictly needed for payment intent itself for Airwallex
        return res.status(400).json({ error: 'Missing required fields: amount or currency' });
    }

    try {
        const authToken = await getAirwallexAuthToken();
        const paymentIntentsUrl = `${process.env.AIRWALLEX_DEMO_API_BASE_URL}/api/v1/pa/payment_intents/create`;

        const payload = {
            request_id: crypto.randomUUID(),
            amount: parseFloat(amount), // Ensure amount is a number
            currency: currency,
            merchant_order_id: crypto.randomUUID(), // Remains dynamic
            // description: description, // Optional: can be added if API supports/requires for intents
        };

        console.log('Creating Airwallex payment intent with dynamic payload:', payload);

        const response = await axios.post(paymentIntentsUrl, payload, {
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            }
        });

        console.log('Airwallex payment intent created:', response.data);
        res.status(200).json({
            intent_id: response.data.id,
            client_secret: response.data.client_secret,
            amount: response.data.amount,
            currency: response.data.currency
        });

    } catch (error) {
        console.error('Error creating Airwallex payment intent:', error.response ? error.response.data : error.message);
        const errorDetails = error.response ? error.response.data : { message: error.message };
        res.status(500).json({ error: 'Failed to create payment intent', details: errorDetails });
    }
}

module.exports = {
    createPaymentLink,
    createPaymentIntent
}; 