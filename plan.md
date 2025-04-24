# Demo Day Prep Plan

**Goal:** Ensure the Recipe-to-Cart app is accurate, intuitive, and polished for the Demo Day presentation. The core functionality (recipe -> accurate cart) must be reliable.

## P0: Must-Haves for Demo

These issues directly impact the core value proposition or the demo user experience and MUST be addressed.

*   **[NEW - P0] Migrate Image->Text Trigger to QStash:**
    *   **Problem:** The current asynchronous trigger (`fetchWithRetry` from `/api/process-image` to `/api/process-text`) is unreliable. Logs show the trigger sometimes fails silently without invoking `/api/process-text`, likely due to cold starts or platform issues, leaving jobs stuck in `vision_completed`. Direct HTTP calls lack guaranteed delivery and robust retry mechanisms needed for this workflow.
    *   **Goal:** Replace the direct `fetch` trigger with Upstash QStash for guaranteed, reliable delivery of the job trigger from the image processing step to the text processing step.
    *   **Solution: Decouple with QStash Message Queue:**
        1.  **Dependencies:** Add `@upstash/qstash` to `backend/package.json`.
        2.  **Environment Variables:** Add `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` to Vercel environment variables. Obtain these from the Upstash console. Document `QSTASH_URL` (the target URL for publishing messages) if needed.
        3.  **Modify Caller (`/api/process-image`):**
            *   Import and initialize the QStash client (`@upstash/qstash`).
            *   After successfully saving the `vision_completed` status to Redis, instead of calling `fetchWithRetry`, use `qstashClient.publishJSON()` to send the `{ jobId }` payload to a designated QStash URL/topic. This URL will point to the new worker endpoint (Step 4).
            *   Remove the `fetchWithRetry` helper function and associated `.catch` logic specific to the fetch trigger failure within `processImageController.js`.
        4.  **Create New Worker (`/api/process-text-worker`):**
            *   Create a new controller `backend/controllers/processTextWorkerController.js` and route `backend/routes/processTextWorkerRoutes.js`.
            *   Move the *entire* core logic from the existing `/api/process-text` function (fetch job from Redis, call Anthropic w/ retry, parse, update Redis status to 'completed' or 'failed') into the new worker controller.
            *   The worker function will be triggered by POST requests from QStash, receiving the `{ jobId }` in the request body.
        5.  **Implement QStash Signature Verification:**
            *   In the new `/api/process-text-worker` route/controller, use the QStash SDK's verification middleware (`verifySignature`) *before* executing any logic. This validates the `Upstash-Signature` header sent by QStash, ensuring requests are legitimate. Reject requests failing verification with a 401/403 status.
        6.  **Configure QStash:** In the Upstash Console:
            *   Create a QStash URL/topic.
            *   Configure the target URL to point to the deployed Vercel URL for `/api/process-text-worker`.
            *   Configure a suitable retry policy (e.g., exponential backoff, 3-5 retries) for failed deliveries.
        7.  **Cleanup:**
            *   Remove the old `/api/process-text` route and controller (`processTextController.js`, `processTextRoutes.js`) as they are no longer triggered by the image flow.
        8.  **Testing:** Perform end-to-end testing for image uploads. Verify:
            *   `/api/process-image` logs successful publishing to QStash.
            *   `/api/process-text-worker` logs successful invocation, signature verification, processing, and completion.
            *   Check the Upstash console for message delivery status (success/retries/failures).
            *   Confirm the frontend UI updates correctly based on polling `/api/job-status`.
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
                *   **Robust Parsing (DONE):** Implemented multi-stage parsing (regex, manual strip, raw parse, first bracket/brace) to handle LLM preambles and slightly malformed responses.
                *   **Max Tokens (DONE):** Increased `max_tokens` in the `callAnthropic` helper to `4096` to prevent truncation of large JSON responses.
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
*   **[X] Implement Asynchronous Image Processing:** Solved Vercel timeout issues using Vercel Blob, KV (Redis), and chained background functions (`/api/upload` -> `/api/process-image` -> `/api/process-text`).
*   **[ ] Address Stuck Processing (`vision_completed` state):** (Superseded by QStash migration for the trigger failure aspect. UX improvement for handling timeouts still relevant).
    *   **Problem:** Occasionally, jobs get stuck in the `vision_completed` status and never proceed to the `/api/process-text` step (Anthropic analysis) or time out gracefully. The frontend polling eventually shows a generic timeout error, but the root cause seems to be the silent failure of the trigger between the two background functions.
    *   **Investigation (DONE):** Added detailed logging. Confirmed that the `fetch` from `/api/process-image` to `/api/process-text` sometimes dispatches successfully but fails to invoke the target function *without* triggering the `.catch()` block. The job remains `vision_completed` in Redis.
    *   **Action 1 (Mitigation - DONE):** Implemented a frontend timeout (`POLLING_TIMEOUT_MS = 60000`) in `frontend/script.js`. If polling detects the job hasn't progressed after 60s, it stops polling and displays a specific error message ("Recipe analysis timed out..." if last status was `vision_completed`, generic timeout otherwise).
    *   **Action 2 (QStash Migration - TODO):** Implement the QStash migration described above to fix the root cause of the trigger failure.
    *   **Action 3 (Required UX Improvement - TODO):** Currently, a timeout affects the whole batch. **Need to allow users to dismiss/remove *only* the specific recipe card that timed out** and potentially re-upload just that image, without clearing other successful results in the session. This likely involves:
        *   Adding a 'close' or 'retry' button to the recipe card when it displays the timeout error.
        *   Modifying `processSingleFile` or adding a new function to handle re-uploading for a specific card ID.
        *   Ensuring `handleReviewList` correctly ignores dismissed/failed cards.
*   **[X] Enhance Action Feedback & Loading/Progress:**
    *   **Problem:** Basic loading indicators and lack of clear feedback on button clicks. Internal state names exposed. Attempt counts shown.
    *   **Action:**
        *   Implement integrated progress display during image processing (e.g., overall progress bar, status update per recipe card). (Deferred)
        *   **[X] Improve Status Messages:** In `frontend/script.js`, mapped internal job statuses (`pending`, `vision_completed`) to user-friendly text ("Processing image...", "Analyzing ingredients...").
        *   **[X] Hide Attempt Counter:** Removed the "(Attempt X)" display from the frontend processing messages.
        *   Add a loading spinner to the "Create Instacart List" button on click.
        *   On success, clearly display the "Open Instacart Shopping List" link (styled prominently, maybe like a button) and disable/hide the create button.
*   **[X] Implement Clear Error Handling:**
    *   **Problem:** Unclear how errors are currently displayed to the user. Need to leverage improved backend error messages.
    *   **Action:** Ensure user-friendly error messages appear *in the UI* for:
        *   Individual image processing failures (Vision/Claude errors, non-recipe images). Retrieve the user-friendly error message from the `jobData.error` field provided by `/api/job-status` when `jobData.status === 'failed'`. **(DONE via polling)**
        *   Frontend timeout errors (specific message if stuck after vision step). **(DONE via timeout logic)**
        *   `/api/create-list` call failures (Instacart API errors, network issues). Suggest retrying.
*   **[X] Add Contextual Instructions/Guidance:**
    *   **Problem:** First-time users might need pointers for a smooth demo. Pantry text is slightly confusing.
    *   **Action:**
        *   **[X] Simplify Pantry Text:** In `frontend/index.html`, changed the label for "I have commonly found pantry items..." to remove the explanatory text.
        *   Add brief, non-intrusive helper text. Examples: Under "Upload": `(Supports JPG, PNG, HEIC)`, Near checkboxes: `Uncheck items you already have`, Near yield: `Adjust servings if needed`.
*   **[X] Interaction & Feedback: Button Labels & Calls-to-Action:**
    *   Review all button labels for clarity and action-orientation (e.g., "Add URL" vs. "Process Recipe URL", "Review Final List" vs. "Consolidate & Review").
*   **[X] Interaction & Feedback: Input Handling (URL):**
    *   Add frontend logic to automatically prepend `https://` if protocol is missing.
    *   Provide clear, immediate feedback if the format is invalid.
*   **[ ] Interaction & Feedback: Processing Feedback:**
    *   Review and enhance visual feedback during image upload/URL processing (e.g., consistent spinners within cards, clearer status messages beyond just the internal state names).
*   **[ ] Interaction & Feedback: Success/Error States:**
    *   Ensure success messages (e.g., "Ingredients extracted!") and error messages are clearly displayed within the context of the specific recipe card/action.
    *   **[ ] Improve Specific Error Message (URL Fallback):** Rephrase backend error "Fallback extraction failed..." to be more user-friendly (e.g., "No recipe found at [URL]...").
*   **[ ] Interaction & Feedback: Ingredient Deselection:**
    *   Verify that the checkboxes for deselecting ingredients in the "Extracted Recipes" section are easily visible and usable.
*   **[ ] Visual Design: Color Scheme:**
    *   Define and apply a simple, cohesive color scheme (e.g., primary action color, background/accent colors).
*   **[ ] Visual Design: Spacing & Padding:**
    *   Apply consistent padding/margins around sections, cards, and buttons for better visual separation.
*   **[ ] Visual Design: Typography:**
    *   Select and apply a clean, readable font pairing for headings and body text.
*   **[ ] Layout & Hierarchy: Logical Flow:**
    *   Review the overall step-by-step flow (Upload/URL -> Review -> Final List) to ensure it feels intuitive.
*   **[ ] Interaction & Feedback: Placeholder Text:**
    *   Add helpful placeholder text to the URL input field.
*   **[ ] Responsive Design: Basic Check:**
    *   Quickly check layout on a simulated mobile viewport to ensure major elements are usable and text is legible.
*   **[ ] Visual Design: Subtle Enhancements (Lower Priority):**
    *   Consider adding subtle background textures or gradients if time permits.
    *   Consider adding simple icons (e.g., upload, URL, checkmark, error) if time permits.

## P1: Important for Polish

These improve the experience but are secondary to core functionality and feedback.

*   **[ ] Refine Layout & Flow:**
    *   **Problem:** Pantry toggle placement is slightly awkward. Minor visual inconsistencies.
    *   **Action:** Experiment with relocating the "Pantry Item Toggle" (e.g., below "2. Extracted Recipes" heading or inside "3. Create Instacart List" section). Perform a quick visual pass for consistent spacing, alignment, and element styling (buttons, cards, etc.).
*   **[ ] Refactor Backend (`backend/server.js`) for Modularity (P1):**
    *   **Problem:** The `server.js` file is excessively long (1600+ lines), mixing routing, business logic, external API calls, and utility functions, hindering maintainability and testing.
    *   **Refactoring Checklist & Status:**
        *   **Dependencies (`require` statements):**
            *   `[X] dotenv`: (`server.js` or config file) - Assumed still needed in main server file.
            *   `[X] express`: (`server.js`, `routes/*`) - Present in routes.
            *   `[X] cors`: (`server.js`) - Likely stays in main server file.
            *   `[X] multer`: (`server.js`, `routes/uploadRoutes.js`) - Used in upload route.
            *   `[X] google-auth-library`: (Handled implicitly by `@google-cloud/vision`) - Implicitly handled.
            *   `[X] @google-cloud/vision`: (`services/googleVisionService.js`) - Service exists.
            *   `[X] @anthropic-ai/sdk`: (`services/anthropicService.js`) - Service exists.
            *   `[X] axios`: (`services/instacartService.js`) - Used in Instacart service.
            *   `[X] heic-convert`: (`controllers/processImageController.js`) - Required in controller.
            *   `[X] @vercel/blob`: (`controllers/uploadController.js`) - Required in upload controller.
            *   `[X] crypto`: (Used across controllers/utils) - Standard Node module.
            *   `[X] @vercel/kv`: (`services/kvService.js`, `controllers/*`) - Service exists, used in controllers.
            *   `[X] jsdom`: (`controllers/urlJobController.js`) - Required in controller.
            *   `[X] @mozilla/readability`: (`controllers/urlJobController.js`) - Required in controller.
            *   `[X] cheerio`: (`utils/recipeParser.js`, `controllers/urlJobController.js`) - Required in utils and controller.
            *   `[X] @upstash/redis`: (`services/redisService.js`, `controllers/*`) - Service exists, used in controllers.
        *   **Initializations:**
            *   `[X] Upstash Redis Client (`redis`)`: (`services/redisService.js` -> imported) - Service exists.
            *   `[X] Vercel KV Client (`kvClient`)`: (`services/kvService.js` -> imported) - Service exists (handles mock logic).
            *   `[X] Anthropic Client (`anthropic`)`: (`services/anthropicService.js` -> imported) - Service exists.
            *   `[X] Express App (`app`)`: (`server.js`) - Stays in main server file.
            *   `[X] Multer Middleware (`upload`)`: (`server.js`, `routes/uploadRoutes.js`) - Defined in server, used in route.
            *   `[X] Google Vision Client (`visionClient`)`: (`services/googleVisionService.js` -> imported) - Service exists.
        *   **Middleware Setup:**
            *   `[X] cors()`: (`server.js`) - Stays in main server file.
            *   `[X] express.json()`: (`server.js`) - Stays in main server file.
            *   `[X] express.urlencoded()`: (`server.js`) - Stays in main server file.
        *   **Helper Functions:**
            *   `[X] callAnthropic()`: (`services/anthropicService.js` -> imported) - Service exists.
            *   `[X] updateJobStatus()`: (`services/kvService.js` -> imported, Redis direct updates) - KV helper exists, Redis logic in controllers.
            *   `[X] parseAndCorrectJson()`: (`utils/jsonUtils.js` -> imported) - Utils file exists.
            *   `[X] simpleNormalize()`: (Logic moved to `controllers/listController.js`) - Logic exists within controller.
            *   `[X] parseYieldString()`: (Copied to `controllers/urlJobController.js`) - Present within controller.
            *   `[X] findRecipe()` (nested within `/api/process-url-job`): (`controllers/urlJobController.js`) - Present within controller.
        *   **Route Handlers (Controller Logic):**
            *   `[X] POST /api/upload` logic: (`controllers/uploadController.js`) - Controller exists.
            *   `[X] POST /api/process-image` logic: (`controllers/processImageController.js`) - Controller exists.
            *   `[X] GET /api/job-status` logic: (`controllers/jobStatusController.js`) - Controller exists.
            *   `[X] POST /api/create-list` logic: (`controllers/listController.js`) - Controller exists.
            *   `[X] POST /api/send-to-instacart` logic: (`controllers/instacartController.js`) - Controller exists.
            *   `[X] POST /api/process-text` logic: (`controllers/processTextController.js`) - Controller exists.
            *   `[X] POST /api/process-url` logic: (`controllers/urlController.js`) - Controller exists.
            *   `[X] POST /api/process-url-job` logic: (`controllers/urlJobController.js`) - Controller exists.
            *   `[X] GET /` logic: (`server.js`) - Stays in main server file.
        *   **Routing Setup (`app.post`, `app.get`):**
            *   `[X] POST /api/upload`: (`routes/uploadRoutes.js`) - Route file exists.
            *   `[X] POST /api/process-image`: (`routes/processImageRoutes.js`) - Route file exists.
            *   `[X] GET /api/job-status`: (`routes/jobStatusRoutes.js`) - Route file exists.
            *   `[X] POST /api/create-list`: (`routes/listRoutes.js`) - Route file exists.
            *   `[X] POST /api/send-to-instacart`: (`routes/instacartRoutes.js`) - Route file exists.
            *   `[X] POST /api/process-text`: (`routes/processTextRoutes.js`) - Route file exists.
            *   `[X] POST /api/process-url`: (`routes/urlRoutes.js`) - Route file exists.
            *   `[X] POST /api/process-url-job`: (`routes/urlJobRoutes.js`) - Route file exists.
            *   `[X] GET /`: (`server.js`) - Stays in main server file.
        *   **Server Start (`app.listen`):**
            *   `[X]` (`server.js`) - Stays in main server file.

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
    *   Identify required secrets (API keys, Redis, Blob, Anthropic, **QStash Tokens**).
    *   Add them via the Vercel project dashboard (do *not* commit to Git).
6.  **[ ] Deployment Process:**
    *   Push code to Git (GitHub/GitLab/Bitbucket).
    *   Create Vercel project linked to the Git repo.
    *   Configure Root Directory/Build settings if needed.
    *   Add Environment Variables in Vercel UI.
    *   Trigger deployment.
7.  **[ ] Testing and Iteration:**
    *   Test the `*.vercel.app` deployment URL end-to-end, **specifically the image upload -> QStash -> worker flow**.
    *   Check API calls, Instacart integration, error handling.
    *   Use Vercel logs and **Upstash QStash console** for debugging.

## Testing Strategy & Evals

*   **[ ] Define Test Set:** Create a small (5-10) but diverse set of recipe images (different formats, cuisines, unit types, complexity, items needing consolidation). Include edge cases (low quality image, non-recipe image).
*   **[ ] Establish Baseline:** Run the test set through the *current* application and document:
    *   LLM Output (structured ingredients pre-normalization).
    *   Backend API Payload (sent to Instacart).
    *   Generated Instacart List (screenshots/manual notes).
*   **[ ] Manual Evaluation (Iterative):** As P0 fixes are implemented, re-run the test set and evaluate against the baseline using these metrics:
    *   **Job Completion:** Does the processing complete successfully via QStash without getting stuck? (Yes/No)
    *   **Consolidation:** Are duplicates correctly merged in the API payload? (Yes/No)
    *   **Unit Normalization:** Is the normalized unit in the API payload appropriate and purchasable? (Score: Good/Acceptable/Bad per item)
    *   **Quantity Normalization:** Is the quantity reasonable after normalization? (Score: Good/Acceptable/Bad per item)
    *   **Instacart List - Item Match:** Does the final list contain the *intended* item? (% matched)
    *   **Instacart List - Variant Match:** Is the matched item the correct *type* (dried vs fresh, whole vs minced)? (% correct variant)
    *   **Instacart List - Completeness:** Are there unexpected missing or added items? (Count)
    *   **UI/Error Feedback:** Does the UI clearly show progress, success, and handle errors gracefully? (Qualitative check)
*   **[ ] Goal:** Aim for **100% job completion** via QStash and high scores (>80-90%) on Item Match and Variant Match for the test set, with clear UI feedback for all scenarios before the demo.

**Execution Plan (Revised):**

1.  **Implement QStash Migration (P0):**
    *   Add dependency.
    *   Configure Env Vars (locally and on Vercel).
    *   Modify `/api/process-image` to publish to QStash.
    *   Create `/api/process-text-worker` (controller/route) with QStash verification and migrated logic.
    *   Configure QStash topic in Upstash Console.
    *   Cleanup old `/api/process-text` endpoint and `fetchWithRetry`.
    *   Test the new flow thoroughly.
2.  **Review & Refine Backend Unit Normalization (P0/P1):** Address herb/wine/other specific normalization issues in `/api/create-list`.
3.  **Implement Individual Timeout Handling (P0 Required UX):** Modify frontend to allow dismissing/retrying single timed-out recipe cards.
4.  **Polish UI/UX (P1):** Simplify pantry text, refine layout. Deploy & Test.
5.  **Final Demo Run-through.**
6.  **Refactor Backend Codebase (P1):** Execute the modularization plan.
7.  **Final Demo Run-through (Post-Refactor).**


---

## P0: UI/UX Polish for Demo Day

**Goal:** Enhance the visual design and user experience based on feedback for a polished demo. Focus on clarity, flow, and feedback.

**Prioritized Checklist:**

*   **[X] Layout & Hierarchy: Section Clarity:**
    *   Clearly differentiate and label "Upload Recipe Image(s)" vs "Paste Recipe URL" inputs.
    *   Organize content into visually distinct sections with clear headings (e.g., "1. Add Recipes", "2. Review Extracted Ingredients", "3. Final Shopping List").
    *   Use visual containers (cards/panels) for each extracted recipe result under "Review Extracted Ingredients".
*   **[X] Layout & Hierarchy: Prominent Actions:**
    *   Ensure the "Review Final List" / "Create Instacart List" button is clearly visible and positioned logically at the end of the main workflow sections.
*   **[X] Interaction & Feedback: Button Labels & Calls-to-Action:**
    *   Review all button labels for clarity and action-orientation (e.g., "Add URL" vs. "Process Recipe URL", "Review Final List" vs. "Consolidate & Review").
*   **[X] Interaction & Feedback: Input Handling (URL):**
    *   Add frontend logic to automatically prepend `https://` if protocol is missing.
    *   Provide clear, immediate feedback if the format is invalid.
*   **[ ] Interaction & Feedback: Processing Feedback:**
    *   Review and enhance visual feedback during image upload/URL processing (e.g., consistent spinners within cards, clearer status messages beyond just the internal state names).
*   **[ ] Interaction & Feedback: Success/Error States:**
    *   Ensure success messages (e.g., "Ingredients extracted!") and error messages are clearly displayed within the context of the specific recipe card/action.
    *   **[ ] Improve Specific Error Message (URL Fallback):** Rephrase backend error "Fallback extraction failed..." to be more user-friendly (e.g., "No recipe found at [URL]...").
*   **[ ] Interaction & Feedback: Ingredient Deselection:**
    *   Verify that the checkboxes for deselecting ingredients in the "Extracted Recipes" section are easily visible and usable.
*   **[ ] Visual Design: Color Scheme:**
    *   Define and apply a simple, cohesive color scheme (e.g., primary action color, background/accent colors).
*   **[ ] Visual Design: Spacing & Padding:**
    *   Apply consistent padding/margins around sections, cards, and buttons for better visual separation.
*   **[ ] Visual Design: Typography:**
    *   Select and apply a clean, readable font pairing for headings and body text.
*   **[ ] Layout & Hierarchy: Logical Flow:**
    *   Review the overall step-by-step flow (Upload/URL -> Review -> Final List) to ensure it feels intuitive.
*   **[ ] Interaction & Feedback: Placeholder Text:**
    *   Add helpful placeholder text to the URL input field.
*   **[ ] Responsive Design: Basic Check:**
    *   Quickly check layout on a simulated mobile viewport to ensure major elements are usable and text is legible.
*   **[ ] Visual Design: Subtle Enhancements (Lower Priority):**
    *   Consider adding subtle background textures or gradients if time permits.
    *   Consider adding simple icons (e.g., upload, URL, checkmark, error) if time permits.

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

## New Feature: URL Recipe Extraction

**Goal:** Allow users to add recipes by pasting URLs from websites, complementing the existing image upload functionality. The extracted recipes should follow the same flow (display, yield adjustment, Instacart list creation).

**Challenges:** Inconsistent website structures, ads, verbose content, client-side rendering, potential login walls.

**Guiding Principles:** Prioritize robustness, user experience, and technical feasibility within the Vercel serverless environment. Avoid heavy server-side browser automation (Puppeteer/Selenium) in the initial phase due to complexity and potential resource limitations.

### Phase 1: MVP - Core URL Extraction [X]

*   **Focus:** Handle common, well-structured recipe websites (especially those using JSON-LD schema) and provide clear errors for unsupported cases (login required, major fetch/parse failures).
*   **Core Idea:** Fetch HTML, attempt structured data extraction (JSON-LD), fall back to cleaning HTML (Readability) and LLM parsing, reusing the existing async job infrastructure.

**Technical Approach:**

1.  **[X] Frontend (`index.html`, `script.js`):
    *   Add URL input field and "Add Recipe from URL" button.
    *   On button click:
        *   Perform basic client-side URL validation.
        *   Display a new recipe card in "Processing URL..." state.
        *   Call new backend endpoint `POST /api/process-url` with `{ url: recipeUrl }`.
        *   Receive `jobId` from backend.
        *   Reuse existing `pollJobStatus(jobId)` and `renderSingleRecipeResult(result)` functions.

2.  **[X] Backend (`server.js`):
    *   **[X] New Endpoint (`/api/process-url` - Trigger):
        *   Input: `{ url }`.
        *   Validate URL.
        *   Generate `jobId`.
        *   Store initial job state in Vercel KV: `{ status: 'pending', inputUrl: url }`.
        *   Asynchronously trigger `/api/process-url-job` via `fetch` with `{ jobId }`.
        *   Return `202 Accepted` with `{ jobId }`.
    *   **[X] New Background Function (`/api/process-url-job` - Worker):
        *   Input: `{ jobId }`.
        *   Retrieve `inputUrl` from KV.
        *   **[X] Step 1: Fetch HTML:** Use `node-fetch` (or similar). Handle errors (non-200, network, wrong content-type). Basic login wall detection (redirect URL, title/content keywords). Update KV with failure if issues arise.
        *   **[X] Step 2: Structured Data Extraction (JSON-LD):
            *   Use `cheerio` to parse HTML.
            *   Search for `<script type="application/ld+json">` containing `@type: Recipe`.
            *   If found, extract `name`, `recipeYield`, `recipeIngredient`.
            *   Parse `recipeYield` into `{ quantity, unit }` object.
            *   Pass `recipeIngredient` strings to a *specialized LLM prompt* for parsing into `{ quantity, unit, name }`.
            *   On success, update KV: `{ status: 'completed', result: { title, yield: { quantity, unit }, ingredients, sourceUrl: inputUrl } }`.
        *   **[X] Step 3: Fallback (Readability + LLM):** If JSON-LD fails/absent:
            *   Use `@mozilla/readability` (with `jsdom`) to extract main article `title` and `content` HTML.
            *   Get `textContent` from the cleaned content.
            *   Use a *different, specialized LLM prompt* optimized for extracting recipe details (title, yield object, ingredients) from unstructured article text.
            *   Parse LLM response.
            *   On success, update KV: `{ status: 'completed', result: { title, yield: { quantity, unit }, ingredients, sourceUrl: inputUrl } }`.
            *   On failure (Readability or LLM), update KV: `{ status: 'failed', error: 'Could not extract recipe details.' }`.
    *   **[X] KV Client Correction:** Ensure `/api/job-status` uses `kvClient` locally.
    *   **[X] New Dependencies:** `jsdom`, `@mozilla/readability`, `cheerio`.

### Phase 2: Handling Client-Side Rendering & Improving Robustness [ ] 

*   **Consider if Phase 1 proves insufficient for key target sites.**
*   **Options (Investigate if needed):**
    1.  **Serverless Headless Browser:** Puppeteer/Playwright (via Vercel functions or external service like Browserless.io) to render JS *before* applying Phase 1 extraction logic. Adds complexity/cost.
    2.  **Third-Party Scraping APIs:** Dedicated services for rendering and extraction. Adds external dependency/cost.

**Implementation Steps (Phase 1):**

1.  [X] Add new dependencies (`jsdom`, `@mozilla/readability`, `cheerio`) to `backend/package.json`.
2.  [X] Implement In-Memory KV Mock for Local Development in `backend/server.js`.
3.  [X] Implement backend endpoints (`/api/process-url`, `/api/process-url-job`) and worker logic, using the (potentially mocked) KV store.
4.  [X] Implement frontend changes (UI elements, JS logic for triggering and polling).
5.  [X] Develop and test specialized LLM prompts for JSON-LD ingredients and fallback text extraction (including yield object).
6.  [X] Thorough testing with diverse URLs (including provided example, JSON-LD sites, non-recipe sites, sites needing login) **both locally and on Vercel**. 