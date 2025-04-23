// backend/services/googleVisionService.js
// Exports the Google Vision API client for use across the application

const { ImageAnnotatorClient } = require('@google-cloud/vision');

let visionClient = null; // Initialize as null

try {
  // Read the credentials JSON content directly from GOOGLE_APPLICATION_CREDENTIALS
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialsJson) {
    // Log a warning if running locally without the variable, but throw on Vercel
    if (process.env.VERCEL === '1') {
         throw new Error('GOOGLE_APPLICATION_CREDENTIALS environment variable (containing JSON content) is not set on Vercel.');
    } else {
         console.warn('GOOGLE_APPLICATION_CREDENTIALS environment variable (containing JSON content) not set for local development. Google Vision will likely fail.');
         // Allow execution to continue locally, but visionClient remains null
    }
  } else {
      // Parse the JSON string from the environment variable
      const credentials = JSON.parse(credentialsJson);

      // Explicitly pass the credentials object during client initialization
      visionClient = new ImageAnnotatorClient({ credentials });
      console.log('Google Vision API client initialized successfully from GOOGLE_APPLICATION_CREDENTIALS JSON content.');
  }

} catch (error) {
  console.error('Failed to initialize Google Cloud Vision client:', error);
  // Log details if parsing fails or client creation fails
  if (error instanceof SyntaxError) {
      console.error('Error parsing GOOGLE_APPLICATION_CREDENTIALS JSON content. Ensure it is valid JSON and not a file path.');
  }
  // visionClient remains null if initialization failed
}

module.exports = {
  visionClient // Will be null if initialization failed
}; 