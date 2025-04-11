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
        // --- Initial call to setLoadingState - shows total count --- 
        setLoadingState(true, files.length, 0); // Indicate loading, show total files

        processedRecipes = []; // Reset recipe data store
        let currentFileIndex = 0; // Track progress

        for (const file of files) {
            currentFileIndex++;
            // --- Update loading state BEFORE processing the file --- 
            setLoadingState(true, files.length, currentFileIndex);
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
                         
                         // Debug log for garlic items
                         if ((itemData.ingredient || '').toLowerCase().includes('garlic')) {
                             console.log(`YIELD CHANGE - Garlic: Original=${itemData.quantity}, Scaled=${scaledValue}`);
                         }
                         
                         // Better number formatting to handle all cases
                         // First convert to a fixed precision string
                         const fixedString = scaledValue.toFixed(2);
                         
                         // Then convert to a number and back to string to remove trailing zeros properly
                         // But make sure to preserve whole numbers correctly
                         const num = parseFloat(fixedString);
                         displayQuantity = Number.isInteger(num) ? num.toString() : num.toString();
                         
                         // Debug log for garlic items
                         if ((itemData.ingredient || '').toLowerCase().includes('garlic')) {
                             console.log(`YIELD CHANGE - Final garlic display: ${displayQuantity}`);
                         }
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
            // Debug logging for troubleshooting quantity issues
            if ((item.ingredient || '').toLowerCase().includes('garlic')) {
                console.log(`DEBUG - Garlic Rendering: Original data:`, item);
            }
            
            let displayQuantity = '';
            if (item.quantity !== null && typeof item.quantity === 'number') {
                const scaledValue = item.quantity * scaleFactor;
                
                // Debug log for garlic specifically
                if ((item.ingredient || '').toLowerCase().includes('garlic')) {
                    console.log(`DEBUG - Garlic Quantity: Original=${item.quantity}, Scaled=${scaledValue}`);
                }
                
                // Better number formatting to handle all cases
                // First convert to a fixed precision string
                const fixedString = scaledValue.toFixed(2);
                
                // Then convert to a number and back to string to remove trailing zeros properly
                // But make sure to preserve whole numbers correctly
                // This approach properly handles 30.0 -> "30" and 30.5 -> "30.5"
                const num = parseFloat(fixedString);
                displayQuantity = Number.isInteger(num) ? num.toString() : num.toString();
                
                // Debug the string formatting
                if ((item.ingredient || '').toLowerCase().includes('garlic')) {
                    console.log(`DEBUG - Garlic display after formatting: ${displayQuantity}`);
                }
            }
            
            const unit = item.unit || '';
            const ingredient = item.ingredient || '';
            const text = `${displayQuantity} ${unit} ${ingredient}`.replace(/\s+/g, ' ').trim();
            
            // Debug final text
            if ((item.ingredient || '').toLowerCase().includes('garlic')) {
                console.log(`DEBUG - Final garlic text: ${text}`);
            }
            
            // Unique ID for the checkbox and label association
            const checkboxId = `ingredient-${recipeData.id}-${index}`;
            // Track original index for filtering later
            const ingredientIndex = index; 
            
            // Default checked state can be stored in recipeData if needed later, for now default true
            const isChecked = item.checked === undefined ? true : item.checked;

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
                        
                        // Preserve any line_item_measurements if present and scale them 
                        let line_item_measurements = null;
                        if (item.line_item_measurements && Array.isArray(item.line_item_measurements)) {
                            line_item_measurements = item.line_item_measurements.map(measurement => {
                                const scaledMeasurement = parseFloat((measurement.quantity * scaleFactor).toFixed(2));
                                // Ensure we're formatting numbers properly
                                const formattedQuantity = Number.isInteger(scaledMeasurement) ? 
                                    scaledMeasurement : scaledMeasurement;
                                
                                return {
                                    quantity: formattedQuantity,
                                    unit: measurement.unit
                                };
                            });
                        }
                        
                        // Special handling for garlic cloves to ensure proper unit
                        const isGarlic = (item.ingredient || '').toLowerCase().includes('garlic');
                        const isCloves = (item.unit || '').toLowerCase() === 'cloves';
                        
                        if (isGarlic && isCloves) {
                            console.log(`Converting garlic cloves to heads: ${finalQuantity} cloves -> ${Math.max(1, Math.ceil(finalQuantity / 10))} each (head)`);
                            
                            // Calculate head count based on 10 cloves = 1 head ratio
                            const headCount = Math.max(1, Math.ceil(finalQuantity / 10));
                            
                            return {
                                ingredient: item.ingredient.replace(/cloves?/i, '').replace(/,/g, '').trim() || 'Garlic',
                                quantity: headCount,
                                unit: 'each',
                                display_text: `${headCount} head${headCount > 1 ? 's' : ''} garlic`,
                                line_item_measurements: [
                                    { quantity: headCount, unit: 'each' },
                                    // Add weight alternatives
                                    { quantity: parseFloat((headCount * 1.75).toFixed(2)), unit: 'oz' },
                                    { quantity: parseFloat((headCount * 50).toFixed(2)), unit: 'g' }
                                ]
                            };
                        }
                        
                        // Special case for herbs sold by sprigs (thyme, rosemary, etc.)
                        const isHerb = /(thyme|rosemary|mint|sage|oregano|basil)/.test((item.ingredient || '').toLowerCase());
                        const isSprigs = (item.unit || '').toLowerCase() === 'sprigs' || (item.unit || '').toLowerCase() === 'sprig';
                        
                        if (isHerb && (isSprigs || finalQuantity > 5)) {
                            console.log(`Converting herb sprigs to bunch: ${item.ingredient}, ${finalQuantity} ${item.unit} -> 1 bunch`);
                            
                            return {
                                ingredient: item.ingredient || 'Herb',
                                quantity: 1,
                                unit: 'bunch',
                                line_item_measurements: [
                                    { quantity: 1, unit: 'bunch' },
                                    { quantity: 1, unit: 'each' }
                                ]
                            };
                        }
                        
                        // Special case for bay leaves and similar spices sold in packages
                        const isBayLeaves = /(bay leaf|bay leaves)/.test((item.ingredient || '').toLowerCase());
                        const isLeaves = /(leaf|leaves)/.test((item.ingredient || '').toLowerCase()) &&
                                        !/(lettuce|cabbage)/.test((item.ingredient || '').toLowerCase());
                        
                        if (isBayLeaves || isLeaves) {
                            console.log(`Converting individual leaves to package: ${item.ingredient}, ${finalQuantity} ${item.unit} -> 1 each`);
                            
                            return {
                                ingredient: item.ingredient || 'Leaves',
                                quantity: 1,
                                unit: 'each',
                                line_item_measurements: [
                                    { quantity: 1, unit: 'each' },
                                    { quantity: 1, unit: 'package' }
                                ]
                            };
                        }
                        
                        return {
                            ingredient: item.ingredient || 'Unknown Ingredient',
                            quantity: finalQuantity,
                            unit: item.unit || 'each',
                            line_item_measurements: line_item_measurements
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

        // --- START: Ingredient Consolidation Logic ---
        const consolidatedMap = new Map();

        allScaledIngredients.forEach(item => {
            // Normalize name and unit for reliable key generation
            const normalizedName = (item.ingredient || '').trim().toLowerCase();
            const normalizedUnit = (item.unit || 'each').trim().toLowerCase(); // Default to 'each' if unit is missing

            if (!normalizedName) {
                console.warn("Skipping item with empty ingredient name:", item);
                return; // Skip if no ingredient name
            }

            const key = `${normalizedName}_${normalizedUnit}`;

            if (consolidatedMap.has(key)) {
                const existingItem = consolidatedMap.get(key);
                existingItem.quantity += item.quantity;
                
                // Merge line_item_measurements if both have them
                if (item.line_item_measurements && existingItem.line_item_measurements) {
                    // Create a map to merge measurements by unit
                    const measurementsMap = new Map();
                    
                    // Add existing measurements first
                    existingItem.line_item_measurements.forEach(m => {
                        measurementsMap.set(m.unit, m.quantity);
                    });
                    
                    // Add new measurements, summing quantities for same units
                    item.line_item_measurements.forEach(m => {
                        const currentQuantity = measurementsMap.get(m.unit) || 0;
                        measurementsMap.set(m.unit, currentQuantity + m.quantity);
                    });
                    
                    // Convert back to array
                    existingItem.line_item_measurements = Array.from(measurementsMap).map(([unit, quantity]) => {
                        // Format the quantity properly to avoid decimal issues
                        const formattedQuantity = parseFloat(quantity.toFixed(2));
                        return {
                            unit,
                            quantity: Number.isInteger(formattedQuantity) ? formattedQuantity : formattedQuantity
                        };
                    });
                } 
                // If only one has measurements, use those
                else if (item.line_item_measurements) {
                    existingItem.line_item_measurements = item.line_item_measurements;
                }
                // Keep the first encountered non-normalized name/unit
            } else {
                consolidatedMap.set(key, {
                    // Store original casing/format for API
                    ingredient: item.ingredient,
                    unit: item.unit || 'each', // Use original or default
                    quantity: item.quantity,
                    line_item_measurements: item.line_item_measurements,
                    // Keep normalized versions for potential future use if needed
                    normalizedName: normalizedName,
                    normalizedUnit: normalizedUnit
                });
            }
        });

        // Convert Map back to array for API call
        const finalIngredientList = Array.from(consolidatedMap.values()).map(({ ingredient, quantity, unit }) => ({
            ingredient,
            // Round final quantity to avoid long decimals, ensure minimum if needed
            quantity: parseFloat(quantity.toFixed(2)) || 0.01, 
            unit
        }));
        // --- END: Ingredient Consolidation Logic ---

        // --- UPDATE: Use the consolidated list ---
        if (finalIngredientList.length === 0) {
            console.log("No ingredients selected or remaining after consolidation.");
            displayInstacartError("No ingredients selected. Check some items before creating the list.");
            setInstacartLoadingState(false);
            return;
        }

        const listTitle = validRecipeTitles.length > 0 ? `Ingredients for ${validRecipeTitles.join(', ')}` : 'My Recipe List';

        // --- UPDATE: Use the consolidated list ---
        console.log("Final consolidated ingredients being sent:", finalIngredientList);
        console.log("List Title:", listTitle);

        try {
            const response = await fetch(`${backendUrl}/api/create-list`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                // --- UPDATE: Use the consolidated list ---
                body: JSON.stringify({
                    ingredients: finalIngredientList,
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
        // Enable button only if there's at least one recipe with ingredients
        const hasIngredients = processedRecipes.some(recipe => recipe.ingredients && recipe.ingredients.length > 0);
        createListButton.disabled = !hasIngredients;
    }

    // Updated loading state indicator
    function setLoadingState(isLoading, totalFiles = 0, currentFileIndex = 0) {
        const indicatorDiv = document.getElementById('loading-indicator');
        const progressSpan = document.getElementById('progress-text'); // Get the span
    
        if (!indicatorDiv || !progressSpan) return; // Guard clause
    
        if (isLoading) {
            indicatorDiv.style.display = 'block';
            let baseText = 'Processing images...'; 
            let progressTextContent = '';
    
            // If processing multiple files and we know which one
            if (totalFiles > 1 && currentFileIndex > 0) { 
                baseText = 'Processing image'; 
                progressTextContent = ` ${currentFileIndex} of ${totalFiles}...`;
            } else if (totalFiles > 1) {
                // Optional: Initial state before loop if desired (e.g., "Processing 3 files...")
                 baseText = `Processing ${totalFiles} images...`;
            }
            
            // Update the text node before the span, and the span itself
            // Assumes the first child is the text node we want to change
            if (indicatorDiv.childNodes.length > 0 && indicatorDiv.childNodes[0].nodeType === Node.TEXT_NODE) {
                indicatorDiv.childNodes[0].nodeValue = baseText;
            } else {
                 // Fallback if structure changes unexpectedly
                 indicatorDiv.textContent = baseText; // This would overwrite the span, less ideal
                 indicatorDiv.appendChild(progressSpan); // Re-add span if fallback occurred
            } 
            progressSpan.textContent = progressTextContent; 
    
        } else {
            indicatorDiv.style.display = 'none';
            progressSpan.textContent = ''; // Clear progress text
            // Optionally reset the base text node
            if (indicatorDiv.childNodes.length > 0 && indicatorDiv.childNodes[0].nodeType === Node.TEXT_NODE) {
                 indicatorDiv.childNodes[0].nodeValue = 'Processing images... ';
            }
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