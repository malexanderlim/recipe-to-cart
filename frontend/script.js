// Global store for recipe data and status
let recipeData = {}; // { 'tempId-xyz': { status: 'pending', file: File, jobId: null, error: null, result: null, sourceType: 'file'|'url', inputUrl: null }, ... }
let processedRecipes = []; // <<< MOVE TO GLOBAL SCOPE >>>

// *** Define helper for empty state visibility ***
function updateEmptyStateVisibility() {
    const emptyStateMessage = document.getElementById('empty-state-message');
    if (emptyStateMessage) {
        // Check if the recipeData map (for in-progress) OR processedRecipes array (for completed/failed) has items
        const hasRecipes = Object.keys(recipeData).length > 0 || processedRecipes.length > 0;
        emptyStateMessage.style.display = hasRecipes ? 'none' : 'block';
        console.log(`Updating empty state visibility. Has recipes: ${hasRecipes}. Display: ${emptyStateMessage.style.display}`);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const imageUploadInput = document.getElementById('recipeImages');
    const imagePreviewArea = document.getElementById('image-preview-area');
    // Container for multiple recipe results
    const recipeResultsContainer = document.getElementById('recipe-results-container'); 
    // const extractedTextArea = document.getElementById('extracted-text'); // Removed
    // const parsedIngredientsList = document.getElementById('parsed-ingredients-list'); // Removed
    const createListButton = document.getElementById('create-list-button');
    const instacartLinkArea = document.getElementById('instacart-link-area');
    const loadingIndicator = document.getElementById('loading-indicator');
    const errorMessageDiv = document.getElementById('error-message');
    const instacartLoadingIndicator = document.getElementById('instacart-loading-indicator');
    const instacartErrorMessageDiv = document.getElementById('instacart-error-message');
    const resultsSection = document.getElementById('results-section'); // Get the section containing results
    // --- Add element for Review List --- 
    const reviewListArea = document.getElementById('review-list-area'); // Placeholder for review section
    // --- Get reference to the static Instacart button ---
    const sendToInstacartButton = document.getElementById('sendToInstacartButton');
    // ---------------------------------

    // Remove single yield controls - they will be per-recipe
    // const yieldControlDiv = document.getElementById('servings-control'); 
    // ... (other single yield control vars removed)

    // Ensure error message is hidden on load
    if (errorMessageDiv) {
        errorMessageDiv.style.display = 'none';
    }
    if (instacartErrorMessageDiv) {
        instacartErrorMessageDiv.style.display = 'none';
    }

    // State for multiple recipes
    let recipeCounter = 0; // Simple ID generator

    // Determine backend URL based on hostname
    const isLocal = window.location.hostname === 'localhost' 
                   || window.location.hostname === '127.0.0.1' 
                   || window.location.hostname === '[::1]'; // Add check for IPv6 loopback
    const backendUrl = isLocal ? 'http://localhost:3001' : ''; // Empty string for relative paths on deployed version
    console.log(`Running ${isLocal ? 'locally' : 'deployed'}. Backend URL: ${backendUrl || '/'}`);

    // --- Define Polling Constants --- 
    const POLLING_INTERVAL = 3000; // Milliseconds (e.g., 3 seconds)
    const MAX_POLLING_ATTEMPTS = 40; // e.g., 40 attempts * 3s = 120s timeout
    const POLLING_TIMEOUT_MS = 60000; // <<< INCREASED TIMEOUT to 60 seconds >>>

    // --- Define Common Pantry Item Keywords (lowercase) --- 
    const commonItemsKeywords = [
        'salt', 
        // Specific pepper
        'black pepper', 
        // More specific oil types
        'olive oil', 'vegetable oil', 'canola oil', 
        'water', 'flour', 'sugar'
    ];

    // --- Elements related to pantry checkbox (will be created dynamically) ---
    let pantryCheckbox = null;

    // Spinner SVG definition (reusable) - DEFINED EARLY
    const spinnerSVG = `
        <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-gray-700 inline-block align-middle" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
    `;

    imageUploadInput.addEventListener('change', handleMultipleImageUpload);
    
    // Check if the button was found before adding listener
    if (createListButton) {
        // --- Restore original listener --- 
        createListButton.addEventListener('click', handleReviewList);
        // --- Rename button text ---
        createListButton.textContent = 'Review Final List'; 
    } else {
        console.error("FATAL: Could not find createListButton element to attach listener!");
    }
    // Remove listeners for single yield controls

    // --- Add listener for the static Instacart button --- 
    if (sendToInstacartButton) {
        sendToInstacartButton.addEventListener('click', handleSendToInstacart);
    } else {
        console.error("FATAL: Could not find sendToInstacartButton element to attach listener!");
    }
    // --------------------------------------------------

    // --- Ensure empty state is correct on load --- 
    updateEmptyStateVisibility(); // Call the helper on load

    // Updated loading state indicator
    function setLoadingState(isLoading, fileCount = 0) {
        if (isLoading) {
            // *** Modify loading text ***
            loadingIndicator.innerHTML = `${spinnerSVG} Processing ${fileCount} file(s)...`; // Keep generic for now, covers initial/add
            loadingIndicator.style.display = 'block';
            errorMessageDiv.textContent = ''; // Clear general error message
            errorMessageDiv.style.display = 'none';
        } else {
            loadingIndicator.style.display = 'none';
        }
    }

    // New handler for multiple files
    async function handleMultipleImageUpload(event) {
        const files = event.target.files;
        if (!files || files.length === 0) return;

        // *** REMOVE clearAllResults() to make uploads additive ***
        // clearAllResults(); 

        // *** Use the *new* file count for the loading message ***
        setLoadingState(true, files.length); 

        updateEmptyStateVisibility(); // Hide empty state if it was visible

        // *** REMOVE processedRecipes reset ***
        // processedRecipes = []; 

        for (const file of files) {
            // displayImagePreview(file); // Preview now handled in renderSingleRecipeResult
            await processSingleFile(file);
            updateEmptyStateVisibility(); 
        }
        
        setLoadingState(false); 
        updateCreateListButtonState(); 
        updateEmptyStateVisibility(); 
    }

    // Function to process one file
    async function processSingleFile(file) {
        const recipeId = `recipe-${recipeCounter++}`;

        // <<< ADD RECIPE LIMIT CHECK >>>
        if (Object.keys(recipeData).length >= 10) {
            alert("Maximum of 10 recipes reached. Please review or clear the current list before adding more.");
            // Optionally remove the preview added in the calling loop if needed
            // This depends on how previews are handled in handleMultipleImageUpload
            return; // Stop processing this file
        }
        // <<< END CHECK >>>

        const recipeDataObj = { // Renamed variable to avoid confusion with global map
            id: recipeId, 
            file: file, 
            title: file.name, // Default title
            yield: null, 
            ingredients: [], 
            scaleFactor: 1, 
            error: null, 
            jobId: null, // Added
            pollingIntervalId: null, // Added
            pollingAttempts: 0, // Added
            pollingTimeoutId: null, // Added for overall timeout
            lastKnownStatus: null // Added to track status for timeout message
        };
        // Store in the global map for active polling
        recipeData[recipeId] = recipeDataObj; 
        // Render initial placeholder with loading state
        renderSingleRecipeResult(recipeDataObj, true, 'Initializing upload...'); // Add loading message

        // Clear previous errors for this specific card (if any)
        clearRecipeError(recipeId);

        const formData = new FormData();
        formData.append('recipeImages', file);

        try {
            // Call the NEW ASYNC /api/upload
            const response = await fetch(`${backendUrl}/api/upload`, {
                method: 'POST',
                body: formData,
            });

            if (response.status === 202) { // Check for 202 Accepted
                const data = await response.json();
                const jobId = data.jobId;
                if (jobId) {
                    recipeDataObj.jobId = jobId; // Store jobId
                    recipeDataObj.pollingAttempts = 0; // Initialize polling counter
                    console.log(`[Recipe ${recipeId}] Upload accepted. Job ID: ${jobId}. Starting polling.`);
                    // Update UI to show 'Processing...'
                    renderSingleRecipeResult(recipeDataObj, true, 'Uploading image...'); // Initial status
                    // Start polling
                    startPollingJobStatus(recipeId, jobId);
                } else {
                    throw new Error('Server accepted upload but did not return a Job ID.');
                }
            } else {
                // Handle immediate errors from /api/upload (e.g., 400, 500)
                const errorData = await response.json().catch(() => ({})); // Try to parse error JSON
                throw new Error(errorData.details || errorData.error || `Upload failed: ${response.statusText} (Status ${response.status})`);
            }

        } catch (error) {
            console.error(`[Recipe ${recipeId}] Error initiating upload for ${file.name}:`, error);
            recipeDataObj.error = `Upload Error: ${error.message}`;
            displayError(`Failed to start processing for ${file.name}.`); // General error message
            // Update the specific recipe block with the error
            renderSingleRecipeResult(recipeDataObj, false); // isLoading = false to show error
            updateCreateListButtonState(); // Re-evaluate button state after error
        }
        updateEmptyStateVisibility(); // Call helper as recipeData is updated
    }

    // Renders the UI block for a single recipe
    // Modified to accept loading message
    function renderSingleRecipeResult(recipeData, isLoading = false, loadingMessage = 'Processing...', internalStatus = null) {
        
        // *** Define Spinner SVG at the top ***
        // MOVED spinnerSVG definition higher up in the scope
        /*
        const spinnerSVG = `
            <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-gray-700 inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
        `;
        */

        // --- Status Mapping ---
        let displayStatus = loadingMessage;
        if (isLoading) {
            // --- UPDATED: Show a consistent "in progress" message --- 
            if (internalStatus && internalStatus !== 'completed' && internalStatus !== 'failed' && internalStatus !== 'not_found') {
                displayStatus = 'Recipe analysis in progress... please wait'; 
            } else {
                displayStatus = loadingMessage; // Fallback for initial upload or if status is unknown
            }
            // --- END UPDATE ---
            /* --- REMOVED --- 
            switch (internalStatus) {
                case 'pending':
                    displayStatus = 'Processing image...';
                    break;
                case 'vision_completed':
                    displayStatus = 'Analyzing ingredients...';
                    break;
                default:
                    displayStatus = loadingMessage; // Fallback (e.g., 'Uploading...')
            }
            */
        }
        let recipeDiv = document.getElementById(recipeData.id);
        if (!recipeDiv) {
            recipeDiv = document.createElement('div');
            recipeDiv.id = recipeData.id;
            recipeDiv.classList.add(
                'recipe-card', 
                'relative', 
                'bg-white', 
                'p-4', 
                'rounded-lg', 
                'shadow-md', 
                'mb-4',
                'opacity-0', 
                'transition-opacity', 
                'duration-300', 
                'ease-in-out'
            ); 
            recipeResultsContainer.appendChild(recipeDiv);
            requestAnimationFrame(() => {
                recipeDiv.classList.add('opacity-100');
            });
        } else {
            recipeDiv.classList.add('opacity-100');
        }

        // *** Add Remove Button HTML ***
        const removeButtonHTML = `
            <button 
                class="remove-recipe-button absolute top-2 right-2 p-1 rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 transition-colors"
                data-recipe-id="${recipeData.id}"
                aria-label="Remove recipe ${recipeData.title || recipeData.id}"
            >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
            </button>
        `;

        // Build HTML structure for yield controls using new classes
        let yieldControlsHTML = '';
        if (!isLoading && recipeData.yield && recipeData.yield.quantity) {
            const { quantity, unit } = recipeData.yield;
            // Ensure scaleFactor is numeric, default to 1
            const scaleFactor = (typeof recipeData.scaleFactor === 'number' && !isNaN(recipeData.scaleFactor)) ? recipeData.scaleFactor : 1;
            // Calculate display value, handle potential NaN
            let currentDisplayValue = Math.round(quantity * scaleFactor);
            if (isNaN(currentDisplayValue)) { currentDisplayValue = quantity; } // Fallback
            const lowerCaseUnit = unit ? unit.toLowerCase() : ''; // Pre-calculate lowercase unit

            // *** RESTORE CORRECT HTML STRUCTURE ***
            yieldControlsHTML = `
                <div class="scale-yield-controls mt-2 mb-3"> <!-- Removed outer flex for manual layout -->
                    <div class="flex items-center flex-wrap gap-2"> <!-- Top row for controls -->
                        <label for="yield-input-${recipeData.id}" class="text-sm font-medium text-gray-700 whitespace-nowrap">Scale Recipe:</label>
                        <div class="yield-buttons flex">
                            <button data-recipe-id="${recipeData.id}" 
                                    class="yield-decrement bg-gray-200 hover:bg-gray-300 text-gray-700 font-bold py-1 px-2 rounded-l focus:outline-none focus:ring-1 focus:ring-gray-400" 
                                    aria-label="Decrease yield">
                                -
                            </button>
                            <button data-recipe-id="${recipeData.id}" 
                                    class="yield-increment bg-gray-200 hover:bg-gray-300 text-gray-700 font-bold py-1 px-2 rounded-r focus:outline-none focus:ring-1 focus:ring-gray-400" 
                                    aria-label="Increase yield">
                                +
                            </button>
                        </div>
                        <input type="number" id="yield-input-${recipeData.id}" data-recipe-id="${recipeData.id}" value="${currentDisplayValue}" min="1" step="1" aria-labelledby="yield-label-${recipeData.id}" class="w-14 px-2 py-1 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500">
                        <span class="yield-unit-label text-sm text-gray-600" id="yield-label-${recipeData.id}">${lowerCaseUnit}</span> <!-- Unit only -->
                    </div>
                    <div class="text-xs text-gray-500 mt-1 ml-2"> <!-- Bottom row for original yield -->
                        Original Recipe: ${quantity} ${lowerCaseUnit}
                    </div>
                </div>
            `;
        }

        // Generate ingredients HTML string directly
        let ingredientsHTML = `<p>${displayStatus}</p>`; // Use mapped display status
        if (!isLoading) {
            if (recipeData.error) {
                let displayError = recipeData.error; // Default to the original error
                // Check for the specific fallback error
                if (displayError.includes('Fallback extraction failed: LLM returned no valid ingredients')) {
                    const urlSnippet = recipeData.inputUrl ? ` at ${recipeData.inputUrl}` : '';
                    displayError = `No recipe could be identified${urlSnippet}. Please check the URL and try again.`;
                } else if (displayError.startsWith('Network error:') || displayError.startsWith('Upload Error:')) {
                     // Keep network/upload errors as is for now, maybe shorten later
                } else {
                     // Optional: Prefix other errors for clarity
                     displayError = `Error: ${displayError}`;
                }
                ingredientsHTML = `<p class="error text-red-600 p-2 bg-red-50 rounded-md">${displayError}</p>`; // Use error class
            } else if (recipeData.ingredients && recipeData.ingredients.length > 0) {
                ingredientsHTML = renderParsedIngredientsHTML(recipeData);
            } else {
                // Handle case where processing finished but no ingredients found (not an error)
                ingredientsHTML = '<p>No ingredients parsed.</p>';
            }
        }
        
        // Use h3 for title in card
        const displayTitle = isLoading ? `<div class="flex items-center">${spinnerSVG} Processing Recipe...</div>` : recipeData.title;
        // *** Add removeButtonHTML to the output ***
        recipeDiv.innerHTML = ` 
            ${removeButtonHTML} 
            <h3 class="text-lg font-semibold mb-2 pr-8">${displayTitle}</h3> <!-- Add padding-right to avoid overlap -->
            ${yieldControlsHTML}
            ${ingredientsHTML}
        `;

        // Add event listeners for the newly created controls (if not loading)
        if (!isLoading && recipeData.yield) {
             recipeDiv.querySelector('.yield-decrement')?.addEventListener('click', handleYieldChange);
             recipeDiv.querySelector('.yield-increment')?.addEventListener('click', handleYieldChange);
             recipeDiv.querySelector(`#yield-input-${recipeData.id}`)?.addEventListener('change', handleYieldInputChange); // Use change for typed input
             recipeDiv.querySelector(`#yield-input-${recipeData.id}`)?.addEventListener('input', handleYieldInputChange); // Optional: Update scale factor dynamically while typing
        }
        
        // Add listener to parent UL for checkbox changes (event delegation)
        const ingredientsList = recipeDiv.querySelector('.ingredient-list');
        if (ingredientsList) {
            ingredientsList.removeEventListener('change', handleCheckboxChange); 
            ingredientsList.addEventListener('change', handleCheckboxChange);
             ingredientsList.removeEventListener('click', handleListItemClick); 
            ingredientsList.addEventListener('click', handleListItemClick);

            // *** NEW: Apply initial pantry check state AFTER rendering ***
            if (pantryCheckbox && pantryCheckbox.checked) {
                const checkboxes = ingredientsList.querySelectorAll('input.ingredient-checkbox');
                checkboxes.forEach(checkbox => {
                    const index = parseInt(checkbox.dataset.ingredientIndex, 10);
                    const itemData = recipeData.ingredients[index];
                    if (itemData && itemData.ingredient) {
                        const isCommon = commonItemsKeywords.some(keyword => 
                            (itemData.ingredient || '').toLowerCase().includes(keyword)
                        );
                        if (isCommon) {
                            checkbox.checked = false; // Uncheck if pantry box is checked and item is common
                            // Update label style if needed
                            const label = ingredientsList.querySelector(`label[for='${checkbox.id}']`);
                            if (label) {
                                label.classList.add('line-through', 'text-gray-400');
                            }
                        }
                    }
                });
            }
            // *** END NEW ***
        }
    }

    // Event handler for yield buttons and input changes
    function handleYieldChange(event) {
        const target = event.target;
        const recipeId = target.dataset.recipeId;
        const recipeData = processedRecipes.find(r => r.id === recipeId);

        if (!recipeData || !recipeData.yield || !recipeData.yield.quantity) return;

        const inputElement = document.getElementById(`yield-input-${recipeId}`);
        let currentDisplayValue = parseInt(inputElement.value, 10);
        const originalQuantity = recipeData.yield.quantity;

        if (target.classList.contains('yield-decrement')) {
            currentDisplayValue = Math.max(1, currentDisplayValue - 1);
        } else if (target.classList.contains('yield-increment')) {
            currentDisplayValue += 1;
        } else { // Direct input change
            if (isNaN(currentDisplayValue) || currentDisplayValue < 1) {
                currentDisplayValue = Math.round(originalQuantity * recipeData.scaleFactor);
                if (isNaN(currentDisplayValue) || currentDisplayValue < 1) { 
                    currentDisplayValue = originalQuantity;
                }
            }
        }

        inputElement.value = currentDisplayValue; 
        recipeData.scaleFactor = originalQuantity > 0 ? currentDisplayValue / originalQuantity : 1; 
        
        // *** RESTORE Ingredient Text Update Logic *** 
        const recipeCard = document.getElementById(recipeId);
        const ingredientItems = recipeCard?.querySelectorAll('.ingredients-list li'); 
        
        if (ingredientItems && recipeData.ingredients) {
             const newScaleFactor = recipeData.scaleFactor; // Use the updated scale factor
             ingredientItems.forEach(li => {
                 const checkbox = li.querySelector('input[type="checkbox"]');
                 if (!checkbox) return; // Skip if checkbox not found

                 const index = parseInt(checkbox.dataset.ingredientIndex, 10);
                 const itemData = recipeData.ingredients[index];
                 const label = li.querySelector('label');
                 
                 if (itemData && label) {
                     let displayQuantity = '';
                     if (itemData.quantity !== null && typeof itemData.quantity === 'number') {
                         const scaledValue = itemData.quantity * newScaleFactor;
                         // Format to max 2 decimal places, removing trailing zeros
                         displayQuantity = parseFloat(scaledValue.toFixed(2)).toString();
                         // Original formatting logic (might need refinement for fractions etc.)
                         // displayQuantity = scaledValue.toFixed(2);
                         // if (displayQuantity.endsWith('.00')) { 
                         //     displayQuantity = displayQuantity.slice(0, -3); // Remove .00
                         // } else if (displayQuantity.includes('.') && displayQuantity.endsWith('0')) {
                         //     displayQuantity = displayQuantity.slice(0, -1); // Remove trailing 0 only if there's a decimal
                         // }
                         // displayQuantity = displayQuantity.toString(); 
                     } else if (itemData.quantity !== null) {
                         // Handle non-numeric quantities (just display original)
                         displayQuantity = itemData.quantity.toString();
                     }
                     const unit = itemData.unit || '';
                     const ingredientName = itemData.ingredient || '';
                     const text = `${displayQuantity} ${unit} ${ingredientName}`.replace(/\s+/g, ' ').trim();
                     label.textContent = text; // Update the text of the existing label
                 }
             });
        }
        // *** End of RESTORED Logic ***
        
        updateCreateListButtonState(); 
    }
    
    // Handler for dynamic input updates (optional)
    function handleYieldInputChange(event) {
         handleYieldChange(event); // Reuse the main logic for now
    }

    // UPDATED: Returns an HTML string for the ingredients list with checkboxes
    function renderParsedIngredientsHTML(recipeData) {
        let html = `<h5 class="text-base font-medium text-gray-600 mb-2">Parsed Ingredients:</h5>`; 
        html += '<ul class="ingredients-list space-y-1">'; 
        recipeData.ingredients.forEach((item, index) => {
            const isChecked = true; // Default to checked in the HTML string

            const ingredientText = `${item.quantity || ''} ${item.unit || ''} ${item.ingredient || ''}`.trim();
            const uniqueId = `ingredient-${recipeData.id}-${index}`;
            html += `
                <li class="flex items-center">
                    <input type="checkbox" id="${uniqueId}" 
                           data-recipe-id="${recipeData.id}" 
                           data-ingredient-index="${index}" 
                           checked  // Always initially checked in HTML
                           class="ingredient-checkbox h-4 w-4 text-orange-600 border-gray-300 rounded focus:ring-orange-500 mr-2 shrink-0">
                    <label for="${uniqueId}" class="ingredient-label text-sm">
                        ${ingredientText}
                    </label>
                </li>
            `;
        });
        html += '</ul>';
        return html;
    }
    
    // Handler for clicking on list item (li) to toggle checkbox
    function handleListItemClick(event) {
        // Only act if the click target is the LI or the LABEL within it
        if (event.target.tagName === 'LI' || event.target.tagName === 'LABEL') {
            // Find the checkbox within this list item
            const listItem = event.target.closest('.ingredient-item');
            const checkbox = listItem?.querySelector('input[type="checkbox"]');
            if (checkbox && event.target !== checkbox) { // Avoid double toggling if checkbox itself was clicked
                 checkbox.checked = !checkbox.checked;
                 // Manually trigger change event on checkbox for consistency
                 const changeEvent = new Event('change', { bubbles: true });
                 checkbox.dispatchEvent(changeEvent);
            }
        }
    }
    
    // Handler for checkbox changes (updates the underlying data)
    function handleCheckboxChange(event) {
        if (event.target.type === 'checkbox') {
            const checkbox = event.target;
            const recipeId = checkbox.dataset.recipeId;
            const ingredientIndex = parseInt(checkbox.dataset.ingredientIndex, 10);
            const recipeData = processedRecipes.find(r => r.id === recipeId);
            
            if (recipeData && recipeData.ingredients[ingredientIndex]) {
                // Update the checked state in our data store
                recipeData.ingredients[ingredientIndex].checked = checkbox.checked;
                console.log(`Updated ${recipeId} ingredient ${ingredientIndex} checked state to: ${checkbox.checked}`);
            }
            updateCreateListButtonState(); // Update button state if needed (e.g., disable if all unchecked?)
        }
    }

    // Renamed function: Handles getting the processed list from backend
    async function handleReviewList() { 
        if (!createListButton) return;
        // --- Deduplicate processedRecipes --- 
        const uniqueRecipeIds = new Set();
        const uniqueProcessedRecipes = processedRecipes.filter(recipe => {
            if (!uniqueRecipeIds.has(recipe.id)) {
                uniqueRecipeIds.add(recipe.id);
                return true;
            }
            return false;
        });
        console.log("Review List button clicked. Processing unique recipes:", uniqueProcessedRecipes);
        // -----------------------------------

        setReviewLoadingState(true); // New loading state for review generation
        clearReviewAreaAndFinalLink(); // Clear previous review/link

        let allScaledIngredients = [];
        let validRecipeTitles = [];

        // --- Use the deduplicated list --- 
        uniqueProcessedRecipes.forEach(recipeData => {
            if (!recipeData.error && recipeData.ingredients.length > 0) {
                let hasCheckedIngredients = false;
                const scaledAndFiltered = recipeData.ingredients
                    // FIX: Include items where checked is undefined (default is checked)
                    .filter(item => (item.checked === undefined || item.checked === true)) 
                    .map(item => {
                        let finalQuantity = item.quantity;
                        // Apply scaling ONLY if the original quantity is numeric
                        if (item.quantity !== null && typeof item.quantity === 'number' && recipeData.scaleFactor !== 1) {
                            finalQuantity = parseFloat((item.quantity * recipeData.scaleFactor).toFixed(2));
                            // Prevent scaling down to zero for non-zero original quantities
                            if (finalQuantity <= 0 && item.quantity > 0) finalQuantity = 0.01; 
                        }
                        hasCheckedIngredients = true;
                        return {
                            ingredient: item.ingredient || 'Unknown Ingredient',
                            quantity: finalQuantity,
                            unit: item.unit // Keep original unit (or null) for backend processing
                        };
                    });

                if (hasCheckedIngredients) {
                    validRecipeTitles.push(recipeData.title || 'Untitled Recipe');
                    allScaledIngredients = allScaledIngredients.concat(scaledAndFiltered);
                }
            }
        });

        if (allScaledIngredients.length === 0) {
            console.log("No ingredients selected to review.");
            displayReviewError("No ingredients selected. Check some items before reviewing the list.");
            setReviewLoadingState(false);
            return;
        }

        const listTitle = validRecipeTitles.length > 0 ? `Ingredients for ${validRecipeTitles.join(', ')}` : 'My Recipe List';
        console.log("Final raw ingredients being sent to backend for Stage 2:", allScaledIngredients);
        console.log("List Title:", listTitle);

        try {
            // Call the MODIFIED endpoint which returns the processed list
            const response = await fetch(`${backendUrl}/api/create-list`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ 
                    ingredients: allScaledIngredients,
                    title: listTitle
                }),
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.details || data.error || `Server error: ${response.statusText}`);
            }

            // *** NEW: Display the returned processed list for review ***
            if (data.processedIngredients && data.originalTitle) {
                // Make Section 3 visible with fade-in
                const finalListSection = document.getElementById('final-list-section');
                if (finalListSection) {
                    // finalListSection.style.display = 'block'; // Remove direct display style change
                    finalListSection.classList.remove('opacity-0'); // Make it potentially visible
                    finalListSection.style.display = 'block'; // Set display block first
                    // Trigger opacity change
                    requestAnimationFrame(() => { 
                         finalListSection.classList.add('opacity-100'); 
                    });
                }
                setReviewLoadingState(false); 
                displayReviewList(data.processedIngredients, data.originalTitle, validRecipeTitles);
            } else {
                throw new Error("Backend did not return the processed ingredient list.");
            }

        } catch (error) {
            console.error('Error getting processed list for review:', error);
            displayReviewError(`Failed to generate list for review: ${error.message}`);
            // Ensure loading state is false on error too
            setReviewLoadingState(false);
        }
    }

    // --- NEW: Function to display the review list ---
    function displayReviewList(ingredients, originalTitle, validRecipeTitles = []) {
        console.log("[displayReviewList] Received ingredients:", JSON.parse(JSON.stringify(ingredients))); 
        console.log("[displayReviewList] Received titles:", validRecipeTitles);
        if (!reviewListArea) {
            console.error("[displayReviewList] reviewListArea element not found!");
            return;
        }
        reviewListArea.innerHTML = ''; // Clear previous content

        // Add helper text for review section
        const reviewHelper = document.createElement('p');
        reviewHelper.classList.add('text-sm', 'text-gray-600', 'mb-4');
        reviewHelper.textContent = "Review your combined shopping list. Uncheck any items you don't want before sending to Instacart.";
        reviewListArea.appendChild(reviewHelper);

        // *** Add Dynamic Title Header ***
        if (validRecipeTitles.length > 0) {
            const titleHeader = document.createElement('h3');
            titleHeader.classList.add('text-lg', 'font-semibold', 'mb-2'); // Match recipe card title style
            
            let titleText = 'Ingredients for ';
            if (validRecipeTitles.length === 1) {
                titleText += validRecipeTitles[0];
            } else if (validRecipeTitles.length === 2) {
                titleText += `${validRecipeTitles[0]} and ${validRecipeTitles[1]}`;
            } else { // 3 or more
                const lastTitle = validRecipeTitles.pop();
                titleText += validRecipeTitles.join(', ') + ', and ' + lastTitle;
            }
            titleHeader.textContent = titleText;
            reviewListArea.appendChild(titleHeader);
        }
        // *** End Dynamic Title Header ***

        if (!ingredients || ingredients.length === 0) {
            console.warn("[displayReviewList] No ingredients to display.");
            reviewListArea.innerHTML += '<p>No ingredients generated after consolidation.</p>';
            return;
        }

        const list = document.createElement('ul');
        list.classList.add('review-ingredient-list', 'border', 'border-gray-300', 'rounded', 'p-4', 'space-y-2'); 
        console.log("[displayReviewList] Created UL element.");

        // ingredients is now expected to be [{name: ..., line_item_measurements: [{unit, quantity}, ...]}, ...]
        try {
            ingredients.forEach((item, index) => {
                console.log(`[displayReviewList] Processing item ${index}:`, JSON.parse(JSON.stringify(item)));
                const li = document.createElement('li');
                li.classList.add('ingredient-item', 'flex', 'items-center', 'space-x-2'); 
                
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = `review-ingredient-${index}`;
                checkbox.checked = true; 
                try {
                    checkbox.dataset.itemData = JSON.stringify(item);
                } catch (stringifyError) {
                    console.error(`[displayReviewList] Error stringifying item data for index ${index}:`, stringifyError, item);
                    // Skip this item if data can't be stored
                    return; 
                }
                
                // --- Display Primary Measurement (with fixes) --- 
                let displayText = 'Error: Could not determine display text'; // Default error message
                let primaryMeasurement = null;

                if (item.line_item_measurements && item.line_item_measurements.length > 0) {
                    // **FIX 1: Prioritize 'each' (head) for garlic display**
                    if (item.name === 'garlic') {
                        primaryMeasurement = item.line_item_measurements.find(m => m.unit === 'each' || m.unit === 'head');
                    }
                    // If not garlic or 'each' not found for garlic, use the first measurement
                    if (!primaryMeasurement) {
                        primaryMeasurement = item.line_item_measurements[0]; 
                    }
                    console.log(`[displayReviewList] Item ${index} - Primary Measurement:`, primaryMeasurement);

                    // **FIX 2: Avoid duplicating name if unit contains it (Revised)**
                    // Ensure primaryMeasurement and its quantity are valid before proceeding
                    if (primaryMeasurement && typeof primaryMeasurement.quantity !== 'undefined' && primaryMeasurement.quantity !== null) {
                        const quantityStr = primaryMeasurement.quantity; // Keep as number for now
                        const unitStr = primaryMeasurement.unit || '';
                        const nameStr = item.name || '';

                        // Stricter Check V2: Check if unit string *ends with* the name string, ignoring case.
                        // This handles "fresh thyme sprigs" vs "thyme" better than includes().
                        const unitLower = unitStr.toLowerCase();
                        const nameLower = nameStr.toLowerCase();
                        // Also check if unit is just the plural of name (e.g. unit='bay leaves', name='bay leaf')
                        const isPluralOfName = unitLower.endsWith('s') && unitLower.slice(0, -1) === nameLower;
                        
                        if (unitLower.endsWith(nameLower) || isPluralOfName) {
                            displayText = `${quantityStr} ${unitStr}`.trim();
                            // Add console log for debugging this specific case
                            // console.log(`Herb Check: Unit '${unitStr}' contained name '${nameStr}' or was plural. Display: '${displayText}'`);
                        } else {
                            displayText = `${quantityStr} ${unitStr} ${nameStr}`.replace(/\s+/g, ' ').trim();
                        }
                    } else {
                         console.warn(`[displayReviewList] Item ${index} - Missing quantity in primary measurement:`, primaryMeasurement);
                         displayText = ` ${item.name || 'Unknown Item'} (Quantity Error)`;
                    }
                    
                } else {
                     console.warn(`[displayReviewList] Item ${index} - Missing line_item_measurements.`);
                    // Fallback if no measurements
                    displayText = ` ${item.name || 'Unknown Item'} (Measurement Error)`; 
                }
                console.log(`[displayReviewList] Item ${index} - Generated displayText:`, displayText);
                // ----------------------------------

                const label = document.createElement('label');
                label.htmlFor = `review-ingredient-${index}`;
                label.textContent = displayText;
                label.classList.add('text-gray-700');
                
                console.log(`[displayReviewList] Item ${index} - Appending checkbox and label to LI.`);
                li.appendChild(checkbox);
                li.appendChild(label);

                console.log(`[displayReviewList] Item ${index} - Appending LI to UL.`);
                list.appendChild(li);
            });
            console.log("[displayReviewList] Finished forEach loop.");
        } catch (loopError) {
            console.error("[displayReviewList] Error during ingredients.forEach loop:", loopError);
            // Display a general error message in the review area
            reviewListArea.innerHTML += `<p class="error">An error occurred while building the review list item. Check the console for details.</p>`;
        }

        console.log("[displayReviewList] Appending UL to reviewListArea.");
        reviewListArea.appendChild(list);
        console.log("[displayReviewList] UL appended.");

        console.log("[displayReviewList] Function finished.");
    }

    // --- NEW: Function to handle sending the final list ---
    async function handleSendToInstacart(event) {
        // No longer inside a form, so preventDefault might not be needed, but doesn't hurt.
        // event.preventDefault(); // Assuming it might be triggered by other means eventually.

        // --- Show Loading State ---
        setInstacartLoadingState(true, 'Building your shopping cart, please wait...');
        clearInstacartResults(); // Clear previous errors/links

        const finalIngredients = [];
        const listItems = reviewListArea.querySelectorAll('li.ingredient-item'); // Target specific list items

        listItems.forEach(item => {
            // *** FIX: Find the checkbox *within* the list item ***
            const checkbox = item.querySelector('input[type="checkbox"]');
            // *** Ensure checkbox exists and is checked ***
            if (checkbox && checkbox.checked) {
                // Retrieve the full data stored on the checkbox element
                try {
                    // *** FIX: Parse data from checkbox.dataset.itemData ***
                    const itemData = JSON.parse(checkbox.dataset.itemData);
                    if (itemData) {
                        // The backend expects the full structure including 'line_item_measurements'
                        finalIngredients.push(itemData); 
                    } else {
                         console.warn("Could not parse ingredient data for item:", item.textContent);
                    }
                } catch (e) {
                    // *** FIX: Log the correct dataset that failed parsing ***
                    console.error("Error parsing ingredient data from list item checkbox:", checkbox.dataset.itemData, e);
                }
            }
        });

        if (finalIngredients.length === 0) {
            displayInstacartError("No ingredients selected to add to cart.");
            setInstacartLoadingState(false); // Re-enable button
            return;
        }

        // --- Log final payload for debugging ---
        console.log("Sending to Instacart:", JSON.stringify({ items: finalIngredients }, null, 2));

        try {
            const response = await fetch(`${backendUrl}/api/send-to-instacart`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                // *** FIX: Send the array under the 'ingredients' key, not 'items' ***
                body: JSON.stringify({ ingredients: finalIngredients }), 
            });

            if (response.ok) {
                const data = await response.json();
                if (data.instacartUrl) {
                    console.log("Instacart URL received:", data.instacartUrl);
                    // --- Redirect on Success - Open in New Tab ---
                    window.open(data.instacartUrl, '_blank');
                    // Since it opens in a new tab, we *should* clear the loading state
                    // of the button on the original page.
                    setInstacartLoadingState(false); // Hide loading, re-enable button
                } else {
                    // Handle cases where response is OK but URL is missing
                    console.error('Instacart API call succeeded but no URL was returned.');
                    displayInstacartError('Failed to get Instacart link. Please try again.');
                    setInstacartLoadingState(false); // Hide loading, re-enable button
                }
            } else {
                // Handle non-OK responses (4xx, 5xx)
                const errorData = await response.json().catch(() => ({})); // Try to parse error
                const errorMessage = errorData.error || `Request failed with status ${response.status}`;
                console.error('Error sending list to Instacart:', response.status, errorMessage);
                displayInstacartError(`Error: ${errorMessage}. Please check items and try again.`);
                setInstacartLoadingState(false); // Hide loading, re-enable button
            }
        } catch (error) {
            // Handle network errors or other fetch issues
            console.error('Network error sending list to Instacart:', error);
            displayInstacartError('Network error. Please check connection and try again.');
            setInstacartLoadingState(false); // Hide loading, re-enable button
        }
    }

    // Refined Loading State function
    function setInstacartLoadingState(isLoading, message = '') {
        const sendButton = document.getElementById('sendToInstacartButton');
        
        if (isLoading) {
            if (sendButton) {
                sendButton.disabled = true;
                // Optionally visually gray out or change style
                sendButton.classList.add('opacity-50', 'cursor-wait'); 
            }
            instacartLoadingIndicator.textContent = message;
            instacartLoadingIndicator.style.display = 'block';
            instacartErrorMessageDiv.style.display = 'none'; // Hide error when loading starts
        } else {
            if (sendButton) {
                sendButton.disabled = false;
                sendButton.classList.remove('opacity-50', 'cursor-wait');
            }
            instacartLoadingIndicator.style.display = 'none';
        }
    }

    // Refined Error Display function
    function displayInstacartError(message) {
        instacartErrorMessageDiv.textContent = message;
        instacartErrorMessageDiv.style.display = 'block';
        instacartLoadingIndicator.style.display = 'none'; // Ensure loading is hidden
        // We now handle enabling the button within setInstacartLoadingState(false) called by the error handler
    }

    // Clear Previous Results (Error or Link)
    function clearInstacartResults() {
        instacartErrorMessageDiv.textContent = '';
        instacartErrorMessageDiv.style.display = 'none';
        instacartLoadingIndicator.textContent = '';
        instacartLoadingIndicator.style.display = 'none';
        // Do NOT remove the button itself here, just clear feedback areas.
        // const linkArea = document.getElementById('instacart-link-area');
        // if(linkArea) linkArea.innerHTML = ''; // Keep the button!
    }

    // --- DEPRECATED: No longer displaying the link, redirecting instead ---
    /*
    function displayInstacartLink(url) {
        instacartLinkArea.innerHTML = ''; // Clear previous links/buttons
        const linkButton = document.createElement('a');
        linkButton.href = url;
        linkButton.target = '_blank'; // Open in new tab
        linkButton.rel = 'noopener noreferrer';
        linkButton.textContent = 'Open Instacart Shopping List';
        // Apply button-like styling with Tailwind
        linkButton.className = 'inline-block bg-orange-500 hover:bg-orange-600 text-white font-bold py-3 px-6 rounded-md transition duration-150 ease-in-out active:scale-95 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500';

        instacartLinkArea.appendChild(linkButton);
        instacartLoadingIndicator.style.display = 'none'; // Hide loading
        instacartErrorMessageDiv.style.display = 'none'; // Hide error
    }
    */
   // --- END DEPRECATED ---

    // --- Function to create and add the master pantry checkbox/toggle ---
    function createPantryCheckbox() {
        console.log("Attempting to create pantry checkbox/toggle...");
        // Check if it already exists
        if (document.getElementById('pantry-items-checkbox')) {
            console.log("Pantry checkbox/toggle already exists.");
            return; // Don't recreate if it's already there
        }
        
        const resultsSection = document.getElementById('results-section');
        const recipeResultsContainer = document.getElementById('recipe-results-container');

        // Create the main container div for the toggle and its labels
        const containerDiv = document.createElement('div');
        // Increased bottom margin for more space
        containerDiv.classList.add('flex', 'items-center', 'mb-6', 'px-1'); 

        // --- Create the Toggle Switch Structure ---
        const toggleLabelContainer = document.createElement('label');
        toggleLabelContainer.classList.add('relative', 'inline-flex', 'items-center', 'cursor-pointer');

        // Create the hidden checkbox input element (the 'peer')
        pantryCheckbox = document.createElement('input'); // Assign to the globally scoped variable
        pantryCheckbox.type = 'checkbox';
        pantryCheckbox.id = 'pantry-items-checkbox';
        // Hide the default checkbox but keep it accessible and functional
        pantryCheckbox.classList.add('sr-only', 'peer'); 

        // Create the background track of the toggle
        const toggleBackground = document.createElement('div');
        toggleBackground.classList.add(
            "w-9", "h-5", // Size (Smaller)
            "bg-gray-200", // Default background
            "peer-focus:outline-none", 
            "peer-focus:ring-2", "peer-focus:ring-blue-300", // Focus ring (Smaller)
            "dark:peer-focus:ring-blue-800", 
            "rounded-full", // Shape
            "peer", 
            "dark:bg-gray-700", 
            "peer-checked:after:translate-x-full", // Knob movement
            "rtl:peer-checked:after:-translate-x-full", 
            "peer-checked:after:border-white", // Knob border when checked
            "after:content-['']", 
            "after:absolute", "after:top-[1px]", "after:start-[1px]", // Knob position (Adjusted)
            "after:bg-white", // Knob color
            "after:border-gray-300", "after:border", // Knob border
            "after:rounded-full", // Knob shape
            "after:h-4", "after:w-4", // Knob size (Smaller)
            "after:transition-all", // Knob transition
            "dark:border-gray-600", 
            "peer-checked:bg-blue-500" // Background color when checked (using primary blue)
        );

        // Append the hidden checkbox and the background track to the toggle label container
        toggleLabelContainer.appendChild(pantryCheckbox);
        toggleLabelContainer.appendChild(toggleBackground);
        
        // --- Create the Text Label ---
        const textLabel = document.createElement('span');
        // Remove text-black class as inline style is used
        textLabel.classList.add('ms-3', 'text-sm', 'font-medium', 'dark:text-gray-300'); 
        textLabel.textContent = 'I have common pantry items'; 
        // *** DIAGNOSTIC TEST: Apply inline style ***
        textLabel.style.color = 'black';

        // Create the helper text span (unchanged)
        const helperSpan = document.createElement('span');
        helperSpan.classList.add('text-xs', 'text-gray-600', 'ml-1'); // Darker Helper Text
        helperSpan.textContent = '(salt, pepper, oil, sugar, etc.)'; 

        // Append the toggle switch container, text label, and helper span to the main container div
        containerDiv.appendChild(toggleLabelContainer);
        containerDiv.appendChild(textLabel);
        containerDiv.appendChild(helperSpan);

        // Insert the container into the DOM (same logic as before)
        if (resultsSection && recipeResultsContainer) {
             resultsSection.insertBefore(containerDiv, recipeResultsContainer);
             console.log("Pantry toggle inserted into DOM.");
        } else {
             console.error("Could not find resultsSection or recipeResultsContainer to insert pantry toggle.");
             return; 
        }

        // Add the event listener to the newly created hidden checkbox (same logic as before)
        pantryCheckbox.addEventListener('change', handlePantryCheckboxChange);
        console.log("Event listener added to pantry toggle checkbox.");

        // Check initial state (same logic as before)
        updatePantryCheckboxInitialState();
    }

    // --- Handler for the master pantry checkbox --- 
    function handlePantryCheckboxChange(event) {
        if (!pantryCheckbox) return; // Guard against null checkbox

        const isChecked = event.target.checked;
        // If master checkbox is checked, corresponding ingredient checkboxes should be unchecked (checked = false)
        // If master checkbox is unchecked, corresponding ingredient checkboxes should be checked (checked = true)
        const shouldIngredientBeChecked = !isChecked;
        console.log(`Pantry checkbox toggled. Master checked: ${isChecked}. Ingredients should be checked: ${shouldIngredientBeChecked}`);

        // Iterate through all *currently displayed* recipe cards
        processedRecipes.forEach(recipeInfo => {
            if (!recipeInfo || !recipeInfo.ingredients) return;

            const recipeCard = document.getElementById(recipeInfo.id);
            if (!recipeCard) return; // Skip if card not found in DOM

            // Find all ingredient checkboxes within this specific recipe card
            const ingredientCheckboxes = recipeCard.querySelectorAll('.ingredient-checkbox');
            
            ingredientCheckboxes.forEach(checkboxElement => {
                const index = parseInt(checkboxElement.dataset.ingredientIndex, 10);
                // Get the corresponding ingredient data using the index
                const itemData = recipeInfo.ingredients[index]; 

                if (itemData && itemData.ingredient) { // Ensure item data and ingredient name exist
                    const ingredientNameLower = itemData.ingredient.toLowerCase();
                    // Check if the ingredient name includes any of the common keywords
                    const isCommon = commonItemsKeywords.some(keyword => ingredientNameLower.includes(keyword));

                    if (isCommon) {
                        // Update the DOM checkbox state
                        checkboxElement.checked = shouldIngredientBeChecked;
                        
                        // Update the label styling (line-through, text color)
                        const labelElement = recipeCard.querySelector(`label[for='${checkboxElement.id}']`);
                        if (labelElement) {
                            if (shouldIngredientBeChecked) {
                                // Re-check the item: remove line-through and gray color
                                labelElement.classList.remove('line-through', 'text-gray-400');
                            } else {
                                // Uncheck the item: add line-through and gray color
                                labelElement.classList.add('line-through', 'text-gray-400');
                            }
                        }
                        
                        // Update the underlying data model (important!)
                        // This ensures the state persists if the card is re-rendered (though it shouldn't be)
                        itemData.checked = shouldIngredientBeChecked;
                    }
                }
            });
        });
        
        // Update the main button state if needed (e.g., if unchecking all makes list empty)
        updateCreateListButtonState(); 
    }

    // --- Helper to set the initial state of the pantry checkbox --- 
    function updatePantryCheckboxInitialState() {
        if (!pantryCheckbox) return; // Only run if checkbox exists

        let allCommonAreUnchecked = true;
        let foundAnyCommon = false;

        processedRecipes.forEach(recipeInfo => {
            if (!recipeInfo || !recipeInfo.ingredients) return;
            const recipeCard = document.getElementById(recipeInfo.id);
            if (!recipeCard) return;

            const ingredientCheckboxes = recipeCard.querySelectorAll('.ingredient-checkbox');
            ingredientCheckboxes.forEach(checkboxElement => {
                const index = parseInt(checkboxElement.dataset.ingredientIndex, 10);
                const itemData = recipeInfo.ingredients[index];
                if (itemData && itemData.ingredient) {
                    const isCommon = commonItemsKeywords.some(keyword => 
                        itemData.ingredient.toLowerCase().includes(keyword)
                    );
                    if (isCommon) {
                        foundAnyCommon = true;
                        if (checkboxElement.checked) { // If any common item IS checked...
                            allCommonAreUnchecked = false; // ...then the pantry box should be unchecked
                        }
                    }
                }
            });
        });

        // If we found common items AND they were all unchecked, the pantry box should be checked.
        // Otherwise (no common items found, or at least one common item was checked), it should be unchecked.
        pantryCheckbox.checked = foundAnyCommon && allCommonAreUnchecked;
        console.log(`Pantry checkbox initial state set to checked: ${pantryCheckbox.checked} (Found common: ${foundAnyCommon}, All common unchecked: ${allCommonAreUnchecked})`);
    }

    // --- Function to Update the State of the "Review Final List" Button ---
    function updateCreateListButtonState() {
        if (!createListButton) {
            console.warn("updateCreateListButtonState: createListButton not found.");
            return; // Guard if button doesn't exist
        }
        // Check if there is at least one recipe in processedRecipes that has finished
        // processing (no error) and has at least one ingredient.
        const hasSuccessfullyProcessedIngredients = processedRecipes.some(recipe => 
            !recipe.error && recipe.ingredients && recipe.ingredients.length > 0
        );

        console.log(`Updating createListButton state. Has ingredients: ${hasSuccessfullyProcessedIngredients}`);
        createListButton.disabled = !hasSuccessfullyProcessedIngredients;

        // Also potentially disable pantry checkbox if no ingredients yet
        // Re-check existence of pantryCheckbox as it might be created later
        const currentPantryCheckbox = document.getElementById('pantry-items-checkbox'); 
        if (currentPantryCheckbox) {
             currentPantryCheckbox.disabled = !hasSuccessfullyProcessedIngredients;
             if (!hasSuccessfullyProcessedIngredients) {
                 currentPantryCheckbox.checked = false; // Reset if disabled
             }
        }
    }

    // --- Function to Set Loading State for Review List Generation ---
    function setReviewLoadingState(isLoading) {
        const finalListSection = document.getElementById('final-list-section');
        // Show/hide a simple text indicator within the review area or show/hide the section itself
        if (isLoading) {
            // Disable the "Review Final List" button while processing
            if (createListButton) { 
                createListButton.disabled = true; 
                // Optionally add spinner to button text
                createListButton.innerHTML = `${spinnerSVG} Generating List...`;
            }
            // Optionally hide the final section until loading is complete
            // if (finalListSection) finalListSection.style.display = 'none';
            // Or display a message within the review area
            // if (reviewListArea) reviewListArea.innerHTML = '<p>Generating review list...</p>';
        } else {
            // Re-enable the button and restore text when done loading (success or error)
            if (createListButton) { 
                createListButton.disabled = false; 
                createListButton.innerHTML = 'Review Final List'; // Restore original text
            }
            // Section visibility is handled by displayReviewList on success
        }
    }

    // --- NEW: Function to start polling ---
    function startPollingJobStatus(recipeId, jobId) {
        const recipeInfo = recipeData[recipeId];
        if (!recipeInfo) {
            console.error(`[Polling ${jobId}] Cannot start polling, recipe data not found in map for ID: ${recipeId}`);
            return;
        }

        // Clear any previous intervals/timeouts for this recipe
        if (recipeInfo.pollingIntervalId) clearInterval(recipeInfo.pollingIntervalId);
        if (recipeInfo.pollingTimeoutId) clearTimeout(recipeInfo.pollingTimeoutId);

        recipeInfo.pollingAttempts = 0; // Reset attempts counter

        // Initial immediate check
        pollJobStatus(recipeId, jobId);

        // Set up polling interval
        recipeInfo.pollingIntervalId = setInterval(() => {
            pollJobStatus(recipeId, jobId);
        }, POLLING_INTERVAL);

        // Set up overall timeout (e.g., 20 seconds)
        recipeInfo.pollingTimeoutId = setTimeout(() => {
            console.warn(`[Recipe ${recipeId}] Polling timed out after ${POLLING_TIMEOUT_MS}ms.`);
            clearInterval(recipeInfo.pollingIntervalId); // Stop polling
            // Set error message based on last known status
            if (recipeInfo.lastKnownStatus === 'vision_completed') {
                recipeInfo.error = 'Recipe analysis timed out. Please try again.';
            } else {
                recipeInfo.error = 'Processing timed out. Please try again.';
            }
            renderSingleRecipeResult(recipeInfo, false); // Render error state
            updateCreateListButtonState();
        }, POLLING_TIMEOUT_MS);
    }

    // --- NEW: Function to poll status --- 
    async function pollJobStatus(recipeId, jobId) {
        const recipeInfo = recipeData[recipeId];
        if (!recipeInfo) {
            console.error(`[Polling ${jobId}] Cannot poll, recipe data not found in map for ID: ${recipeId}`);
            // Cannot clear intervals if recipeInfo is not found
            return;
        }

        recipeInfo.pollingAttempts += 1;
        console.log(`[Recipe ${recipeId}] Polling attempt ${recipeInfo.pollingAttempts} for job ${jobId}...`);

        if (recipeInfo.pollingAttempts > MAX_POLLING_ATTEMPTS) {
            console.warn(`[Recipe ${recipeId}] Max polling attempts reached for recipe ${recipeId}. Stopping polling.`);
            clearInterval(recipeInfo.pollingIntervalId);
            recipeInfo.pollingIntervalId = null;
            recipeInfo.error = 'Processing timed out. Please try again.';
            renderSingleRecipeResult(recipeInfo, false); // Show timeout error
            updateCreateListButtonState();
            return;
        }

        try {
            const response = await fetch(`${backendUrl}/api/job-status?jobId=${jobId}`);
            const data = await response.json();

            console.log(`[Recipe ${recipeId}] Job Status Response:`, JSON.stringify(data));

            recipeInfo.lastKnownStatus = data.status; // Update last known status

            // --- Update UI based on specific status --- 
            renderSingleRecipeResult(recipeInfo, true, `Processing...`, data.status);

            if (data.status === 'completed') {
                console.log(`[Recipe ${recipeId}] Job completed successfully.`);
                stopPolling(recipeId); // Stop polling and timeout
                // Update recipe data with results
                recipeInfo.title = data.result.title || (recipeInfo.file ? recipeInfo.file.name : recipeInfo.inputUrl);
                recipeInfo.yield = data.result.yield || null;
                recipeInfo.ingredients = data.result.ingredients || [];
                recipeInfo.extractedText = data.result.extractedText;
                recipeInfo.scaleFactor = 1; // Reset scale factor
                recipeInfo.error = null; // Clear any previous error
                
                // *** Move completed data from map to array - WITH DUPLICATE CHECK ***
                if (!processedRecipes.some(r => r.id === recipeId)) {
                    processedRecipes.push(recipeInfo); // Add to final results array
                } else {
                    console.warn(`[Polling ${jobId}] Duplicate completion detected for ${recipeId}. Ignoring.`);
                }
                // Remove from the map once processing is final
                delete recipeData[recipeId];
                // ****************************************************

                renderSingleRecipeResult(recipeInfo, false); // Render final result
                updateCreateListButtonState();
                updateEmptyStateVisibility(); // << Add call here
                
                // If this was the last job being processed, create the pantry checkbox
                if (Object.keys(recipeData).length === 0 && !document.getElementById('pantry-checkbox-container')) {
                    createPantryCheckbox();
                }

            } else if (data.status === 'failed') {
                console.error(`[Recipe ${recipeId}] Job failed. Reason:`, data.error);
                stopPolling(recipeId); // Stop polling and timeout
                recipeInfo.error = data.error || 'Processing failed.'; // Store the error
                
                // *** Move failed data from map to array for display - WITH DUPLICATE CHECK ***
                if (!processedRecipes.some(r => r.id === recipeId)) {
                    processedRecipes.push(recipeInfo); // Add to final results array
                } else {
                    console.warn(`[Polling ${jobId}] Duplicate failure detected for ${recipeId}. Ignoring.`);
                }
                delete recipeData[recipeId]; // Remove from map
                // ***********************************************************

                renderSingleRecipeResult(recipeInfo, false); // Re-render the card to show the error
                updateCreateListButtonState(); // Update button state after failure
                updateEmptyStateVisibility(); // << Add call here

                // If this was the last job being processed, create the pantry checkbox
                if (Object.keys(recipeData).length === 0 && !document.getElementById('pantry-checkbox-container')) {
                    createPantryCheckbox();
                }

            } else if (data.status === 'pending' || data.status === 'vision_completed' || data.status === 'processing_started' || data.status === 'fetching_html' || data.status === 'parsing_jsonld' || data.status === 'llm_parsing_ingredients' || data.status === 'parsing_readability' || data.status === 'llm_parsing_fallback' ) { // Added URL statuses
                // Continue polling, check max attempts
                // DO NOT render final state here - handled by timeout or next successful poll
            } else if (data.status === 'not_found') {
                console.error(`[Recipe ${recipeId}] Job ID ${jobId} not found. Stopping polling.`);
                stopPolling(recipeId, 'Processing job data lost. Please try again.');
            } else {
                // Unexpected status
                console.warn(`[Recipe ${recipeId}] Received unexpected status '${data.status}' for recipe ${recipeId}.`);
                // Optionally continue polling a few more times or treat as failure
                // For now, treat as pending to avoid premature failure
                renderSingleRecipeResult(recipeInfo, true, `Processing... (Status: ${data.status})`);
            }
        } catch (error) {
            console.error(`[Recipe ${recipeId}] Error during polling:`, error);
            stopPolling(recipeId, `Error during polling: ${error.message}`);
            updateEmptyStateVisibility(); // << Add call here
        }
    }

    // Helper function to stop polling and clear timeout
    function stopPolling(recipeId, errorMessage = null) {
        const recipeInfo = recipeData[recipeId];
        if (!recipeInfo) {
            console.warn(`[Polling Stop] Recipe data not found in map for ID: ${recipeId} when trying to stop polling.`);
            return; // Cannot stop intervals/timeouts if data object not found
        }
        if (recipeInfo.pollingIntervalId) clearInterval(recipeInfo.pollingIntervalId);
        if (recipeInfo.pollingTimeoutId) clearTimeout(recipeInfo.pollingTimeoutId);
        recipeInfo.pollingIntervalId = null;
        recipeInfo.pollingTimeoutId = null;
        if (errorMessage) {
             recipeInfo.error = errorMessage;
             // Optional: Re-render immediately to show the error if needed
             // renderSingleRecipeResult(recipeInfo, false);
             
             // *** Important: Move error data from map to array if stopping with error - WITH DUPLICATE CHECK ***
             if (!processedRecipes.some(r => r.id === recipeId)) {
                 processedRecipes.push(recipeInfo); // Add to final results array
             } else {
                 console.warn(`[Polling Stop] Duplicate error handling detected for ${recipeId}. Ignoring.`);
             }
             delete recipeData[recipeId]; // Remove from map
            // ***********************************************************

             // If this was the last job being processed, create the pantry checkbox
             if (Object.keys(recipeData).length === 0 && !document.getElementById('pantry-checkbox-container')) {
                 createPantryCheckbox();
             }
        }
        updateEmptyStateVisibility(); // Call helper as recipeData is updated
    }

    // --- Helper function to clear specific recipe card error ---
    function clearRecipeError(recipeId) {
        const recipeDiv = document.getElementById(recipeId);
        const errorElement = recipeDiv?.querySelector('p.error');
        if (errorElement) {
            errorElement.remove(); // Remove specific error message
        }
    }

    // --- URL Processing Logic moved inside DOMContentLoaded ---
    const addUrlButton = document.getElementById('addUrlButton');
    const recipeUrlInput = document.getElementById('recipeUrlInput');
    const urlErrorMessageDiv = document.getElementById('url-error-message'); // Get the new error div

    if (addUrlButton && recipeUrlInput) {
        const handleUrlSubmit = () => {
            console.log('Attempting URL submit...');
            let url = recipeUrlInput.value.trim(); 
            
            if(urlErrorMessageDiv) {
                urlErrorMessageDiv.textContent = '';
                urlErrorMessageDiv.style.display = 'none';
            }
            
            // *** Use validator.js for Robust Validation ***
            if (!url) {
                console.log('URL input was empty.');
                if (urlErrorMessageDiv) {
                    urlErrorMessageDiv.textContent = 'Please enter a URL.';
                    urlErrorMessageDiv.style.display = 'block';
                }
                return; // Stop if empty
            }

            // Define validation options
            const validationOptions = {
                protocols: ['http','https'], // Require http or https
                require_protocol: true,
                require_valid_protocol: true,
                require_host: true, 
                // require_tld: true, // Ensure it has a TLD like .com, .org (might be too strict for some cases?)
                validate_length: true
            };

            // Check if the URL is valid using the library
            if (validator.isURL(url, validationOptions)) {
                console.log('Validator.js: URL format appears valid:', url);
                console.log('Proceeding to process URL:', url);
                processSingleUrl(url); 
                recipeUrlInput.value = ''; // Clear input only on successful validation/start
            } else {
                // URL is invalid according to validator.js
                console.log('Validator.js: Invalid URL format entered:', url);
                if (urlErrorMessageDiv) {
                    urlErrorMessageDiv.textContent = 'Invalid URL format. Please enter a full, valid web address (e.g., https://example.com).';
                    urlErrorMessageDiv.style.display = 'block';
                }
                // Do not proceed if format is invalid
            }
            // *** End validator.js usage ***
        };

        addUrlButton.addEventListener('click', handleUrlSubmit);

        // Add listener for pressing Enter in the URL input
        recipeUrlInput.addEventListener('keypress', (event) => {
            if (event.key === 'Enter') {
                console.log('Enter key pressed in URL input.');
                event.preventDefault(); // Prevent default form submission if any
                handleUrlSubmit(); // Use the same handler
            }
        });
    }
    
    // Moved function definition inside DOMContentLoaded
    async function processSingleUrl(url) {
        console.log(`processSingleUrl function called with URL: ${url}`);
        const tempId = `tempId-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        console.log(`Processing URL (${tempId}): ${url}`);
    
        // <<< ADD RECIPE LIMIT CHECK >>>
        if (Object.keys(recipeData).length >= 10) {
            alert("Maximum of 10 recipes reached. Please review or clear the current list before adding more.");
             if(urlErrorMessageDiv) { // Also display near URL input if possible
                urlErrorMessageDiv.textContent = 'Maximum of 10 recipes reached.';
                urlErrorMessageDiv.style.display = 'block';
            }
            return; // Stop processing this URL
        }
        // <<< END CHECK >>>

        // Add to global store and render initial pending state
        recipeData[tempId] = {
            id: tempId, // Ensure the ID is also stored here
            status: 'pending_upload', // Initial status before job starts
            jobId: null,
            error: null,
            yield: null, // <-- Initialize yield
            result: null,
            ingredients: [], // Initialize ingredients array
            scaleFactor: 1, // Initialize scale factor
            sourceType: 'url',
            inputUrl: url,
            pollingTimeoutId: null, 
            pollingIntervalId: null, 
            startTime: Date.now(),
            pollingAttempts: 0, 
            lastKnownStatus: null 
        };
        // Call renderSingleRecipeResult (now in the same scope)
        console.log('Checking if renderSingleRecipeResult is defined:', typeof renderSingleRecipeResult);
        renderSingleRecipeResult(recipeData[tempId], true, 'Initializing...'); 
    
        try {
            console.log(`[${tempId}] Sending request to /api/process-url...`);
            // Access backendUrl (defined inside DOMContentLoaded)
            const response = await fetch(`${backendUrl}/api/process-url`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ url: url }),
            });
            console.log(`[${tempId}] Received response status: ${response.status}`);
    
            if (response.status === 202) {
                const { jobId } = await response.json();
                console.log(`URL ${tempId} processing job started with ID: ${jobId}`);
                const recipeInfo = recipeData[tempId]; // Get ref to the object in map
                if (recipeInfo) {
                    recipeInfo.jobId = jobId;
                    recipeInfo.status = 'pending'; // Update status to reflect job is running
                    renderSingleRecipeResult(recipeInfo, true, 'Processing...', 'pending'); 
                    startPollingJobStatus(tempId, jobId); 
                } else {
                     console.error(`Recipe data for tempId ${tempId} not found after API call.`);
                }
            } else {
                throw new Error(`Unexpected response status: ${response.status}`);
            }
        } catch (error) {
            console.error(`Network or fetch error processing URL ${tempId}:`, error);
            const recipeInfo = recipeData[tempId]; // Get ref
            if (recipeInfo) {
                recipeInfo.status = 'failed';
                recipeInfo.error = `Network error: ${error.message}`;
                renderSingleRecipeResult(recipeInfo, false); 
            }
        }
        updateEmptyStateVisibility(); // Call helper as recipeData is updated
    } // <<< Closing brace for processSingleUrl

    // --- Add listener for remove button clicks (event delegation) --- 
    if (recipeResultsContainer) {
        recipeResultsContainer.addEventListener('click', handleRemoveRecipe);
    } else {
        console.error("Could not find recipeResultsContainer to attach remove listener.");
    }

    // --- NEW: Handler for removing a recipe card --- 
    function handleRemoveRecipe(event) {
        // Check if the clicked element is the remove button or inside it (the SVG)
        const removeButton = event.target.closest('.remove-recipe-button'); 
        if (!removeButton) {
            return; // Click wasn't on a remove button
        }

        const recipeId = removeButton.dataset.recipeId;
        if (!recipeId) {
            console.error("Remove button clicked, but no recipeId found.");
            return;
        }
        console.log(`Remove button clicked for recipe: ${recipeId}`);

        // *** Add Confirmation Dialog ***
        // Try to get the title for a more informative message
        let recipeTitle = recipeId; // Default to ID
        const recipeInfo = processedRecipes.find(r => r.id === recipeId) || recipeData[recipeId];
        if (recipeInfo && recipeInfo.title) {
            recipeTitle = recipeInfo.title;
        }
        
        if (!window.confirm(`Are you sure you want to remove the recipe "${recipeTitle}"?`)) {
            console.log(`Removal cancelled for recipe: ${recipeId}`);
            return; // Stop if user cancels
        }
        // *** End Confirmation Dialog ***

        // Stop polling if this recipe was still in progress
        if (recipeData[recipeId]) {
            console.log(`Stopping polling for removed recipe: ${recipeId}`);
            stopPolling(recipeId); // stopPolling already deletes from recipeData
        } else {
             // If not in recipeData, ensure it's removed from processedRecipes
            processedRecipes = processedRecipes.filter(recipe => recipe.id !== recipeId);
        }

        // Remove the card from the DOM
        const recipeCard = document.getElementById(recipeId);
        if (recipeCard) {
            recipeCard.remove();
        }

        // Update UI states
        updateEmptyStateVisibility();
        updateCreateListButtonState();
        
        // Remove pantry checkbox if no recipes are left
        if (Object.keys(recipeData).length === 0 && processedRecipes.length === 0) {
            const existingCheckboxDiv = document.getElementById('pantry-checkbox-container');
            if (existingCheckboxDiv) {
                existingCheckboxDiv.remove();
                pantryCheckbox = null;
            }
        }
    }

    // --- Function to Clear Review Area and Final Feedback --- 
    function clearReviewAreaAndFinalLink() {
        if (reviewListArea) {
            reviewListArea.innerHTML = ''; // Clear the list display area
            console.log("Cleared review list area.");
        }
        clearInstacartResults(); // Also clear any previous link/error/loading in the final feedback section
        
        // Hide the final list section when clearing (before new one is generated)
        const finalListSection = document.getElementById('final-list-section');
        if (finalListSection) {
            finalListSection.classList.remove('opacity-100');
            finalListSection.classList.add('opacity-0');
             // Optionally set display none after transition
             // Using timeout might be slightly fragile, relying on opacity might be better
             // For now, let's just ensure opacity is 0.
             // setTimeout(() => { 
             //    if (!finalListSection.classList.contains('opacity-100')) { 
             //         finalListSection.style.display = 'none';
             //    }
             // }, 300); 
        }
    }

}); // <<< RESTORED Closing brace for DOMContentLoaded listener

// Keep existing globally defined functions like detectYield, displayImagePreview, etc., OUTSIDE DOMContentLoaded
function detectYield(text) {
    if (!text) return null;
    const yieldRegex = /(serves|yields|makes)(?:[:\s]+(?:about|approx\.?))?\s*(\d+(?:[.,]\d+)?)\s*([a-z\s()]+)?/i;
    const match = text.match(yieldRegex);
    
    if (match) {
        const keyword = match[1].toLowerCase();
        const quantity = parseFloat(match[2].replace(',', '.')); 
        let capturedUnit = (match[3] || '').trim().toLowerCase(); 
        let displayUnit = 'persons'; 
        
        if (keyword !== 'serves' && capturedUnit) {
             capturedUnit = capturedUnit.replace(/^[(\[]/, '').replace(/[)\]]$/, '').trim();
             displayUnit = capturedUnit;
        }
        
        if (quantity === 1) {
            if (displayUnit.endsWith('s')) displayUnit = displayUnit.slice(0, -1);
        } else { 
            if (displayUnit === 'person') displayUnit = 'persons'; 
            else if (!displayUnit.endsWith('s')) displayUnit += 's';
        }
        return { quantity, unit: displayUnit };
    }
    return null;
}

function displayImagePreview(file) {
    const imagePreviewArea = document.getElementById('image-preview-area'); // Need reference if outside event listener
    // imagePreviewArea.innerHTML = ''; // Clearing handled in clearAllResults
    const fileType = file.type;
    const webImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const p = document.createElement('p'); // Create element to show file info

    if (webImageTypes.includes(fileType)) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const img = document.createElement('img');
            img.src = e.target.result;
            img.alt = file.name;
            img.style.maxWidth = '100px'; // Add style for smaller preview
            img.style.maxHeight = '100px';
            img.style.marginRight = '10px';
            p.innerHTML = ``; // Clear text if image shown
            p.appendChild(img); // Add image to paragraph
            p.insertAdjacentText('beforeend', file.name);
        }
        reader.readAsDataURL(file);
    } else {
        p.textContent = `File selected: ${file.name} (Preview not available)`;
    }
    imagePreviewArea.appendChild(p); // Append the paragraph (with image or just text)
} 