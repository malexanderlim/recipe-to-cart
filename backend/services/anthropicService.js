// --- Setup Anthropic Client ---
const Anthropic = require('@anthropic-ai/sdk'); // <-- Ensure Anthropic SDK is required

// Initialize the Anthropic client
let anthropic;
try {
    if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY environment variable is not set.');
    }
    
    anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
    });
    console.log('Anthropic API client initialized successfully');
} catch (error) {
    console.error('Failed to initialize Anthropic client:', error);
    anthropic = null;
}
// ----------------------------

// --- Helper Function for Anthropic Calls ---
async function callAnthropic(systemPrompt, userPrompt, model = 'claude-3-haiku-20240307', max_tokens = 4096) {
    if (!anthropic) {
        throw new Error('Anthropic client not initialized. Check ANTHROPIC_API_KEY environment variable.');
    }
    
    console.log(`Calling Anthropic model ${model}...`);
    try {
        const response = await anthropic.messages.create({
            model: model,
            max_tokens: max_tokens,
            temperature: 0.1, // Keep low temp for consistency
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }]
        });
        console.log("Anthropic API response received.");

        // Check for valid response structure
        if (response.content && response.content.length > 0 && response.content[0].type === 'text') {
            // Return ONLY the raw text content
            return response.content[0].text;
        } else {
            console.error("Anthropic response format unexpected:", response);
            throw new Error("Anthropic response did not contain expected text content.");
        }
    } catch (error) {
        console.error("Error calling Anthropic API:", error);
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        throw new Error(`Anthropic API Error: ${errorMessage}`);
    }
}

module.exports = {
    anthropic,
    callAnthropic
}; 