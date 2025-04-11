#!/bin/bash
# Navigate to the frontend directory and start the simple HTTP server

cd frontend || exit

echo "Starting frontend server on http://localhost:8000 ..."
python3 -m http.server 8000 