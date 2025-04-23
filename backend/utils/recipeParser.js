const cheerio = require('cheerio');
const { callAnthropic } = require('../services/anthropicService');

/**
 * Parse recipe data from HTML content
 * @param {string} html - HTML content to parse
 * @param {string} url - URL of the recipe
 * @returns {Object} - Parsed recipe data (title, ingredients)
 */
async function parseRecipeData(html, url) {
  const $ = cheerio.load(html);
  
  // Try to find recipe structured data
  let recipeData = extractStructuredData($);
  
  // If no structured data, try site-specific extraction
  if (!recipeData.title || !recipeData.ingredients.length) {
    recipeData = extractSiteSpecificData($, url);
  }
  
  // If still no data, try enhancing with AI
  // Focus AI enhancement only if title or ingredients are missing
  if (!recipeData.title || !recipeData.ingredients.length) {
    recipeData = await enhanceRecipeWithAI(html, recipeData);
  }
  
  // Return only title and ingredients
  return { 
    title: recipeData.title,
    ingredients: recipeData.ingredients
  };
}

/**
 * Extract recipe data from structured JSON-LD
 * @param {Object} $ - Cheerio instance
 * @returns {Object} - Extracted recipe data (title, ingredients)
 */
function extractStructuredData($) {
  const recipeData = {
    title: '',
    ingredients: []
    // Removed instructions and image
  };
  
  // Look for JSON-LD schema
  let jsonLdSchema = null;
  $('script[type="application/ld+json"]').each((i, elem) => {
    try {
      const json = JSON.parse($(elem).html());
      // Simplified check for Recipe type
      const potentialRecipe = json['@type'] === 'Recipe' ? json : 
                             (json['@graph'] && Array.isArray(json['@graph'])) ? json['@graph'].find(item => item['@type'] === 'Recipe') : null;
      if (potentialRecipe) {
        jsonLdSchema = potentialRecipe;
        return false; // Stop searching once found
      }
    } catch (e) {
      // Ignore parsing errors silently for now, as some scripts might be invalid
      // console.error('Error parsing JSON-LD:', e);
    }
  });
  
  if (jsonLdSchema) {
    recipeData.title = jsonLdSchema.name || '';
    
    // Removed image extraction logic
    
    if (jsonLdSchema.recipeIngredient && Array.isArray(jsonLdSchema.recipeIngredient)) {
      // Filter out any non-string entries, just in case
      recipeData.ingredients = jsonLdSchema.recipeIngredient.filter(ing => typeof ing === 'string');
    }
    
    // Removed instructions extraction logic
  }
  
  return recipeData;
}

/**
 * Extract recipe data using generic patterns (fallback)
 * @param {Object} $ - Cheerio instance
 * @param {string} url - URL of the recipe
 * @returns {Object} - Extracted recipe data (title, ingredients)
 */
function extractSiteSpecificData($, url) {
  const recipeData = {
    title: '',
    ingredients: []
    // Removed instructions and image
  };
  
  // Generic extraction based on common patterns
  recipeData.title = $('h1').first().text().trim();
  
  // Try to find ingredients - simplified selector
  // Look for list items within elements having classes/ids often containing 'ingredient'
  const potentialIngredientLists = $('[class*="ingredient"], [id*="ingredient"] ul, ul[class*="ingredient"], ul[id*="ingredient"]');
  let foundIngredients = [];
  if (potentialIngredientLists.length > 0) {
     potentialIngredientLists.find('li').each((i, elem) => {
       const text = $(elem).text().trim();
       // Basic filtering for plausible ingredient lines
       if (text && text.length > 3 && text.length < 200 && /\d/.test(text)) { // Require a digit 
         foundIngredients.push(text);
       }
     });
  }
  // Fallback to any top-level <ul> if specific selectors fail
  if (foundIngredients.length === 0) {
      $('ul > li').each((i, elem) => {
          const text = $(elem).text().trim();
           if (text && text.length > 3 && text.length < 200 && /\d/.test(text)) { 
             foundIngredients.push(text);
          }
      });
  }
  recipeData.ingredients = foundIngredients;
  
  // Removed instructions extraction logic
  
  // Removed image extraction logic
  
  return recipeData;
}

/**
 * Enhance recipe data using AI (if extraction fails)
 * @param {string} html - HTML content
 * @param {Object} existingData - Existing recipe data (title, ingredients)
 * @returns {Object} - Enhanced recipe data (title, ingredients)
 */
async function enhanceRecipeWithAI(html, existingData) {
  // Only enhance if necessary fields are missing
  if (existingData.title && existingData.ingredients.length > 0) {
    return existingData;
  }

  try {
    // Simplified prompt focusing only on title and ingredients
    const prompt = `
You are an expert recipe extraction assistant. Analyze this HTML to extract the recipe title and ingredients list.

The current extracted data is:
Title: "${existingData.title || 'Unknown'}"
Ingredients: ${existingData.ingredients.length ? existingData.ingredients.join(', ') : 'None found'}

Please extract or improve the following from the HTML. Return ONLY a JSON object with these fields:
1. title: the recipe title (string)
2. ingredients: an array of ingredient strings (each item should be a separate ingredient)

HTML (first 15000 chars):
${html.substring(0, 15000)}
`;

    // Use the existing anthropic service call
    const responseText = await callAnthropic(
      "Extract recipe title and ingredients. Respond ONLY with a valid JSON object {title: string, ingredients: string[]}.", // System prompt
      prompt, // User prompt
      'claude-3-haiku-20240307', // Model
      2000 // Reduced max_tokens as we expect less output
    );

    if (responseText) {
      // Extract JSON from the response - simplified extraction
      const jsonMatch = responseText.match(/{\s*"title"\s*:[\s\S]*?}/);
                       
      if (jsonMatch && jsonMatch[0]) {
        try {
            const parsedData = JSON.parse(jsonMatch[0]);
            // Return enhanced data, preferring newly parsed data if valid
            return {
              title: parsedData.title && typeof parsedData.title === 'string' ? parsedData.title : existingData.title,
              ingredients: Array.isArray(parsedData.ingredients) && parsedData.ingredients.length > 0 ? parsedData.ingredients.filter(i => typeof i === 'string') : existingData.ingredients,
            };
        } catch (parseError) {
             console.error('AI response JSON parsing failed:', parseError, '\nResponse text:', responseText);
             // Fallback to existing data if parsing fails
             return existingData; 
        }
      } else {
          console.warn('AI response did not contain expected JSON structure.', '\nResponse text:', responseText);
      }
    } else {
        console.warn('AI service returned empty response.');
    }
    
    // Fallback to existing data if AI call fails or yields no usable result
    return existingData;
  } catch (error) {
    console.error('Error enhancing recipe with AI:', error);
    return existingData; // Return existing data on error
  }
}

module.exports = {
  parseRecipeData
}; 