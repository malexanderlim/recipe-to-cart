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