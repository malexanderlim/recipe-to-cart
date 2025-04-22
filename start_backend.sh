#!/bin/bash
# Navigate to the backend directory and start the server

cd backend || exit

# Export the Google credentials JSON content as an environment variable
# Check if the key file exists first
KEY_FILE="../recipe-vision-sa-key.json" # Path relative to backend dir
if [ -f "$KEY_FILE" ]; then
  export GOOGLE_APPLICATION_CREDENTIALS=$(cat "$KEY_FILE")
  echo "Loaded Google credentials from $KEY_FILE into environment variable."
else
  echo "WARNING: Google credentials file not found at $KEY_FILE. Vision API calls will likely fail."
fi

echo "Starting backend server..."
# Run node, dotenv will load .env from within the script
node server.js 