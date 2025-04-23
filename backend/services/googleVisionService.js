// backend/services/googleVisionService.js
// Exports the Google Vision API client for use across the application

const { ImageAnnotatorClient } = require('@google-cloud/vision');

// Google Cloud Vision client initialization
let visionClient;

try {
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialsPath) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS environment variable is not set.');
  }
  
  visionClient = new ImageAnnotatorClient();
  console.log('Google Vision API client initialized successfully');
} catch (error) {
  console.error('Failed to initialize Google Cloud Vision client:', error);
  if (error.message.includes('Could not load the default credentials') || error.message.includes('Could not find file')) {
      console.error(`Check if the path specified in GOOGLE_APPLICATION_CREDENTIALS is correct: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
  }
  visionClient = null; // Ensure it's null if init failed
}

module.exports = {
  visionClient
}; 