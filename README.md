# Recipe-to-Cart

A simple web application to extract ingredients from a recipe image and create an Instacart shopping list.

## Features

*   Upload one or more recipe images (JPG, PNG, HEIC, etc.).
*   Uses Google Cloud Vision API for text extraction.
*   Uses Anthropic Claude API (via `.env` key) to parse ingredients, title, and yield.
*   Allows scaling of recipe yield before adding to cart.
*   Creates an Instacart shopping list using the Instacart Developer API (via `.env` key).
*   Handles asynchronous processing reliably using Upstash QStash and Redis.

## Technology Stack & Architecture

This project utilizes a modern web stack and a serverless architecture designed to handle potentially long-running image processing tasks efficiently and reliably.

**Languages & Frameworks:**

*   **Frontend:** HTML5, CSS3, Vanilla JavaScript (ES6+)
*   **Backend:** Node.js with Express.js

**Key Services & APIs:**

*   **Google Cloud Vision API:** Used for Optical Character Recognition (OCR) to extract raw text from uploaded recipe images.
*   **Anthropic Claude API (Claude 3 Haiku):** Employed for Natural Language Processing (NLP) tasks:
    *   Initial parsing of raw OCR text to extract structured recipe data (title, yield, ingredients).
    *   Generating normalized ingredient names and purchasable unit conversion data for Instacart compatibility.
*   **Instacart Connect API:** Used to create the final shopping list based on the processed ingredients.
*   **Upstash QStash:** Used as a reliable message queue/task runner for all asynchronous background processing steps (image OCR, URL scraping, text analysis).
*   **Upstash Redis:** Acts as a simple, fast database for managing asynchronous job status and intermediate results.
*   **Vercel Platform:**
    *   **Serverless Functions:** Hosts the Node.js/Express backend API endpoints.
    *   **Blob Storage:** Provides temporary storage for uploaded images before processing.

**Core Libraries:**

*   **Backend:** `express`, `cors`, `multer` (image upload handling), `@google-cloud/vision`, `@anthropic-ai/sdk`, `axios` (API calls), `heic-convert` (HEIC/HEIF image support), `@vercel/blob`, `@upstash/redis`, `@upstash/qstash` (Upstash services integration), `jsdom`, `@mozilla/readability`, `cheerio` (URL processing), `dotenv` (environment variables).
*   **Frontend:** No external libraries; relies on standard browser APIs (`fetch`, DOM manipulation).

**Architectural Highlights:**

*   **QStash-Powered Asynchronous Pipeline:** To overcome serverless function timeout limits and ensure reliable execution, processing is handled asynchronously using Upstash QStash:
    1.  Frontend uploads image or submits URL to a lightweight trigger endpoint (`/api/upload` or `/api/process-url`).
    2.  The trigger endpoint stores the image in Vercel Blob (if applicable), creates a job entry in Upstash Redis (status `pending`), publishes a job message to QStash targeting the appropriate worker (`/api/process-image` or `/api/process-url-job`), and immediately returns a `jobId` (`202 Accepted`).
    3.  QStash delivers the message to the worker endpoint, which verifies the signature.
    4.  **Image Worker (`/api/process-image`):** Performs OCR (Vision API), updates job status in Redis, and publishes *another* QStash message targeting the text analysis worker (`/api/process-text-worker`).
    5.  **URL Worker (`/api/process-url-job`):** Fetches and parses the URL, potentially calls an LLM, and updates job status in Redis.
    6.  **Text Worker (`/api/process-text-worker`):** Performs NLP parsing (Anthropic API) and updates job status in Redis.
    7.  Frontend polls an `/api/job-status` endpoint using the `jobId` to retrieve the final status and results from Redis.
*   **Hybrid Ingredient Processing:** Combines LLM capabilities with deterministic backend logic:
    *   An LLM call (`/api/create-list`) analyzes the initially parsed ingredients to suggest `normalized_name`, `primary_unit` (purchasable), and `equivalent_units` conversion factors based on Instacart standards.
    *   Backend code then uses this LLM-generated data dictionary to perform the actual consolidation and unit conversion calculations reliably, avoiding LLM mathematical errors.
*   **Robust Error Handling:** Includes specific error messages for various failure points (upload, OCR, NLP, timeout, API errors) propagated to the UI.

## Setup

1.  **Clone the repository:**
    ```bash
    git clone <your-repo-url>
    cd recipe-to-cart
    ```
2.  **Backend Setup:**
    *   Navigate to the `backend` directory:
        ```bash
        cd backend
        ```
    *   Install dependencies:
        ```bash
        npm install
        ```
    *   Create a `.env` file in the `backend` directory:
        ```
        cp .env.example .env 
        # Or manually create .env
        ```
    *   Edit the `.env` file and add your API keys:
        ```dotenv
        # Required: Get from https://console.anthropic.com/
        ANTHROPIC_API_KEY=your_anthropic_api_key_here
        
        # Required: Get from https://developer.instacart.com/
        INSTACART_API_KEY=your_instacart_developer_api_key_here
        
        # Required: Get from Upstash Console (https://console.upstash.com/)
        UPSTASH_REDIS_REST_URL=your_upstash_redis_url
        UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_token

        # Required: Get from Upstash Console (QStash section)
        QSTASH_TOKEN=your_qstash_token
        QSTASH_CURRENT_SIGNING_KEY=your_qstash_current_signing_key
        QSTASH_NEXT_SIGNING_KEY=your_qstash_next_signing_key

        # Required for Local Development with QStash Callbacks:
        # Your public tunnel URL (e.g., from ngrok or cloudflared)
        APP_BASE_URL=https://your-tunnel-url.ngrok.io 

        # Optional: If running locally and haven't set up Google Cloud ADC, 
        # you might need to point to your service account key file.
        # GOOGLE_APPLICATION_CREDENTIALS=path/to/your-google-cloud-sa-key.json 
        ```
    *   **Google Cloud Vision API Setup:** Ensure you have Application Default Credentials (ADC) set up for Google Cloud, or uncomment and set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable in your `.env` file pointing to your service account key JSON.

3.  **Frontend Setup:** No specific build steps required for the basic HTML/CSS/JS frontend.

4.  **Local Development Tunnel (Required for QStash):**
    *   QStash needs a public URL to send webhook callbacks to your local machine.
    *   Start your backend server (e.g., on port `3001`).
    *   In a separate terminal, use a tunneling service like `ngrok` or `cloudflared`:
        *   `ngrok http 3001`
        *   `cloudflared tunnel --url localhost:3001`
    *   Copy the generated `https://*.ngrok.io` or `https://*.trycloudflare.com` URL.
    *   Paste this URL as the value for `APP_BASE_URL` in your `backend/.env` file. This allows QStash messages published by your local server to be correctly routed back to your running worker endpoints via the tunnel.

## Running the Application

**Note:** Before running the scripts for the first time, you might need to make them executable:
```bash
chmod +x start_backend.sh start_frontend.sh
```

1.  **Start the Backend Server:**
    *   Open a terminal in the project root directory.
    *   Run the backend start script:
        ```bash
        ./start_backend.sh
        ```
    *   The backend should start, typically on port 3001.

2.  **Start the Frontend Server:**
    *   Open a *new* terminal window/tab in the project root directory.
    *   Run the frontend start script:
        ```bash
        ./start_frontend.sh
        ```
    *   The frontend server will start on port 8000.

3.  **Access the Application:**
    *   Open your web browser and go to `http://localhost:8000`.

## Usage

1.  Click "Choose Files" and select one or more recipe images.
2.  Wait for the images to be processed. Results for each recipe (title, yield controls, ingredients) will appear.
3.  Adjust the yield for each recipe using the +/- buttons or by entering a number.
4.  **Optionally, uncheck ingredients** you already have (e.g., salt, olive oil) using the checkboxes next to each item. 
5.  **Optionally, use the "I have commonly found pantry items..." checkbox** above the recipes to quickly toggle common staples (salt, black pepper, common oils, sugar, flour, water).
6.  Click "Create Instacart List".
7.  If successful, a link to "Open Instacart Shopping List" will appear. Click it to view your list on Instacart.

## Next Steps / Potential Improvements

*   See `requirements.md` for remaining tasks and ideas.
*   Refine error handling and user feedback.
*   Add ingredient consolidation.
*   Improve UI/UX, especially for multiple file processing. 