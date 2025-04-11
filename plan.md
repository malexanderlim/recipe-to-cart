# Demo Day Prep Plan

**Goal:** Ensure the Recipe-to-Cart app is accurate, intuitive, and polished for the YC Demo Day presentation. The core functionality (recipe -> accurate cart) must be reliable.

## P0: Must-Haves for Demo

These issues directly impact the core value proposition or the demo user experience and MUST be addressed.

*   **[ ] Fix Ingredient Consolidation:**
    *   **Problem:** Duplicate ingredients (garlic, thyme) appear in the Instacart API request, indicating consolidation isn't happening correctly before the API call. `requirements.md` says frontend handles this.
    *   **Action:** Investigate frontend JavaScript (`frontend/script.js`) where the final list is aggregated. Ensure consolidation logic runs *before* constructing the payload for the `/api/create-list` endpoint. Combine items with the same normalized name, summing quantities appropriately (handling unit conversions carefully).
*   **[ ] Review & Refine Backend Unit Normalization (`backend/server.js`):**
    *   **Problem:** Current normalization (e.g., cloves->each, tsp->bunch) leads to inaccurate quantities and incorrect product matching by Instacart (fresh vs dried oregano, whole vs minced garlic, cooking vs table wine).
    *   **Action (General):** Implement robust logging of original extracted units vs. normalized units to easily trace issues during testing.
    *   **Action (Garlic):** Re-evaluate `cloves` -> `each`. Is quantity considered? Should we map groups of cloves (e.g., 6-10) to `head` or `each`? Strip potentially confusing descriptors ("smashed", "peeled") before sending the name, but maybe retain in `display_text`?
    *   **Action (Herbs):** How did `1 tsp dried oregano` become `1 bunch`? Check LLM output and backend logic. Ensure "dried" is preserved and influences normalization (perhaps map to `oz` or `package` instead of `bunch`?). Re-evaluate `tsp`/`tbsp`/`sprigs` -> `bunch`/`package` - needs to be more nuanced.
    *   **Action (Wine):** Clarify "dry white wine" to something less ambiguous like "white table wine" or "Sauvignon Blanc" if identifiable, to avoid matching with "cooking wine".
    *   **Action (Leverage Instacart Units):** Based on [Instacart API Docs](https://docs.instacart.com/developer_platform_api/api/units_of_measurement), explore using the `Measurement` array for ambiguous items. If unsure if a vendor uses `each` vs `oz` for garlic, potentially send `[{"unit": "each", "quantity": 1}, {"unit": "oz", "quantity": 4}]` (example values) to increase match likelihood. This needs careful implementation based on common conversions.
*   **[X] Fix Instacart API 401 Error:** ... (details)
*   **[X] Implement Two-Stage LLM Processing + Hybrid Adjustment:** 
    *   **Strategy:** Combined LLM (Stage 1: Extraction, Stage 2: Preliminary Normalization/Consolidation) with backend algorithmic adjustments for reliable quantity/unit constraints. **Refined to output `line_item_measurements` array based on testing.**
    *   Stage 1 (Backend `/api/upload`): LLM extracts structured data ...
    *   Stage 2 (Backend `/api/create-list`): LLM normalizes/consolidates, generates `line_item_measurements` array (with primary + alternative units where applicable), returns calculated values + original context. Backend code applies final adjustments within the measurements array. **(NEEDS UPDATE)**
*   **[X] Implement Final List Review Step (P0/P1):**
    *   **Goal:** Allow users to review the final adjusted list and deselect items.
    *   **Backend Action:** `/api/create-list` returns adjusted list (now with `line_item_measurements`). `/api/send-to-instacart` calls Instacart API (accepting `line_item_measurements`). **(NEEDS UPDATE for send endpoint)**
    *   **Frontend Action:** UI displays review list (showing primary measurement), handles new buttons/API calls. **(NEEDS UPDATE for display logic)**
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

1.  **Backend Refactor (Multi-Unit):** Modify Stage 2 LLM prompt and post-processing in `/api/create-list` to generate/handle `line_item_measurements`. Verify `/api/send-to-instacart` structure.
2.  **Frontend Update (Multi-Unit):** Adjust `displayReviewList` to show primary measurement. Verify `handleSendToInstacart` sends the correct structure.
3.  **Enhance Frontend Feedback:** Improve loading indicators/error handling.
4.  **Test & Refine:** Test full flow with multi-unit logic.
5.  **Address P1:** Polish layout.
6.  **Final Demo Run-through.**

---

Let me know if this revised plan aligns with your vision for crushing Demo Day! 