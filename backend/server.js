// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
// Import the Google Cloud Vision client library
const vision = require('@google-cloud/vision');
// Import Anthropic SDK
const Anthropic = require('@anthropic-ai/sdk');
// Import HEIC converter
const heicConvert = require('heic-convert');

const app = express();
const port = process.env.PORT || 3001; // Use environment variable or default

// Creates a client
// Assumes Application Default Credentials (ADC) are set up.
// See: https://cloud.google.com/docs/authentication/provide-credentials-adc#local-dev
const visionClient = new vision.ImageAnnotatorClient();

// Creates an Anthropic client
// Assumes ANTHROPIC_API_KEY environment variable is set
const anthropic = new Anthropic();

// Middleware
app.use(cors()); // Enable CORS for all origins (adjust for production)
app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies

// Configure Multer for file uploads (in-memory storage for simplicity)
const upload = multer({ storage: multer.memoryStorage() });

// --- TODO: Vision API Client Setup --- DONE

// --- TODO: Ingredient Parsing Setup --- Updated to Anthropic
const INGREDIENT_SYSTEM_PROMPT = `You are an expert recipe parser. Your task is to analyze the provided text extracted from a recipe image. 

First, identify the main **title** of the recipe. 

Second, identify the **yield** of the recipe, if specified (e.g., "Serves 4", "Makes 2 loaves", "Yields 6 cups"). Extract the quantity and the unit. Use "persons" as the unit if the keyword is "serves" or if no specific unit is mentioned with "makes" or "yields".

Third, identify ONLY the lines that list **ingredients**. Ignore instructions, page numbers, cooking times, temperatures, storage instructions, and any other non-ingredient text.

For each identified ingredient line, extract:
1.  **quantity**: The numerical amount (e.g., 0.5, 30). Use null if none specified.
2.  **unit**: Standardized unit (e.g., 'cup', 'teaspoon', 'ounce', 'gram', 'each'). Standardize abbreviations (tbsp->tablespoon, tsp->teaspoon, lb->pound, oz->ounce). Remove extraneous characters like brackets.
3.  **ingredient**: The name, including preparations/adjectives (e.g., 'extra-virgin olive oil', 'garlic cloves, peeled', 'Kosher salt').

**Conversion Rules for Ingredients:**
*   Estimate weight in ounces for counts of common items (1 garlic clove ≈ 0.15 oz, 1 large onion ≈ 8 oz, 1 large egg ≈ 2 oz, etc.) using 'ounce' as the unit.
*   Keep existing weights (grams, pounds, oz), standardizing unit names.
*   Keep volumes (cup, tablespoon, ml) or 'each' without common weight conversion, standardizing unit names.

Format your output STRICTLY as a single JSON object with the keys "title", "yield" (which should be an object with "quantity" and "unit", or null if no yield is found), and "ingredients" (an array of ingredient objects as specified above).

Example Input Text Snippet:
MOJO DE AJO
MAKES ABOUT 2 CUPS [480 ML]
1/2 cup [120 ml] extra-virgin olive oil
30 garlic cloves, peeled
Preheat the oven to 350°F [180°C].

Example JSON Output:
{
  "title": "MOJO DE AJO",
  "yield": { "quantity": 2, "unit": "cups" },
  "ingredients": [
    { "quantity": 0.5, "unit": "cup", "ingredient": "extra-virgin olive oil" },
    { "quantity": 4.5, "unit": "ounce", "ingredient": "garlic cloves, peeled" }
  ]
}

If no title, yield, or ingredients are found, return the corresponding key with a null or empty value (e.g., "title": null, "yield": null, "ingredients": []).
Output ONLY the JSON object. Do not include any introductory text, explanations, or markdown formatting like \`\`\`json.
`;

// --- API Endpoints ---

// Endpoint for image upload and processing
app.post('/api/upload', upload.single('recipeImage'), async (req, res) => {
    console.log('Received image upload request');
    if (!req.file) {
        return res.status(400).json({ error: 'No image file provided.' });
    }

    try {
        let imageBuffer = req.file.buffer;
        const originalFilename = req.file.originalname.toLowerCase();
        const mimetype = req.file.mimetype;

        // Modified log to clearly show mimetype
        console.log(`Received file: ${req.file.originalname}, DETECTED MIMETYPE: ${mimetype}, size: ${imageBuffer.length} bytes`);

        // Check if the image is HEIC/HEIF and convert if necessary
        if (mimetype === 'image/heic' || mimetype === 'image/heif' || originalFilename.endsWith('.heic') || originalFilename.endsWith('.heif')) {
            console.log('HEIC/HEIF file detected, attempting conversion to JPEG...');
            try {
                const outputBuffer = await heicConvert({ 
                    buffer: imageBuffer, 
                    format: 'JPEG', 
                    quality: 0.9 // Adjust quality as needed
                });
                imageBuffer = outputBuffer; // Use the converted buffer
                console.log('Successfully converted HEIC to JPEG.');
            } catch (conversionError) {
                console.error('HEIC conversion failed:', conversionError);
                // Decide whether to proceed with original buffer or return error
                // For now, let's return an error as Vision API likely won't parse the original
                return res.status(500).json({ error: 'Failed to convert HEIC image.', details: conversionError.message });
            }
        }

        // --- Call Vision API to extract text ---
        console.log('Calling Google Cloud Vision API...');
        const [result] = await visionClient.textDetection({ image: { content: imageBuffer } });
        const detections = result.textAnnotations;

        let extractedText = '';
        if (detections && detections.length > 0) {
            // The first annotation contains the full detected text
            extractedText = detections[0].description;
            console.log('Successfully extracted text from Vision API.');
            // console.log('Extracted Text:\n', extractedText); // Log full text if needed
        } else {
            console.log('No text detected by Vision API.');
        }

        // --- Parse ingredients from extracted text using Anthropic API ---
        let ingredients = [];
        if (extractedText) {
            console.log(`Sending extracted text to Anthropic for ingredient parsing...`);
            try {
                const msg = await anthropic.messages.create({
                    model: "claude-3-5-haiku-20241022", // Using user's corrected model name
                    max_tokens: 2048,
                    system: INGREDIENT_SYSTEM_PROMPT,
                    messages: [{ role: "user", content: extractedText }],
                });

                // Assuming the response content is the JSON string
                const responseText = msg.content[0]?.text; 
                if (responseText) {
                    console.log("Received response from Anthropic.");
                    // Attempt to parse the JSON object response
                    try {
                        // Find the start and end of the JSON object
                        const jsonStart = responseText.indexOf('{');
                        const jsonEnd = responseText.lastIndexOf('}');
                        
                        if (jsonStart !== -1 && jsonEnd !== -1) {
                            const jsonString = responseText.substring(jsonStart, jsonEnd + 1);
                            // Parse the entire structured object
                            const parsedData = JSON.parse(jsonString);
                            
                            // Extract parts for the response to the frontend
                            const title = parsedData.title || null;
                            const yieldInfo = parsedData.yield || null;
                            ingredients = parsedData.ingredients || []; // Keep using 'ingredients' variable
                            
                            console.log(`Successfully parsed title, yield, and ${ingredients.length} ingredients from Anthropic response.`);
                            
                            // Send structured data back to frontend
                            res.json({ 
                                extractedText, // Still send raw text
                                title, 
                                yield: yieldInfo, 
                                ingredients 
                            });

                        } else {
                             console.error("Anthropic response did not contain a valid JSON object.");
                             // Send error back - or default empty values?
                            res.status(500).json({ error: 'AI parsing failed: Invalid JSON structure.', extractedText });
                        }
                    } catch (jsonParseError) {
                        console.error("Failed to parse JSON response from Anthropic:", jsonParseError);
                        console.error("Anthropic raw response was:", responseText);
                        res.status(500).json({ error: 'AI parsing failed: Could not parse JSON.', extractedText });
                    }
                } else {
                    console.log("Anthropic response did not contain text content.");
                     res.status(500).json({ error: 'AI parsing failed: Empty response.', extractedText });
                }

            } catch (anthropicError) {
                console.error("Error calling Anthropic API:", anthropicError);
                 return res.status(500).json({ 
                    error: 'Failed to parse ingredients using AI.', 
                    details: anthropicError.message,
                    extractedText: extractedText // Still send back the raw text
                });
            }
        } else {
             console.log('No extracted text to parse ingredients from.');
             // Send back empty results if no text was extracted initially
             res.json({ extractedText, title: null, yield: null, ingredients: [] });
        }

    } catch (error) {
        // Handle Vision API errors or other general errors
        console.error('Error in /api/upload endpoint:', error);
        // Avoid sending duplicate responses if Anthropic call already sent one
        if (!res.headersSent) {
             res.status(500).json({ error: 'Failed to process image or parse ingredients.', details: error.message });
        }
    }
});

// Endpoint to create Instacart list
app.post('/api/create-list', async (req, res) => {
    // Remove apiKey from destructuring - it will come from process.env
    const { ingredients, title = 'My Recipe Ingredients' } = req.body;
    console.log('Received request to create Instacart list');

    // Get Instacart API key from environment variables
    const instacartApiKey = process.env.INSTACART_API_KEY;

    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
        return res.status(400).json({ error: 'Invalid or missing ingredients data.' });
    }
    // Remove check for apiKey in body, check environment variable instead
    if (!instacartApiKey) {
        console.error('Instacart API key is missing in environment variables (INSTACART_API_KEY).');
        return res.status(500).json({ error: 'Server configuration error: Instacart API key not found.' });
    }

    const instacartApiUrl = 'https://connect.dev.instacart.tools/idp/v1/products/products_link';

    // Format ingredients for Instacart API
    const lineItems = ingredients.map(item => ({
        name: item.ingredient, // Assuming 'ingredient' holds the name
        quantity: item.quantity || 1, // Default quantity to 1 if missing
        unit: item.unit || 'each' // Default unit to 'each' if missing
    }));

    const requestBody = {
        title: title,
        link_type: 'shopping_list',
        line_items: lineItems
    };

    try {
        console.log('Sending request to Instacart API:', instacartApiUrl);
        console.log('Request Body:', JSON.stringify(requestBody, null, 2));

        const response = await axios.post(instacartApiUrl, requestBody, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                // Use the key from environment variables
                'Authorization': `Bearer ${instacartApiKey}` 
            }
        });

        console.log('Instacart API Response Status:', response.status);
        console.log('Instacart API Response Data:', response.data);

        if (response.data && response.data.products_link_url) {
            res.json({ instacartUrl: response.data.products_link_url });
        } else {
            throw new Error('Instacart API did not return a products_link_url.');
        }

    } catch (error) {
        console.error('Error creating Instacart list:', error.response ? error.response.data : error.message);
        res.status(error.response ? error.response.status : 500).json({ 
            error: 'Failed to create Instacart list.',
            details: error.response ? error.response.data : error.message
        });
    }
});

// Basic route
app.get('/', (req, res) => {
    res.send('Recipe-to-Cart Backend is running!');
});

// Start server
app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
}); 