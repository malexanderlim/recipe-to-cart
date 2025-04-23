const cheerio = require('cheerio');
const { callAnthropic } = require('../services/anthropicService');

/**
 * Parse recipe data from HTML content
 * @param {string} html - HTML content to parse
 * @param {string} url - URL of the recipe
 * @returns {Object} - Parsed recipe data
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
  if (!recipeData.title || !recipeData.ingredients.length) {
    recipeData = await enhanceRecipeWithAI(html, recipeData);
  }
  
  return recipeData;
}

/**
 * Extract recipe data from structured JSON-LD
 * @param {Object} $ - Cheerio instance
 * @returns {Object} - Extracted recipe data
 */
function extractStructuredData($) {
  const recipeData = {
    title: '',
    ingredients: [],
    instructions: '',
    image: ''
  };
  
  // Look for JSON-LD schema
  let jsonLdSchema = null;
  $('script[type="application/ld+json"]').each((i, elem) => {
    try {
      const json = JSON.parse($(elem).html());
      if (json['@type'] === 'Recipe' || (json['@graph'] && json['@graph'].find(item => item['@type'] === 'Recipe'))) {
        jsonLdSchema = json['@type'] === 'Recipe' ? json : json['@graph'].find(item => item['@type'] === 'Recipe');
      }
    } catch (e) {
      console.error('Error parsing JSON-LD:', e);
    }
  });
  
  if (jsonLdSchema) {
    recipeData.title = jsonLdSchema.name || '';
    
    if (jsonLdSchema.image) {
      if (typeof jsonLdSchema.image === 'string') {
        recipeData.image = jsonLdSchema.image;
      } else if (jsonLdSchema.image.url) {
        recipeData.image = jsonLdSchema.image.url;
      } else if (Array.isArray(jsonLdSchema.image) && jsonLdSchema.image.length > 0) {
        const firstImage = jsonLdSchema.image[0];
        recipeData.image = typeof firstImage === 'string' ? firstImage : (firstImage.url || '');
      }
    }
    
    if (jsonLdSchema.recipeIngredient && Array.isArray(jsonLdSchema.recipeIngredient)) {
      recipeData.ingredients = jsonLdSchema.recipeIngredient;
    }
    
    if (jsonLdSchema.recipeInstructions) {
      if (Array.isArray(jsonLdSchema.recipeInstructions)) {
        recipeData.instructions = jsonLdSchema.recipeInstructions
          .map(instruction => {
            if (typeof instruction === 'string') return instruction;
            if (instruction.text) return instruction.text;
            return '';
          })
          .filter(text => text)
          .join('\n');
      } else {
        recipeData.instructions = jsonLdSchema.recipeInstructions;
      }
    }
  }
  
  return recipeData;
}

/**
 * Extract recipe data using generic patterns
 * @param {Object} $ - Cheerio instance
 * @param {string} url - URL of the recipe
 * @returns {Object} - Extracted recipe data
 */
function extractSiteSpecificData($, url) {
  const recipeData = {
    title: '',
    ingredients: [],
    instructions: '',
    image: ''
  };
  
  // Generic extraction based on common patterns
  recipeData.title = $('h1').first().text().trim();
  
  // Try to find ingredients
  $('ul li').each((i, elem) => {
    const text = $(elem).text().trim();
    if (text && text.length > 3 && text.length < 200) {
      recipeData.ingredients.push(text);
    }
  });
  
  // Try to find instructions
  const instructionsText = [];
  $('ol li').each((i, elem) => {
    const text = $(elem).text().trim();
    if (text) {
      instructionsText.push(text);
    }
  });
  recipeData.instructions = instructionsText.join('\n');
  
  // Try to find image
  const firstImage = $('img').first();
  if (firstImage.attr('src')) {
    recipeData.image = firstImage.attr('src');
  }
  
  return recipeData;
}

/**
 * Enhance recipe data using AI
 * @param {string} html - HTML content
 * @param {Object} existingData - Existing recipe data
 * @returns {Object} - Enhanced recipe data
 */
async function enhanceRecipeWithAI(html, existingData) {
  try {
    const prompt = `
You are an expert recipe extraction assistant. I need you to extract recipe details from this HTML.
The current extracted data is:
Title: "${existingData.title || 'Unknown'}"
Ingredients: ${existingData.ingredients.length ? existingData.ingredients.join(', ') : 'None found'}
Instructions: ${existingData.instructions || 'None found'}

Please extract or improve the following recipe information from the HTML. Return ONLY a JSON object with these fields:
1. title - the recipe title
2. ingredients - an array of ingredient strings (each item should be a separate ingredient)
3. instructions - the full cooking instructions as a string with newlines between steps

HTML:
${html.substring(0, 15000)}
`;

    const response = await callAnthropic({
      messages: [{ role: 'user', content: prompt }],
      model: 'claude-3-haiku-20240307',
      max_tokens: 4000,
    });

    if (response && response.content) {
      const content = response.content[0].text;
      // Extract JSON from the response
      const jsonMatch = content.match(/```(?:json)?\s*({[\s\S]*?})\s*```/) || 
                       content.match(/{[\s\S]*?}/);
                       
      if (jsonMatch) {
        const parsedData = JSON.parse(jsonMatch[1] || jsonMatch[0]);
        return {
          title: parsedData.title || existingData.title,
          ingredients: parsedData.ingredients || existingData.ingredients,
          instructions: parsedData.instructions || existingData.instructions
        };
      }
    }
    
    return existingData;
  } catch (error) {
    console.error('Error enhancing recipe with AI:', error);
    return existingData;
  }
}

module.exports = {
  parseRecipeData
}; 