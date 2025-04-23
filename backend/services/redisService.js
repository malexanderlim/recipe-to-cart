// backend/services/redisService.js
// Exports the Redis client instance for use across the application

const { Redis } = require("@upstash/redis");

// Redis client initialization
let redis;
const isVercel = process.env.VERCEL === '1';

try {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    // If running locally and variables are missing, don't throw, just warn and disable Redis features
    if (!isVercel) {
      console.warn('Upstash Redis environment variables not set for local development. Image processing will fail.');
      redis = null;
    } else {
      // If on Vercel, these ARE required
      throw new Error('Upstash Redis environment variables (UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN) are not set on Vercel.');
    }
  } else {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log('Redis service: Successfully initialized Upstash Redis client.');
  }
} catch (error) {
   console.error('Redis service: Failed to initialize Upstash Redis client:', error);
   redis = null; // Ensure it's null if init failed
}

module.exports = {
  redis
}; 