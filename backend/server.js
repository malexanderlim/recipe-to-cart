require('dotenv').config({ path: './.env' }); // Explicitly point to .env

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { GoogleAuth } = require('google-auth-library');
const { ImageAnnotatorClient } = require('@google-cloud/vision');
const Anthropic = require('@anthropic-ai/sdk'); // <-- Ensure Anthropic SDK is required
const axios = require('axios');
const heicConvert = require('heic-convert');

const app = express();
const port = process.env.PORT || 3001;

// --- Setup Anthropic Client ---
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY, // Ensure this key is in your .env
});
// ----------------------------

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
// ------------------

// --- Google Cloud Setup ---
// Assume existing Google Cloud setup using ADC or GOOGLE_APPLICATION_CREDENTIALS
const visionClient = new ImageAnnotatorClient();
// ------------------------


// --- Helper Function for Anthropic Calls ---
async function callAnthropic(systemPrompt, userPrompt) {
    console.log("Calling Anthropic API...");
    try {
        const response = await anthropic.messages.create({
            model: "claude-3-haiku-20240307", // <-- Use Haiku model for cost efficiency
            max_tokens: 2048, // Adjust as needed, ensure enough for JSON output
            temperature: 0.1, // Low temperature for deterministic results
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }]
        });
        console.log("Anthropic API response received.");

        if (response.content && response.content.length > 0 && response.content[0].type === 'text') {
            return response.content[0].text;
        } else {
            console.error("Anthropic response format unexpected:", response);
            throw new Error("Anthropic response did not contain expected text content.");
        }
    } catch (error) {
        console.error("Error calling Anthropic API:", error);
        // Include more details if available (e.g., error type, status code from Anthropic)
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        throw new Error(`Anthropic API Error: ${errorMessage}`);
    }
}
// -----------------------------------------


// Endpoint for image upload and initial parsing (Stage 1)
app.post('/api/upload', upload.array('recipeImages'), async (req, res) => {
    console.log(`Received ${req.files.length} files for upload.`);
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded.' });
    }

    // --- For simplicity in this example, process only the first file ---
    // --- In a real scenario, you'd loop or handle multiple files appropriately ---
    const file = req.files[0];
    let imageBuffer = file.buffer;
    const originalFilename = file.originalname;
    const mimeType = file.mimetype;

    console.log(`Processing file: ${originalFilename}, DETECTED MIMETYPE: ${mimeType}, size: ${file.size} bytes`);

    // --- HEIC Conversion ---
    if (originalFilename.toLowerCase().endsWith('.heic') || originalFilename.toLowerCase().endsWith('.heif') || mimeType === 'image/heic' || mimeType === 'image/heif') {
         console.log('HEIC/HEIF file detected, attempting conversion to JPEG...');
        try {
            imageBuffer = await heicConvert({
                buffer: imageBuffer,
                format: 'JPEG',
                quality: 0.8
            });
             console.log('Successfully converted HEIC to JPEG.');
        } catch (convertError) {
            console.error('HEIC conversion failed:', convertError);
            return res.status(500).json({ error: 'Failed to convert HEIC image.', details: convertError.message });
        }
    }
    // ----------------------

    try {
        // --- Google Cloud Vision API Call ---
        console.log('Calling Google Cloud Vision API...');
        const [result] = await visionClient.textDetection({
            image: { content: imageBuffer },
        });
        const detections = result.textAnnotations;
        const extractedText = detections && detections.length > 0 ? detections[0].description : '';
        console.log('Successfully extracted text from Vision API.');
        // --------------------------------

        if (extractedText && extractedText.trim().length > 0) {
            // --- Anthropic API Call (Stage 1 - Initial Extraction) ---
            console.log('Sending extracted text to Anthropic for ingredient parsing...');
            const systemPromptStage1 = `You are an expert recipe parser. Analyze the following recipe text extracted via OCR and extract key information. Output ONLY a valid JSON object.`;
            const userPromptStage1 = `Recipe Text:\n---\n${extractedText}\n---\n\nExtract the recipe title, yield (quantity and unit, e.g., "4 servings", "2 cups"), and a list of ingredients.\nFor each ingredient, provide:\n- quantity: The numerical value (e.g., 0.5, 30, 1). Use null if not specified.\n- unit: The unit as written in the text (e.g., 'cup', 'cloves', 'tsp', 'sprigs', 'each', 'lb'). Use null if not specified or implied (like '1 lemon').\n- ingredient: The name of the ingredient as written, including descriptive words (e.g., 'extra-virgin olive oil', 'garlic cloves, peeled', 'kosher salt').\n\nOutput ONLY a single JSON object with keys "title", "yield" (an object with "quantity" and "unit"), and "ingredients" (an array of objects with "quantity", "unit", "ingredient"). Ensure the JSON is valid.`;

            const rawJsonResponse = await callAnthropic(systemPromptStage1, userPromptStage1);
            console.log("Received response from Anthropic.");
            // --------------------------

            // --- Parse Stage 1 Response ---
            try {
                const jsonMatch = rawJsonResponse.match(/```json\s*([\s\S]*?)\s*```/);
                const jsonString = jsonMatch ? jsonMatch[1].trim() : rawJsonResponse.trim();
                const parsedData = JSON.parse(jsonString);
                console.log(`Successfully parsed title, yield, and ${parsedData.ingredients?.length || 0} ingredients from Anthropic response.`);

                res.json({
                    extractedText, // Send raw text back too for debugging/context
                    title: parsedData.title,
                    yield: parsedData.yield,
                    ingredients: parsedData.ingredients
                });
            } catch (parseError) {
                console.error("Error parsing Stage 1 JSON response:", parseError);
                console.error("Raw Response causing parse error:", rawJsonResponse);
                res.status(500).json({ error: 'AI parsing failed: Could not parse JSON structure from Stage 1.', details: parseError.message, rawResponse: rawJsonResponse, extractedText });
            }
            // --------------------------

        } else {
            console.log('No extracted text found by Vision API.');
            res.json({ extractedText: '', title: null, yield: null, ingredients: [] }); // Return empty results
        }

    } catch (error) {
        console.error('Error in /api/upload endpoint:', error);
        if (!res.headersSent) { // Avoid sending duplicate error responses
            res.status(500).json({ error: 'Failed to process image or perform initial parsing.', details: error.message });
        }
    }
});


// Endpoint to create Instacart list (incorporating Stage 2 LLM)
// ********** THIS IS THE MODIFIED ENDPOINT **********
app.post('/api/create-list', async (req, res) => {
    const { ingredients: rawIngredients, title = 'My Recipe Ingredients' } = req.body;
    console.log('Received request to create Instacart list (Stage 2 processing).'); // <-- New log
    console.log('Raw ingredients received from frontend:', JSON.stringify(rawIngredients, null, 2)); // <-- New log


    // --- Initial Checks ---
    const instacartApiKey = process.env.INSTACART_API_KEY;
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

    if (!rawIngredients || !Array.isArray(rawIngredients) || rawIngredients.length === 0) {
        return res.status(400).json({ error: 'Invalid or missing ingredients data for Stage 2 processing.' });
    }
    if (!instacartApiKey || !anthropicApiKey) {
        console.error('API key(s) missing in environment variables (INSTACART_API_KEY or ANTHROPIC_API_KEY).');
        return res.status(500).json({ error: 'Server configuration error: API key(s) not found.' });
    }
    // ---------------------


    let finalLineItems;
    try {
        // --- Anthropic API Call (Stage 2 - Normalization & Consolidation) ---
        const systemPromptStage2 = `You are an expert grocery shopping assistant. Your task is to take a list of ingredients compiled from recipes (potentially with scaled quantities), normalize them, convert units to standard Instacart units, consolidate duplicates accurately, and format them for the Instacart API. Prioritize accuracy in unit conversion and consolidation. Adhere strictly to the requested JSON output format.`; // Added strict format adherence

        // Reference: Common Instacart Units: oz, fl oz, lb, g, kg, each, bunch, package, can, cup, pint, head, large, medium, small
        const userPromptStage2 = `Input Ingredient List (JSON array):
\`\`\`json
${JSON.stringify(rawIngredients, null, 2)}
\`\`\`

Instructions:
1.  **Normalize Ingredient Names:** Identify the core purchasable item. Merge common variations (peeled, minced, chopped, stemmed, leaves) into a base name but retain essential types (e.g., "dried oregano", "extra-virgin olive oil", "kosher salt", "greek-style yogurt"). Use lowercase.
2.  **Standardize Units & Generate Measurements:** Convert recipe units to standard Instacart units (oz, fl oz, lb, g, kg, each, bunch, package, can, head). For each ingredient, determine the primary standardized unit and calculate the quantity. Where appropriate (e.g., for garlic, fresh herbs, tomatoes), ALSO determine a common secondary unit (like oz or lb) and calculate its quantity. 
3.  **Apply Purchasable Quantity Rules:** For BOTH the primary and any secondary measurements generated:
    *   Round UP quantities for countable units ('bunch', 'can', 'head', 'each') to the nearest whole number.
    *   For fresh herbs converted to weight/volume, if the quantity is small (< ~2oz/~50g), adjust to quantity: 1, unit: 'bunch' or 'package'.
    *   Ensure other weights/volumes are practical.
4.  **Consolidate:** Combine items with the same normalized name. For each item, output an array of the *adjusted* measurement objects ({unit, quantity}) generated in step 3. 
5.  **Format Output:** Return ONLY a valid JSON array of objects. Each object MUST have keys:
    *   "name" (string, normalized)
    *   "line_item_measurements" (array of objects, each containing "unit" [string] and "quantity" [number] AFTER adjustments)
    *   "original_quantity" (number)
    *   "original_unit" (string)
    Do not include any other text.

Example Input: [{"ingredient": "garlic cloves, peeled", "quantity": 30, "unit": "cloves"}]
Example Output: [
  {"name": "garlic", "line_item_measurements": [{"unit": "head", "quantity": 3}, {"unit": "oz", "quantity": 12}], "original_quantity": 30, "original_unit": "cloves"}
]

Example Input: [{"ingredient": "basil leaves", "quantity": 15, "unit": "g"}]
Example Output: [
  {"name": "basil", "line_item_measurements": [{"unit": "package", "quantity": 1}, {"unit": "oz", "quantity": 0.5}], "original_quantity": 15, "original_unit": "g"} // Note: 0.5oz might be adjusted later by algorithm if needed
]

Final Output JSON Array:
`;

        console.log("Calling Stage 2 LLM for preliminary processing..."); // Updated log text
        const stage2Response = await callAnthropic(systemPromptStage2, userPromptStage2);
        console.log("Raw Stage 2 LLM Response:", stage2Response); // <-- New log

        // --- Parse Stage 2 Response ---
        try {
            // Attempt to extract JSON potentially embedded in markdown first
            let jsonString = stage2Response.trim();
            const jsonMatch = jsonString.match(/```json\s*([\s\S]*?)\s*```/);
            if (jsonMatch) {
                console.log("Found JSON block in Stage 2 response.");
                jsonString = jsonMatch[1].trim();
            } else {
                console.log("No JSON block found, attempting to parse entire Stage 2 response.");
            }

            let llmProcessedItems = JSON.parse(jsonString);

             // --- Basic validation of LLM output structure ---
            if (!Array.isArray(llmProcessedItems)) {
                 throw new Error("Parsed response is not an array.");
            }
            // Check for required keys from LLM
            if (llmProcessedItems.length > 0 && llmProcessedItems.some(item => 
                 typeof item.name !== 'string' || 
                 !Array.isArray(item.line_item_measurements) || 
                 item.line_item_measurements.length === 0 ||
                 item.line_item_measurements.some(m => typeof m.unit !== 'string' || typeof m.quantity !== 'number') ||
                 typeof item.original_quantity !== 'number' ||
                 typeof item.original_unit !== 'string' // Allow null
             )) { 
                 throw new Error("Parsed array items missing required keys or have incorrect structure (name, line_item_measurements: [{unit, quantity}], original_quantity, original_unit).");
             }
             console.log("Stage 2 LLM preliminary processing successful.");

            // --- START: Algorithmic Post-Processing on Measurements --- 
            console.log("Applying algorithmic adjustments to measurements...");
            const finalAdjustedItems = llmProcessedItems.map(item => {
                const finalMeasurements = item.line_item_measurements.map(measurement => {
                    let adjustedQuantity = measurement.quantity;
                    const unit = measurement.unit.toLowerCase();
                    const name = item.name.toLowerCase();
                    const originalUnit = item.original_unit?.toLowerCase();

                    const countableUnits = ['bunch', 'can', 'head', 'each'];
                    const freshHerbs = ['basil', 'thyme', 'mint', 'parsley', 'cilantro', 'rosemary', 'dill', 'oregano'];

                    // Rule 1: Garlic conversion consistency (applied to 'head' unit)
                    if (name === 'garlic' && unit === 'head' && originalUnit === 'cloves') {
                        adjustedQuantity = Math.ceil(item.original_quantity / 10); 
                        console.log(`Adjusted garlic head: ${item.original_quantity} cloves -> ${adjustedQuantity} head`);
                    }
                    // Rule 2: Fresh herb bunch/package minimum (applied to 'bunch'/'package' units)
                    else if (freshHerbs.some(herb => name.includes(herb)) && (unit === 'bunch' || unit === 'package')) {
                         if (adjustedQuantity < 1) {
                             adjustedQuantity = 1;
                             console.log(`Adjusted ${name} ${unit} minimum to 1`);
                         }
                         adjustedQuantity = Math.ceil(adjustedQuantity);
                    }
                     // Rule 3: Ensure countable units are whole numbers (round up)
                    else if (countableUnits.includes(unit)) {
                         if (adjustedQuantity !== Math.ceil(adjustedQuantity)) {
                            console.log(`Adjusted ${name} ${unit}: ${measurement.quantity} -> ${Math.ceil(adjustedQuantity)}`);
                            adjustedQuantity = Math.ceil(adjustedQuantity);
                         }
                    }

                    return { unit: measurement.unit, quantity: adjustedQuantity };
                });

                // Return the final structure for the *next* step (frontend review)
                return {
                    name: item.name,
                    line_item_measurements: finalMeasurements, // Pass adjusted measurements
                    // Keep original values if needed for display/debug, but not for Instacart
                    // original_quantity: item.original_quantity, 
                    // original_unit: item.original_unit
                };
            });
            console.log("Algorithmic adjustments applied. Final List for Review:", JSON.stringify(finalAdjustedItems, null, 2));
            // --- END: Algorithmic Post-Processing ---

            finalLineItems = finalAdjustedItems; // Use the adjusted list for response

        } catch (parseError) {
             console.error("Error parsing Stage 2 JSON response:", parseError);
             throw new Error(`AI Normalization Failed: Could not parse valid line_items JSON array from Stage 2 response. Details: ${parseError.message}`);
        }
        // --------------------------

        // *** MODIFICATION START: Return the processed list, don't call Instacart yet ***
        res.json({ 
            processedIngredients: finalLineItems, 
            originalTitle: title // Pass original title back too
        }); 
        // *** MODIFICATION END ***

    } catch (llmError) {
        console.error("Error during Stage 2 LLM processing:", llmError);
        // Send error response to client
        return res.status(500).json({
            error: 'Failed to normalize or consolidate ingredients using AI.',
            details: llmError.message // Provide the specific LLM error
        });
    }
    
    // --- REMOVE INSTACART API CALL FROM HERE --- 
    /*
    // --- Prepare and Call Instacart API ---
    // Ensure finalLineItems is defined and is an array before proceeding
     if (!finalLineItems || !Array.isArray(finalLineItems)) {
         console.error("Stage 2 LLM processing resulted in invalid finalLineItems. Cannot call Instacart.");
         return res.status(500).json({
             error: 'Internal server error: Failed to obtain valid ingredient list after AI processing.',
             details: 'finalLineItems was null or not an array.'
         });
     }

    const instacartApiUrl = 'https://connect.dev.instacart.tools/idp/v1/products/products_link';
    const instacartRequestBody = {
        title: title,
        link_type: 'shopping_list',
        line_items: finalLineItems // Use the LLM-processed list
    };

    try {
        console.log('Sending final request to Instacart API...'); // <-- Existing log
        console.log('Instacart Request Body:', JSON.stringify(instacartRequestBody, null, 2)); // <-- Log the ACTUAL body being sent
        console.log('Using Instacart API Key (masked):', `***${instacartApiKey.slice(-4)}`); // <-- Existing log

        const response = await axios.post(instacartApiUrl, instacartRequestBody, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${instacartApiKey}`
            }
        });

        console.log('Instacart API Response Status:', response.status); // <-- Existing log
        // console.log('Instacart API Response Data:', response.data);

        if (response.data && response.data.products_link_url) {
            res.json({ instacartUrl: response.data.products_link_url });
        } else {
            console.error('Instacart API response missing products_link_url:', response.data);
            throw new Error('Instacart API did not return a products_link_url.');
        }

    } catch (instacartError) {
        console.error('Error creating Instacart list:', instacartError.response ? JSON.stringify(instacartError.response.data) : instacartError.message); // Log full error data if available
        const errorDetails = instacartError.response ? instacartError.response.data : instacartError.message;
        const statusCode = instacartError.response ? instacartError.response.status : 500;
         res.status(statusCode).json({
            error: 'Failed to create Instacart list.',
            details: errorDetails,
            llm_output_sent: finalLineItems // Include what was sent to help debug
        });
    }
    */
    // ------------------------------------
});


// *** NEW ENDPOINT: Send final list to Instacart ***
app.post('/api/send-to-instacart', async (req, res) => {
    const { ingredients, title } = req.body; // Expect final list and title
    console.log('Received request to send final list to Instacart.');
    console.log('Final ingredients received for Instacart:', JSON.stringify(ingredients, null, 2));

    // --- Initial Checks ---
    const instacartApiKey = process.env.INSTACART_API_KEY;
    if (!ingredients || !Array.isArray(ingredients)) { // Allow empty list if user deselects all
        return res.status(400).json({ error: 'Invalid or missing ingredients data for Instacart API call.' });
    }
    if (!instacartApiKey) {
        console.error('Instacart API key missing in environment variables.');
        return res.status(500).json({ error: 'Server configuration error: Instacart API key not found.' });
    }
    // ---------------------
    
    // --- Prepare and Call Instacart API ---
    const instacartApiUrl = 'https://connect.dev.instacart.tools/idp/v1/products/products_link';
    const instacartRequestBody = {
        title: title || 'My Recipe Ingredients', 
        link_type: 'shopping_list',
        line_items: ingredients // Pass the structure directly
    };

    try {
        console.log('Sending final request to Instacart API...');
        console.log('Instacart Request Body:', JSON.stringify(instacartRequestBody, null, 2));
        console.log('Using Instacart API Key (masked):', `***${instacartApiKey.slice(-4)}`);

        const response = await axios.post(instacartApiUrl, instacartRequestBody, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${instacartApiKey}`
            }
        });

        console.log('Instacart API Response Status:', response.status);

        if (response.data && response.data.products_link_url) {
            res.json({ instacartUrl: response.data.products_link_url });
        } else {
            console.error('Instacart API response missing products_link_url:', response.data);
            throw new Error('Instacart API did not return a products_link_url.');
        }

    } catch (instacartError) {
        console.error('Error creating Instacart list:', instacartError.response ? JSON.stringify(instacartError.response.data) : instacartError.message);
        const errorDetails = instacartError.response ? instacartError.response.data : instacartError.message;
        const statusCode = instacartError.response ? instacartError.response.status : 500;
         res.status(statusCode).json({
            error: 'Failed to create Instacart list.',
            details: errorDetails,
            ingredients_sent: ingredients // Include what was sent to help debug
        });
    }
    // ------------------------------------
});

// Basic route
app.get('/', (req, res) => {
    res.send('Recipe-to-Cart Backend is running!');
});

// Start server
app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});