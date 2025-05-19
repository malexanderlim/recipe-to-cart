# Demo Day Prep Plan

**Goal:** Ensure the Recipe-to-Cart app is accurate, intuitive, and polished for the Demo Day presentation. The core functionality (recipe -> accurate cart) must be reliable.

## P0: Must-Haves for Demo

These issues directly impact the core value proposition or the demo user experience and MUST be addressed.

*   **[X] Migrate Image->Text Trigger to QStash:** (Verified complete, including signature verification)
    *   **Problem:** The current asynchronous trigger (`fetchWithRetry` from `/api/process-image` to `/api/process-text`) is unreliable. Logs show the trigger sometimes fails silently without invoking `/api/process-text`, likely due to cold starts or platform issues, leaving jobs stuck in `vision_completed`. Direct HTTP calls lack guaranteed delivery and robust retry mechanisms needed for this workflow.
    *   **Goal:** Replace the direct `fetch` trigger with Upstash QStash for guaranteed, reliable delivery of the job trigger from the image processing step to the text processing step.
    *   **Solution: Decouple with QStash Message Queue:**
        1.  **Dependencies:** Add `@upstash/qstash` to `backend/package.json`. **(DONE)**
        2.  **Environment Variables:** Add `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` to Vercel environment variables. Obtain these from the Upstash console. Document `QSTASH_URL` (the target URL for publishing messages) if needed. **(Assumed DONE in Vercel)**
        3.  **Modify Caller (`/api/process-image`):** Use `qstashClient.publishJSON()` after saving to Redis. **(DONE)**
        4.  **Create New Worker (`/api/process-text-worker`):** Move logic from old `/api/process-text`. **(DONE)**
        5.  **Implement QStash Signature Verification:** Use `Receiver.verify()` middleware in the worker route. **(DONE)**
        6.  **Configure QStash:** Set up topic/URL and retry policy in Upstash Console. **(Assumed DONE in Upstash)**
        7.  **Cleanup:** Remove old `/api/process-text` route/controller. **(DONE)**
        8.  **Testing:** Verify end-to-end flow. **(Partially DONE, confirmed via code review)**
*   **[ ] Fix Vercel Blob Storage Cleanup (Delete on Success):**
    *   **Problem:** Images in Vercel Blob storage are deleted on processing failure or "quick fail" (insufficient text), but NOT after successful Vision API processing and handoff to the next QStash worker (`/api/process-text-worker`). This causes successfully processed images to accumulate, leading to unnecessarily large storage usage.
    *   **Goal:** Ensure that images are deleted from Vercel Blob storage immediately after they have been successfully processed by the Vision API and the job has been successfully published to the next QStash queue.
    *   **Solution:**
        1.  In `backend/controllers/processImageController.js`, within the `try` block where `qstashClient.publishJSON()` is called to trigger `/api/process-text-worker`:
        2.  After a successful `qstashClient.publishJSON()` call, add logic to delete the image from Vercel Blob using `VercelBlobDelete(imageUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });`.
        3.  Wrap this deletion call in its own `try...catch` block to log any deletion errors without failing the overall job if the QStash publish was successful.
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
*   **[X] Responsive Design: Basic Check:**
    *   Quickly check layout on a simulated mobile viewport to ensure major elements are usable and text is legible.
*   **[ ] Visual Design: Subtle Enhancements (Lower Priority):**
    *   Consider adding subtle background textures or gradients if time permits.
    *   Consider adding simple icons (e.g., upload, URL, checkmark, error) if time permits.
*   **[X] Add Further Polish/UX Improvements (Prioritized):**
    *   **[X] 1. Empty State (Section 2):** Add and control visibility of a message when no recipes are present.
    *   **[X] 2. Button Feedback (Active State):** Add `active:` variants to button styles for visual feedback on click.
    *   **[X] 3. Focus States Review:** Ensure all interactive elements have clear, consistent focus states.
    *   **[X] 4. Remove Single Recipe Card ('X' Button):** Allow users to dismiss individual failed/timed-out cards.
    *   **[X] 5. Transitions (Fade-in):** Add subtle transitions for new elements appearing.
    *   **[X] 6. Dynamic Title for Final List:** Display "Ingredients for [Recipe A] and [Recipe B]..." above the final list.
*   **[X] Fix Final Button Click Error (JSON Parsing):**
    *   **Problem:** Clicking "Shop with Instacart" fails with a JSON parsing error because `handleSendToInstacart` tries to read ingredient data from the `<li>` element's dataset instead of the checkbox's dataset where it's stored.
    *   **Action:** Modify `handleSendToInstacart` in `script.js` to correctly select the checkbox within each list item and parse `checkbox.dataset.itemData`. **(DONE)**
*   **[X] Fix Final Button Visual Layout (Systematic Debugging):**
    *   **Problem:** The "Shop with Instacart" button does not visually match the spec (incorrect height/padding/alignment).
    *   **Action 1 (Inspect Element):** Use browser DevTools to inspect the computed styles (`height`, `padding`, `box-sizing`, `align-items`, `line-height`) and applied CSS rules for the button (`#sendToInstacartButton`), the SVG (`img`), and the text (`span`). Verify they match the intended values (46px height, 16px vertical pad, 18px horizontal pad, flex center, etc.) and identify any conflicting styles. **(DONE - Identified conflicting rule in style.css)**
    *   **Action 2 (Isolate CSS):** Temporarily comment out the link to `style.css` in `index.html`, rebuild Tailwind CSS (`npm run build:css`), and check if the button renders correctly with only Tailwind styles. If it does, the conflict lies within `style.css`. **(DONE - Confirmed conflict)**
    *   **(If needed) Action 3 (Simplify Structure):** Temporarily remove the SVG or the text span from the button HTML to see if either element alone renders correctly within the button's dimensions.
    *   **(If needed) Action 4 (Verify Tailwind Build):** Check `frontend/styles/output.css` to ensure the custom classes (`.h-46px`, `.px-18px`) are defined correctly.
    *   **Action 5 (Implement Fix):** Based on the findings, apply the necessary fix (e.g., remove conflicting CSS, adjust Tailwind classes, fix HTML structure). **(DONE - Removed conflicting rule from style.css)**
*   **[X] Testing:** Verify the appearance and responsiveness across different screen sizes (basic check).
*   **[X] Refine UI Copy:** 
    *   [X] Section 1: Remove italics from instructions.
    *   [X] Section 2: Remove parentheses and update wording for recipe card instructions.
    *   [X] Section 3: Rephrase final list instructions for clarity and action.
*   **[X] Refine Intro Text Hierarchy:** Split the main intro text into a heading (H2) and subheading (P) for better visual structure.
*   **[X] P0: Migrate Initial Job Triggers to QStash (Image & URL Flows):**
    *   **Problem:** The current asynchronous triggers (`fetch` from `/api/upload` to `/api/process-image` and from `/api/process-url` to `/api/process-url-job`) are unreliable, lacking guaranteed delivery and retries. Jobs can get stuck in `pending` state in Redis if the trigger fails silently (e.g., Vercel cold start).
    *   **Goal:** Replace the `fetch` triggers with Upstash QStash messages for guaranteed delivery and retries, mirroring the existing robust pattern used for the `/api/process-image` -> `/api/process-text-worker` step.
    *   **Solution (Extend Existing QStash Pattern):**
        1.  **[X] Verify Dependencies & Env Vars:** Ensure `@upstash/qstash` and `@upstash/redis` are present, and all `QSTASH_*` and `APP_BASE_URL`/`VERCEL_URL` environment variables are correctly configured for local (tunnel) and Vercel environments. (Verified `express.json` global, no base URL utility needed for now).
        2.  **Refactor Trigger Endpoints:**
            *   **[X] `/api/upload` (`uploadController.js`):** Remove `fetch`. After Blob upload and initial Redis `pending` status set, use the QStash `Client` (`qstashClient.publishJSON`) to send a message targeting the full public URL of `/api/process-image`, passing `{ jobId }` in the body. Return `202 Accepted` immediately.
            *   **[ ] `/api/process-url` (`urlController.js`):** Remove `fetch`. After initial Redis `pending` status set, use the QStash `Client` to send a message targeting the full public URL of `/api/process-url-job`, passing `{ jobId }` in the body. Return `202 Accepted` immediately.
        3.  **Refactor Target Endpoints into QStash Handlers:**
            *   **[X] `/api/process-image` (`processImageRoutes.js`, `processImageController.js`):**
                *   **[X] Route:** Add QStash `Receiver.verify()` middleware using the shared `Receiver` instance *before* the controller logic. Ensure correct handling of `express.json()` and signature verification (re-stringify `req.body` if needed for verification).
                *   **[X] Controller:** Adapt the main function to be a QStash handler. Access `jobId` from `req.body`. **Crucially, port the existing core logic exactly:** fetch job from Redis, download from Blob, call Vision, **check Redis status to ensure idempotency (only proceed if status is 'pending' or appropriate initial state)**, handle Vision errors, publish *next* QStash message (to `/api/process-text-worker`), update Redis status (`vision_completed`, `failed`, etc.). Return appropriate status codes (200 for success/next step triggered, 5xx for retryable errors) to QStash.
            *   **[X] `/api/process-url-job` (`urlJobRoutes.js`, `urlJobController.js`):**
                *   **[X] Route:** Add `Receiver.verify()` middleware similarly.
                *   **[X] Controller:** Adapt to be a QStash handler. Access `jobId` from `req.body`. **Port existing core logic exactly:** fetch job from Redis, **check Redis status for idempotency**, fetch URL content, parse (JSON-LD/Readability), handle errors, potentially call initial LLM, update Redis status (`completed`, `failed` with specific error). Return appropriate status codes to QStash.
                    *   **Checklist - `urlJobController.js` Refactor:**
                        *   **[X] Adapt Function Signature:** Change `processUrlJob(req, res)` signature for QStash.
                        *   **[X] Extract `jobId`:** Get `jobId` from `req.body`. Handle missing `jobId` (return 500).
                        *   **[X] Redis Fetch & Type Check:** Fetch data using `redis.get(jobId)`. Handle `null`/`undefined` (return 200). Check `typeof` result (string vs object) and parse/use accordingly (Rule #17). Handle parse errors (set status failed, return 500).
                        *   **[X] Idempotency Check:** Check `jobData.status`. If not `pending`, log and return `200 OK`.
                        *   **[X] Input URL Check:** Verify `jobData.inputUrl` exists after parsing/retrieving from Redis (Rule #16). If missing, set status failed, return 500.
                        *   **[X] Initial Status Update:** Update Redis status to `processing_started` using a helper function.
                        *   **[X] Port Core Logic:** Carefully move existing logic blocks (HTML fetch, JSON-LD, Readability, LLM calls) into the new structure, wrapped in a main `try...catch`.
                        *   **[X] Refactor Status Updates:** Replace direct `updateUrlJobStatusInRedis` calls with a unified helper (like in `processImageController`), passing correct status strings (`fetching_html`, `parsing_jsonld`, etc.) and error messages.
                        *   **[X] Centralized Error Handling:** Use main `catch` block to call status update helper, setting status to `failed` with specific error message.
                        *   **[X] Return Correct Codes:** Return `200 OK` on success/acknowledged states. Return `500` on processing errors.
                        *   **[X] Module Export:** Ensure correct function name (`processUrlJob`) is exported.
        4.  **[X] Idempotency Check:** Explicitly add logic at the beginning of the QStash handlers (`processImageController`, `urlJobController`) to read the current job status from Redis. If the status is *not* the expected initial state (e.g., `pending`), log a warning and return `200 OK` immediately to prevent reprocessing. (Done for Image flow & URL flow).
        5.  **[X] Error Handling & Final Status:** Ensure terminal failures (after any internal retries within the controller and after QStash retries are exhausted) result in a clear `failed` status in Redis, including a specific error message indicating the point of failure (e.g., `vision_failed`, `url_fetch_failed`, `url_parse_failed`). Consider adding Blob cleanup for failed image jobs. (Done for Image flow & URL flow).
        6.  **[X] Staged Rollout & Testing:** Implement and thoroughly test the **Image Flow** first (local tunnel + Vercel deployment) before starting the **URL Flow**. Verify QStash console, Redis state, logs, and frontend behavior. (Image Flow Implementation Complete, URL Flow Implementation Complete).

---

## P1: UI Facelift using Tailwind CSS (Inspired by shadcn/ui)

**Goal:** Significantly improve the visual presentation and user experience of the frontend by adopting Tailwind CSS for styling, aiming for a clean, modern aesthetic similar to `shadcn/ui`.

**Rationale:** Direct integration of `shadcn/ui` components is not feasible with the current vanilla JS/HTML frontend. Using Tailwind CSS directly allows us to leverage its utility-first approach to achieve a comparable visual style without requiring a React migration.

**Tasks:**

*   **[X] Setup Tailwind CSS:**
    *   **[X]** Add `tailwindcss` as a dev dependency to the project (likely at the root or within `frontend/`). (Downgraded to v3.4.17)
    *   **[X]** Initialize Tailwind: Create `tailwind.config.js` and a base CSS input file (e.g., `frontend/styles/input.css`).
    *   **[X]** Configure `tailwind.config.js` to scan `frontend/index.html` and `frontend/script.js` for class names.
    *   **[X]** Set up a build script (e.g., in `package.json` or manually run via CLI) to process `input.css` and generate `frontend/styles/output.css`. (Using `npx tailwindcss` via npm script)
    *   **[X]** Link `frontend/styles/output.css` in `frontend/index.html`.
*   **[X] Refactor `frontend/index.html` with Tailwind Classes:**
    *   **Overall Layout:** Apply Tailwind classes for container management, max-width, margins, padding, and background colors.
    *   **Typography:** Use Tailwind utilities for font sizes, weights, and colors for headings and body text.
    *   **Sections:** Style the main sections ("Add Recipes", "Review Extracted Ingredients", "Final Shopping List") using borders, padding, and background colors for clear visual separation.
    *   **[X] Form Elements:** Style the file input, URL input, and buttons using Tailwind classes for a consistent look and feel (including hover/focus states).
    *   **Recipe Cards:** Refactor the structure and apply Tailwind classes for borders, padding, spacing, and layout within each recipe card display.
    *   **[X]** Checkboxes/Toggles: Style the ingredient deselection checkboxes and pantry toggle.
    *   **[X]** Feedback Elements: Style loading indicators, success messages, and error messages using Tailwind utilities for colors, borders, and padding.
    *   **[X]** Standardize Button Styles: Ensure the "Choose Files", "Add URL", and "Review Final List" buttons use a consistent dark blue style (`bg-blue-500`, `text-white`) and fully rounded shape (`rounded-full`) based on design feedback.
*   **[X] Apply Targeted Styling Improvements (Prioritized):**
    *   **[X]** 1. Style Final Shopping List (Section 3): In `displayReviewList`, apply Tailwind classes to the `ul` and `li` elements, including checkboxes and labels, for better structure and visual consistency (`border`, `padding`, `spacing`, custom checkbox styles).
    *   **[X]** 2. Enhance Error/Loading Feedback:** Style global error/loading messages (e.g., for URL input, Instacart interactions). Add visual indicators (e.g., spinners) to individual recipe card loading states (`renderSingleRecipeResult`).
    *   **[X]** 3. Refine Pantry Checkbox Area:** Style the helper text (`text-xs`, `text-gray-600`) and apply consistent Tailwind styling. Change the pantry checkbox to a visually lighter toggle switch/slider and darken label text (`text-black`, `text-gray-600`).
    *   **[X]** 4. Final Consistency Pass:** Review all sections for minor inconsistencies in padding, margins, font sizes, alignment, etc.
*   **[ ] Cleanup:** Remove any existing custom CSS rules that are replaced by Tailwind utilities. (Deferred post-demo due to risk of breaking styles).
*   **[X] Testing:** Verify the appearance and responsiveness across different screen sizes (basic check).

---

## P1: Important for Polish

These improve the experience but are secondary to core functionality and feedback.

*   **[X] Implement Quick-Fail for Non-Recipe Inputs (P1):**
    *   **Goal:** Prevent unnecessary LLM calls for images or URLs that don't contain recipe content, saving cost and providing faster feedback.
    *   **Image Flow (`/api/process-image`):**
        *   **Action:** After the Vision API call, check if the extracted text is empty or shorter than a minimum threshold (e.g., 50 characters). **(DONE)**
        *   **On Failure:** Update job status in KV/Redis to `failed` with a specific error (e.g., "Image does not contain enough readable text to be a recipe.") and **do not** publish the QStash message to trigger the text processing worker. **(DONE)**
        *   *(Considered, Deferred): Keyword analysis for reliability concerns.*
    *   **URL Flow (`/api/process-url-job`):**
        *   **Action (JSON-LD Path):** After successfully parsing JSON-LD, check if the `recipeIngredient` array exists and is non-empty. **(DONE - checks filtered array, proceeds to fallback if empty)**
        *   **Action (Readability Path):** After successfully using Readability, check if the extracted `textContent` meets a minimum length threshold (e.g., 100 characters). **(DONE - check removed as requested)**
        *   **On Failure (Either Path):** Update job status in KV/Redis to `failed` with a specific error (e.g., "No recipe ingredients found in structured data." or "Webpage content does not appear to be a recipe.") and **do not** proceed to the LLM call within the job. **(DONE - JSON-LD path proceeds to fallback, Readability path fails if no content)**
        *   *(Considered, Deferred): Keyword analysis for reliability concerns.*
    *   **Frontend:** Ensure new specific error messages from the backend (`jobData.error`) are handled and displayed clearly in the respective recipe card during polling.
*   **[ ] Implement Recipe Limit (Frontend):**
    *   **Problem:** The application could become slow or unwieldy if a user tries to process too many recipes (e.g., >10) simultaneously. This could also lead to potential abuse or hit backend rate limits faster.
    *   **Goal:** Limit the number of recipes that can be actively processed or displayed in the list at any given time to 10.
    *   **Action:** Modify `frontend/script.js` to check the length of the `recipeData` array before processing a new image file or URL. If the length is 10 or more, prevent the addition and display an alert to the user (e.g., "Maximum of 10 recipes reached."). **(DONE)**
*   **[ ] Refine Layout & Flow:**
    *   **Problem:** Pantry toggle placement is slightly awkward. Minor visual inconsistencies.
    *   **Action:** Experiment with relocating the "Pantry Item Toggle" (e.g., below "2. Extracted Recipes" heading or inside "3. Create Instacart List" section). Perform a quick visual pass for consistent spacing, alignment, and element styling (buttons, cards, etc.).
*   **[X] Review UI for Instacart Mark Usage:** Ensure the frontend uses the name "Instacart" appropriately (functional descriptions) and does not use any Instacart logos or branding in a way that implies endorsement, per Section 8 and 16.9 of the T&Cs. ([Source: Developer T&Cs](https://docs.instacart.com/developer_platform_api/guide/terms_and_policies/developer_terms/))
*   **[X] Confirm T&C Compliance Aspects:** Perform a final read-through of the T&Cs, focusing on data handling and any specific limitations relevant to the Recipe-to-Cart use case, ensuring no planned features conflict. ([Source: Developer T&Cs](https://docs.instacart.com/developer_platform_api/guide/terms_and_policies/developer_terms/))
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
3. **Implement Individual Timeout Handling (P0 Required UX):** Modify frontend to allow dismissing/retrying single timed-out recipe cards.
4.  **Polish UI/UX (P1):** Simplify pantry text, refine layout. Deploy & Test.
5.  **Final Demo Run-through.**
6.  **Refactor Backend Codebase (P1):** Execute the modularization plan.
7.  **Final Demo Run-through (Post-Refactor).**


---

Let me know if this revised plan aligns with your vision for crushing Demo Day!

## Asynchronous Processing Technical Design Document (TDD)

**NOTE:** *This TDD describes the Vercel KV + fetch-based async approach initially implemented. The final, more robust implementation uses Upstash Redis for state and Upstash QStash for ALL asynchronous job triggering (upload -> process-image, process-url -> process-url-job, process-image -> process-text-worker), replacing the unreliable `fetch` triggers described below. See `PROJECT_OVERVIEW.md` for the current architecture.*

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

**NOTE:** *This TDD section describes the Vercel KV + fetch-based async approach initially implemented for URL extraction. The final implementation uses Upstash Redis for state and Upstash QStash for triggering `/api/process-url-job`. See `PROJECT_OVERVIEW.md` for the current architecture.*

*   **Focus:** Handle common, well-structured recipe websites (especially those using JSON-LD schema) and provide clear errors for unsupported cases (login required, major fetch/parse failures).

**Technical Approach:**

1.  **[X] Frontend (`index.html`, `script.js`):**
    *   Add URL input field and "Add Recipe from URL" button.
    *   On button click:
        *   Perform basic client-side URL validation.
        *   Display a new recipe card in "Processing URL..." state.
        *   Call new backend endpoint `POST /api/process-url` with `{ url: recipeUrl }`.
        *   Receive `jobId` from backend.
        *   Reuse existing `pollJobStatus(jobId)` and `renderSingleRecipeResult(result)` functions.

2.  **[X] Backend (`server.js`):**
    *   **[X] New Endpoint (`/api/process-url` - Trigger):
        *   Input: `{ url }`.
        *   Validate URL.
        *   Generate `jobId`.
        *   Store initial job state in Vercel KV: `{ status: 'pending', inputUrl: url }`.
        *   Asynchronously trigger `/api/process-url-job` via `fetch` with `{ jobId }`.
        *   Return `202 Accepted` with `{ jobId }` to the frontend.
        
            *   **[X] Route:** Add `Receiver.verify()` middleware similarly.
            *   **[X] Controller:** Adapt to be a QStash handler. Access `jobId` from `req.body`. **Port existing core logic exactly:** fetch job from Redis, **check Redis status for idempotency**, fetch URL content, parse (JSON-LD/Readability), handle errors, potentially call initial LLM, update Redis status (`completed`, `failed` with specific error). Return appropriate status codes to QStash.
                *   **Checklist - `urlJobController.js` Refactor:**
                    *   **[X] Adapt Function Signature:** Change `processUrlJob(req, res)` signature for QStash.
                    *   **[X] Extract `jobId`:** Get `jobId` from `req.body`. Handle missing `jobId` (return 500).
                    *   **[X] Redis Fetch & Type Check:** Fetch data using `redis.get(jobId)`. Handle `null`/`undefined` (return 200). Check `typeof` result (string vs object) and parse/use accordingly (Rule #17). Handle parse errors (set status failed, return 500).
                    *   **[X] Idempotency Check:** Check `jobData.status`. If not `pending`, log and return `200 OK`.
                    *   **[X] Input URL Check:** Verify `jobData.inputUrl` exists after parsing/retrieving from Redis (Rule #16). If missing, set status failed, return 500.
                    *   **[X] Initial Status Update:** Update Redis status to `processing_started` using a helper function.
                    *   **[X] Port Core Logic:** Carefully move existing logic blocks (HTML fetch, JSON-LD, Readability, LLM calls) into the new structure, wrapped in a main `try...catch`.
                    *   **[X] Refactor Status Updates:** Replace direct `updateUrlJobStatusInRedis` calls with a unified helper (like in `processImageController`), passing correct status strings (`fetching_html`, `parsing_jsonld`, etc.) and error messages.
                    *   **[X] Centralized Error Handling:** Use main `catch` block to call status update helper, setting status to `failed` with specific error message.
                    *   **[X] Return Correct Codes:** Return `200 OK` on success/acknowledged states. Return `500` on processing errors.
                    *   **[X] Module Export:** Ensure correct function name (`processUrlJob`) is exported.
        4.  **[X] Idempotency Check:** Explicitly add logic at the beginning of the QStash handlers (`processImageController`, `urlJobController`) to read the current job status from Redis. If the status is *not* the expected initial state (e.g., `pending`), log a warning and return `200 OK` immediately to prevent reprocessing. (Done for Image flow & URL flow).
        5.  **[X] Error Handling & Final Status:** Ensure terminal failures (after any internal retries within the controller and after QStash retries are exhausted) result in a clear `failed` status in Redis, including a specific error message indicating the point of failure (e.g., `vision_failed`, `url_fetch_failed`, `url_parse_failed`). Consider adding Blob cleanup for failed image jobs. (Done for Image flow & URL flow).
        6.  **[X] Staged Rollout & Testing:** Implement and thoroughly test the **Image Flow** first (local tunnel + Vercel deployment) before starting the **URL Flow**. Verify QStash console, Redis state, logs, and frontend behavior. (Image Flow Implementation Complete, URL Flow Implementation Complete).

## P0: Airwallex Payment Link Demo Integration (Branch: airwallex-demo)

**Goal:** Implement a "Book a Session with Michael" feature that integrates Airwallex payments, allowing a user to pay for consultations of varying lengths. This demonstrates understanding of Airwallex backend API integration for Payment Links and the Drop-in Element.

**Tech Stack for this Feature:**
*   **Backend:** Node.js/Express (existing `backend/server.js`, new controller `airwallexController.js`)
*   **Frontend:** Vanilla HTML/CSS/JS (existing `frontend/index.html`, new script `frontend/airwallex-checkout.js`)
*   **Airwallex API:** Demo environment (`https://api-demo.airwallex.com`), Airwallex.js SDK

**Phase 1: Backend Setup - Dynamic Payment Intent & Link Creation**
*   **[X] Environment Variables:**
    *   In `backend/.env`, ensure `AIRWALLEX_CLIENT_ID` and `AIRWALLEX_API_KEY` are set with demo credentials.
    *   Add `AIRWALLEX_DEMO_API_BASE_URL="https://api-demo.airwallex.com"`
*   **[X] Backend Routes & Controller (`airwallexController.js`, `airwallexRoutes.js`):**
    *   **[X] Routes:**
        *   `POST /api/airwallex/create-payment-link`: Creates an Airwallex Payment Link.
        *   `POST /api/airwallex/create-payment-intent`: Creates an Airwallex Payment Intent (used by Drop-in).
    *   **[X] Controller Logic:**
        *   **[X] Authentication Function:** Helper to get/cache Airwallex Bearer Token.
        *   **[X] `createPaymentLink` Function:**
            *   Accepts `amount`, `currency`, `description` from `req.body`.
            *   Calls Airwallex `POST /api/v1/pa/payment_links/create` with dynamic details.
            *   Returns `{ payment_link_url, payment_link_id }`.
        *   **[X] `createPaymentIntent` Function:**
            *   Accepts `amount`, `currency` (and optionally `description`) from `req.body`.
            *   Calls Airwallex `POST /api/v1/pa/payment_intents/create` with dynamic details.
            *   Returns `{ intent_id, client_secret, amount, currency }`.
        *   **[X] Error Handling:** Graceful error handling for Airwallex API calls.

**Phase 2: Frontend Integration - Multi-step Booking & Payment Flow**
*   **[X] Modify `frontend/index.html`:**
    *   **[X] "Book a Session" Card:**
        *   Updated introductory text about consultation.
        *   Initial button: `<button id="viewConsultationOptionsButton">View Consultation Options</button>`.
        *   Hidden container: `<div id="sessionChoiceContainer">` with buttons for different session durations and prices (e.g., "15 Min Brainstorm - $75", "30 Min Strategy Call - $125", "1 Hour Deep Dive - $250"). These buttons store `data-amount`, `data-currency`, `data-description`.
        *   Hidden container: `<div id="paymentChoiceContainer">` with buttons:
            *   `<button id="payWithLinkButton">Pay with Secure Link</button>`
            *   `<button id="payWithDropInButton">Pay with Card / Other Methods</button>`
        *   Container for Payment Link URL: `<div id="paymentLinkContainer"></div>`.
        *   Container for Drop-in Element: `<div id="drop-in-container" class="max-h-[450px] overflow-y-auto"></div>` (styled for constrained height).
        *   General status message area: `<p id="paymentLinkMessage"></div>`.
    *   **[X]** Simple static page: `frontend/payment-success.html`.
    *   **[X]** Include `airwallex-checkout.js` (as `type="module"`) and Airwallex SDK via import map.
*   **[X] Create `frontend/airwallex-checkout.js`:**
    *   **[X] State Management:** Variable `selectedSessionDetails` to store chosen amount, currency, description.
    *   **[X] UI Flow Logic:**
        1.  `viewConsultationOptionsButton` click: Hides itself, shows `sessionChoiceContainer`.
        2.  Session duration button click: Populates `selectedSessionDetails`, hides `sessionChoiceContainer`, shows `paymentChoiceContainer`.
    *   **[X] `payWithLinkButton` Click Handler:**
        *   Uses `selectedSessionDetails` to `fetch POST /api/airwallex/create-payment-link`.
        *   Displays the returned `payment_link_url`.
    *   **[X] `payWithDropInButton` Click Handler:**
        *   Calls `initializeDropInElement()`.
    *   **[X] `initializeDropInElement()` Function:**
        *   Calls `Airwallex.init({ env: 'demo', ... })`.
        *   Uses `selectedSessionDetails` to `fetch POST /api/airwallex/create-payment-intent`.
        *   `Airwallex.createElement('dropIn', { intent_id, client_secret, currency })`.
        *   Mounts element to `drop-in-container`.
        *   Handles `on('ready')`, `on('success')` (redirects to success page), `on('error')` events.
    *   **[X]** Robust error display and UI state management.

**Phase 3: Webhook Confirmation (Discussion & Existing Setup)**
*   **[X] Mention during Demo:** Explain that while the user is redirected, robust payment confirmation relies on webhooks.
*   **[X] Airwallex Setup:** Events (e.g., `payment_link.paid`, `payment_intent.succeeded`) are configured in the Airwallex dashboard to send to your Pipedream URL (`https://eow2zak5z3nkcls.m.pipedream.net`).
*   **[X] Pipedream:** You can monitor incoming events on Pipedream to show this part of the flow during the demo. For a real application, Pipedream could then call a webhook handler on your backend to update application state (e.g., mark session as paid).

**Demo Flow:**
1.  Show the "Book a Session" UI with the "View Consultation Options" button.
2.  Click it, explain the different session options are now available.
3.  Select a session (e.g., "30 Min Strategy Call - $125").
4.  Explain the user can now choose their payment method.
5.  **Path A (Payment Link):**
    *   Click "Pay with Secure Link". Explain backend is calling Airwallex.
    *   Show the generated payment link. Click it (opens Airwallex hosted page).
6.  **Path B (Drop-in Element):**
    *   Click "Pay with Card / Other Methods". Explain Airwallex.js SDK is initializing.
    *   Show the Drop-in Element loaded in the sidebar (with its constrained height and scroll).
    *   Interact with the Drop-in (e.g., enter test card details if available).
7.  (For either path) Show successful payment and redirection to `payment-success.html`.
8.  Show the payment confirmation event received in Pipedream.