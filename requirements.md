# Requirements

## Core Features
- [X] Image Upload: Allow users to upload recipe images (multiple file support - *implemented*)
- [X] Ingredient Extraction: Extract ingredients list from recipe images using Google Vision & Anthropic Claude
- [X] Recipe Scaling: Support scaling recipes up or down based on detected yield (servings, cups, etc.)
- [X] Instacart Integration: Create a shopping list on Instacart using the Developer Platform API (combines multiple recipes)

## Frontend Requirements
- [X] Simple HTML/CSS/JS interface
- [ ] Support for desktop browsers (*needs testing*)
- [X] Upload area for multiple recipe images
- [X] Preview area for uploaded images (shows filename for non-web formats like HEIC)
- [X] Display area for extracted recipes (shows title, yield controls, ingredients per recipe)
- [X] Controls for adjusting recipe yield (increment/decrement per recipe)
- [X] Button to create Instacart shopping list (aggregates all displayed recipes)
- [X] **UI Refresh:** Improve layout (wider, recipe cards), spacing, and aesthetics.
- [X] **Ingredient Exclusion:** Add checkboxes next to ingredients to allow users to deselect items before adding to Instacart.
- [X] **Pantry Item Toggle:** Add master checkbox to easily toggle common pantry items.

## Backend Requirements
- [X] Use Node.js server for handling API requests
- [X] Implement image processing (Google Vision) + HEIC conversion
- [X] Parse ingredients, title, and yield using Anthropic Claude API
- [X] Connect to Instacart's Developer Platform API (key via .env)

## Ingredient Parsing Logic (via LLM)
- [X] Extract quantities, units, and ingredient names
- [X] Handle common units & abbreviations
- [X] Default to "each" for units when none specified
- [X] Attempt conversion of item counts (e.g., cloves) to weight (e.g., ounces)
- [X] Extract recipe title
- [X] Extract recipe yield (quantity and unit)
- [N/A] **Ingredient Exclusion Support:** Ensure backend can handle potentially filtered ingredient lists (logic implemented fully on frontend).

## Implementation Details
- [X] Create basic HTML/CSS layout
- [X] Implement frontend JavaScript for file uploads and UI interactions
- [X] Create Node.js server endpoints:
  - [X] /api/upload (handles image processing and LLM parsing)
  - [X] /api/create-list (handles Instacart API call)
- [-] Use `.env` file for API keys (Anthropic & Instacart)
- [/] Implement proper error handling and loading states (*basic states implemented, needs refinement*)
- [X] Implement UI refresh (CSS adjustments, HTML structure changes via JS).
- [X] Implement ingredient checkboxes (HTML generation in JS, update list creation logic in JS).
- [X] Implement pantry item master checkbox and logic.

## Testing
- [ ] Test with diverse recipe image data (different layouts, formats, yields)
- [ ] Test Instacart API integration with various combined lists
- [ ] Test edge cases (no ingredients found, API errors, etc.)
- [X] Test ingredient exclusion functionality.
- [X] Test responsiveness of the new layout.
- [ ] Test pantry item checkbox logic (toggling, timing, accuracy).

## Final Deliverables
- [ ] Complete, functional web application (*pending testing/refinement*)
- [X] Server code (*exists, pending testing/refinement*)
- [ ] Clear documentation (README.md) (*basic setup added, needs final update*)
- [/] Basic error handling and user feedback (*needs refinement*)
- [X] Improved UI/UX based on refresh requirements (wider layout, cards, checkboxes).

## Potential MVP+ Ideas (Optional)
- [ ] Consolidate duplicate ingredients before sending to Instacart
- [ ] Improve UI/UX (better loading indicators, progress for multiple files)
- [ ] More robust ingredient parsing (handling ranges, alternatives via LLM prompt tuning)
- [ ] Basic user authentication
- [ ] Save/Load recipes
- [ ] Support for different OCR/Vision providers 

