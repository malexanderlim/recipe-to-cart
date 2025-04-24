#!/bin/bash
# Load Google credentials (Ensure this path is correct relative to where you run the script)
# Example: If run from root, path might be ./recipe-vision-sa-key.json
# If run from backend, path might be ../recipe-vision-sa-key.json
# Using the path from your log for now:
# KEY_PATH="../recipe-vision-sa-key.json"
# if [ -f "$KEY_PATH" ]; then
#     export GOOGLE_APPLICATION_CREDENTIALS=$(readlink -f "$KEY_PATH") # Get absolute path
#     echo "Loaded Google credentials from ${GOOGLE_APPLICATION_CREDENTIALS} into environment variable."
# else
#     echo "Warning: Google credentials file not found at $KEY_PATH. Vision API might fail."
# fi

# Navigate to the backend directory (assuming script is run from project root)
# If script is already IN backend dir, remove the cd command.
echo "Changing to backend directory..."
cd backend || { echo "Failed to change directory to backend. Exiting."; exit 1; }

# --- Set Google Credentials AFTER changing directory ---
KEY_PATH_RELATIVE_TO_BACKEND="../recipe-vision-sa-key.json" # Assuming key is in project root
if [ -f "$KEY_PATH_RELATIVE_TO_BACKEND" ]; then
    export GOOGLE_APPLICATION_CREDENTIALS="$KEY_PATH_RELATIVE_TO_BACKEND"
    echo "Set GOOGLE_APPLICATION_CREDENTIALS to relative path: $GOOGLE_APPLICATION_CREDENTIALS"
else
    echo "Warning: Google credentials file not found at $KEY_PATH_RELATIVE_TO_BACKEND (relative to backend dir). Vision API might fail."
fi
# --------------------------------------------------

# Ensure dependencies are installed
echo "Ensuring backend dependencies are installed..."
npm install
INSTALL_EXIT_CODE=$?
if [ $INSTALL_EXIT_CODE -ne 0 ]; then
    echo "npm install failed with exit code $INSTALL_EXIT_CODE. Exiting."
    exit $INSTALL_EXIT_CODE
fi

# Start the server
echo "Starting backend server..."
export NODE_ENV=development # Set environment to development for local run
node server.js 