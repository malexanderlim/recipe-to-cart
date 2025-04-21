#!/bin/bash
# Navigate to the backend directory and start the server

cd backend || exit

echo "Starting backend server..."
# Use --env-file flag to load the .env file
node --env-file=.env server.js 