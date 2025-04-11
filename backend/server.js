// Load environment variables from .env file
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

// --- ADDED DEBUG LOGS for Environment Variables ---
console.log('--- Environment Variables Check ---');
console.log(`process.env.ANTHROPIC_API_KEY loaded: ${!!process.env.ANTHROPIC_API_KEY}`); // Check if defined (value is sensitive)
console.log(`process.env.INSTACART_API_KEY loaded: ${!!process.env.INSTACART_API_KEY}`); // Check if defined (value is sensitive)
console.log(`process.env.PORT: ${process.env.PORT}`); // Check the port value
console.log('-----------------------------------');
// -------------------------------------------------

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

// Creates a client for Google Vision
// Assumes Application Default Credentials (ADC) are set up.
let visionClient;
try {
    visionClient = new vision.ImageAnnotatorClient();
    console.log("Google Vision client initialized successfully.");
} catch (error) {
    console.error("FATAL: Failed to initialize Google Vision client:", error);
    process.exit(1);
}

// Creates an Anthropic client
// Assumes ANTHROPIC_API_KEY environment variable is set
let anthropic;
try {
    // Explicitly pass the API key from environment variables
    anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY, 
    });
    console.log("Anthropic client initialized successfully (with explicit key).");
} catch (error) {
    console.error("FATAL: Failed to initialize Anthropic client:", error);
    process.exit(1); // Exit the process if client fails to initialize
}

// Middleware
app.use(cors()); // Enable CORS for all origins (adjust for production)
app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies

// Configure Multer for file uploads (in-memory storage for simplicity)
const upload = multer({ storage: multer.memoryStorage() });

// --- TODO: Vision API Client Setup --- DONE

// --- TODO: Ingredient Parsing Setup --- Updated to Anthropic
const INGREDIENT_SYSTEM_PROMPT = `You are an expert recipe parser that converts recipe ingredients into a format suitable for an online shopping list (like Instacart). Your task is to analyze the provided text extracted from a recipe image.

First, identify the main **title** of the recipe.

Second, identify the **yield** of the recipe (e.g., "Serves 4", "Makes 2 loaves"). Extract the quantity and the unit. Use "persons" as the unit if the keyword is "serves".

Third, identify ONLY the lines that list **ingredients**. Ignore instructions, page numbers, etc.

For each identified ingredient line, extract quantity, unit, and ingredient name, then **convert them into shopping list format** according to these rules:

1.  **Standard Weights/Volumes:** If the unit is a standard measure, use the following Instacart-compatible units:
    - Volume: cup, tablespoon, teaspoon, fluid ounce (fl oz), milliliter (ml), liter (l), pint, quart, gallon
    - Weight: ounce (oz), pound (lb), gram (g), kilogram (kg)
    *   Example: "1/2 cup extra-virgin olive oil" -> { "quantity": 0.5, "unit": "cup", "ingredient": "extra-virgin olive oil" }
    *   Example: "3 tbsp soy sauce" -> { "quantity": 3, "unit": "tablespoon", "ingredient": "soy sauce" }

2.  **Countable Items:** If the unit refers to a countable item, use these Instacart-compatible units ONLY:
    - bunch (for herbs, vegetables sold in bunches)
    - can (for canned goods)
    - each (for single items, heads, or individual fruits/vegetables)
    - head (use "each" instead)
    - package (for packaged goods)
    - Size descriptors: small, medium, large
    *   Example: "1 lime" -> { "quantity": 1, "unit": "each", "ingredient": "lime" }
    *   Example: "2 large onions, chopped" -> { "quantity": 2, "unit": "large", "ingredient": "onions" }
    *   Example: "1 bunch cilantro" -> { "quantity": 1, "unit": "bunch", "ingredient": "cilantro" }
    *   Example: "2 (15 oz) cans diced tomatoes" -> { "quantity": 2, "unit": "can", "ingredient": "diced tomatoes" }

3.  **Garlic:** For garlic, follow these guidelines to ensure proper matching in Instacart:
    *   If the recipe specifies "head" or "heads": { "quantity": [number], "unit": "each", "ingredient": "garlic" }
    *   If the recipe specifies "clove" or "cloves": STILL use { "quantity": [number], "unit": "cloves", "ingredient": "garlic" }
       (The backend will handle converting cloves to heads using a 10 cloves = 1 head ratio)
    *   Example: "8 heads garlic" -> { "quantity": 8, "unit": "each", "ingredient": "garlic" }
    *   Example: "30 cloves garlic, minced" -> { "quantity": 30, "unit": "cloves", "ingredient": "garlic, peeled" }
    *   IMPORTANT: Be extremely accurate when counting garlic cloves/heads.

4.  **Herbs:** For fresh herbs typically sold in bunches, use "bunch" as the unit. For dried herbs and spices typically sold in containers, use appropriate volume measures:
    *   Example: "1 bunch fresh thyme" -> { "quantity": 1, "unit": "bunch", "ingredient": "fresh thyme" }
    *   Example: "12 sprigs fresh thyme" -> { "quantity": 1, "unit": "bunch", "ingredient": "fresh thyme" }
    *   Example: "2 tsp dried oregano" -> { "quantity": 2, "unit": "teaspoon", "ingredient": "dried oregano" }

5.  **Bay Leaves:** For bay leaves, don't count individual leaves; instead, use:
    *   Example: "3 bay leaves" -> { "quantity": 1, "unit": "each", "ingredient": "bay leaves" }

6.  **Ambiguous/Unitless Items:** For items with no clear unit or quantity (e.g., "Salt to taste"), use a sensible default:
    *   Example: "Salt and pepper to taste" -> { "quantity": 1, "unit": "each", "ingredient": "salt" } and { "quantity": 1, "unit": "each", "ingredient": "pepper" }

**Output Format:**
Format your output STRICTLY as a single JSON object with the keys "title", "yield" (object with "quantity" and "unit", or null), and "ingredients" (an array of the converted shopping list item objects).

Example Input Text Snippet:
MOJO DE AJO
MAKES 2 CUPS
1/2 cup extra-virgin olive oil
30 cloves garlic, peeled
1/2 cup fresh lime juice
1 teaspoon dried oregano
1/2 teaspoon crushed red pepper flakes
1 kosher salt
1/2 cup fresh orange juice

Example JSON Output:
{
  "title": "MOJO DE AJO",
  "yield": { "quantity": 2, "unit": "cups" },
  "ingredients": [
    { "quantity": 0.5, "unit": "cup", "ingredient": "extra-virgin olive oil" },
    { "quantity": 30, "unit": "cloves", "ingredient": "garlic, peeled" },
    { "quantity": 0.5, "unit": "cup", "ingredient": "fresh lime juice" },
    { "quantity": 1, "unit": "teaspoon", "ingredient": "dried oregano" },
    { "quantity": 0.5, "unit": "teaspoon", "ingredient": "crushed red pepper flakes" },
    { "quantity": 1, "unit": "each", "ingredient": "kosher salt" },
    { "quantity": 0.5, "unit": "cup", "ingredient": "fresh orange juice" }
  ]
}

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
            console.log('==== EXTRACTED TEXT FROM OCR ====');
            console.log(extractedText);
            console.log('=================================');
        } else {
            console.log('No text detected by Vision API.');
        }

        // --- Parse ingredients from extracted text using Anthropic API ---
        let ingredients = [];
        if (extractedText) {
            console.log(`Sending extracted text to Anthropic for ingredient parsing...`);
            // --- ADDED DEBUG LOG FOR SYSTEM PROMPT ---
            console.log(`Using System Prompt: ${INGREDIENT_SYSTEM_PROMPT}`); 
            // -------------------------------------------
            try {
                // --- ADDED DEBUG LOGS: Check key and client state before API call ---
                console.log(`[DEBUG] Checking Auth Key before messages.create: process.env.ANTHROPIC_API_KEY defined? ${!!process.env.ANTHROPIC_API_KEY}`);
                // Note: Inspecting the internal state like this is fragile and depends on SDK implementation details
                // We log it here purely for debugging this specific persistent auth issue.
                // REMOVING: console.log(`[DEBUG] Anthropic client object (internal state inspection):`, JSON.stringify(anthropic, null, 2)); 
                // ----------------------------------------------------------------------

                const msg = await anthropic.messages.create({
                    model: "claude-3-5-haiku-20241022", // Using user's corrected model name
                    max_tokens: 2048, // Increased slightly for potentially more complex reasoning
                    system: INGREDIENT_SYSTEM_PROMPT,
                    messages: [{ role: "user", content: extractedText }],
                });

                // Assuming the response content is the JSON string
                const responseText = msg.content[0]?.text; 
                if (responseText) {
                    console.log("Received response from Anthropic.");
                    console.log("FULL LLM RESPONSE:", responseText);
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
                            
                            // --- DEBUG LOG: Ingredients parsed by LLM (now expected to include 'cloves') ---
                            console.log('Ingredients parsed from LLM (before backend conversion):', JSON.stringify(ingredients, null, 2));
                            // --------------------------------------------------------------------------------------

                            // Check specifically for garlic quantity to debug issue
                            const garlicCloves = ingredients.find(item => 
                                (item.ingredient || '').toLowerCase().includes('garlic') && 
                                (item.unit || '').toLowerCase() === 'cloves'
                            );
                            if (garlicCloves) {
                                console.log('IMPORTANT - GARLIC CLOVES DETECTED:', 
                                    `Quantity: ${garlicCloves.quantity}, Unit: ${garlicCloves.unit}, Ingredient: ${garlicCloves.ingredient}`);
                            }

                            // --- START: Backend Garlic Conversion (Cloves/Heads to Each/Ounce) ---
                            const GARLIC_CLOVE_TO_OZ_FACTOR = 0.15;
                            const CLOVE_TO_HEAD_THRESHOLD = 6; // If cloves <= this, assume 1 head ('each')

                            ingredients = ingredients.map(item => {
                                const unitLower = (item.unit || '').toLowerCase();
                                const ingredientLower = (item.ingredient || '').toLowerCase();

                                // Logic for Garlic specifically
                                if (ingredientLower.includes('garlic')) {
                                    // If unit is cloves, decide between 'each' (head) or 'ounce'
                                    if (unitLower === 'clove' || unitLower === 'cloves') {
                                        if (typeof item.quantity === 'number' && item.quantity > 0) {
                                            const originalQuantity = item.quantity;
                                            
                                            // Instead of converting directly, provide alternative measurements
                                            // Keep cloves as the primary unit but add alternatives
                                            const measurements = [
                                                { quantity: originalQuantity, unit: 'cloves' }
                                            ];
                                            
                                            // Few cloves -> 1 head ('each') as alternative
                                            if (originalQuantity <= CLOVE_TO_HEAD_THRESHOLD) {
                                                console.log(`[MEASUREMENT] Adding alternative for garlic: ${originalQuantity} cloves -> 1 each (head)`);
                                                measurements.push({ quantity: 1, unit: 'each' });
                                                
                                                // For small quantities of cloves, don't add ounce conversion
                                                // Just keep cloves and each (head) as options
                                            } 
                                            // Many cloves -> ounces as alternative
                                            else {
                                                const ozQuantity = parseFloat((originalQuantity * GARLIC_CLOVE_TO_OZ_FACTOR).toFixed(2));
                                                console.log(`[MEASUREMENT] Adding alternative for garlic: ${originalQuantity} cloves -> ${ozQuantity} ounce`);
                                                measurements.push({ quantity: ozQuantity, unit: 'ounce' });
                                                // Also add grams as another alternative
                                                const gramQuantity = parseFloat((ozQuantity * 28.35).toFixed(2));
                                                measurements.push({ quantity: gramQuantity, unit: 'g' });
                                            }
                                            
                                            // Return enhanced item with measurements
                                            return {
                                                ...item,
                                                line_item_measurements: measurements
                                            };
                                        } else {
                                            console.warn('Found garlic clove item, but quantity is not a positive number. Skipping conversion:', item);
                                        }
                                    } 
                                    // If unit is already 'head' or 'heads', ensure it's 'each' and add alternatives
                                    else if (unitLower === 'head' || unitLower === 'heads') {
                                        const measurements = [
                                            { quantity: item.quantity, unit: 'each' }
                                        ];
                                        
                                        // Add ounce alternative (1 head ≈ 1.75 oz)
                                        const ozQuantity = parseFloat((item.quantity * 1.75).toFixed(2));
                                        measurements.push({ quantity: ozQuantity, unit: 'ounce' });
                                        
                                        // Add gram alternative
                                        const gramQuantity = parseFloat((ozQuantity * 28.35).toFixed(2));
                                        measurements.push({ quantity: gramQuantity, unit: 'g' });
                                        
                                        console.log(`[MEASUREMENT] Adding alternatives for garlic heads: ${item.quantity} heads -> multiple units`);
                                        
                                        return { 
                                            ...item, 
                                            unit: 'each',
                                            line_item_measurements: measurements
                                        };
                                    }
                                }
                                
                                // Add other non-garlic conversions here if needed in the future

                                return item; // Return unchanged item if no conversion applied
                            });
                            // --- END: Backend Garlic Conversion ---

                            // --- START: Consolidate potentially mixed garlic units (each/ounce) --- 
                            const garlicItems = ingredients.filter(item => (item.ingredient || '').toLowerCase().includes('garlic'));
                            
                            // Only consolidate if there are multiple garlic items
                            if (garlicItems.length > 1) {
                                console.log('[CONSOLIDATION] Found multiple garlic items. Creating a consolidated item with all measurements.');
                                
                                // Collect all measurements from all garlic items
                                const allMeasurements = [];
                                
                                garlicItems.forEach(item => {
                                    // Add the primary measurement
                                    allMeasurements.push({
                                        quantity: item.quantity,
                                        unit: item.unit
                                    });
                                    
                                    // Add any alternative measurements
                                    if (item.line_item_measurements && Array.isArray(item.line_item_measurements)) {
                                        item.line_item_measurements.forEach(measurement => {
                                            allMeasurements.push(measurement);
                                        });
                                    }
                                });
                                
                                // Filter out old garlic items
                                ingredients = ingredients.filter(item => !(item.ingredient || '').toLowerCase().includes('garlic'));
                                
                                // Add the new consolidated garlic item with all measurements
                                ingredients.push({
                                    ingredient: 'garlic', 
                                    quantity: garlicItems[0].quantity, // Use the first item's quantity as primary
                                    unit: garlicItems[0].unit, // Use the first item's unit as primary
                                    line_item_measurements: allMeasurements
                                });
                                
                                console.log(`[CONSOLIDATION] Consolidated garlic with ${allMeasurements.length} measurement options`);
                            }
                            // --- END: Consolidate mixed garlic units ---

                            // --- DEBUG LOG: Final ingredients after potential conversion --- 
                            console.log('Final ingredients after backend conversion/consolidation:', JSON.stringify(ingredients, null, 2));
                            // --------------------------------------------------------------- 

                            console.log(`Successfully processed title, yield, and ${ingredients.length} shopping list ingredients from Anthropic response.`);
                            
                            // Send structured data back to frontend
                            res.json({ 
                                extractedText, // Still send raw text
                                title, 
                                yield: yieldInfo, 
                                ingredients // Send the LLM's processed shopping list ingredients
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
    console.log('Raw ingredients received:', JSON.stringify(ingredients, null, 2));

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

    // Unit conversion mapping to ensure we use Instacart's accepted units
    const unitMapping = {
        // Measured items - volume
        'cup': 'cup', 'cups': 'cup', 'c': 'cup',
        'tablespoon': 'tablespoon', 'tablespoons': 'tablespoon', 'tbsp': 'tablespoon', 'tb': 'tablespoon', 'tbs': 'tablespoon',
        'teaspoon': 'teaspoon', 'teaspoons': 'teaspoon', 'tsp': 'teaspoon', 'ts': 'teaspoon', 'tspn': 'teaspoon',
        'fluid ounce': 'fl oz', 'fl oz': 'fl oz', 'fl ounce': 'fl oz',
        'ml': 'ml', 'milliliter': 'ml', 'milliliters': 'ml', 'millilitre': 'ml', 'millilitres': 'ml',
        'l': 'l', 'liter': 'l', 'liters': 'l', 'litre': 'l', 'litres': 'l',
        'pint': 'pint', 'pints': 'pint', 'pt': 'pint', 'pts': 'pint',
        'quart': 'quart', 'quarts': 'quart', 'qt': 'quart', 'qts': 'quart',
        'gallon': 'gallon', 'gallons': 'gallon', 'gal': 'gallon', 'gals': 'gallon',
        
        // Weighed items
        'ounce': 'oz', 'ounces': 'oz', 'oz': 'oz',
        'pound': 'lb', 'pounds': 'lb', 'lb': 'lb', 'lbs': 'lb',
        'gram': 'g', 'grams': 'g', 'g': 'g', 'gs': 'g',
        'kilogram': 'kg', 'kilograms': 'kg', 'kg': 'kg', 'kgs': 'kg',
        
        // Countable items
        'each': 'each',
        'clove': 'each', // Convert cloves to each, with special handling below
        'cloves': 'each', // Convert cloves to each, with special handling below
        'head': 'each', 'heads': 'each',
        'bunch': 'bunch', 'bunches': 'bunch',
        'can': 'can', 'cans': 'can',
        'package': 'package', 'packages': 'package', 'pkg': 'package',
        'large': 'large', 'lrg': 'large', 'lge': 'large', 'lg': 'large',
        'medium': 'medium', 'med': 'medium', 'md': 'medium',
        'small': 'small', 'sm': 'small',
        'sprig': 'bunch', 'sprigs': 'bunch' // Sprigs convert to bunch for herbs
    };

    // Format ingredients for Instacart API with multiple measurement options
    const lineItems = ingredients.map(item => {
        // Default standardized unit based on mapping or fallback to 'each'
        const standardUnit = unitMapping[item.unit?.toLowerCase()] || 'each';
        const quantity = item.quantity || 1;
        const ingredient = item.ingredient;
        const ingredientLower = ingredient.toLowerCase();
        
        console.log(`Processing ingredient for Instacart: ${ingredient}, ${quantity} ${item.unit} -> ${standardUnit}`);
        
        // Check for existing line_item_measurements
        if (item.line_item_measurements && Array.isArray(item.line_item_measurements) && item.line_item_measurements.length > 0) {
            console.log(`Found existing measurements for ${ingredient}:`, 
                JSON.stringify(item.line_item_measurements, null, 2));
            
            // Use existing measurements
            return {
                name: ingredient,
                quantity: quantity,
                unit: standardUnit,
                line_item_measurements: item.line_item_measurements
            };
        }

        // Special case for garlic cloves - convert to heads using 10 cloves = 1 head ratio
        if (ingredientLower.includes('garlic') && (item.unit?.toLowerCase() === 'clove' || item.unit?.toLowerCase() === 'cloves')) {
            // Calculate how many heads (using ceiling to ensure we get at least 1 head for small amounts)
            const headCount = Math.max(1, Math.ceil(quantity / 10));
            
            console.log(`Converting garlic cloves to heads: ${quantity} cloves -> ${headCount} each (head)`);
            
            return {
                name: ingredient.replace(/cloves?/i, '').replace(/,/g, '').trim() || 'Garlic',
                quantity: headCount,
                unit: 'each',
                display_text: `${headCount} head${headCount > 1 ? 's' : ''} garlic`,
                line_item_measurements: [
                    { quantity: headCount, unit: 'each' },
                    // Add weight alternatives
                    { quantity: headCount * 1.75, unit: 'oz' }, // Approx weight per head
                    { quantity: headCount * 50, unit: 'g' }
                ]
            };
        }
        
        // Special case for herbs sold by sprigs (thyme, rosemary, etc.)
        if ((item.unit?.toLowerCase() === 'sprig' || item.unit?.toLowerCase() === 'sprigs') || 
            (ingredientLower.includes('thyme') || 
             ingredientLower.includes('rosemary') || 
             ingredientLower.includes('mint') || 
             ingredientLower.includes('sage') || 
             ingredientLower.includes('oregano') || 
             ingredientLower.includes('basil'))) {
            
            console.log(`Converting herb sprigs to bunch: ${ingredient}, ${quantity} ${item.unit} -> 1 bunch`);
            
            return {
                name: ingredient,
                quantity: 1,
                unit: 'bunch',
                display_text: `1 bunch ${ingredient}`,
                line_item_measurements: [
                    { quantity: 1, unit: 'bunch' },
                    { quantity: 1, unit: 'each' }
                ]
            };
        }
        
        // Special case for bay leaves and similar spices sold in packages
        if (ingredientLower.includes('bay leaf') || 
            ingredientLower.includes('bay leaves') || 
            ((ingredientLower.includes('leaf') || ingredientLower.includes('leaves')) && 
             !ingredientLower.includes('lettuce') && !ingredientLower.includes('cabbage'))) {
            
            console.log(`Converting individual leaves to package: ${ingredient}, ${quantity} ${item.unit} -> 1 each`);
            
            return {
                name: ingredient,
                quantity: 1,
                unit: 'each',
                display_text: `1 package ${ingredient}`,
                line_item_measurements: [
                    { quantity: 1, unit: 'each' },
                    { quantity: 1, unit: 'package' }
                ]
            };
        }
        
        // Start with the base item configuration if no pre-existing measurements
        const lineItem = {
            name: ingredient,
            quantity: quantity,
            unit: standardUnit
        };
        
        // Initialize alternative measurements array
        const measurements = [
            { quantity: quantity, unit: standardUnit }
        ];
        
        // Add alternative measurements based on ingredient type and unit
        // For volume measurements, provide weight alternatives when relevant
        if (['cup', 'tablespoon', 'teaspoon', 'fl oz', 'ml', 'l', 'pint', 'quart', 'gallon'].includes(standardUnit)) {
            // For liquid ingredients like oils, milk, water, etc.
            if (
                ingredient.toLowerCase().includes('oil') || 
                ingredient.toLowerCase().includes('milk') || 
                ingredient.toLowerCase().includes('water') || 
                ingredient.toLowerCase().includes('juice') || 
                ingredient.toLowerCase().includes('broth') || 
                ingredient.toLowerCase().includes('stock') ||
                ingredient.toLowerCase().includes('cream') ||
                ingredient.toLowerCase().includes('sauce') ||
                ingredient.toLowerCase().includes('vinegar')
            ) {
                // Volume to volume conversions for liquids
                if (standardUnit === 'cup') {
                    measurements.push({ quantity: quantity * 8, unit: 'fl oz' });
                    measurements.push({ quantity: quantity * 237, unit: 'ml' });
                } else if (standardUnit === 'tablespoon') {
                    measurements.push({ quantity: quantity * 0.5, unit: 'fl oz' });
                    measurements.push({ quantity: quantity * 15, unit: 'ml' });
                } else if (standardUnit === 'teaspoon') {
                    measurements.push({ quantity: quantity * 5, unit: 'ml' });
                } else if (standardUnit === 'fl oz') {
                    measurements.push({ quantity: quantity * 30, unit: 'ml' });
                    measurements.push({ quantity: quantity / 8, unit: 'cup' });
                } else if (standardUnit === 'l') {
                    measurements.push({ quantity: quantity * 1000, unit: 'ml' });
                    measurements.push({ quantity: quantity * 33.8, unit: 'fl oz' });
                }
            }
        }
        
        // For weight measurements, provide volume alternatives when relevant
        else if (['oz', 'lb', 'g', 'kg'].includes(standardUnit)) {
            // Weight to weight conversions
            if (standardUnit === 'oz') {
                measurements.push({ quantity: quantity / 16, unit: 'lb' });
                measurements.push({ quantity: quantity * 28.35, unit: 'g' });
            } else if (standardUnit === 'lb') {
                measurements.push({ quantity: quantity * 16, unit: 'oz' });
                measurements.push({ quantity: quantity * 454, unit: 'g' });
            } else if (standardUnit === 'g') {
                measurements.push({ quantity: quantity / 28.35, unit: 'oz' });
                measurements.push({ quantity: quantity / 1000, unit: 'kg' });
            } else if (standardUnit === 'kg') {
                measurements.push({ quantity: quantity * 1000, unit: 'g' });
                measurements.push({ quantity: quantity * 2.2, unit: 'lb' });
            }
        }
        
        // Add line_item_measurements array to the line item if we have alternatives
        if (measurements.length > 1) {
            lineItem.line_item_measurements = measurements;
        }
        
        return lineItem;
    });

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

// --- REMOVING DEBUG: Force event loop activity ---
// setInterval(() => {
//     console.log('Server process still alive...');
// }, 5000); // Log every 5 seconds
// ---------------------------------------------- 