document.addEventListener('DOMContentLoaded', () => {
    const imageUploadInput = document.getElementById('recipe-image-upload');
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

    // Remove single yield controls - they will be per-recipe
    // const yieldControlDiv = document.getElementById('servings-control'); 
    // ... (other single yield control vars removed)

    // State for multiple recipes
    let processedRecipes = []; // Array to store data for each recipe: { id, file, title, yield, ingredients, scaleFactor, error }
    let recipeCounter = 0; // Simple ID generator

    const backendUrl = 'http://localhost:3001'; // Adjust if necessary

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
    const resultsSection = document.getElementById('results-section'); // Get the section to add the checkbox

    // --- Add this log --- 
    console.log("Checking createListButton element before adding listener:", createListButton);

    imageUploadInput.addEventListener('change', handleMultipleImageUpload);
    
    // Check if the button was found before adding listener
    if (createListButton) {
        // --- Restore original listener --- 
        createListButton.addEventListener('click', handleCreateList);
    } else {
        console.error("FATAL: Could not find createListButton element to attach listener!");
    }
    // Remove listeners for single yield controls

    // New handler for multiple files
    async function handleMultipleImageUpload(event) {
        const files = event.target.files;
        if (!files || files.length === 0) return;

        clearAllResults(); // Clear everything before processing new batch
        setLoadingState(true, files.length); // Indicate loading for multiple files

        processedRecipes = []; // Reset recipe data store

        for (const file of files) {
            displayImagePreview(file); // Show preview/filename for current file being processed
            await processSingleFile(file);
        }

        // --- Add createPantryCheckbox() call here, after processing --- 
        createPantryCheckbox(); 
        
        setLoadingState(false); // Hide loading indicator when all done
        updateCreateListButtonState(); // Enable/disable button based on results
    }

    // Function to process one file
    async function processSingleFile(file) {
        const recipeId = `recipe-${recipeCounter++}`;
        const formData = new FormData();
        formData.append('recipeImage', file);

        const recipeData = { 
            id: recipeId, 
            file: file, 
            title: file.name, // Default title
            yield: null, 
            ingredients: [], 
            scaleFactor: 1, 
            error: null 
        };
        processedRecipes.push(recipeData);
        // Render initial placeholder while processing
        renderSingleRecipeResult(recipeData, true); 

        try {
            const response = await fetch(`${backendUrl}/api/upload`, {
                method: 'POST',
                body: formData,
            });

            const data = await response.json(); 

            if (!response.ok) {
                throw new Error(data.details || data.error || `Server error: ${response.statusText}`);
            }

            recipeData.title = data.title || file.name; 
            recipeData.yield = data.yield || null; 
            recipeData.ingredients = data.ingredients || [];
            recipeData.extractedText = data.extractedText; 
            recipeData.scaleFactor = 1; // Reset scale factor on successful load

        } catch (error) {
            console.error(`Error processing file ${file.name}:`, error);
            recipeData.error = `Error: ${error.message}`;
            displayError(`Failed to process ${file.name}. `);
        }
        
        // Re-render the specific recipe block with full results or error
        renderSingleRecipeResult(recipeData, false); // isLoading = false
    }

    // Renders the UI block for a single recipe
    function renderSingleRecipeResult(recipeData, isLoading = false) {
        let recipeDiv = document.getElementById(recipeData.id);
        if (!recipeDiv) {
            recipeDiv = document.createElement('div');
            recipeDiv.id = recipeData.id;
            // Use the new card class
            recipeDiv.classList.add('recipe-card'); 
            recipeResultsContainer.appendChild(recipeDiv);
        }

        // Build HTML structure for yield controls using new classes
        let yieldControlsHTML = '';
        if (!isLoading && recipeData.yield && recipeData.yield.quantity) {
            const { quantity, unit } = recipeData.yield;
            // Ensure scaleFactor is numeric, default to 1
            const scaleFactor = (typeof recipeData.scaleFactor === 'number' && !isNaN(recipeData.scaleFactor)) ? recipeData.scaleFactor : 1;
            // Calculate display value, handle potential NaN
            let currentDisplayValue = Math.round(quantity * scaleFactor);
            if (isNaN(currentDisplayValue)) { currentDisplayValue = quantity; } // Fallback

            yieldControlsHTML = `
                <div class="scale-yield-controls"> 
                    <label for="yield-input-${recipeData.id}">Scale Yield:</label>
                    <div class="yield-buttons">
                        <button data-recipe-id="${recipeData.id}" class="yield-decrement" aria-label="Decrease yield">-</button>
                        <button data-recipe-id="${recipeData.id}" class="yield-increment" aria-label="Increase yield">+</button>
                    </div>
                    <input type="number" id="yield-input-${recipeData.id}" data-recipe-id="${recipeData.id}" value="${currentDisplayValue}" min="1" step="1" aria-labelledby="yield-label-${recipeData.id}">
                    <span class="yield-unit-label" id="yield-label-${recipeData.id}">${unit || ''} (Original: ${quantity})</span>
                </div>
            `;
        }

        // Generate ingredients HTML string directly
        let ingredientsHTML = '<p>Processing...</p>'; // Default while loading
        if (!isLoading) {
            if (recipeData.error) {
                ingredientsHTML = `<p class="error">${recipeData.error}</p>`; // Use error class
            } else if (recipeData.ingredients.length > 0) {
                // Render ingredients with checkboxes
                ingredientsHTML = renderParsedIngredientsHTML(recipeData);
            } else {
                ingredientsHTML = '<p>No ingredients parsed.</p>';
            }
        }
        
        // Use h3 for title in card
        recipeDiv.innerHTML = ` 
            <h3>${recipeData.title}</h3>
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
            // Remove previous listener if any to avoid duplicates on re-render
            // A more robust approach might involve storing/removing listeners explicitly
            ingredientsList.removeEventListener('change', handleCheckboxChange); 
            ingredientsList.addEventListener('change', handleCheckboxChange);
            // Add click listener to LI for toggling checkbox via label click
             ingredientsList.removeEventListener('click', handleListItemClick); 
            ingredientsList.addEventListener('click', handleListItemClick);
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
        
        // --- FIX: Update ingredient text directly instead of re-rendering --- 
        const recipeCard = document.getElementById(recipeId);
        const ingredientItems = recipeCard?.querySelectorAll('.ingredient-list .ingredient-item'); 
        
        if (ingredientItems && recipeData.ingredients) {
             const newScaleFactor = recipeData.scaleFactor; // Use the updated scale factor
             ingredientItems.forEach(li => {
                 const index = parseInt(li.querySelector('input[type="checkbox"]')?.dataset.ingredientIndex, 10);
                 const itemData = recipeData.ingredients[index];
                 const label = li.querySelector('label');
                 
                 if (itemData && label) {
                     let displayQuantity = '';
                     if (itemData.quantity !== null && typeof itemData.quantity === 'number') {
                         const scaledValue = itemData.quantity * newScaleFactor;
                         displayQuantity = Number(scaledValue.toFixed(2)).toString();
                         if (displayQuantity.endsWith('.00')) { displayQuantity = displayQuantity.slice(0, -3); }
                         else if (displayQuantity.endsWith('0')) { displayQuantity = displayQuantity.slice(0, -1); } 
                     }
                     const unit = itemData.unit || '';
                     const ingredient = itemData.ingredient || '';
                     const text = `${displayQuantity} ${unit} ${ingredient}`.replace(/\s+/g, ' ').trim();
                     label.textContent = text; // Update the text of the existing label
                 }
             });
        }
        // --- End of FIX ---
        
        updateCreateListButtonState(); 
    }
    
    // Handler for dynamic input updates (optional)
    function handleYieldInputChange(event) {
         handleYieldChange(event); // Reuse the main logic for now
    }

    // UPDATED: Returns an HTML string for the ingredients list with checkboxes
    function renderParsedIngredientsHTML(recipeData) {
        if (!recipeData.ingredients || recipeData.ingredients.length === 0) {
            return '<p>No ingredients parsed.</p>';
        }
        // Ensure scaleFactor is valid
        const scaleFactor = (typeof recipeData.scaleFactor === 'number' && !isNaN(recipeData.scaleFactor)) ? recipeData.scaleFactor : 1;

        const listItems = recipeData.ingredients.map((item, index) => {
            let displayQuantity = '';
            if (item.quantity !== null && typeof item.quantity === 'number') {
                const scaledValue = item.quantity * scaleFactor;
                // Format nicely: avoid excessive decimals, show fractions for common ones?
                // Simple rounding for now:
                displayQuantity = Number(scaledValue.toFixed(2)).toString();
                if (displayQuantity.endsWith('.00')) { displayQuantity = displayQuantity.slice(0, -3); }
                else if (displayQuantity.endsWith('0')) { displayQuantity = displayQuantity.slice(0, -1); } 
            }
            const unit = item.unit || '';
            const ingredient = item.ingredient || '';
            const text = `${displayQuantity} ${unit} ${ingredient}`.replace(/\s+/g, ' ').trim();
            
            // Unique ID for the checkbox and label association
            const checkboxId = `ingredient-${recipeData.id}-${index}`;
            // Track original index for filtering later
            const ingredientIndex = index; 
            
            // Default checked state can be stored in recipeData if needed later, for now default true
            const isChecked = item.checked === undefined ? true : item.checked; // Add a checked state to the item data

            return `
                <li class="ingredient-item">
                    <input type="checkbox" id="${checkboxId}" data-recipe-id="${recipeData.id}" data-ingredient-index="${ingredientIndex}" ${isChecked ? 'checked' : ''}>
                    <label for="${checkboxId}">${text}</label>
                </li>
            `;
        }).join(''); // Join list items into a single string

        // Return the UL element containing the list items
        // No surrounding div needed if UL has the class directly
        return `<ul class="ingredient-list">${listItems}</ul>`;
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

    // Updated handleCreateList function
    async function handleCreateList() { 
        console.log("Create List button clicked. Processing recipes:", processedRecipes);
        setInstacartLoadingState(true);
        clearInstacartResults();

        let allScaledIngredients = [];
        const validRecipeTitles = [];

        processedRecipes.forEach(recipeData => {
            if (!recipeData.error && recipeData.ingredients && recipeData.ingredients.length > 0) {
                let hasCheckedIngredients = false;

                const scaledAndFiltered = recipeData.ingredients
                    .filter((item, index) => {
                         const isChecked = item.checked === undefined ? true : item.checked;
                         // console.log(`Recipe ${recipeData.id}, Ingredient ${index} (${item.ingredient}), Checked state: ${isChecked}`); // Keep log for debugging
                         return isChecked;
                    })
                    .map(item => {
                        const scaleFactor = (typeof recipeData.scaleFactor === 'number' && !isNaN(recipeData.scaleFactor)) ? recipeData.scaleFactor : 1;
                        let finalQuantity = 1;
                        if (item.quantity !== null && typeof item.quantity === 'number') {
                            finalQuantity = parseFloat((item.quantity * scaleFactor).toFixed(2));
                            if (finalQuantity <= 0 && item.quantity > 0) finalQuantity = 0.01; 
                        }
                        hasCheckedIngredients = true; 
                        return {
                            ingredient: item.ingredient || 'Unknown Ingredient',
                            quantity: finalQuantity,
                            unit: item.unit || 'each' 
                        };
                    });

                if (hasCheckedIngredients) {
                     validRecipeTitles.push(recipeData.title || 'Untitled Recipe');
                     allScaledIngredients = allScaledIngredients.concat(scaledAndFiltered);
                }
            } else {
                 console.log(`Skipping recipe ${recipeData.id} due to error or no ingredients.`);
            }
        });

        if (allScaledIngredients.length === 0) {
            console.log("No ingredients selected to add to Instacart.");
            displayInstacartError("No ingredients selected. Check some items before creating the list.");
            setInstacartLoadingState(false);
            return;
        }

        // --- FIX: Restore original title format --- 
        const listTitle = validRecipeTitles.length > 0 ? `Ingredients for ${validRecipeTitles.join(', ')}` : 'My Recipe List';
        // --- End of FIX ---
        
        console.log("Final aggregated ingredients being sent:", allScaledIngredients);
        console.log("List Title:", listTitle);

        try {
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

            displayInstacartLink(data.instacartUrl);

        } catch (error) {
            console.error('Error creating Instacart list:', error);
            displayInstacartError(`Failed to create list: ${error.message}`);
        } finally {
            setInstacartLoadingState(false);
        }
    }

    // Updates the Create Instacart List button based on whether any recipes have ingredients
    function updateCreateListButtonState() {
        const hasIngredients = processedRecipes.some(r => !r.error && r.ingredients.length > 0);
        createListButton.disabled = !hasIngredients;
        // Also potentially disable pantry checkbox if no ingredients yet
        if (pantryCheckbox) {
             pantryCheckbox.disabled = !hasIngredients;
             if (!hasIngredients) {
                 pantryCheckbox.checked = false; // Reset if disabled
             }
        }
    }

    // Updated loading state indicator
    function setLoadingState(isLoading, fileCount = 0) {
        if (isLoading) {
            loadingIndicator.textContent = `Processing ${fileCount} image(s)...`;
            loadingIndicator.style.display = 'block';
            errorMessageDiv.textContent = ''; // Clear general error message
            errorMessageDiv.style.display = 'none';
        } else {
            loadingIndicator.style.display = 'none';
        }
    }
    
    // Updated error display (appends messages)
    function displayError(message) {
        const p = document.createElement('p');
        p.textContent = message;
        errorMessageDiv.appendChild(p);
        errorMessageDiv.style.display = 'block';
    }

    // New function to clear all results areas
    function clearAllResults() {
        imagePreviewArea.innerHTML = '';
        recipeResultsContainer.innerHTML = ''; // Clear dynamic recipe blocks
        processedRecipes = []; // Clear stored data
        recipeCounter = 0;
        createListButton.disabled = true;
        errorMessageDiv.innerHTML = ''; // Clear appended error messages
        errorMessageDiv.style.display = 'none';
        clearInstacartResults();
        
        // Also remove the pantry checkbox if it exists
        const existingCheckboxDiv = document.getElementById('pantry-checkbox-container');
        if (existingCheckboxDiv) {
            existingCheckboxDiv.remove();
            pantryCheckbox = null; // Clear the reference
        }
    }

    // --- Placeholder/Unchanged functions --- 
    function detectYield(text) { /* ... existing code ... */ }
    function displayImagePreview(file) { /* ... existing code ... */ }
    function setInstacartLoadingState(isLoading) { /* ... existing code ... */ }
    function displayInstacartError(message) { /* ... existing code ... */ }
    function clearInstacartResults() { /* ... existing code ... */ }
    function displayInstacartLink(url) {
        // --- Remove debugging logs --- 
        // console.log("displayInstacartLink called with URL:", url);
        const instacartLinkArea = document.getElementById('instacart-link-area');
        // if (!instacartLinkArea) { ... } // Keep check?
        // console.log("Found instacartLinkArea element:", instacartLinkArea);
        
        instacartLinkArea.innerHTML = ''; // Clear previous links
        const link = document.createElement('a');
        link.href = url;
        link.textContent = 'Open Instacart Shopping List';
        link.target = '_blank'; // Open in new tab
        link.classList.add('instacart-link-button'); // Add class for styling
        
        // console.log("Appending link element:", link);
        instacartLinkArea.appendChild(link);
        // console.log("Content of instacartLinkArea after append:", instacartLinkArea.innerHTML);
    }

    // --- Function to create and add the pantry checkbox --- 
    function createPantryCheckbox() {
        // Check if it already exists, remove if so (e.g., on re-upload)
        const existingCheckboxDiv = document.getElementById('pantry-checkbox-container');
        if (existingCheckboxDiv) {
            existingCheckboxDiv.remove();
        }

        const containerDiv = document.createElement('div');
        containerDiv.id = 'pantry-checkbox-container';
        containerDiv.style.marginBottom = '15px'; // Add some spacing
        
        pantryCheckbox = document.createElement('input');
        pantryCheckbox.type = 'checkbox';
        pantryCheckbox.id = 'pantry-items-checkbox';
        
        const label = document.createElement('label');
        label.htmlFor = 'pantry-items-checkbox';
        label.textContent = ' I have commonly found pantry items (salt, pepper, oil, sugar)';
        label.style.cursor = 'pointer';
        label.style.userSelect = 'none';

        containerDiv.appendChild(pantryCheckbox);
        containerDiv.appendChild(label);

        // Insert before the recipe results container
        resultsSection.insertBefore(containerDiv, recipeResultsContainer); 

        // Add event listener
        pantryCheckbox.addEventListener('change', handlePantryCheckboxChange);
    }

    // --- Handler for the master pantry checkbox --- 
    function handlePantryCheckboxChange(event) {
        const isChecked = event.target.checked;
        const shouldBeChecked = !isChecked; // If master is checked, items should be unchecked (false), and vice versa
        
        // Iterate through all recipes and ingredients
        processedRecipes.forEach(recipeData => {
            if (recipeData.ingredients && recipeData.ingredients.length > 0) {
                recipeData.ingredients.forEach((item, index) => {
                    const ingredientNameLower = (item.ingredient || '').toLowerCase();
                    // Check if the ingredient name contains any common keyword
                    const isCommon = commonItemsKeywords.some(keyword => ingredientNameLower.includes(keyword));
                    
                    if (isCommon) {
                        // Update the data
                        item.checked = shouldBeChecked;
                        // Update the corresponding checkbox in the DOM
                        const checkboxElement = document.getElementById(`ingredient-${recipeData.id}-${index}`);
                        if (checkboxElement) {
                            checkboxElement.checked = shouldBeChecked;
                        }
                    }
                });
            }
        });

        if (isChecked) {
            console.log("Unchecked common pantry items.");
        } else {
             // --- Logic added for re-checking ---
            console.log("Pantry checkbox unchecked - Re-checking common items.");
        }
        // Might need to update button state if disabling when *all* are unchecked is desired
        // updateCreateListButtonState(); 
    }
});

// Keep existing detectYield, displayImagePreview, setInstacartLoadingState, 
// displayInstacartError, clearInstacartResults, displayInstacartLink functions here for now

// --- Existing code to be kept (or moved inside DOMContentLoaded if not already) ---
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

function setInstacartLoadingState(isLoading) {
    const instacartLoadingIndicator = document.getElementById('instacart-loading-indicator');
    const instacartErrorMessageDiv = document.getElementById('instacart-error-message');
    const instacartLinkArea = document.getElementById('instacart-link-area');
    instacartLoadingIndicator.style.display = isLoading ? 'block' : 'none';
    if (isLoading) {
        instacartErrorMessageDiv.textContent = '';
        instacartErrorMessageDiv.style.display = 'none';
        instacartLinkArea.innerHTML = ''; 
    }
}

function displayInstacartError(message) {
    const instacartErrorMessageDiv = document.getElementById('instacart-error-message');
    instacartErrorMessageDiv.textContent = message;
    instacartErrorMessageDiv.style.display = 'block';
}

function clearInstacartResults() {
    const instacartLinkArea = document.getElementById('instacart-link-area');
    const instacartErrorMessageDiv = document.getElementById('instacart-error-message');
    instacartLinkArea.innerHTML = '';
    instacartErrorMessageDiv.textContent = '';
    instacartErrorMessageDiv.style.display = 'none';
} 