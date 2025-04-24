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
// --- REVIEWED --- getCanonicalUnit - Logic seems okay with the expanded map
// It prioritizes the map, then handles simple pluralization ('s') if the singular is a known canonical unit.
// This should cover most cases from the Instacart docs.
function getCanonicalUnit(rawUnit) {
    if (!rawUnit) return null;
    const lowerUnit = rawUnit.toLowerCase().trim();
    
    // Check abbreviation map first
    if (unitAbbreviations[lowerUnit]) {
        return unitAbbreviations[lowerUnit];
    }
    
    // Simple singularization as fallback (if not in map)
    // Check the plural first before trying singular
    if (lowerUnit.endsWith('s') && !lowerUnit.endsWith('ss')) {
         const singular = lowerUnit.slice(0, -1);
         // Check if the singular form is a known canonical name (value in the map)
         // OR if the singular form itself is a key in the map (e.g. 'cup')
         if (Object.values(unitAbbreviations).includes(singular) || unitAbbreviations[singular]) {
             return singular === 'cup' ? 'cup' : (unitAbbreviations[singular] || singular); // Handle 'cups' -> 'cup' specifically
         }
    }
    
    // Return original (lowercase) if not an abbreviation and not recognized as plural of a canonical unit
    return lowerUnit;
}

/**
 * V7: Single LLM call for normalization & conversions, algorithm for math
 * This is the refactored endpoint based on the revised hybrid plan
 */
async function createList(req, res) {
    try {
        const { ingredients: rawIngredients, title } = req.body;
        
        console.log("V7: Received /api/create-list request", {
            ingredientsCount: rawIngredients?.length || 0, 
            title: title || '(untitled)'
        });

        if (!rawIngredients || !Array.isArray(rawIngredients) || rawIngredients.length === 0) {
            return res.status(400).json({ error: 'Invalid or empty ingredients list.' });
        }

        if (!rawIngredients.every(item => typeof item === 'object' && item !== null && 'ingredient' in item)) {
            return res.status(400).json({ error: 'Each ingredient must be an object with at least an "ingredient" field.' });
        }

        console.log("V7: Raw ingredients received:", JSON.stringify(rawIngredients.slice(0, 3), null, 2) + (rawIngredients.length > 3 ? `... (and ${rawIngredients.length - 3} more)` : ""));

        // --- Step 1: Single LLM Call for Conversion Data ---
        console.log("V7 Step 1: Fetching conversion data from LLM...");
        
        const uniqueIngredientsMap = new Map();
        
        // Extract unique distinct ingredients
        rawIngredients.forEach(ingredient => {
            const name = (ingredient.ingredient || "").toLowerCase().trim();
            if (name && !uniqueIngredientsMap.has(name)) {
                uniqueIngredientsMap.set(name, ingredient);
            }
        });
        
        const uniqueIngredientsList = Array.from(uniqueIngredientsMap.values());
        
        console.log(`V7: Reduced ${rawIngredients.length} raw ingredients to ${uniqueIngredientsList.length} unique names.`);
        
        // Construct prompt for LLM (for both quantities and descriptions)
        // --- MODIFIED Prompt - Reduced verbosity, focus on valid JSON ---
        const systemPrompt = `
            You are an expert ingredient normalizer for grocery lists, preparing data for platforms like Instacart.
            Given a list of raw ingredients, standardize them and provide conversion rates. **Your response MUST be valid and complete JSON.**

            For EACH unique ingredient concept output:
            1. normalized_name: Canonical, singular form. Preserve important distinctions (e.g., "ground beef", not "beef").
            2. primary_unit: Most common **purchasable** unit (Instacart style: pound, ounce, head, bunch, can, each). Use lowercase.
            3. equivalent_units: Array of objects with unit name (lowercase) and conversion factor FROM the primary unit.

            **Keep the equivalent_units array concise:**
            - **MUST** include the primary unit itself (factor_from_primary: 1).
            - Include **at most TWO (2) additional** relevant units. Choose common cooking units (like cup, tbsp, tsp, oz, g) OR a significant alternative purchase unit (like 'each' if primary is 'pound').
            - **DO NOT** include every possible unit or abbreviation. Focus on the most useful conversions.
            - Ensure factors are accurate. Use null factor only if conversion is impossible.

            Example for 'ground beef':
            {
                "normalized_name": "ground beef",
                "primary_unit": "pound",
                "equivalent_units": [
                    { "unit": "pound", "factor_from_primary": 1 },
                    { "unit": "ounce", "factor_from_primary": 16 }, // Common weight alternative
                    { "unit": "package", "factor_from_primary": 1 } // Common purchase alternative
                ]
            } // Max 2 additional units

            Example for 'tomato':
            {
                "normalized_name": "tomato",
                "primary_unit": "each",
                "equivalent_units": [
                    { "unit": "each", "factor_from_primary": 1 },
                    { "unit": "pound", "factor_from_primary": 0.4 }, // Common weight reference
                    { "unit": "cup", "factor_from_primary": 0.75 } // Common cooking volume
                ]
            } // Max 2 additional units

            Return ONLY a valid, complete JSON array of objects. No explanation. Ensure units are lowercase.
        `;

        const userPrompt = `
            Ingredient List:
            ${uniqueIngredientsList.map(item => `- ${item.ingredient}`).join('\n')}

            For EACH distinct ingredient concept, output an object:
            {
                "normalized_name": string, // singular form
                "primary_unit": string, // most common purchasable unit (e.g., "head", "bunch", "can")
                "equivalent_units": [ // include the primary unit itself with factor=1
                    {
                        "unit": string, // "head", "clove", "cup", etc.
                        "factor_from_primary": number // 1 (primary) = X (this unit)
                    }
                ]
            }`;

        let conversionDataList = [];
        let rawLlmResponse = '';

        try {
            // Single call to the LLM: Get normalized names & conversion data
            console.log("V7: Sending request to LLM for normalization and conversion data...");
            rawLlmResponse = await callAnthropic(systemPrompt, userPrompt, 'claude-3-haiku-20240307');
            console.log(`V7: Received LLM response. Length: ${rawLlmResponse?.length || 0}`);

            // V7: More robust parsing - several fallback options
            let parsedJson = null;
            let jsonString = rawLlmResponse.trim();

            // Attempt 1: Look for a JSON array inside ```json blocks
            const jsonMatch = jsonString.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch && jsonMatch[1]) {
                jsonString = jsonMatch[1].trim();
                console.log("V7: Extracted JSON using regex match.");
                try {
                    parsedJson = JSON.parse(jsonString);
                } catch (e) {
                    console.warn("V7: Regex match content failed to parse:", e.message);
                    // Reset jsonString if parsing the extracted part failed, to allow other attempts
                    jsonString = rawLlmResponse.trim();
                    parsedJson = null;
                }
            }

            // Attempt 2: Manual stripping if regex failed but backticks seem present
            if (parsedJson === null && jsonString.startsWith("```json") && jsonString.endsWith("```")) {
                 console.warn("V7: Regex failed or its content was invalid, attempting manual backtick stripping.");
                 jsonString = jsonString.substring(7, jsonString.length - 3).trim(); // Remove ```json and ```
                 try {
                      parsedJson = JSON.parse(jsonString);
                      console.log("V7: Successfully parsed JSON after manual stripping.");
                 } catch (e) {
                      console.warn("V7: Manual stripping content failed to parse:", e.message);
                      parsedJson = null; // Reset on failure
                 }
            }

            // Attempt 3: Updated: Check for start bracket only, as end bracket might be missing if truncated
            if (parsedJson === null && jsonString.startsWith("[")) {
                 console.warn("V7: No backticks found/parsed, attempting to parse raw string as array.");
                 try {
                     parsedJson = JSON.parse(jsonString);
                     console.log("V7: Successfully parsed raw string as JSON.");
                 } catch (e) {
                     console.warn("V7: Raw string parsing failed:", e.message);
                     parsedJson = null;
                 }
            }

            // Attempt 4: Find the first '[' or '{' and parse from there
            if (parsedJson === null) {
                 console.warn("V7: Previous attempts failed, finding first '[' or '{' to parse from.");
                 const jsonStartIndex = jsonString.search(/\s*[{\[]/); // Find first { or [
                 if (jsonStartIndex !== -1) {
                     jsonString = jsonString.substring(jsonStartIndex);
                     try {
                         parsedJson = JSON.parse(jsonString);
                         console.log("V7: Successfully parsed JSON after finding start bracket/brace.");
                     } catch (e) {
                         console.warn("V7: Parsing after finding start bracket/brace failed:", e.message);
                         parsedJson = null;
                     }
                 }
             }

            // Final check and assignment
            if (parsedJson === null) {
                 console.error("V7: Failed to parse JSON from LLM response after multiple attempts.");
                 console.error("V7: Raw Response causing failure:\n---\n" + rawLlmResponse + "\n---");
                 throw new Error("Could not parse conversion data from AI response."); // More specific error
            }

            conversionDataList = parsedJson; // Assign the successfully parsed JSON

            if (!Array.isArray(conversionDataList)) throw new Error("LLM output is not an array.");
            conversionDataList.forEach((item, index) => {
                if (!item.normalized_name || !item.primary_unit || !Array.isArray(item.equivalent_units)) {
                    throw new Error(`Item at index ${index} missing required keys.`);
                }
                item.equivalent_units.forEach((eq, eqIndex) => {
                    if (!eq.unit || eq.factor_from_primary === undefined) { 
                         throw new Error(`Equivalent unit at index ${eqIndex} for item ${item.normalized_name} is invalid.`);
                    }
                });
            });
            console.log("V7: Successfully parsed conversion data from LLM.");
        } catch (parseError) {
            console.error("V7: Error parsing LLM JSON response:", parseError);
            throw new Error(`AI Processing Failed: ${parseError.message}`); // Throw the specific parse error
        }

        // --- Step 2: Algorithmic Consolidation using LLM Data ---
        console.log("V7 Step 2: Consolidating ingredients using LLM conversion data...");
        // ... (Building conversionMap remains the same) ...
        const conversionMap = new Map();
        conversionDataList.forEach(item => {
            const eqUnitsMap = new Map();
            item.equivalent_units.forEach(eq => {
                if (eq.unit && eq.factor_from_primary != null) {
                     eqUnitsMap.set(eq.unit.toLowerCase(), eq.factor_from_primary);
                }
            });
            conversionMap.set(item.normalized_name, {
                primaryUnit: item.primary_unit.toLowerCase(),
                equivalentUnits: eqUnitsMap
            });
        });
        console.log("V7: Built conversion map:", conversionMap);
        
        // V7: simpleNormalize remains the same as V5 (can be improved later if needed)
        const simpleNormalize = (name) => name ? name.toLowerCase().replace(/\(.*?\)/g, '').replace(/\bleaves\b/g, 'leaf').replace(/\btomatoes\b/g, 'tomato').replace(/\bpotatoes\b/g, 'potato').replace(/\bonions\b/g, 'onion').replace(/\bcloves\b/g, 'clove').replace(/\bheads\b/g, 'head').replace(/,( smashed| minced| peeled| separated| chopped| stemmed| fresh| dried| bruised| whole| sliced| diced)/g, '').replace(/\'s$/, '').trim() : 'unknown';
        
        // ... (nameMapping logic remains the same) ...
        const nameMapping = {};
        rawIngredients.forEach(rawItem => {
            if (!rawItem.ingredient) return;
            const simpleRawName = simpleNormalize(rawItem.ingredient);
            let foundMatch = false;
            for (const normName of conversionMap.keys()) {
                if (simpleRawName.includes(normName) || normName.includes(simpleRawName)) {
                    nameMapping[rawItem.ingredient] = normName;
                    foundMatch = true;
                    break;
                }
            }
            if (!foundMatch) {
                 console.warn(`V7: Could not map raw ingredient '${rawItem.ingredient}' (simplified: '${simpleRawName}') to a normalized name from LLM output.`);
                 nameMapping[rawItem.ingredient] = simpleRawName; 
            }
        });
        
        const consolidatedTotals = {}; 

        for (const rawItem of rawIngredients) {
            console.log(`  V7 Consolidating Raw: ${JSON.stringify(rawItem)}`); 

            // Skip only if ingredient name is missing
            if (!rawItem.ingredient) { 
                console.log(`    V7 Skipping raw item: Missing ingredient name.`);
                continue;
            }
            
            // Default quantity to 1 if it's null/undefined
            let rawQuantity = rawItem.quantity; 
            if (rawQuantity == null) {
                console.log(`    V7 Raw quantity is null for '${rawItem.ingredient}', assuming quantity = 1.`);
                rawQuantity = 1;
            } // Use rawQuantity (potentially defaulted to 1) below

            const normalizedName = nameMapping[rawItem.ingredient] || simpleNormalize(rawItem.ingredient);
            console.log(`    V7 Mapped to normalizedName: ${normalizedName}`);
            
            const conversionData = conversionMap.get(normalizedName);
            // --- MODIFIED --- Get canonical unit using helper
            const canonicalRawUnit = getCanonicalUnit(rawItem.unit); 
            // console.log(`    Raw Unit: '${rawItem.unit}', Canonical Unit: '${canonicalRawUnit}'`); // Optional debug log
            
            // V7: Refined fallback/error handling during consolidation
            if (!conversionData) {
                console.warn(`V7: No conversion data for '${normalizedName}'. Adding raw: ${rawQuantity} ${canonicalRawUnit || '(no unit)'}.`);
                if (!consolidatedTotals[normalizedName]) consolidatedTotals[normalizedName] = { units: {}, failed: true }; // Mark as failed
                 const unitToAdd = canonicalRawUnit || 'unknown_unit'; 
                 consolidatedTotals[normalizedName].units[unitToAdd] = (consolidatedTotals[normalizedName].units[unitToAdd] || 0) + rawQuantity;
                continue;
            }

            const primaryUnit = conversionData.primaryUnit; // Already lowercase from map build
            const eqUnitsMap = conversionData.equivalentUnits; // Keys are already lowercase from map build
            let quantityInPrimary = 0;
            let conversionSuccessful = false;

            // --- MODIFIED --- Use canonicalRawUnit for checks below
            if (!canonicalRawUnit) { 
                if (primaryUnit === 'each') { 
                     quantityInPrimary = rawQuantity; // Already defaulted to 1 if null
                     conversionSuccessful = true;
                     console.log(`  V7: ${rawItem.ingredient} - Assuming unitless as primary unit 'each'`);
                } else if (eqUnitsMap.has('leaf') && normalizedName.includes('leaf')) {
                    // If unitless and name includes leaf, assume 'leaf' canonical unit
                    if (eqUnitsMap.has('leaf')) { // Check if 'leaf' conversion exists
                        const factorFromPrimary = eqUnitsMap.get('leaf');
                         if (factorFromPrimary != null && factorFromPrimary > 0) {
                            const factorToPrimary = 1.0 / factorFromPrimary;
                            quantityInPrimary = rawQuantity * factorToPrimary; // rawQuantity defaulted to 1
                            conversionSuccessful = true;
                            console.log(`  V7: ${rawItem.ingredient} - Converted unitless (as leaf) to ${quantityInPrimary.toFixed(3)} ${primaryUnit}`);
                        } else {
                             console.warn(`  V7: Unitless '${rawItem.ingredient}' assumed 'leaf', but invalid conversion factor found.`);
                        }
                    } else {
                         console.warn(`  V7: Unitless '${rawItem.ingredient}' assumed 'leaf', but no 'leaf' conversion factor provided by LLM.`);
                    }
                } else {
                    // --- MODIFIED FALLBACK ---
                    // If unitless and primary unit isn't 'each', assume they want 1 package/item.
                    console.warn(`  V7: Unitless '${rawItem.ingredient}' found. Primary unit is '${primaryUnit}'. Assuming quantity '1 each' for shopping list.`);
                    // We will add this quantity directly to the 'each' unit later.
                    // Set quantityInPrimary to the defaulted quantity (usually 1)
                    quantityInPrimary = rawQuantity; // Should be 1 from the earlier default
                    // Mark conversion as successful to proceed, but we'll handle the unit below.
                    conversionSuccessful = true;
                    // We won't use primaryUnit here, force 'each' later
                }
            } else { // Attempt conversion if canonicalRawUnit exists
                if (canonicalRawUnit === primaryUnit) {
                    quantityInPrimary = rawQuantity;
                    conversionSuccessful = true;
                } else {
                    // --- MODIFIED --- Lookup canonicalRawUnit directly in the map
                    if (eqUnitsMap.has(canonicalRawUnit)) { 
                        const factorFromPrimary = eqUnitsMap.get(canonicalRawUnit);
                        
                        if (factorFromPrimary != null && factorFromPrimary > 0) {
                            const factorToPrimary = 1.0 / factorFromPrimary;
                            quantityInPrimary = rawQuantity * factorToPrimary;
                            conversionSuccessful = true;
                            console.log(`  V7: Converted ${rawQuantity} ${rawItem.unit} (as ${canonicalRawUnit}) of ${normalizedName} to ${quantityInPrimary.toFixed(3)} ${primaryUnit}`);
                        } else {
                             console.warn(`  V7: Unit '${rawItem.unit}' (canonical: ${canonicalRawUnit}) found in map for ${normalizedName}, but factor is invalid (${factorFromPrimary}). Adding raw.`);
                        }
                    } else {
                        console.warn(`  V7: Unit '${rawItem.unit}' (canonical: ${canonicalRawUnit}) not found in equivalent units map for ${normalizedName} (primary: ${primaryUnit}). Adding raw.`);
                        // console.log(`    Available units for ${normalizedName}:`, Array.from(eqUnitsMap.keys())); // Debugging: Show available keys
                    }
                }
            }
            
            // Accumulate totals
            if (!consolidatedTotals[normalizedName]) consolidatedTotals[normalizedName] = { units: {}, primaryUnit: primaryUnit }; 

            if (conversionSuccessful) {
                // --- MODIFIED ACCUMULATION for the unitless fallback ---
                let unitToAccumulate = primaryUnit;
                if (!canonicalRawUnit && primaryUnit !== 'each' && !(eqUnitsMap.has('leaf') && normalizedName.includes('leaf'))) {
                    // If we hit the modified unitless fallback (where we assumed '1 each')
                    unitToAccumulate = 'each';
                    console.log(`    V7: Accumulating unitless '${rawItem.ingredient}' as '${unitToAccumulate}'`);
                     // Ensure the primary unit is still stored correctly, even if we add 'each'
                     consolidatedTotals[normalizedName].primaryUnit = primaryUnit;
                }

                consolidatedTotals[normalizedName].units[unitToAccumulate] = (consolidatedTotals[normalizedName].units[unitToAccumulate] || 0) + quantityInPrimary;
                
                // --- REMOVED Secondary unit calculation - keep it simple for now ---
                // ['oz', 'fl oz'].forEach(secondaryUnit => {
                //      if (secondaryUnit === primaryUnit) return;
                //      if (eqUnitsMap.has(secondaryUnit)) {
                //          const factorFromPrimaryForSecondary = eqUnitsMap.get(secondaryUnit);
                //          if (factorFromPrimaryForSecondary > 0) {
                //               const quantityInSecondary = quantityInPrimary * factorFromPrimaryForSecondary;
                //               if (quantityInSecondary > 0) {
                //                    consolidatedTotals[normalizedName].units[secondaryUnit] = (consolidatedTotals[normalizedName].units[secondaryUnit] || 0) + quantityInSecondary;
                //               }
                //          }
                //      }
                // });
            } else {
                 // Add raw quantity if conversion failed (using canonical unit if possible)
                 // --- MODIFIED --- Use canonicalRawUnit for the key
                 const unitToAdd = canonicalRawUnit || 'unknown_unit'; 
                 consolidatedTotals[normalizedName].units[unitToAdd] = (consolidatedTotals[normalizedName].units[unitToAdd] || 0) + rawQuantity;
                 consolidatedTotals[normalizedName].failed = true; // Mark that at least one conversion failed
            }
        }
        console.log("V7: Consolidated totals before adjustments:", JSON.stringify(consolidatedTotals, null, 2));
        // --- End Step 2 ---

        // --- Step 3: Final Adjustments & Formatting ---
        console.log("V7 Step 3: Applying final adjustments...");
        const finalAdjustedItems = [];
        // --- MODIFIED --- Use canonical names from our map for Instacart alignment
        const countableUnits = ['bunch', 'can', 'head', 'each', 'large', 'medium', 'small', 'package', 'packet', 'pint', 'clove', 'sprig', 'ear', 'slice'];
        const freshHerbs = ['basil', 'thyme', 'mint', 'parsley', 'cilantro', 'rosemary', 'dill', 'oregano'];

        for (const normalizedName in consolidatedTotals) {
            const itemData = consolidatedTotals[normalizedName];
            const measurements = itemData.units;
            // Primary unit determined by LLM (now guided by Instacart conventions)
            const primaryUnit = itemData.primaryUnit || Object.keys(measurements)[0] || 'each';
            let finalMeasurements = [];

            for (const [unit, quantity] of Object.entries(measurements)) {
                if (quantity <= 0 || unit === 'unknown_unit') continue; // Skip zero/negative/unknown
                
                let adjustedQuantity = quantity;
                // --- MODIFIED --- Use the expanded countableUnits list
                const isCountable = countableUnits.includes(unit);
                const isHerb = freshHerbs.some(herb => normalizedName.includes(herb));

                // Adjustment 1: Round up countable units (using expanded list)
                if (isCountable) {
                    const rounded = Math.ceil(adjustedQuantity);
                    if (rounded > adjustedQuantity) {
                         console.log(`  Adjusting ${normalizedName} ${unit}: ${adjustedQuantity.toFixed(3)} -> ${rounded} (Ceiling)`);
                         adjustedQuantity = rounded;
                    }
                    // Ensure minimum 1 after rounding if it was originally > 0
                    if (quantity > 0) {
                         adjustedQuantity = Math.max(1, adjustedQuantity); 
                    }
                }

                // Adjustment 2: Minimum 1 for fresh herbs in bunch/package/sprig
                 if (isHerb && (unit === 'bunch' || unit === 'package' || unit === 'sprig') && adjustedQuantity > 0 && adjustedQuantity < 1) {
                     console.log(`  Adjusting ${normalizedName} ${unit}: ${adjustedQuantity.toFixed(3)} -> 1 (Herb Minimum)`);
                     adjustedQuantity = 1; 
                 }
                 
                 // Ensure reasonable precision for non-countable
                 if (!isCountable) adjustedQuantity = parseFloat(adjustedQuantity.toFixed(2));
                 
                 // Prevent zeroing out tiny quantities after rounding
                 if (quantity > 0 && adjustedQuantity <= 0) adjustedQuantity = 0.01; 

                 if (adjustedQuantity > 0) {
                    // The 'unit' here comes directly from the keys of `consolidatedTotals[normalizedName].units`.
                    // These keys were populated using `getCanonicalUnit` or the LLM's `primaryUnit`,
                    // which should now align with our expanded `unitAbbreviations` map and Instacart terms.
                    finalMeasurements.push({ unit, quantity: adjustedQuantity });
                 }
            }
            
            // Sort measurements: primary unit first, then alpha
            finalMeasurements.sort((a, b) => {
                 if (a.unit === primaryUnit) return -1; 
                 if (b.unit === primaryUnit) return 1;
                 return a.unit.localeCompare(b.unit); 
            });

            if (finalMeasurements.length > 0) {
                 // If conversion failed for any part of this item, maybe add a note?
                 // For now, just use the normalized name.
                 finalAdjustedItems.push({ name: normalizedName, line_item_measurements: finalMeasurements });
            }
        }
        console.log("V7: Final adjusted items ready for review:", JSON.stringify(finalAdjustedItems, null, 2));
        // --- End Step 3 ---

        res.json({ 
            processedIngredients: finalAdjustedItems, 
            originalTitle: title
        }); 

    } catch (error) {
        console.error("V7: Error during /api/create-list processing:", error);
        return res.status(500).json({
            error: 'Failed to process ingredients list.',
            details: error.message
        });
    }
}

module.exports = {
    createList
}; 