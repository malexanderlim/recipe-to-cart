// --- Import Services ---
// Import callAnthropic directly from the service file
const { callAnthropic } = require('../services/anthropicService');

// --- NEW Helper: Parse JSON, with LLM correction fallback ---
// Tries to parse JSON. If it fails, asks the LLM to fix the syntax.
async function parseAndCorrectJson(jobId, rawJsonResponse, expectedType) {
    // Default to 'object' if not specified or invalid
    if (expectedType !== 'array') {
        expectedType = 'object';
    }
    console.log(`[${jobId}] Attempting to parse JSON (expected type: ${expectedType}). Raw length: ${rawJsonResponse?.length}`);
    let parsedJson = null;
    let jsonString = rawJsonResponse?.trim() || '';

    // Initial attempt: Strict extraction and parsing
    try {
        let extractedString = null;
        if (expectedType === 'array') {
            // Try to find array strictly delimited by optional whitespace
            const arrayMatchStrict = jsonString.match(/^\s*(\[[\s\S]*\])\s*$/);
            if (arrayMatchStrict) {
                extractedString = arrayMatchStrict[1];
            } else {
                // Fallback: find first '[' and last ']'
                const firstBracket = jsonString.indexOf('[');
                const lastBracket = jsonString.lastIndexOf(']');
                if (firstBracket !== -1 && lastBracket > firstBracket) {
                    extractedString = jsonString.substring(firstBracket, lastBracket + 1);
                    console.log(`[${jobId}] Used fallback bracket finding for array.`);
                } else {
                    throw new Error(`Response does not appear to contain a JSON array.`);
                }
            }
        } else { // expectedType === 'object'
             // Try to find object strictly delimited by optional whitespace
            const objectMatchStrict = jsonString.match(/^\s*(\{[\s\S]*\})\s*$/);
            if (objectMatchStrict) {
                extractedString = objectMatchStrict[1];
            } else {
                // Fallback: find first '{' and last '}'
                 const firstBrace = jsonString.indexOf('{');
                 const lastBrace = jsonString.lastIndexOf('}');
                 if (firstBrace !== -1 && lastBrace > firstBrace) {
                     extractedString = jsonString.substring(firstBrace, lastBrace + 1);
                     console.log(`[${jobId}] Used fallback brace finding for object.`);
                 } else {
                    throw new Error(`Response does not appear to contain a JSON object.`);
                 }
            }
        }

        // Clean potential trailing commas before final bracket/brace
        extractedString = extractedString.replace(/,\s*([}\]])/g, '$1');

        parsedJson = JSON.parse(extractedString);
        console.log(`[${jobId}] Initial JSON parse successful.`);

        // Final type check
        if (expectedType === 'array' && !Array.isArray(parsedJson)) {
             throw new Error(`Parsed result is not an array, but expected one. Found: ${typeof parsedJson}`);
        }
        if (expectedType === 'object' && (typeof parsedJson !== 'object' || Array.isArray(parsedJson) || parsedJson === null)) {
             throw new Error(`Parsed result is not an object, but expected one. Found: ${typeof parsedJson}`);
        }
        return parsedJson; // SUCCESS

    } catch (initialParseError) {
        console.warn(`[${jobId}] Initial JSON parse failed: ${initialParseError.message}. Attempting LLM correction.`);
        // Use the original potentially messy jsonString for correction attempt
        console.warn(`[${jobId}] Faulty JSON string being sent for correction: ${jsonString.substring(0, 500)}...`);

        // --- Correction Attempt ---
        try {
            const correctionSystemPrompt = "You are a JSON syntax correction expert. The user will provide a string that is *supposed* to be valid JSON, but contains syntax errors. Your ONLY task is to fix the syntax errors (missing commas, brackets, quotes, etc.) and return ONLY the corrected, valid JSON string. Do not add any explanations or change the data structure.";
            // Use the original rawJsonResponse in the prompt for correction
            const correctionUserPrompt = `Please fix the syntax errors in the following JSON string and return only the corrected JSON string:\n\n\`\`\`json\n${jsonString}\n\`\`\`\n\nCorrected JSON:`;

            // Use callAnthropic (imported from service)
            const correctedJsonStringRaw = await callAnthropic(correctionSystemPrompt, correctionUserPrompt, 'claude-3-haiku-20240307', jsonString.length + 500); // Give some buffer

            console.log(`[${jobId}] Received potential corrected JSON string from LLM. Length: ${correctedJsonStringRaw?.length}`);

            // Re-attempt parsing on the *corrected* string, using similar extraction logic
            let correctedJsonString = correctedJsonStringRaw?.trim() || '';
            let finalCorrectedString = null;

             if (expectedType === 'array') {
                 const arrayMatchStrict = correctedJsonString.match(/^\s*(\[[\s\S]*\])\s*$/);
                 if (arrayMatchStrict) { finalCorrectedString = arrayMatchStrict[1]; }
                 else { const first = correctedJsonString.indexOf('['); const last = correctedJsonString.lastIndexOf(']'); if(first !== -1 && last > first) finalCorrectedString = correctedJsonString.substring(first, last+1); }
             } else { // object
                 const objectMatchStrict = correctedJsonString.match(/^\s*(\{[\s\S]*\})\s*$/);
                  if (objectMatchStrict) { finalCorrectedString = objectMatchStrict[1]; }
                  else { const first = correctedJsonString.indexOf('{'); const last = correctedJsonString.lastIndexOf('}'); if(first !== -1 && last > first) finalCorrectedString = correctedJsonString.substring(first, last+1); }
             }

             if (!finalCorrectedString) {
                 throw new Error("LLM correction response did not contain expected JSON structure.");
             }

             finalCorrectedString = finalCorrectedString.replace(/,\s*([}\]])/g, '$1'); // Clean trailing commas again
             parsedJson = JSON.parse(finalCorrectedString);

             console.log(`[${jobId}] Successfully parsed corrected JSON.`);

             // Final type check again
             if (expectedType === 'array' && !Array.isArray(parsedJson)) throw new Error("Corrected result is not an array.");
             if (expectedType === 'object' && (typeof parsedJson !== 'object' || Array.isArray(parsedJson) || parsedJson === null)) throw new Error("Corrected result is not an object.");

            return parsedJson; // SUCCESS after correction

        } catch (correctionError) {
            console.error(`[${jobId}] Failed to parse JSON even after LLM correction: ${correctionError.message}`);
            console.error(`[${jobId}] Original faulty JSON: ${jsonString.substring(0, 500)}...`);
            // console.error(`[${jobId}] Corrected attempt raw string: ${correctedJsonStringRaw?.substring(0, 500)}...`); // Optionally log corrected attempt
            return null; // FAILURE after correction attempt
        }
    }
}

module.exports = {
    parseAndCorrectJson
}; 