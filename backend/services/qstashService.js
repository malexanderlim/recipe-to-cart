require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') }); // Ensure env vars are loaded
const { Client } = require("@upstash/qstash");

// Initialize QStash Client
let qstashClient = null;

if (process.env.QSTASH_TOKEN) {
    try {
        qstashClient = new Client({ token: process.env.QSTASH_TOKEN });
        console.log('QStash service: Successfully initialized Upstash QStash client.');
    } catch (error) {
        console.error('QStash service: Failed to initialize Upstash QStash client:', error);
        // Decide if you want to throw error or let the app run without QStash
    }
} else {
    console.warn("QStash service: QSTASH_TOKEN environment variable not set. QStash functionality will be disabled.");
}

module.exports = {
    qstashClient
}; 