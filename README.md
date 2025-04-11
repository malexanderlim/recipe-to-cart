# Recipe-to-Cart

A simple web application to extract ingredients from a recipe image and create an Instacart shopping list.

## Features

*   Upload one or more recipe images (JPG, PNG, HEIC, etc.).
*   Uses Google Cloud Vision API for text extraction.
*   Uses Anthropic Claude API (via `.env` key) to parse ingredients, title, and yield.
*   Allows scaling of recipe yield before adding to cart.
*   Creates an Instacart shopping list using the Instacart Developer API (via `.env` key).

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
        
        # Optional: If running locally and haven't set up Google Cloud ADC, 
        # you might need to point to your service account key file.
        # GOOGLE_APPLICATION_CREDENTIALS=path/to/your-google-cloud-sa-key.json 
        ```
    *   **Google Cloud Vision API Setup:** Ensure you have Application Default Credentials (ADC) set up for Google Cloud, or uncomment and set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable in your `.env` file pointing to your service account key JSON.

3.  **Frontend Setup:** No specific build steps required for the basic HTML/CSS/JS frontend.

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