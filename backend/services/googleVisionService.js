// backend/services/googleVisionService.js
// Exports the Google Vision API client for use across the application

const { ImageAnnotatorClient } = require('@google-cloud/vision');
const fs = require('fs'); // Import fs module
const path = require('path'); // Import path module

let visionClient = null; // Initialize as null

try {
  const credentialsInput = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialsInput) {
    // Log a warning if running locally without the variable, but throw on Vercel
    if (process.env.VERCEL === '1') {
         throw new Error('GOOGLE_APPLICATION_CREDENTIALS environment variable (containing JSON content or path) is not set on Vercel.');
    } else {
         console.warn('GOOGLE_APPLICATION_CREDENTIALS environment variable (containing JSON content or path) not set for local development. Google Vision will likely fail.');
         // Allow execution to continue locally, but visionClient remains null
    }
  } else {
      // Check if it looks like a path or JSON content
      const isPath = credentialsInput.trim().endsWith('.json');
      const isJsonContent = credentialsInput.trim().startsWith('{');

      if (isPath) {
          // If it's a path, use keyFilename
          const keyFilePath = path.resolve(__dirname, '..', credentialsInput); // Resolve relative path correctly
          console.log(`Initializing Google Vision API client using key file path: ${keyFilePath}`);
          if (!fs.existsSync(keyFilePath)) {
              throw new Error(`Credentials file not found at path: ${keyFilePath}. Relative path provided: ${credentialsInput}`);
          }
          visionClient = new ImageAnnotatorClient({ keyFilename: keyFilePath });
          console.log('Google Vision API client initialized successfully from key file path.');

      } else if (isJsonContent) {
          // If it's JSON content, parse and use credentials
          console.log('Initializing Google Vision API client using JSON content from environment variable.');
          const credentials = JSON.parse(credentialsInput);
          visionClient = new ImageAnnotatorClient({ credentials });
          console.log('Google Vision API client initialized successfully from GOOGLE_APPLICATION_CREDENTIALS JSON content.');

      } else {
          // Neither a path nor valid JSON content detected
          throw new Error('GOOGLE_APPLICATION_CREDENTIALS environment variable does not appear to be a valid JSON key file path (ending in .json) or direct JSON content (starting with {).');
      }
  }

} catch (error) {
  console.error('Failed to initialize Google Cloud Vision client:', error);
  // Log details if parsing fails or client creation fails
  if (error instanceof SyntaxError) {
      console.error('Error parsing GOOGLE_APPLICATION_CREDENTIALS JSON content. Ensure it is valid JSON.');
  }
  // visionClient remains null if initialization failed
}

module.exports = {
  visionClient // Will be null if initialization failed
}; 