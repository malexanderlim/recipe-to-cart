// backend/controllers/listController.js
// ----------------------------------------------------------------------------
//  FULL "/api/create-list" CONTROLLER – restored from legacy server.js
// ----------------------------------------------------------------------------

/* External deps */
const axios = require('axios');

/* Internal services & utils */
const { parseAndCorrectJson } = require('../utils/jsonUtils');
const { callAnthropic } = require('../services/anthropicService');

// ADDED: Helper map for unit abbreviations
// --- MODIFIED --- Expanded unitAbbreviations based on Instacart Docs
const unitAbbreviations = {
    // Volume - Measured
    'c': 'cup',
    'cup': 'cup',
    'cups': 'cup',
    'fl oz': 'fluid ounce',
    'fl. oz.': 'fluid ounce', // Added variation
    'fluid ounce': 'fluid ounce',
    'fluid ounces': 'fluid ounce',
    'gal': 'gallon',
    'gals': 'gallon',
    'gallon': 'gallon',
    'gallons': 'gallon',
    'l': 'liter',
    'liter': 'liter',
    'liters': 'liter',
    'litre': 'liter', // Instacart variation
    'litres': 'liter', // Instacart variation
    'ml': 'milliliter',
    'mls': 'milliliter',
    'milliliter': 'milliliter',
    'millilitre': 'milliliter', // Instacart variation
    'milliliters': 'milliliter',
    'millilitres': 'milliliter', // Instacart variation
    'pt': 'pint',
    'pts': 'pint',
    'pint': 'pint',
    'pints': 'pint',
    'qt': 'quart',
    'qts': 'quart',
    'quart': 'quart',
    'quarts': 'quart',
    'tb': 'tablespoon', // Instacart variation
    'tbs': 'tablespoon', // Instacart variation
    'tbsp': 'tablespoon',
    'tbsps': 'tablespoon',
    'tablespoon': 'tablespoon',
    'tablespoons': 'tablespoon',
    'ts': 'teaspoon', // Instacart variation
    'tsp': 'teaspoon',
    'tsps': 'teaspoon',
    'tspn': 'teaspoon', // Instacart variation
    'teaspoon': 'teaspoon',
    'teaspoons': 'teaspoon',

    // Weight - Weighed
    'g': 'gram',
    'gs': 'gram',
    'gram': 'gram',
    'grams': 'gram',
    'kg': 'kilogram',
    'kgs': 'kilogram',
    'kilogram': 'kilogram',
    'kilograms': 'kilogram',
    'lb': 'pound',
    'lbs': 'pound',
    'pound': 'pound',
    'pounds': 'pound',
    'oz': 'ounce',
    'ozs': 'ounce', // Added variation
    'ounce': 'ounce',
    'ounces': 'ounce',

    // Countable
    'bunch': 'bunch',
    'bunches': 'bunch',
    'can': 'can',
    'cans': 'can',
    'clove': 'clove', // Keep specific count units
    'cloves': 'clove',
    'ear': 'ear',
    'ears': 'ear',
    'each': 'each', // Explicitly map 'each'
    'head': 'head',
    'heads': 'head',
    'package': 'package',
    'packages': 'package',
    'packet': 'packet', // From Instacart docs
    'packets': 'packet',
    'sprig': 'sprig', // Keep specific count units
    'sprigs': 'sprig',
    'slice': 'slice', // Common unit
    'slices': 'slice',

    // Descriptive sizes (map to 'each' or keep specific? Let's keep specific for now)
    'large': 'large',
    'lrg': 'large',
    'lge': 'large',
    'lg': 'large',
    'medium': 'medium',
    'med': 'medium',
    'md': 'medium',
    'small': 'small',
    'sm': 'small',

    // Note: Compound units like 'fl oz can', 'lb bag' are NOT handled here.
    // We rely on the base unit ('fl oz', 'lb') and LLM context.
};

// ADDED: Function to get the canonical unit name
// V8: Significantly Enhanced
function getCanonicalUnit(rawUnit) {
    if (!rawUnit || typeof rawUnit !== 'string') return null;
    
    let unit = rawUnit.toLowerCase().trim();
    
    // 1. Remove bracketed/parenthesized text (e.g., [120 ml], (page 223))
    unit = unit.replace(/\s*[\[\(].*?[\]\)]/g, '').trim();
    
    // 2. Remove common descriptive suffixes often attached to units
    unit = unit.replace(/,(?:\s*(?:peeled|separated|bruised|minced|chopped|halved|pitted|fresh|dried|ground|cut|into|wide|matchsticks|through|stem|end|plus|more|as|needed|page|\d+))+$/, '').trim();
    
    // 3. Handle specific edge cases identified from logs
    if (unit === 'garlic cloves' || unit === 'cloves') return 'clove';
    if (unit === 'heads') return 'head';
    if (unit === 'bay leaves') return 'bay leaf';
    if (unit === 'thyme sprigs' || unit === 'fresh thyme sprigs') return 'sprig'; // Map variations to canonical
        
    // 4. Check abbreviation map 
    if (unitAbbreviations[unit]) {
        return unitAbbreviations[unit];
    }
    
    // 5. Simple singularization as fallback (if not in map)
    if (unit.endsWith('s') && !unit.endsWith('ss')) {
         const singular = unit.slice(0, -1);
         if (Object.values(unitAbbreviations).includes(singular) || unitAbbreviations[singular]) {
             return unitAbbreviations[singular] || singular; // Return the canonical form
         }
         // Special check: is the singular form itself the unit? e.g. "cups" -> "cup"
         if (unitAbbreviations[singular]){
             return singular;
         }
    }
    
    // 6. Return processed unit if not found in map or singularized
    // Return null if processing resulted in empty string
    return unit || null; 
}

/**
 * V8: Single LLM call for normalization & basic parsing, algorithm for math
 * This is the refactored endpoint based on the revised hybrid plan
 */
async function createList(req, res) {
    try {
        const { ingredients: rawIngredients, title } = req.body;
        
        console.log("V8: Received /api/create-list request", {
            ingredientsCount: rawIngredients?.length || 0, 
            title: title || '(untitled)'
        });

        if (!rawIngredients || !Array.isArray(rawIngredients) || rawIngredients.length === 0) {
            return res.status(400).json({ error: 'Invalid or empty ingredients list.' });
        }

        if (!rawIngredients.every(item => typeof item === 'object' && item !== null && 'ingredient' in item)) {
            return res.status(400).json({ error: 'Each ingredient must be an object with at least an "ingredient" field.' });
        }

        console.log("V8: Raw ingredients received:", JSON.stringify(rawIngredients.slice(0, 3), null, 2) + (rawIngredients.length > 3 ? `... (and ${rawIngredients.length - 3} more)` : ""));

        // --- Step 1: LLM Call for Name Normalization & Basic Parsing --- 
        console.log("V8 Step 1: Normalizing ingredient names via LLM...");
        
        // ** MODIFIED LLM TASK: Just normalize name, optionally parse qty/unit **
        const systemPrompt = `
            You are an expert ingredient parser. Analyze the following list of raw ingredient strings extracted from recipes.
            For EACH raw ingredient string, provide:
            1. raw_ingredient: The original input string.
            2. normalized_name: The canonical, singular, common name for the ingredient concept (e.g., "garlic", "olive oil", "fresh thyme", "bay leaf"). Preserve essential descriptive words (e.g., "extra-virgin olive oil", "kosher salt").
            3. quantity (optional): The numerical quantity parsed from the raw string, if easily identifiable. Use null if complex or absent.
            4. unit (optional): The unit parsed from the raw string, if easily identifiable. Use null if complex or absent.

            Output ONLY a valid JSON array of objects, one object per input raw ingredient string. Maintain the original order.
            Example Input: "2 heads garlic, cloves separated"
            Example Output: 
            { 
                "raw_ingredient": "2 heads garlic, cloves separated",
                "normalized_name": "garlic", 
                "quantity": 2, 
                "unit": "heads"
            }

            Example Input: "Salt"
            Example Output:
            {
                "raw_ingredient": "Salt",
                "normalized_name": "salt",
                "quantity": null,
                "unit": null
            }
            
            Focus on accurate normalization.
            
            **CRITICAL FORMATTING RULES:**
            - Your entire response MUST be a single, valid JSON array.
            - The response MUST start *exactly* with \`[\` and end *exactly* with \`]\`
            - Do NOT include any text, explanations, or markdown formatting (like \`\`\`json\`) before or after the JSON array.
            - Do NOT output a nested array like \`[[...]]\`. Output only a single, flat array \`[...]\`
        `;

        const userPrompt = `
            Raw Ingredient List:
            ${rawIngredients.map(item => `- ${item.ingredient?.trim() || '(empty)'}`).join('\n')}

            Return a JSON array where each object corresponds to an input line and contains:
            { "raw_ingredient": string, "normalized_name": string, "quantity": number | null, "unit": string | null }
        `;

        let llmParsedItems = [];
        let rawLlmResponse = '';

        try {
            console.log("V8: Sending request to LLM for normalization...");
            rawLlmResponse = await callAnthropic(systemPrompt, userPrompt, 'claude-3-haiku-20240307');
            console.log(`V8: Received LLM response. Length: ${rawLlmResponse?.length || 0}`);

            // Use the same robust parsing logic as before for the JSON array
            // ... (robust parsing logic copied from V7 - parseAndCorrectJson can be used) ...
            const parsedJson = await parseAndCorrectJson(null, rawLlmResponse, 'array'); // Use utility function WITH await, specify expectedType
            
            if (parsedJson === null) {
                console.error("V8: Failed to parse JSON from LLM response after multiple attempts.");
                console.error("V8: Raw Response causing failure:\n---\n" + rawLlmResponse + "\n---");
                throw new Error("Could not parse normalization data from AI response."); 
           }

           // ** FIX: Handle nested array [[...]] case **
           if (Array.isArray(parsedJson)) {
               if (parsedJson.length === 1 && Array.isArray(parsedJson[0])) {
                   console.log("V8: Detected nested array [[...]], extracting inner array.");
                   llmParsedItems = parsedJson[0]; // Use the inner array
               } else {
                   llmParsedItems = parsedJson; // Use the parsed array directly
               }
           } else {
                // If parseAndCorrectJson somehow returned non-null but also non-array
                console.error("V8: Parsed LLM response is not an array:", parsedJson);
                throw new Error("LLM output is not an array.");
           }
           // ** END FIX **
           
           if (!Array.isArray(llmParsedItems)) { 
               // This check might be redundant now but kept as a safety net
               console.error("V8: Result assigned to llmParsedItems is not an array after potential extraction.");
               throw new Error("LLM output could not be processed into an array.");
            }
            
           if (llmParsedItems.length !== rawIngredients.length) {
               console.warn(`LLM response items (${llmParsedItems.length}) don't match raw input items (${rawIngredients.length}). Proceeding with caution.`);
               // Handle mismatch? For now, log warning.
           }
           // Basic validation of items
           llmParsedItems.forEach((item, index) => {
               if (!item || !item.normalized_name || !item.raw_ingredient) {
                   throw new Error(`LLM Item at index ${index} missing required keys (raw_ingredient, normalized_name).`);
               }
           });
           console.log("V8: Successfully parsed normalization data from LLM.");
           // Log first few items for checking
           console.log("V8: LLM Parsed Items (sample):", JSON.stringify(llmParsedItems.slice(0, 3), null, 2));

        } catch (parseError) {
            console.error("V8: Error parsing LLM JSON response:", parseError);
            throw new Error(`AI Processing Failed: ${parseError.message}`); 
        }
        
        // --- Merge LLM results back with original rawIngredients --- 
        // Create a map for faster lookup based on raw ingredient string
        const llmResultMap = new Map();
        llmParsedItems.forEach(item => {
            if(item.raw_ingredient) {
                llmResultMap.set(item.raw_ingredient.trim(), item);
            }
        });
        
        // Add normalized name and potentially parsed qty/unit to original array
        const ingredientsWithNorm = rawIngredients.map(rawItem => {
             const originalRawString = rawItem.ingredient?.trim() || '';
             const llmMatch = llmResultMap.get(originalRawString);
             
             let normalized_name = simpleNormalize(originalRawString); // Fallback
             let parsed_quantity = rawItem.quantity; // Use original quantity by default
             let parsed_unit = rawItem.unit; // Use original unit by default
             
             if (llmMatch) {
                 normalized_name = llmMatch.normalized_name; // Prefer LLM normalization
                 // Optionally use LLM parsed qty/unit if they seem valid
                 if (llmMatch.quantity !== null && typeof llmMatch.quantity === 'number') {
                     parsed_quantity = llmMatch.quantity;
                 }
                 if (llmMatch.unit !== null && typeof llmMatch.unit === 'string') {
                     parsed_unit = llmMatch.unit;
                 }
                 // Add a flag indicating source for debugging?
             }
             
             return {
                 ...rawItem, // Keep original data
                 ingredient: originalRawString, // Ensure it's the trimmed original string
                 normalized_name: normalized_name, // Add normalized name
                 quantity_source: llmMatch && llmMatch.quantity !== null ? 'llm' : 'original',
                 unit_source: llmMatch && llmMatch.unit !== null ? 'llm' : 'original',
                 quantity: parsed_quantity, // Use potentially LLM-parsed quantity
                 unit: parsed_unit // Use potentially LLM-parsed unit
             };
        });

        console.log("V8: Merged Raw Ingredients with LLM Normalization (sample):", JSON.stringify(ingredientsWithNorm.slice(0, 3), null, 2));
        
        // --- Step 2: Enhance Unit Parsing --- 
        console.log("V8 Step 2: Enhancing Unit Parsing...");
        // TODO: Enhance getCanonicalUnit function below this endpoint
        
        // --- Step 3: Define Hardcoded Conversions --- 
        console.log("V8 Step 3: Defining Hardcoded Conversions...");
        // TODO: Define conversionFactors map below this endpoint
        
        // --- Step 4: Backend Consolidation --- 
        console.log("V8 Step 4: Consolidating Ingredients using Backend Logic...");

        // Define target primary units for consolidation (lowercase)
        const targetPrimaryUnits = {
            default: 'each', // Fallback if no specific rule
            garlic: 'head',
            salt: 'ounce', // Example: consolidate salt by weight
            sugar: 'pound',
            flour: 'pound',
            butter: 'pound',
            'olive oil': 'fluid ounce',
            'vegetable oil': 'fluid ounce',
            'canola oil': 'fluid ounce',
            'baking soda': 'ounce',
            'baking powder': 'ounce',
            // Add more ingredient name keywords and their desired primary unit
        };

        const consolidatedTotals = {}; 

        for (const item of ingredientsWithNorm) {
            const normName = item.normalized_name;
            if (!normName) {
                console.warn(`V8 Skipping item - missing normalized name: ${JSON.stringify(item)}`);
                continue;
            }
            
            let quantity = item.quantity;
            if (quantity == null) {
                console.log(`V8 Defaulting null quantity to 1 for: ${normName}`);
                quantity = 1; 
            }
            if (typeof quantity !== 'number' || isNaN(quantity) || quantity < 0) {
                 console.warn(`V8 Skipping item - invalid quantity (${item.quantity}) for: ${normName}`);
                 continue;
            }

            const canonicalUnit = getCanonicalUnit(item.unit); 
            console.log(`V8 Processing: ${quantity} ${canonicalUnit || 'unitless'} ${normName} (Raw unit: ${item.unit})`);

            let targetUnit = targetPrimaryUnits.default;
            // Find a matching keyword for target unit, longest match first
            const sortedKeys = Object.keys(targetPrimaryUnits).sort((a, b) => b.length - a.length);
            for (const key of sortedKeys) {
                if (key !== 'default' && normName.includes(key)) {
                    targetUnit = targetPrimaryUnits[key];
                    break;
                }
            }
            console.log(`   Target unit for ${normName}: ${targetUnit}`);

            let quantityInTargetUnit = 0;
            let conversionSuccess = false;

            if (!canonicalUnit) {
                // Handle unitless items - often imply 'each'
                if (targetUnit === 'each') {
                    quantityInTargetUnit = quantity;
                    conversionSuccess = true;
                    console.log(`   Unitless item, target is 'each'. Adding quantity: ${quantity}`);
                } else {
                     console.warn(`   Cannot convert unitless '${normName}' to target '${targetUnit}'. Assuming 1 'each'.`);
                     // Add to 'each' unit explicitly if possible, otherwise log failure
                     if (!consolidatedTotals[normName]) consolidatedTotals[normName] = { units: {}, targetUnit: targetUnit, failedItems: [] };
                     consolidatedTotals[normName].units['each'] = (consolidatedTotals[normName].units['each'] || 0) + quantity;
                     consolidatedTotals[normName].failedItems.push({ original: item, reason: `Unitless item could not be converted to target ${targetUnit}` });
                     continue; // Skip normal conversion path
                }
            } else if (canonicalUnit === targetUnit) {
                quantityInTargetUnit = quantity;
                conversionSuccess = true;
                console.log(`   Canonical unit matches target. Adding quantity: ${quantity}`);
            } else {
                // Attempt conversion using hardcoded map
                if (conversionFactors[canonicalUnit] && conversionFactors[canonicalUnit][targetUnit]) {
                    const factor = conversionFactors[canonicalUnit][targetUnit];
                    quantityInTargetUnit = quantity * factor;
                    conversionSuccess = true;
                    console.log(`   Converted ${quantity} ${canonicalUnit} to ${quantityInTargetUnit.toFixed(3)} ${targetUnit} (Factor: ${factor})`);
                } else {
                    console.warn(`   No hardcoded conversion found from '${canonicalUnit}' to '${targetUnit}' for '${normName}'.`);
                    // Add raw if conversion fails
                    if (!consolidatedTotals[normName]) consolidatedTotals[normName] = { units: {}, targetUnit: targetUnit, failedItems: [] };
                    consolidatedTotals[normName].units[canonicalUnit] = (consolidatedTotals[normName].units[canonicalUnit] || 0) + quantity;
                    consolidatedTotals[normName].failedItems.push({ original: item, reason: `No conversion from ${canonicalUnit} to ${targetUnit}` });
                    continue; // Skip accumulation in target unit
                }
            }

            // Accumulate totals in the target unit
            if (conversionSuccess) {
                if (!consolidatedTotals[normName]) consolidatedTotals[normName] = { units: {}, targetUnit: targetUnit, failedItems: [] };
                consolidatedTotals[normName].units[targetUnit] = (consolidatedTotals[normName].units[targetUnit] || 0) + quantityInTargetUnit;
            }
        }

        console.log("V8: Consolidated totals before final adjustments:", JSON.stringify(consolidatedTotals, null, 2));

        // --- Step 5: Final Adjustments & Formatting --- 
        console.log("V8 Step 5: Applying final adjustments...");
        const finalAdjustedItems = [];
        const countableUnits = ['bunch', 'can', 'head', 'each', 'large', 'medium', 'small', 'package', 'packet', 'pint', 'clove', 'sprig', 'ear', 'slice'];
        const weightUnits = ['pound', 'ounce', 'gram', 'kilogram'];
        const volumeUnits = ['cup', 'fluid ounce', 'tablespoon', 'teaspoon', 'liter', 'milliliter', 'pint', 'quart', 'gallon'];

        for (const normName in consolidatedTotals) {
            const itemData = consolidatedTotals[normName];
            const targetUnit = itemData.targetUnit;
            let finalMeasurements = [];

            // Process the primary target unit total
            if (itemData.units[targetUnit] != null && itemData.units[targetUnit] > 0) {
                let adjustedQuantity = itemData.units[targetUnit];
                const isCountable = countableUnits.includes(targetUnit);
                
                // Round up countable units
                if (isCountable) {
                    adjustedQuantity = Math.ceil(adjustedQuantity);
                    adjustedQuantity = Math.max(1, adjustedQuantity); // Ensure minimum 1
                }
                // Round weight/volume units to reasonable precision
                else if (weightUnits.includes(targetUnit) || volumeUnits.includes(targetUnit)) {
                     adjustedQuantity = parseFloat(adjustedQuantity.toFixed(2));
                     if (adjustedQuantity <= 0) adjustedQuantity = 0.01; // Prevent zeroing out small amounts
                }
                
                if (adjustedQuantity > 0) {
                    finalMeasurements.push({ unit: targetUnit, quantity: adjustedQuantity });
                }
            }

            // Add any unconverted units (marked as failed)
            for (const unit in itemData.units) {
                if (unit !== targetUnit && itemData.units[unit] > 0) {
                    console.log(`V8: Including unconverted unit for ${normName}: ${itemData.units[unit]} ${unit}`);
                    finalMeasurements.push({ unit: unit, quantity: parseFloat(itemData.units[unit].toFixed(2)) });
                }
            }

            // Add secondary units if needed (e.g., lb for garlic)
            if (normName === 'garlic' && targetUnit === 'head') {
                const headMeasurement = finalMeasurements.find(m => m.unit === 'head');
                if (headMeasurement && headMeasurement.quantity > 0) {
                    const hasLb = finalMeasurements.some(m => m.unit === 'pound');
                    if (!hasLb) {
                         let poundsToAdd = parseFloat((headMeasurement.quantity * 0.12).toFixed(2));
                         poundsToAdd = Math.max(0.05, poundsToAdd);
                         console.log(`   Garlic: Adding secondary 'lb' unit: ${poundsToAdd} lbs`);
                         finalMeasurements.push({ unit: 'pound', quantity: poundsToAdd });
                    }
                }
            }
            // TODO: Add logic for other desired secondary units

            // Sort measurements: target unit first, then alpha (or other desired order)
            finalMeasurements.sort((a, b) => {
                if (a.unit === targetUnit) return -1; 
                if (b.unit === targetUnit) return 1;
                // Add secondary sort for common pairs like head/lb
                if (normName === 'garlic') {
                    if (a.unit === 'head') return -1;
                    if (b.unit === 'head') return 1;
                    if (a.unit === 'pound') return -1;
                    if (b.unit === 'pound') return 1;
                }
                return a.unit.localeCompare(b.unit); 
            });

            if (finalMeasurements.length > 0) {
                 finalAdjustedItems.push({ name: normName, line_item_measurements: finalMeasurements });
            }
        }

        console.log("V8: Final adjusted items ready:", JSON.stringify(finalAdjustedItems, null, 2));

        // --- Return final processed list ---
        res.json({ 
            processedIngredients: finalAdjustedItems, 
            originalTitle: title
        }); 

    } catch (error) {
        console.error("V8: Error during /api/create-list processing:", error);
        return res.status(500).json({
            error: 'Failed to process ingredients list.',
            details: error.message
        });
    }
}

// --- Existing helper functions (simpleNormalize, unitAbbreviations, getCanonicalUnit) ---
// --- TODO: Enhance getCanonicalUnit significantly --- 
// --- TODO: Define conversionFactors map --- 

// V8: Hardcoded Conversion Factors
// Defines conversion FROM the key unit TO the units in the nested object.
// Example: 1 head of garlic = 11 cloves
const conversionFactors = {
    // Garlic
    head: { clove: 11, pound: 0.12, each: 1 }, 
    clove: { head: 1/11, pound: 0.012, each: 1/11, teaspoon: 0.33 }, // teaspoon is minced
    // Common Volumes (to fluid ounce)
    cup: { 'fluid ounce': 8, tablespoon: 16, teaspoon: 48, liter: 0.236 },
    tablespoon: { 'fluid ounce': 0.5, teaspoon: 3, cup: 1/16 },
    teaspoon: { 'fluid ounce': 1/6, tablespoon: 1/3, cup: 1/48 },
    liter: { 'fluid ounce': 33.814, cup: 4.227 },
    milliliter: { 'fluid ounce': 0.033814 },
    pint: { 'fluid ounce': 16, cup: 2 },
    quart: { 'fluid ounce': 32, cup: 4, pint: 2 },
    gallon: { 'fluid ounce': 128, cup: 16, quart: 4 },
    // Common Weights (to ounce)
    pound: { ounce: 16, gram: 453.592, kilogram: 0.453592 },
    kilogram: { ounce: 35.274, pound: 2.20462, gram: 1000 },
    gram: { ounce: 0.035274, pound: 0.00220462 },
    // Base units (convert to themselves)
    ounce: { ounce: 1 },
    'fluid ounce': { 'fluid ounce': 1 },
    each: { each: 1 },
    bunch: { bunch: 1 },
    can: { can: 1 },
    package: { package: 1 },
    packet: { packet: 1 },
    sprig: { sprig: 1 },
    slice: { slice: 1 },
    // Add more as needed based on common recipe units
};

module.exports = {
    createList
}; 