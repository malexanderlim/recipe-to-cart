# Development Rules & Guidelines

This document outlines key rules and best practices to follow during development to ensure stability and prevent common issues.

1.  **Environment Variable Loading:**
    *   **Problem:** Relying on the default behavior of tools like `dotenv` can lead to errors if the process's working directory is unexpected.
    *   **Rule:** When using `dotenv` (or similar tools) to load configuration from files, **always explicitly specify the path** to the configuration file (e.g., `require('dotenv').config({ path: './.env' })`).
    *   **Verification:** Add temporary logging (e.g., logging masked keys or checking if variables are defined) during setup or debugging to confirm environment variables are loaded correctly *before* they are used in critical operations like API calls.

2.  **Scope of Changes:**
    *   **Problem:** Modifying code unrelated to the current task or re-introducing previously removed logic can break functionality unexpectedly.
    *   **Rule:** Only modify code directly relevant to the immediate task or bug fix. **Strictly avoid** changing unrelated functions or re-adding logic that has been explicitly superseded by a new strategy.
    *   **Verification:** After applying an edit, mentally review the diff or use source control tools (`git diff`) to confirm ONLY the intended lines were changed and no unrelated code was touched or old logic reintroduced.

3.  **LLM Constraints & Hybrid Approach:**
    *   **Problem:** LLMs, especially faster models, may not consistently adhere to strict numerical constraints, precise calculations, or specific rounding rules defined solely via prompts.
    *   **Rule:** For tasks requiring both nuanced language understanding AND strict numerical/constraint adherence, favor a hybrid approach.
    *   **Guideline:** Use the LLM for parsing, normalization, identifying standard types/units, generating context (like original units/quantities), and *suggesting multiple valid measurements* (e.g., using `line_item_measurements`). Implement deterministic code (algorithmic checks, `Math.ceil`, fixed conversions) *after* the LLM call to enforce critical constraints, calculations, and rounding rules reliably on the LLM's suggestions.
    *   **Verification:** Log LLM outputs *before* algorithmic adjustments and the final output *after* adjustments to easily debug and verify both stages.

4.  **API Endpoint URLs:** Do NOT change API endpoint URLs unless explicitly instructed by the user or clearly justified by referenced documentation. Pay extremely close attention to development (`*.dev.*`, `sandbox`, etc.) versus production URLs (`api.*`). When debugging authentication/authorization errors (403 Forbidden, 401 Unauthorized), verify the target URL against known working examples (like user-provided `curl` commands) or official documentation *before* assuming the issue is solely the API key, especially if the key has been verified elsewhere.

5.  **Data Persistence Across UI Steps:**
    *   **Problem:** In multi-step UI interactions (e.g., parse -> review -> submit), data needed for later steps might be lost if only the displayed information is used.
    *   **Rule:** When implementing flows where intermediate steps modify or filter data, ensure the *complete data structure* required for the final action is preserved.
    *   **Guideline:** Store necessary complex data (e.g., full objects, arrays like `line_item_measurements`) associated with UI elements (e.g., using `data-*` attributes storing JSON) if it needs to be retrieved accurately later, rather than trying to reconstruct it solely from displayed text.

6.  **Edit Verification:**
    *   **Problem:** Applying code edits, especially in structured files like `package.json` or configuration files, can inadvertently remove or modify unrelated but necessary lines if the edit context is imprecise.
    *   **Rule:** Before finalizing *any* code edit, mentally (or using diff tools) verify the *exact* changes being made. Pay special attention when modifying lists (like dependencies, routes, imports) or configuration blocks to ensure only the intended additions, deletions, or modifications are occurring, and that essential existing items are not accidentally removed.
    *   **Rule Addendum:** When removing or refactoring a function, explicitly search the codebase for all locations where that function was called and ensure those call sites are also removed or updated appropriately to prevent `ReferenceError`s or logic errors.
    *   **Verification:** Review the diff provided after an edit is applied. If essential code (e.g., required dependencies like `express` in `package.json`, necessary function calls) was unexpectedly removed or left dangling, immediately point out the error and apply a corrective edit. 

7.  **Variable Scope, Shadowing, and Declaration Order:**
    *   **Problem:** Accidentally re-declaring a variable within an inner scope (shadowing) or accessing `const`/`let` variables before their declaration (Temporal Dead Zone - TDZ) can lead to ReferenceErrors or unexpected behavior. This also applies to making up variable names that don't exist in the intended scope.
    *   **Rule:** 
        *   When accessing global or outer-scoped variables, **do not** re-declare a variable with the same name using `let` or `const` within that inner scope. Use the existing variable name directly.
        *   Within a given scope, variables/constants declared with `const` or `let` **must be declared *before*** any code that attempts to access them is executed. Ensure constants/variables are declared at the top of their relevant scope or at least before their first use.
        *   **Verify** that the variable names being used actually exist in the intended scope.
    *   **Verification:** Before finalizing an edit, check for variable shadowing and ensure all variables/constants are declared before they are accessed within their scope. Double-check variable names against their declarations.

8.  **Check for Existing Functionality:**
    *   **Problem:** Creating new modules, services, or functions without checking if similar functionality already exists leads to code duplication, increased maintenance burden, and potential inconsistencies.
    *   **Rule:** Before implementing new functionality (especially helper functions, service interactions, or utility logic), **thoroughly search the codebase** (using file search, semantic search, or directory exploration) to identify existing modules, services, or functions that might already provide the needed capability or can be extended. Favor using or adapting existing code over creating duplicates.
    *   **Verification:** Document the search process briefly in thoughts or comments if necessary. Ensure imports point to existing, relevant modules rather than newly created, potentially redundant ones. 

9.  **Raw Body Handling for Verification:**
    *   **Problem:** Libraries performing request verification (e.g., signature checks for webhooks/queues) often require the **raw, unparsed request body** string or buffer to correctly calculate hashes. Standard body-parsing middleware (like `express.json()` or implicit parsing by frameworks/platforms) can run *before* the verification logic, providing a parsed object instead of the raw body, leading to verification failures.
    *   **Rule:** When implementing request verification that needs the raw body:
        *   Ensure any necessary middleware (like `@upstash/qstash`'s `Receiver` or Stripe's webhook handler) receives the request body in the format it expects (typically raw string or buffer).
        *   Be aware of default body parsers. Explicitly configure middleware (like `express.raw()`) to capture the raw body *if* it's guaranteed to run before any default parsing.
        *   If the body is unavoidably parsed before verification, check if the library supports verifying against a re-serialized string (e.g., `JSON.stringify(parsedBody)`), ensuring the serialization matches the original format precisely.
    *   **Verification:** Log the `typeof` and the actual value of the request body *immediately before* it's passed to the verification function to confirm it's in the expected raw format or to understand how it needs to be handled (e.g., re-serialized). 

10. **Error Handling Within Loops:**
    *   **Problem:** Handling errors for individual items within a loop (e.g., `forEach`) using `try...catch` and then immediately returning (`return;`) from the entire function within the `catch` block prevents subsequent iterations and crucial final actions (like appending the partially processed results) outside the loop from executing.
    *   **Rule:** When using `try...catch` inside a loop to handle errors for individual iterations: Log or handle the error within the `catch` block, but **avoid** using `return` (or `throw`/`break` unless the error is truly fatal) if the goal is to process other items and perform actions after the loop. Allow the loop to continue and ensure code following the loop (e.g., appending a partially built list) can still run.
    *   **Verification:** Check `catch` blocks inside loops. Ensure they handle the iteration's error appropriately without unnecessarily halting the entire function's execution if partial success is desired. 

11. **Environment & Tooling Troubleshooting:**
    *   **Problem:** Issues like "command not found" or "could not determine executable" might stem from the local environment (Node/npm/nvm versions, cache, PATH) or unexpected changes in package structure/behavior (especially with major version bumps), rather than project code.
    *   **Rule:** When encountering persistent command execution failures after verifying project configuration:
        1.  **Isolate:** Try running the command directly (e.g., `npx <command>`) to bypass intermediate scripts (`npm run`).
        2.  **Verify Artifacts:** Check if the expected executable links exist in `node_modules/.bin` (`ls -la node_modules/.bin`).
        3.  **Check Package Manifest:** Examine the `package.json` of the *installed dependency* (in `node_modules/<package>/package.json`) for a `bin` field to confirm how its executable *should* be invoked.
        4.  **Consider Version:** If using a very new major version of a tool/package, check its documentation for breaking changes or different invocation methods. Consider downgrading to a more stable/LTS version as a troubleshooting step.
        5.  **Clean & Reinstall:** Use `npm cache clean --force` and perform clean reinstalls (`rm -rf node_modules && rm package-lock.json && npm install`).
        6.  **Check Environment:** Verify `$PATH` and consider testing with a different Node.js version via NVM.
    *   **Verification:** Document the troubleshooting steps taken. Prioritize checking for known issues or version incompatibilities before assuming project code errors for tool execution problems. 

12. **DOM ID/Selector Consistency:**
    *   **Problem:** When dynamically generating HTML (e.g., in JavaScript) that includes elements with IDs or specific classes, and later trying to select or manipulate those elements using `getElementById`, `querySelector`, etc., inconsistencies in the generated ID format or selector string will cause the lookup to fail silently or throw errors.
    *   **Rule:** Ensure that the exact string format used to generate an element's ID or the selectors used to query elements (including class names) are identical between the code that creates the HTML and the code that later tries to find or interact with those elements. Pay close attention to template literals, variable interpolation, and specific class names.
    *   **Verification:** When debugging issues where DOM manipulation isn't working, log the generated ID/selector from the creation code and the queried ID/selector from the manipulation code to verify they match exactly. Use browser developer tools (Elements tab) to inspect the rendered HTML and confirm the actual IDs/classes present. 

13. **Prefer Libraries for Standard Problems:**
    *   **Problem:** Re-implementing complex, standard functionality like URL validation or date formatting from scratch increases development time, risks missing edge cases, and reduces maintainability.
    *   **Rule:** For common, well-defined problems (e.g., validation, data manipulation, specific API interactions), **prioritize using established, well-maintained libraries** (like `validator.js` for validation) over custom implementations.
    *   **Verification:** Before writing complex validation or utility logic, perform a quick search (web or package manager) for existing libraries that solve the specific problem. Justify custom implementations if no suitable library is found or if specific constraints prevent library use.

14. **Decouple Rendering and Post-Render Logic:**
    *   **Problem:** Race conditions can occur when JavaScript tries to access or modify DOM elements that depend on asynchronous data or are created dynamically, especially if the access attempt happens before the element is fully rendered or if the logic relies on other dynamically created elements (like the pantry checkbox influencing ingredient checkboxes).
    *   **Rule:** When logic depends on the state of dynamically created elements or needs to manipulate them *after* they are rendered: 
        1. Keep the initial HTML generation simple (e.g., default states).
        2. Place the logic that accesses or modifies these elements *after* the code that inserts the HTML into the DOM (e.g., after `element.innerHTML = ...`).
    *   **Verification:** Review code that dynamically generates HTML and then immediately interacts with it. Ensure the interaction logic runs *after* the HTML is part of the document, especially if the logic relies on elements created in the same dynamic block. 

15. **CSS Specificity & Framework Integration:**
    *   **Problem:** Integrating utility-first frameworks (like Tailwind) into projects with existing CSS (especially using IDs or complex selectors) can lead to unexpected style overrides due to CSS specificity rules.
    *   **Rule:** When applying utility classes that don't seem to take effect (especially for layout, padding, color), use browser DevTools (Computed Styles panel) to check for higher-specificity rules from other stylesheets that might be overriding the utility classes. Prioritize resolving conflicts by removing or refactoring the overly specific legacy CSS rather than adding `!important` to utility classes.
    *   **Verification:** Inspect computed styles in DevTools. Identify the source of conflicting rules and address the specificity conflict directly in the CSS.

16. **Frontend/Backend Data Contracts:**
    *   **Problem:** API calls can fail with seemingly generic errors (like 400 Bad Request) if the frontend sends data in a structure (e.g., object keys, array formats) that doesn't perfectly match what the backend API endpoint expects and validates.
    *   **Rule:** Before making significant changes to data structures passed between frontend and backend, or when debugging API call failures:
        1. Verify the exact structure the frontend is sending (log the data immediately before the `fetch` call).
        2. Verify the exact structure the backend API endpoint expects (read the backend controller/handler code, focusing on `req.body` destructuring and validation logic).
        3. Ensure the keys, data types, and nesting match precisely.
    *   **Verification:** Log frontend payload. Read backend validation code. Compare structures side-by-side.
    