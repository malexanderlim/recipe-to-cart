// backend/controllers/listController.js
// ----------------------------------------------------------------------------
//  FULL "/api/create-list" CONTROLLER – restored from legacy server.js
// ----------------------------------------------------------------------------

/* External deps */
const axios = require('axios');

/* Internal services & utils */
const { parseAndCorrectJson } = require('../utils/jsonUtils');
const { callAnthropic } = require('../services/anthropicService');

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
        const systemPrompt = `
            You are an expert ingredient normalizer for grocery lists. Given a list of raw ingredients, standardize them and provide conversion rates between different units.

            For EACH unique ingredient concept (e.g., "garlic" whether it appears as "cloves of garlic", "garlic cloves", etc.), output:
            1. normalized_name: A canonical, singular form of the ingredient
            2. primary_unit: The most common purchasable unit (e.g., "head" for garlic, "bunch" for herbs, "can" for tomatoes)
            3. equivalent_units: Array of objects with unit name and conversion factor FROM primary TO this unit.

            The equivalent_units must include conversion factors FROM the primary unit TO each equivalent unit.
            Example: For garlic, if primary_unit is "head", then the factor for "clove" is 10.0, meaning 1 head = 10 cloves.

            Return ONLY a JSON array of objects with these exact keys. No explanation.`;

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
            rawLlmResponse = await callAnthropic(systemPrompt, userPrompt, 'claude-3-haiku-20240307', 15000);
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
            if (!rawItem.ingredient || rawItem.quantity == null) continue;
            
            const normalizedName = nameMapping[rawItem.ingredient] || simpleNormalize(rawItem.ingredient);
            const conversionData = conversionMap.get(normalizedName);
            let rawUnit = rawItem.unit ? rawItem.unit.toLowerCase().trim() : null;
            const rawQuantity = rawItem.quantity;

            // V7: Refined fallback/error handling during consolidation
            if (!conversionData) {
                console.warn(`V7: No conversion data for '${normalizedName}'. Adding raw: ${rawQuantity} ${rawUnit || '(no unit)'}.`);
                if (!consolidatedTotals[normalizedName]) consolidatedTotals[normalizedName] = { units: {}, failed: true }; // Mark as failed
                 const unitToAdd = rawUnit || 'unknown_unit'; 
                 consolidatedTotals[normalizedName].units[unitToAdd] = (consolidatedTotals[normalizedName].units[unitToAdd] || 0) + rawQuantity;
                continue;
            }

            const primaryUnit = conversionData.primaryUnit;
            const eqUnitsMap = conversionData.equivalentUnits;
            let quantityInPrimary = 0;
            let conversionSuccessful = false;

            if (!rawUnit) {
                if (primaryUnit === 'each') { 
                     quantityInPrimary = rawQuantity;
                     conversionSuccessful = true;
                     console.log(`  V7: ${rawItem.ingredient} - Assuming unitless as primary unit 'each'`);
                } else if (eqUnitsMap.has('leaf') && normalizedName.includes('leaf')) {
                    rawUnit = 'leaf'; // Treat as leaf and proceed to lookup below
                     console.log(`  V7: ${rawItem.ingredient} - Treating unitless as 'leaf' for conversion attempt.`);
                } else {
                    console.warn(`  V7: Cannot convert unitless '${rawItem.ingredient}' to primary unit '${primaryUnit}'. Adding raw.`);
                    // Keep track of raw quantity if conversion fails
                }
            }

            if (rawUnit && !conversionSuccessful) { // Attempt conversion only if needed and not already handled
                if (rawUnit === primaryUnit) {
                    quantityInPrimary = rawQuantity;
                    conversionSuccessful = true;
                } else {
                    let factorFromPrimary = null;
                    const singularRawUnit = rawUnit.endsWith('s') && !rawUnit.endsWith('ss') ? rawUnit.slice(0, -1) : null; 
                    
                    if (eqUnitsMap.has(rawUnit)) {
                        factorFromPrimary = eqUnitsMap.get(rawUnit);
                    } else if (singularRawUnit && eqUnitsMap.has(singularRawUnit)) { 
                        factorFromPrimary = eqUnitsMap.get(singularRawUnit);
                        console.log(`  V7: Matched plural raw unit '${rawUnit}' to singular map key '${singularRawUnit}' for ${normalizedName}`);
                    }
                    
                    if (factorFromPrimary != null && factorFromPrimary > 0) {
                        const factorToPrimary = 1.0 / factorFromPrimary;
                        quantityInPrimary = rawQuantity * factorToPrimary;
                        conversionSuccessful = true;
                        console.log(`  V7: Converted ${rawQuantity} ${rawUnit} of ${normalizedName} to ${quantityInPrimary.toFixed(3)} ${primaryUnit}`);
                    } else {
                        console.warn(`  V7: Unit '${rawUnit}' (or singular) not found/invalid factor for ${normalizedName}. Cannot convert to primary '${primaryUnit}'. Adding raw.`);
                    }
                }
            }
            
            // Accumulate totals
            if (!consolidatedTotals[normalizedName]) consolidatedTotals[normalizedName] = { units: {}, primaryUnit: primaryUnit }; // Store primary unit

            if (conversionSuccessful) {
                consolidatedTotals[normalizedName].units[primaryUnit] = (consolidatedTotals[normalizedName].units[primaryUnit] || 0) + quantityInPrimary;
                // Calculate secondary units only if primary conversion worked
                ['oz', 'fl oz'].forEach(secondaryUnit => {
                     if (secondaryUnit === primaryUnit) return;
                     if (eqUnitsMap.has(secondaryUnit)) {
                         const factorFromPrimaryForSecondary = eqUnitsMap.get(secondaryUnit);
                         if (factorFromPrimaryForSecondary > 0) {
                              const quantityInSecondary = quantityInPrimary * factorFromPrimaryForSecondary;
                              if (quantityInSecondary > 0) {
                                   consolidatedTotals[normalizedName].units[secondaryUnit] = (consolidatedTotals[normalizedName].units[secondaryUnit] || 0) + quantityInSecondary;
                              }
                         }
                     }
                });
            } else {
                 // Add raw quantity if conversion failed
                 const unitToAdd = rawUnit || 'unknown_unit';
                 consolidatedTotals[normalizedName].units[unitToAdd] = (consolidatedTotals[normalizedName].units[unitToAdd] || 0) + rawQuantity;
                 consolidatedTotals[normalizedName].failed = true; // Mark that at least one conversion failed
            }
        }
        console.log("V7: Consolidated totals before adjustments:", JSON.stringify(consolidatedTotals, null, 2));
        // --- End Step 2 ---

        // --- Step 3: Final Adjustments & Formatting ---
        console.log("V7 Step 3: Applying final adjustments...");
        const finalAdjustedItems = [];
        const countableUnits = ['bunch', 'can', 'head', 'each', 'large', 'medium', 'small', 'package', 'pint'];
        const freshHerbs = ['basil', 'thyme', 'mint', 'parsley', 'cilantro', 'rosemary', 'dill', 'oregano'];

        for (const normalizedName in consolidatedTotals) {
            const itemData = consolidatedTotals[normalizedName];
            const measurements = itemData.units;
            const primaryUnit = itemData.primaryUnit || Object.keys(measurements)[0] || 'each'; // Use stored primary or fallback
            let finalMeasurements = [];

            for (const [unit, quantity] of Object.entries(measurements)) {
                if (quantity <= 0 || unit === 'unknown_unit') continue; // Skip zero/negative/unknown
                
                let adjustedQuantity = quantity;
                const isCountable = countableUnits.includes(unit);
                const isHerb = freshHerbs.some(herb => normalizedName.includes(herb));

                // Adjustment 1: Round up countable units
                if (isCountable) {
                    const rounded = Math.ceil(adjustedQuantity);
                    if (rounded > adjustedQuantity) {
                         console.log(`  Adjusting ${normalizedName} ${unit}: ${adjustedQuantity.toFixed(3)} -> ${rounded} (Ceiling)`);
                         adjustedQuantity = rounded;
                    }
                    adjustedQuantity = Math.max(1, Math.round(adjustedQuantity)); 
                }

                // Adjustment 2: Minimum 1 for fresh herbs in bunch/package
                 if (isHerb && (unit === 'bunch' || unit === 'package') && adjustedQuantity > 0 && adjustedQuantity < 1) {
                     console.log(`  Adjusting ${normalizedName} ${unit}: ${adjustedQuantity.toFixed(3)} -> 1 (Herb Minimum)`);
                     adjustedQuantity = 1; 
                 }
                 
                 // Ensure reasonable precision for non-countable
                 if (!isCountable) adjustedQuantity = parseFloat(adjustedQuantity.toFixed(2));
                 
                 if (quantity > 0 && adjustedQuantity <= 0) adjustedQuantity = 0.01; 

                 if (adjustedQuantity > 0) {
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