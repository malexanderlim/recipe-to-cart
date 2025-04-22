# Demo Day Prep Plan

**Goal:** Ensure the Recipe-to-Cart app is accurate, intuitive, and polished for the Demo Day presentation. The core functionality (recipe -> accurate cart) must be reliable.

## P0: Must-Haves for Demo

These issues directly impact the core value proposition or the demo user experience and MUST be addressed.

*   **[X] Fix Ingredient Consolidation & Normalization (Revised Hybrid Approach V2 - SUCCESSFUL):**
    *   **P0 Addendum: Fixing Mixed-Unit Ingredient Consolidation (Garlic Example) - Strategy V2**
        *   **1. Problem Statement:** Previous attempts using multiple LLM calls or single calls with complex instructions failed due to LLM math errors, latency, or inability to handle context correctly (e.g., garlic cloves vs heads). The core issue is reliably consolidating diverse units while leveraging LLM knowledge without relying on its math.
        *   **2. Goal:** Reliably consolidate ingredients with mixed convertible units using a single LLM call for knowledge and robust backend logic for calculations.
        *   **3. Proposed Solution: Single LLM Call for Conversions, Algorithm for Consolidation (Implemented & Verified)**
            1.  **Single LLM Call (Normalization & Conversion Data):** Make a single call to the LLM (Haiku initially) with the entire `rawIngredients` list. The LLM's task is to identify *unique conceptual ingredients* and for each, provide:
                *   A canonical `normalized_name`.
                *   The `primary_unit` (most common purchasable unit).
                *   `equivalent_units`: A list/map defining conversion factors *FROM* the primary unit *TO* other common units (e.g., 1 'head' [primary] = 10 'cloves' [factor: 10.0], 1 'head' = 4 'oz' [factor: 4.0]).
                *   Crucially, the LLM **does not perform quantity calculations** on the input list, only provides this conversion data dictionary.
            2.  **Algorithmic Consolidation (Post-LLM):**
                *   **Map Conversion Data:** Create a lookup map from `normalized_name` -> conversion data object (primary unit, equivalent units map) returned by the LLM.
                *   **Map Raw to Normalized (Optional Refinement):** Determine the mapping from each `rawIngredient` string to its LLM-provided `normalized_name`.
                *   **Iterate Raw & Consolidate:** Initialize `consolidatedTotals = {}`. Loop through `rawIngredients`. For each `rawItem`:
                    *   Find its `normalized_name`.
                    *   Look up its `conversionData`.
                    *   Calculate the `factor_to_primary` for the `rawItem.unit` by inverting the LLM's `factor_from_primary` (e.g., `1.0 / equivalent_units['clove'].factor_from_primary`). Handle primary unit (factor=1) and missing units.
                    *   Calculate `quantity_in_primary = rawItem.quantity * factor_to_primary`.
                    *   Add this value to `consolidatedTotals[normalized_name][primary_unit]`.
                    *   (Optional) Calculate and add totals for 'oz'/'fl oz' similarly.
            3.  **Final Adjustments:** Iterate `consolidatedTotals`. Apply `Math.ceil` to countable primary units, apply minimums, format the final `line_item_measurements` array for each normalized item.
        *   **4. Detailed Implementation Steps:** **(DONE)**
            *   **Backend (`server.js` - `/api/create-list`):** Refactor the endpoint entirely. Define the new single prompt. Implement the LLM call. Implement the post-LLM consolidation loop using inverse factors. Implement final adjustments.
            *   **LLM Prompt:** Carefully design the prompt to extract the conversion data structure reliably.
            *   **Logging:** Add detailed logging for the single LLM I/O, the conversion data map, the consolidation loop, and final adjustments.
        *   **5. Potential Risks & Alternatives:**
            *   **LLM Data Quality:** Haiku might provide inaccurate/incomplete conversion data. Backend logic needs safety checks. May still need Sonnet if Haiku fails this task.
            *   **Matching Raw to Normalized:** Reliably mapping raw ingredient strings to the LLM's normalized name might require refinement (e.g., simple algo + LLM confirmation).
        *   **6. Verification:** Test with garlic case (expecting 9 heads). Test other complex cases (sprigs, weights, volumes). **(Verified Successful)**
*   **[ ] Review & Refine Backend Unit Normalization (`backend/server.js`):** (Partially addressed by consolidation fix, but review other aspects like herb/wine normalization)
    *   **Problem:** Current normalization (e.g., cloves->each, tsp->bunch) leads to inaccurate quantities and incorrect product matching by Instacart (fresh vs dried oregano, whole vs minced garlic, cooking vs table wine).
    *   **Action (General):** Implement robust logging of original extracted units vs. normalized units to easily trace issues during testing.
    *   **Action (Herbs):** How did `1 tsp dried oregano` become `1 bunch`? Check LLM output and backend logic. Ensure "dried" is preserved and influences normalization (perhaps map to `oz` or `package` instead of `bunch`?). Re-evaluate `tsp`/`tbsp`/`sprigs` -> `bunch`/`package` - needs to be more nuanced.
    *   **Action (Wine):** Clarify "dry white wine" to something less ambiguous like "white table wine" or "Sauvignon Blanc" if identifiable, to avoid matching with "cooking wine".
    *   **Action (Leverage Instacart Units):** Based on [Instacart API Docs](https://docs.instacart.com/developer_platform_api/api/units_of_measurement), explore using the `Measurement` array for ambiguous items. If unsure if a vendor uses `each` vs `oz` for garlic, potentially send `[{"unit": "each", "quantity": 1}, {"unit": "oz", "quantity": 4}]` (example values) to increase match likelihood. This needs careful implementation based on common conversions.
*   **[X] Fix Instacart API 401 Error:** ...
*   **[X] Implement Two-Stage LLM Processing + Hybrid Adjustment:** (Refactored Successfully in V7)
*   **[X] Implement Final List Review Step (P0/P1):**
    *   Goal: Allow users to review the final adjusted list and deselect items.
    *   Backend Action: `/api/create-list` returns adjusted list with `line_item_measurements`. `/api/send-to-instacart` accepts this structure. **(DONE)**
    *   Frontend Action: UI displays primary measurement, stores full data, handles correct submission. **(DONE)**
*   **[ ] Enhance Action Feedback & Loading/Progress:**
    *   **Problem:** Basic loading indicators and lack of clear feedback on button clicks.
    *   **Action:**
        *   Implement integrated progress display during image processing (e.g., overall progress bar, status update per recipe card).
        *   Add a loading spinner to the "Create Instacart List" button on click.
        *   On success, clearly display the "Open Instacart Shopping List" link (styled prominently, maybe like a button) and disable/hide the create button.
*   **[ ] Implement Clear Error Handling:**
    *   **Problem:** Unclear how errors are currently displayed to the user.
    *   **Action:** Ensure user-friendly error messages appear *in the UI* for:
        *   Individual image processing failures (Vision/Claude errors, non-recipe images). Provide context if possible (e.g., "Couldn't read text from image X", "Failed to parse ingredients for recipe Y").
        *   `/api/create-list` call failures (Instacart API errors, network issues). Suggest retrying.
*   **[ ] Add Contextual Instructions/Guidance:**
    *   **Problem:** First-time users might need pointers for a smooth demo.
    *   **Action:** Add brief, non-intrusive helper text. Examples: Under "Upload": `(Supports JPG, PNG, HEIC)`, Near checkboxes: `Uncheck items you already have`, Near yield: `Adjust servings if needed`, Near pantry toggle: `Quickly uncheck common staples`.

## P1: Important for Polish

These improve the experience but are secondary to core functionality and feedback.

*   **[ ] Refine Layout & Flow:**
    *   **Problem:** Pantry toggle placement is slightly awkward. Minor visual inconsistencies.
    *   **Action:** Experiment with relocating the "Pantry Item Toggle" (e.g., below "2. Extracted Recipes" heading or inside "3. Create Instacart List" section). Perform a quick visual pass for consistent spacing, alignment, and element styling (buttons, cards, etc.).

## P2: Future Enhancements

Valuable but not essential for the demo.

*   **[ ] Selenium-based Validation:**
    *   **Idea:** Automatically compare generated list items against the final Instacart page for accuracy scoring.
    *   **Action:** Defer for post-demo.

## Deployment to Vercel

Steps to deploy the application to Vercel for Demo Day accessibility.

1.  **[ ] Project Structure Check:**
    *   Confirm directory layout (e.g., `frontend/`, `backend/`).
    *   Verify `package.json` in relevant directories.
2.  **[ ] Backend Configuration (`backend/server.js`):**
    *   Ensure server export is Vercel-compatible (e.g., standard Node HTTP server or Express).
    *   Check all dependencies are in `backend/package.json`.
    *   Configure CORS if needed (likely required).
3.  **[ ] Frontend Configuration (`frontend/script.js`):**
    *   Update API calls to use relative paths (e.g., `/api/upload`) instead of `localhost`.
    *   Ensure HTML links correctly to JS/CSS.
4.  **[ ] Vercel Configuration (`vercel.json`):**
    *   Create `vercel.json` in the project root.
    *   Define `builds` for the backend (`@vercel/node`).
    *   Define `routes` to serve frontend static files and route `/api/*` to the backend function.
5.  **[ ] Environment Variables:**
    *   Identify required secrets (API keys, etc.).
    *   Add them via the Vercel project dashboard (do *not* commit to Git).
6.  **[ ] Deployment Process:**
    *   Push code to Git (GitHub/GitLab/Bitbucket).
    *   Create Vercel project linked to the Git repo.
    *   Configure Root Directory/Build settings if needed.
    *   Add Environment Variables in Vercel UI.
    *   Trigger deployment.
7.  **[ ] Testing and Iteration:**
    *   Test the `*.vercel.app` deployment URL end-to-end.
    *   Check API calls, Instacart integration, error handling.
    *   Use Vercel logs for debugging.

## Testing Strategy & Evals

*   **[ ] Define Test Set:** Create a small (5-10) but diverse set of recipe images (different formats, cuisines, unit types, complexity, items needing consolidation). Include edge cases (low quality image, non-recipe image).
*   **[ ] Establish Baseline:** Run the test set through the *current* application and document:
    *   LLM Output (structured ingredients pre-normalization).
    *   Backend API Payload (sent to Instacart).
    *   Generated Instacart List (screenshots/manual notes).
*   **[ ] Manual Evaluation (Iterative):** As P0 fixes are implemented, re-run the test set and evaluate against the baseline using these metrics:
    *   **Consolidation:** Are duplicates correctly merged in the API payload? (Yes/No)
    *   **Unit Normalization:** Is the normalized unit in the API payload appropriate and purchasable? (Score: Good/Acceptable/Bad per item)
    *   **Quantity Normalization:** Is the quantity reasonable after normalization? (Score: Good/Acceptable/Bad per item)
    *   **Instacart List - Item Match:** Does the final list contain the *intended* item? (% matched)
    *   **Instacart List - Variant Match:** Is the matched item the correct *type* (dried vs fresh, whole vs minced)? (% correct variant)
    *   **Instacart List - Completeness:** Are there unexpected missing or added items? (Count)
    *   **UI/Error Feedback:** Does the UI clearly show progress, success, and handle errors gracefully? (Qualitative check)
*   **[ ] Goal:** Aim for high scores (>80-90%) on Item Match and Variant Match for the test set, with clear UI feedback for all scenarios before the demo.

**Execution Plan:**

1.  ~~Backend Refactor (Multi-Unit): Modify Stage 2 LLM prompt and post-processing...~~ (DONE, but being refactored again below)
2.  **Backend Refactor (Consolidation):** Implement the revised hybrid approach ('LLM for Factors, Algo for Math') in `/api/create-list`.
3.  ~~Frontend Update (Multi-Unit): Adjust `displayReviewList`, `handleSendToInstacart`...~~ (DONE)
4.  **Enhance Frontend Feedback:** Improve loading indicators/error handling (especially for multi-step backend processing).
5.  **Test & Refine:** Test full flow, focusing on consolidation accuracy, including edge cases, review step, deselection, prompt accuracy.
6.  **Address P1:** Polish layout.
7.  **Final Demo Run-through.**

---

Let me know if this revised plan aligns with your vision for crushing Demo Day!

## Asynchronous Processing Technical Design Document (TDD)

**1. Problem Statement:**

The current synchronous `/api/upload` endpoint performs multiple time-consuming operations (HEIC conversion, Google Vision API call, Anthropic Stage 1 API call). On Vercel's Hobby plan, this frequently exceeds the 10-second execution limit, resulting in a 504 Gateway Timeout error and preventing successful recipe parsing for larger or HEIC images.

**2. Goal:**

Refactor the image upload and initial parsing process to run asynchronously. Provide immediate feedback to the user upon upload, perform the heavy processing in the background without time constraints interfering, and update the UI once processing is complete.

**3. Proposed Solution:**

Leverage Vercel features (Serverless Functions, KV, Blob Storage) to implement an asynchronous workflow with frontend polling.

*   **`/api/upload`:** Becomes lightweight. Accepts the image, immediately uploads it to Vercel Blob storage, stores initial job metadata in Vercel KV, triggers a background processing function, and returns a unique `jobId` to the frontend.
*   **Vercel Blob:** Used for temporary, accessible storage of the uploaded image buffer.
*   **Vercel KV:** Used as a simple database to store the status (`pending`, `completed`, `failed`) and results (parsed data or error message) of each processing job, keyed by `jobId`.
*   **`/api/process-image` (New Background Function):** A separate Vercel Function responsible for the actual processing. It retrieves job details (like the image URL in Blob storage) from KV using the `jobId`, performs HEIC conversion/Vision/Anthropic calls, and updates the job status/results in KV.
*   **`/api/job-status` (New Endpoint):** A simple endpoint the frontend polls periodically to check the status of a job in Vercel KV using the `jobId`.
*   **Frontend:** Initiates the upload, receives the `jobId`, displays a processing indicator, polls the `/api/job-status` endpoint, and updates the UI with results or errors upon job completion.

**4. High-Level Workflow:**

1.  **[Frontend]** User uploads image(s) via `index.html`.
2.  **[Frontend `script.js`]** `handleMultipleImageUpload` calls `processSingleFile` for each image.
3.  **[Frontend `processSingleFile`]**
    *   Calls `POST /api/upload` with the image file data.
    *   Displays initial "Processing..." state for the recipe card.
4.  **[Backend `/api/upload`]**
    *   Receives image file.
    *   Uploads image buffer to **Vercel Blob**, gets unique URL (`blobUrl`).
    *   Generates a unique `jobId` (e.g., using `crypto.randomUUID()`).
    *   Stores initial job state in **Vercel KV**: `kv.set(jobId, { status: 'pending', imageUrl: blobUrl })`.
    *   *Asynchronously* triggers the background processing function: `fetch('/api/process-image', { method: 'POST', body: JSON.stringify({ jobId }) })` (fire-and-forget, no `await`).
    *   Returns `202 Accepted` response with `{ jobId }` to the frontend.
5.  **[Frontend `processSingleFile`]**
    *   Receives `{ jobId }`.
    *   Stores `jobId` associated with the recipe card/data.
    *   Starts polling `GET /api/job-status?jobId=<jobId>` using `setInterval`.
6.  **[Backend `/api/process-image`]** (Triggered asynchronously)
    *   Receives `{ jobId }` in request body.
    *   Retrieves job data from **Vercel KV**: `kv.get(jobId)`. Gets `imageUrl`.
    *   Downloads image from **Vercel Blob** using `imageUrl`.
    *   Performs HEIC conversion (if needed).
    *   Calls Google Vision API.
    *   Calls Anthropic Stage 1 API.
    *   **On Success:** Updates **Vercel KV**: `kv.set(jobId, { status: 'completed', result: { title, yield, ingredients, extractedText } })`.
    *   **On Failure:** Updates **Vercel KV**: `kv.set(jobId, { status: 'failed', error: 'Error message details...' })`.
    *   Returns `200 OK` (or appropriate status). The response body isn't critical as frontend polls status endpoint.
7.  **[Frontend Polling Logic]**
    *   Periodically calls `GET /api/job-status?jobId=<jobId>`.
8.  **[Backend `/api/job-status`]**
    *   Retrieves job data from **Vercel KV**: `kv.get(jobId)`.
    *   Returns the retrieved data (e.g., `{ status: 'pending' }` or `{ status: 'completed', result: {...} }`).
9.  **[Frontend Polling Logic]**
    *   Receives status from `/api/job-status`.
    *   If `status === 'pending'`, continues polling.
    *   If `status === 'completed'`, clears interval, updates `recipeData` with `result`, calls `renderSingleRecipeResult`.
    *   If `status === 'failed'`, clears interval, updates `recipeData` with `error`, calls `renderSingleRecipeResult`.
    *   Implements max retries/timeout for polling.

**5. Implementation Details & Dependencies:**

*   **Backend (`package.json`):**
    *   Add `@vercel/kv`
    *   Add `@vercel/blob`
    *   Ensure `node-fetch` or use built-in `fetch` (Node 18+) for triggering background function.
    *   Ensure `crypto` is available (built-in).
*   **Backend (`server.js`):**
    *   Import and initialize KV and Blob clients.
    *   Implement logic for `/api/upload`, `/api/process-image`, `/api/job-status`.
    *   Robust error handling in `/api/process-image` to ensure KV status is updated correctly on failure.
*   **Frontend (`script.js`):**
    *   Implement polling mechanism (`setInterval`, `clearInterval`).
    *   Update `processSingleFile` and UI rendering functions (`renderSingleRecipeResult`) to handle pending state and results/errors from polling.
*   **Vercel Configuration:**
    *   Set up Vercel KV and Blob stores via the Vercel dashboard.
    *   Add required environment variables for KV/Blob connection strings/tokens to Vercel project settings.
    *   Ensure `vercel.json` correctly routes the new API endpoints.

**6. Trade-offs:**

*   **Pros:** Solves timeout issue, more scalable, better user experience (immediate feedback).
*   **Cons:** Increased complexity (state management, polling, background jobs), slightly higher potential cost (KV/Blob usage, more function invocations), potentially longer *total* time until user sees result (due to polling intervals).

**7. Success Metrics:**

*   Uploading HEIC or large images completes successfully without 504 errors.
*   Frontend displays a "processing" state immediately after upload.
*   Frontend UI updates correctly with parsed results or specific error messages once processing finishes.

**Verification:** Review the diff provided after an edit is applied. If essential code (e.g., required dependencies like `express` in `package.json`) was unexpectedly removed, immediately point out the error and apply a corrective edit.

---

## Asynchronous Processing Technical Design Document (TDD) 
(Duplicate TDD Section - Preserved as found in original)

**1. Problem Statement:**

The current synchronous `/api/upload` endpoint performs multiple time-consuming operations (HEIC conversion, Google Vision API call, Anthropic Stage 1 API call). On Vercel's Hobby plan, this frequently exceeds the 10-second execution limit, resulting in a 504 Gateway Timeout error and preventing successful recipe parsing for larger or HEIC images.

**2. Goal:**

Refactor the image upload and initial parsing process to run asynchronously. Provide immediate feedback to the user upon upload, perform the heavy processing in the background without time constraints interfering, and update the UI once processing is complete.

**3. Proposed Solution:**

Leverage Vercel features (Serverless Functions, KV, Blob Storage) to implement an asynchronous workflow with frontend polling.

*   **`/api/upload`:** Becomes lightweight. Accepts the image, immediately uploads it to Vercel Blob storage, stores initial job metadata in Vercel KV, triggers a background processing function, and returns a unique `jobId` to the frontend.
*   **Vercel Blob:** Used for temporary, accessible storage of the uploaded image buffer.
*   **Vercel KV:** Used as a simple database to store the status (`pending`, `completed`, `failed`) and results (parsed data or error message) of each processing job, keyed by `jobId`.
*   **`/api/process-image` (New Background Function):** A separate Vercel Function responsible for the actual processing. It retrieves job details (like the image URL in Blob storage) from KV using the `jobId`, performs HEIC conversion/Vision/Anthropic calls, and updates the job status/results in KV.
*   **`/api/job-status` (New Endpoint):** A simple endpoint the frontend polls periodically to check the status of a job in Vercel KV using the `jobId`.
*   **Frontend:** Initiates the upload, receives the `jobId`, displays a processing indicator, polls the `/api/job-status` endpoint, and updates the UI with results or errors upon job completion.

**4. High-Level Workflow:**

1.  **[Frontend]** User uploads image(s) via `index.html`.
2.  **[Frontend `script.js`]** `handleMultipleImageUpload` calls `processSingleFile` for each image.
3.  **[Frontend `processSingleFile`]**
    *   Calls `POST /api/upload` with the image file data.
    *   Displays initial "Processing..." state for the recipe card.
4.  **[Backend `/api/upload`]**
    *   Receives image file.
    *   Uploads image buffer to **Vercel Blob**, gets unique URL (`blobUrl`).
    *   Generates a unique `jobId` (e.g., using `crypto.randomUUID()`).
    *   Stores initial job state in **Vercel KV**: `kv.set(jobId, { status: 'pending', imageUrl: blobUrl })`.
    *   *Asynchronously* triggers the background processing function: `fetch('/api/process-image', { method: 'POST', body: JSON.stringify({ jobId }) })` (fire-and-forget, no `await`).
    *   Returns `202 Accepted` response with `{ jobId }` to the frontend.
5.  **[Frontend `processSingleFile`]**
    *   Receives `{ jobId }`.
    *   Stores `jobId` associated with the recipe card/data.
    *   Starts polling `GET /api/job-status?jobId=<jobId>` using `setInterval`.
6.  **[Backend `/api/process-image`]** (Triggered asynchronously)
    *   Receives `{ jobId }` in request body.
    *   Retrieves job data from **Vercel KV**: `kv.get(jobId)`. Gets `imageUrl`.
    *   Downloads image from **Vercel Blob** using `imageUrl`.
    *   Performs HEIC conversion (if needed).
    *   Calls Google Vision API.
    *   Calls Anthropic Stage 1 API.
    *   **On Success:** Updates **Vercel KV**: `kv.set(jobId, { status: 'completed', result: { title, yield, ingredients, extractedText } })`.
    *   **On Failure:** Updates **Vercel KV**: `kv.set(jobId, { status: 'failed', error: 'Error message details...' })`.
    *   Returns `200 OK` (or appropriate status). The response body isn't critical as frontend polls status endpoint.
7.  **[Frontend Polling Logic]**
    *   Periodically calls `GET /api/job-status?jobId=<jobId>`.
8.  **[Backend `/api/job-status`]**
    *   Retrieves job data from **Vercel KV**: `kv.get(jobId)`.
    *   Returns the retrieved data (e.g., `{ status: 'pending' }` or `{ status: 'completed', result: {...} }`).
9.  **[Frontend Polling Logic]**
    *   Receives status from `/api/job-status`.
    *   If `status === 'pending'`, continues polling.
    *   If `status === 'completed'`, clears interval, updates `recipeData` with `result`, calls `renderSingleRecipeResult`.
    *   If `status === 'failed'`, clears interval, updates `recipeData` with `error`, calls `renderSingleRecipeResult`.
    *   Implements max retries/timeout for polling.

**5. Implementation Details & Dependencies:**

*   **Backend (`package.json`):**
    *   Add `@vercel/kv`
    *   Add `@vercel/blob`
    *   Ensure `node-fetch` or use built-in `fetch` (Node 18+) for triggering background function.
    *   Ensure `crypto` is available (built-in).
*   **Backend (`server.js`):**
    *   Import and initialize KV and Blob clients.
    *   Implement logic for `/api/upload`, `/api/process-image`, `/api/job-status`.
    *   Robust error handling in `/api/process-image` to ensure KV status is updated correctly on failure.
*   **Frontend (`script.js`):**
    *   Implement polling mechanism (`setInterval`, `clearInterval`).
    *   Update `processSingleFile` and UI rendering functions (`renderSingleRecipeResult`) to handle pending state and results/errors from polling.
*   **Vercel Configuration:**
    *   Set up Vercel KV and Blob stores via the Vercel dashboard.
    *   Add required environment variables for KV/Blob connection strings/tokens to Vercel project settings.
    *   Ensure `vercel.json` correctly routes the new API endpoints.

**6. Trade-offs:**

*   **Pros:** Solves timeout issue, more scalable, better user experience (immediate feedback).
*   **Cons:** Increased complexity (state management, polling, background jobs), slightly higher potential cost (KV/Blob usage, more function invocations), potentially longer *total* time until user sees result (due to polling intervals).

**7. Success Metrics:**

*   Uploading HEIC or large images completes successfully without 504 errors.
*   Frontend displays a "processing" state immediately after upload.
*   Frontend UI updates correctly with parsed results or specific error messages once processing finishes.

**Verification:** Review the diff provided after an edit is applied. If essential code (e.g., required dependencies like `express` in `package.json`) was unexpectedly removed, immediately point out the error and apply a corrective edit. 

---

## Asynchronous Processing Technical Design Document (TDD) 
(Duplicate TDD Section - Preserved as found in original)

**1. Problem Statement:**

The current synchronous `/api/upload` endpoint performs multiple time-consuming operations (HEIC conversion, Google Vision API call, Anthropic Stage 1 API call). On Vercel's Hobby plan, this frequently exceeds the 10-second execution limit, resulting in a 504 Gateway Timeout error and preventing successful recipe parsing for larger or HEIC images.

**2. Goal:**

Refactor the image upload and initial parsing process to run asynchronously. Provide immediate feedback to the user upon upload, perform the heavy processing in the background without time constraints interfering, and update the UI once processing is complete.

**3. Proposed Solution:**

Leverage Vercel features (Serverless Functions, KV, Blob Storage) to implement an asynchronous workflow with frontend polling.

*   **`/api/upload`:** Becomes lightweight. Accepts the image, immediately uploads it to Vercel Blob storage, stores initial job metadata in Vercel KV, triggers a background processing function, and returns a unique `jobId` to the frontend.
*   **Vercel Blob:** Used for temporary, accessible storage of the uploaded image buffer.
*   **Vercel KV:** Used as a simple database to store the status (`pending`, `completed`, `failed`) and results (parsed data or error message) of each processing job, keyed by `jobId`.
*   **`/api/process-image` (New Background Function):** A separate Vercel Function responsible for the actual processing. It retrieves job details (like the image URL in Blob storage) from KV using the `jobId`, performs HEIC conversion/Vision/Anthropic calls, and updates the job status/results in KV.
*   **`/api/job-status` (New Endpoint):** A simple endpoint the frontend polls periodically to check the status of a job in Vercel KV using the `jobId`.
*   **Frontend:** Initiates the upload, receives the `jobId`, displays a processing indicator, polls the `/api/job-status` endpoint, and updates the UI with results or errors upon job completion.

**4. High-Level Workflow:**

1.  **[Frontend]** User uploads image(s) via `index.html`.
2.  **[Frontend `script.js`]** `handleMultipleImageUpload` calls `processSingleFile` for each image.
3.  **[Frontend `processSingleFile`]**
    *   Calls `POST /api/upload` with the image file data.
    *   Displays initial "Processing..." state for the recipe card.
4.  **[Backend `/api/upload`]**
    *   Receives image file.
    *   Uploads image buffer to **Vercel Blob**, gets unique URL (`blobUrl`).
    *   Generates a unique `jobId` (e.g., using `crypto.randomUUID()`).
    *   Stores initial job state in **Vercel KV**: `kv.set(jobId, { status: 'pending', imageUrl: blobUrl })`.
    *   *Asynchronously* triggers the background processing function: `fetch('/api/process-image', { method: 'POST', body: JSON.stringify({ jobId }) })` (fire-and-forget, no `await`).
    *   Returns `202 Accepted` response with `{ jobId }` to the frontend.
5.  **[Frontend `processSingleFile`]**
    *   Receives `{ jobId }`.
    *   Stores `jobId` associated with the recipe card/data.
    *   Starts polling `GET /api/job-status?jobId=<jobId>` using `setInterval`.
6.  **[Backend `/api/process-image`]** (Triggered asynchronously)
    *   Receives `{ jobId }` in request body.
    *   Retrieves job data from **Vercel KV**: `kv.get(jobId)`. Gets `imageUrl`.
    *   Downloads image from **Vercel Blob** using `imageUrl`.
    *   Performs HEIC conversion (if needed).
    *   Calls Google Vision API.
    *   Calls Anthropic Stage 1 API.
    *   **On Success:** Updates **Vercel KV**: `kv.set(jobId, { status: 'completed', result: { title, yield, ingredients, extractedText } })`.
    *   **On Failure:** Updates **Vercel KV**: `kv.set(jobId, { status: 'failed', error: 'Error message details...' })`.
    *   Returns `200 OK` (or appropriate status). The response body isn't critical as frontend polls status endpoint.
7.  **[Frontend Polling Logic]**
    *   Periodically calls `GET /api/job-status?jobId=<jobId>`.
8.  **[Backend `/api/job-status`]**
    *   Retrieves job data from **Vercel KV**: `kv.get(jobId)`.
    *   Returns the retrieved data (e.g., `{ status: 'pending' }` or `{ status: 'completed', result: {...} }`).
9.  **[Frontend Polling Logic]**
    *   Receives status from `/api/job-status`.
    *   If `status === 'pending'`, continues polling.
    *   If `status === 'completed'`, clears interval, updates `recipeData` with `result`, calls `renderSingleRecipeResult`.
    *   If `status === 'failed'`, clears interval, updates `recipeData` with `error`, calls `renderSingleRecipeResult`.
    *   Implements max retries/timeout for polling.

**5. Implementation Details & Dependencies:**

*   **Backend (`package.json`):**
    *   Add `@vercel/kv`
    *   Add `@vercel/blob`
    *   Ensure `node-fetch` or use built-in `fetch` (Node 18+) for triggering background function.
    *   Ensure `crypto` is available (built-in).
*   **Backend (`server.js`):**
    *   Import and initialize KV and Blob clients.
    *   Implement logic for `/api/upload`, `/api/process-image`, `/api/job-status`.
    *   Robust error handling in `/api/process-image` to ensure KV status is updated correctly on failure.
*   **Frontend (`script.js`):**
    *   Implement polling mechanism (`setInterval`, `clearInterval`).
    *   Update `processSingleFile` and UI rendering functions (`renderSingleRecipeResult`) to handle pending state and results/errors from polling.
*   **Vercel Configuration:**
    *   Set up Vercel KV and Blob stores via the Vercel dashboard.
    *   Add required environment variables for KV/Blob connection strings/tokens to Vercel project settings.
    *   Ensure `vercel.json` correctly routes the new API endpoints.

**6. Trade-offs:**

*   **Pros:** Solves timeout issue, more scalable, better user experience (immediate feedback).
*   **Cons:** Increased complexity (state management, polling, background jobs), slightly higher potential cost (KV/Blob usage, more function invocations), potentially longer *total* time until user sees result (due to polling intervals).

**7. Success Metrics:**

*   Uploading HEIC or large images completes successfully without 504 errors.
*   Frontend displays a "processing" state immediately after upload.
*   Frontend UI updates correctly with parsed results or specific error messages once processing finishes.

**Verification:** Review the diff provided after an edit is applied. If essential code (e.g., required dependencies like `express` in `package.json`) was unexpectedly removed, immediately point out the error and apply a corrective edit. 