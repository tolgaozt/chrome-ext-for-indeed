// --- START OF FILE content.js ---

console.log("Indeed Scraper: Content script loaded (Manual Save Button Mode).");

// --- Configuration ---
const DEBUG_MODE = true; // Set true for detailed logs, false for normal use
const LEFT_LIST_JOB_CARD_SELECTOR = 'div[data-testid="slider_item"]';
const JOB_KEY_SELECTOR_INSIDE_CARD = '[data-jk]';

const DETAILS_PANEL_SELECTORS = [
    'div[data-testid="viewJobSSRRoot"] > div > div:nth-child(2)', // Often the direct container
    '#jobsearch-ViewjobPaneWrapper',
    '.jobsearch-ViewJobLayout-mainPane',
    'aside[aria-labelledby="jobsearch-ViewJobViewComponent-heading"]',
    'aside[aria-label="description détaillée du poste"]',
    '#vjs-container', // More generic
    '.jobsearch-ViewJobLayout', // More generic
    '#viewJobSSRRoot', // Root element
    '#jobsearch-ViewJob' // Another root-like element
];

const INJECTION_POINT_SELECTORS = [
    '.jobsearch-JobInfoHeader-headerContainer', // Good general area near top
    'div[data-testid="jobsearch-JobInfoHeader-header"]', // Specific header div
    // Inject *after* title elements
    'h1.jobsearch-JobInfoHeader-title',
    'h2[data-testid="simpler-jobTitle"]',
    'h1[data-testid="jobTitle"]',
    // Inject *before* description text as a reliable fallback point
    '#jobDescriptionText',
    'div[data-testid="jobDescriptionText"]'
];

const SAVE_BUTTON_ID = 'manualSaveJobButtonIndeedExt';
const DEBOUNCE_DELAY_MS = 750;    // Debounce for observer fallback/correction
const OBSERVER_RETRY_DELAY_MS = 400;
const OBSERVER_MAX_RETRIES = 5;
const PANEL_FIND_RETRY_MAX = 4;   // Retries if observer setup fails initially
const PANEL_FIND_RETRY_DELAY_MS = 1000;
const PERIODIC_CHECK_INTERVAL_MS = 15000; // Interval for observer health check
const ACTIVATION_DELAY_MS = 300;  // Delay for initial activation on page load

// --- State Variables ---
let isAddButtonActive = false;
let currentJobKeyForPanel = null;
let observer = null;
let debounceTimeout = null;
let quickInjectTimeout = null; // Timeout ID for quick inject attempt
let panelFindRetries = 0;
let periodicCheckInterval = null;
let lastFoundPanelElement = null; // Cache the last found panel element

// --- Helper Functions ---
function safeQuerySelector(selector, parentElement = document) {
    try {
        // Minimal check for invalid ID start characters
        if (selector.includes('#') && !/^[a-zA-Z@_-]/i.test(selector.split('#')[1]?.charAt(0))) {
            // Log only in debug to avoid noise, but allow attempt
            // if (DEBUG_MODE) console.warn(`Potentially invalid selector (ID format?): ${selector}`);
        }
        // Check selector syntax validity before using it
        document.createDocumentFragment().querySelector(selector);
        return parentElement.querySelector(selector);
    } catch (e) {
        // Log detailed error only in debug mode
        // if (DEBUG_MODE) console.warn(`Invalid selector "${selector}":`, e);
        return null;
    }
}

function safeQuerySelectorAll(selector, parentElement = document) {
    try {
        if (selector.includes('#') && !/^[a-zA-Z@_-]/i.test(selector.split('#')[1]?.charAt(0))) {
            // if (DEBUG_MODE) console.warn(`Potentially invalid selector (ID format?): ${selector}`);
        }
        document.createDocumentFragment().querySelector(selector);
        return parentElement.querySelectorAll(selector);
    } catch (e) {
        // if (DEBUG_MODE) console.warn(`Invalid selector "${selector}":`, e);
        return [];
    }
}

function safeGetText(element, useInnerHTML = false) {
    if (!element) return "";
    try {
        // Use innerText primarily as it respects visibility, fallback to innerHTML if requested
        const text = useInnerHTML ? element.innerHTML : element.innerText;
        return text ? text.trim() : "";
    } catch (e) {
        // console.error("Error getting text:", e, element); // Reduce console noise
        return "";
    }
}

function safeGetAttribute(element, attributeName) {
    if (!element) return "";
    try {
        return element.getAttribute(attributeName) || "";
    } catch (e) {
        // console.error(`Error getting attribute "${attributeName}":`, e, element); // Reduce console noise
        return "";
    }
}

function getJoinedTextFromAll(selector, parentElement) {
    const elements = safeQuerySelectorAll(selector, parentElement);
    if (!elements || elements.length === 0) return "";
    const texts = Array.from(elements)
        .map(el => safeGetText(el))
        .filter(text => text); // Filter out empty strings
    return texts.join(', ');
}

function getExternalUrlFromInitialData() {
    try {
        const results = window._initialData?.hostQueryExecutionResult?.data?.jobData?.results;
        if (results && results.length > 0) {
            const jobUrl = results[0]?.job?.url;
            // Ensure it's a valid, external URL, not an Indeed viewjob/ad URL
            if (jobUrl && typeof jobUrl === 'string' && jobUrl.startsWith('http') && !jobUrl.includes('indeed.com/viewjob') && !jobUrl.includes('indeed.com/pagead')) {
                return jobUrl;
            }
        }
    } catch (error) {
        // if (DEBUG_MODE) console.warn("Could not access _initialData for external URL:", error);
    }
    return null;
}

function getCompanyNameFromInitialData() {
    try {
        const companyName = window._initialData?.jobInfoWrapperModel?.jobInfoModel?.companyName ||
                            window._initialData?.hostQueryExecutionResult?.data?.jobData?.results?.[0]?.job?.companyName ||
                            window._initialData?.jobMap?.jobInfoModel?.companyName;
        if (companyName && typeof companyName === 'string') {
            // if (DEBUG_MODE) console.log("  [Data Attempt - Company] Found in _initialData:", companyName);
            return companyName.trim();
        }
    } catch (error) {
        // if (DEBUG_MODE) console.warn("Could not access _initialData for company name:", error);
    }
    return null;
}

// --- Fonction findDetailsPanel (Optimized) ---
function findDetailsPanel() {
    const callTime = Date.now(); // For timing checks
    if (DEBUG_MODE) console.log(`[findDetailsPanel @ ${callTime}] Called.`);

    // 1. Check cached reference
    if (lastFoundPanelElement && document.body.contains(lastFoundPanelElement)) {
        let cacheValid = false;
        try { cacheValid = DETAILS_PANEL_SELECTORS.some(selector => lastFoundPanelElement.matches(selector)); } catch {}
        if (cacheValid) {
             if (DEBUG_MODE) console.log(`[findDetailsPanel @ ${callTime}] Using valid cached reference.`);
             return lastFoundPanelElement;
        } else {
             if (DEBUG_MODE) console.log(`[findDetailsPanel @ ${callTime}] Cached ref invalid/detached. Searching.`);
             lastFoundPanelElement = null;
        }
    } else if (lastFoundPanelElement) {
         if (DEBUG_MODE) console.log(`[findDetailsPanel @ ${callTime}] Cached ref detached. Searching.`);
         lastFoundPanelElement = null;
    } else {
         // if (DEBUG_MODE) console.log(`[findDetailsPanel @ ${callTime}] No cache. Searching.`); // Reduce noise
    }


    // 2. Search using prioritized selectors
    const prioritizedSelectors = [
        'div[data-testid="viewJobSSRRoot"] > div > div:nth-child(2)', '#jobsearch-ViewjobPaneWrapper',
        '.jobsearch-ViewJobLayout-mainPane', 'aside[aria-labelledby="jobsearch-ViewJobViewComponent-heading"]',
        'aside[aria-label="description détaillée du poste"]', '#vjs-container', '.jobsearch-ViewJobLayout',
        '#viewJobSSRRoot', '#jobsearch-ViewJob'
    ];
    for (const selector of prioritizedSelectors) {
        const panel = safeQuerySelector(selector);
        if (panel) {
             if (DEBUG_MODE) console.log(`[findDetailsPanel @ ${callTime}] Found with primary selector: "${selector}"`);
            lastFoundPanelElement = panel;
            return panel;
        }
    }

    // 3. Fallback via description parent
    if (DEBUG_MODE) console.log(`[findDetailsPanel @ ${callTime}] Primary failed. Trying fallback.`);
    const descriptionContainer = safeQuerySelector('#jobDescriptionText') || safeQuerySelector('div[data-testid="jobDescriptionText"]');
    if (descriptionContainer) {
        let parent = descriptionContainer.parentElement;
        for (let i = 0; i < 7; i++) {
            if (!parent || parent === document.body) break;
            for (const selector of prioritizedSelectors) {
                 try { if (parent.matches(selector)) {
                     if (DEBUG_MODE) console.log(`[findDetailsPanel @ ${callTime}] Found via fallback matching "${selector}"`);
                     lastFoundPanelElement = parent; return parent;
                    } } catch(e) {}
            }
             if ((parent.id && (parent.id.includes('viewjob') || parent.id.includes('ViewJob') || parent.id.includes('jobsearch'))) ||
                 parent.classList.contains('jobsearch-ViewJobLayout') || parent.tagName === 'ASIDE')
             {
                 if (DEBUG_MODE) console.log(`[findDetailsPanel @ ${callTime}] Found via fallback (ID/Class/Tag)`);
                 lastFoundPanelElement = parent; return parent;
             }
            parent = parent.parentElement;
        }
    }

    if (DEBUG_MODE) console.warn(`[findDetailsPanel @ ${callTime}] FAILED to find panel.`);
    lastFoundPanelElement = null;
    return null;
}


// --- Button Injection Logic ---
function removeExistingSaveButton() {
    const existingButton = document.getElementById(SAVE_BUTTON_ID);
    if (existingButton) {
        try { existingButton.remove(); } catch (e) {}
    }
}

function injectSaveButton(panelElement, jobKey) {
    if (!panelElement || !jobKey || !document.body.contains(panelElement)) {
        if (DEBUG_MODE) console.warn("injectSaveButton: Invalid panel or job key, or panel detached.");
        return false;
    }
    if (document.getElementById(SAVE_BUTTON_ID)) {
         // Optional: Check if existing button is for the correct key
         if(document.getElementById(SAVE_BUTTON_ID).dataset.jobKey === jobKey){
            // if (DEBUG_MODE) console.log("injectSaveButton: Button already exists correctly.");
             return true; // Already exists correctly
         } else {
              if (DEBUG_MODE) console.warn("injectSaveButton: Button exists but for wrong key! Replacing.");
              removeExistingSaveButton(); // Remove wrong button
         }
    } else {
        removeExistingSaveButton(); // Ensure clean slate just in case
    }


    let injectionPoint = null;
    let foundSelector = null;
    let injectBefore = false;

    for (const selector of INJECTION_POINT_SELECTORS) {
        injectionPoint = safeQuerySelector(selector, panelElement);
        if (injectionPoint) {
            foundSelector = selector;
            if (selector === '#jobDescriptionText' || selector === 'div[data-testid="jobDescriptionText"]') {
                injectBefore = true; // Inject *before* description
            }
            break;
        }
    }

    if (!injectionPoint) {
        injectionPoint = panelElement; // Fallback to panel root
        foundSelector = "Panel Root Fallback";
        injectBefore = true; // Prepend
         if (DEBUG_MODE) console.warn(`No specific injection point found. Using panel root fallback (prepend).`);
    }

    const saveButton = document.createElement('button');
    saveButton.id = SAVE_BUTTON_ID;
    saveButton.textContent = '💾 Sauvegarder cette offre';
    saveButton.dataset.jobKey = jobKey;
    saveButton.style.cssText = `
        background-color: #198754; color: white; padding: 8px 15px; border: none;
        border-radius: 6px; cursor: pointer; margin-top: 10px; margin-bottom: 15px;
        font-size: 14px; font-weight: 500; display: block; width: fit-content;
        margin-left: 0; margin-right: 0; transition: background-color 0.2s ease, opacity 0.2s ease;
    `;
    saveButton.addEventListener('click', handleSaveButtonClick);

    try {
        if (injectBefore) {
            if (injectionPoint.parentNode) {
                injectionPoint.parentNode.insertBefore(saveButton, injectionPoint);
            } else if (injectionPoint === panelElement) {
                panelElement.prepend(saveButton); // Handle prepend directly
            } else { throw new Error("injectBefore target has no parentNode."); }
        } else { // Inject after
            if (injectionPoint.parentNode) {
                injectionPoint.parentNode.insertBefore(saveButton, injectionPoint.nextSibling);
            } else { throw new Error("injectAfter target has no parentNode."); }
        }
        if (DEBUG_MODE) console.log(`Injected save button (${injectBefore ? 'BEFORE' : 'AFTER'} "${foundSelector}") for Job Key: ${jobKey}`);
        return true;
    } catch (error) {
        console.error("Error injecting save button:", error, `(Point: ${foundSelector}, Before: ${injectBefore})`);
        try { // Final fallback: prepend
            panelElement.prepend(saveButton);
            if (DEBUG_MODE) console.warn(`Injection failed, used final Fallback Prepend for Job Key: ${jobKey}`);
            return true;
        } catch (prependError) {
            console.error("FATAL: Could not inject button even with prepend fallback:", prependError);
            return false;
        }
    }
}

// --- Event Handler for Save Button Click ---
async function handleSaveButtonClick(event) {
    const button = event.currentTarget;
    const jobKeyToSave = button.dataset.jobKey;
    const forceSave = event.shiftKey;

    if (!jobKeyToSave) { console.error("Save button missing job key!"); return; }
    // if (DEBUG_MODE) console.log(`Manual save: ${jobKeyToSave}${forceSave ? ' (FORCE)' : ''}`);
    button.disabled = true;
    button.textContent = '💾 Sauvegarde en cours...';
    button.style.opacity = '0.7';

    let jobData = null;
    try {
        jobData = await scrapeJobDetails(jobKeyToSave);
    } catch (scrapeError) {
        console.error(`Error during scrapeJobDetails for ${jobKeyToSave}:`, scrapeError);
    }

    // Update button UI based on scrape success/failure *before* sending message
    const currentButton = document.getElementById(SAVE_BUTTON_ID); // Re-find button
    if (!currentButton || currentButton.dataset.jobKey !== jobKeyToSave) {
        if (DEBUG_MODE) console.log("Button state changed before scrape finished for", jobKeyToSave);
        return; // Stop if button changed/removed
    }

    if (!jobData) {
        currentButton.textContent = '❌ Erreur Scraping';
        currentButton.style.backgroundColor = '#dc3545';
        currentButton.disabled = false;
        currentButton.style.opacity = '1';
        return; // Stop if scraping failed
    }

    // Send data to background script
    const payload = { ...jobData, forceSave: forceSave };
    chrome.runtime.sendMessage({ action: "SAVE_JOB_DATA", payload: payload }, (response) => {
        const latestButton = document.getElementById(SAVE_BUTTON_ID); // Re-find again before callback
        if (!latestButton || latestButton.dataset.jobKey !== jobKeyToSave) {
            // if (DEBUG_MODE) console.log("Button state changed before response callback for", jobKeyToSave);
            return;
        }

        if (chrome.runtime.lastError) {
            console.error("Error sending data:", chrome.runtime.lastError.message);
            latestButton.textContent = '❌ Erreur Envoi';
            latestButton.style.backgroundColor = '#dc3545';
        } else if (response && response.success) {
            // if (DEBUG_MODE) console.log("Save response:", response);
            if (forceSave && response.duplicate) { latestButton.textContent = '✅ Re-Sauvegardé!'; latestButton.style.backgroundColor = '#198754'; }
            else if (response.duplicate) { latestButton.textContent = '✅ Déjà Sauvegardé'; latestButton.style.backgroundColor = '#ffc107'; }
            else { latestButton.textContent = '✅ Offre Sauvegardée!'; latestButton.style.backgroundColor = '#0d6efd'; }
        } else {
            console.error("Background save failed:", response);
            latestButton.textContent = '❌ Erreur Sauvegarde';
            latestButton.style.backgroundColor = '#dc3545';
        }

        // Re-enable button after response/error handling
        setTimeout(() => {
            const finalButton = document.getElementById(SAVE_BUTTON_ID);
            if (finalButton && finalButton.dataset.jobKey === jobKeyToSave) {
                finalButton.disabled = false;
                finalButton.style.opacity = '1';
            }
        }, 800); // Delay to allow user to see status message
    });
}

// --- Scraping Function ---
async function scrapeJobDetails(jobKey) {
     if (!jobKey) { return null; }
     const detailsPanel = findDetailsPanel(); // Use optimized finder
     if (!detailsPanel) { console.error(`Cannot scrape: Details panel not found for job ${jobKey}.`); return null; }
     // if (DEBUG_MODE) console.log(`--- Scraping Job Key: ${jobKey} ---`);

    // --- Helper ---
    const trySelector = (selector, purpose, parent = detailsPanel) => {
        const element = safeQuerySelector(selector, parent);
        const text = safeGetText(element);
        return { element, text };
    };

    // --- Position Name ---
    let positionName = trySelector('h2[data-testid="simpler-jobTitle"]', 'Position').text ||
                      trySelector('h1[data-testid="jobTitle"]', 'Position').text ||
                      trySelector('h1.jobsearch-JobInfoHeader-title', 'Position').text ||
                      trySelector('.jobsearch-JobInfoHeader-title', 'Position').text;

    // --- Location ---
    const locationSelectors = [
        'div[data-testid="jobsearch-JobInfoHeader-companyLocation"]', 'div[data-testid="company-location"]',
        '.jobsearch-JobInfoCompanyLocation', 'div[itemprop="jobLocation"]'
    ];
    let location = "";
    let locationElement = null;
    for (const selector of locationSelectors) {
        const result = trySelector(selector, 'Location');
        if (result.text) { location = result.text; locationElement = result.element; break; }
    }

    // --- Get Company Near Location ---
    const getCompanyNameNearLocation = (locElement) => {
        if (!locElement) return null;
        const parentDiv = locElement.parentElement;
        if (!parentDiv) return null;
        // Strategy 1: First span in parent (not matching location)
        const spansInParent = safeQuerySelectorAll('span', parentDiv);
        for (const span of spansInParent) {
             const companyText = safeGetText(span);
             if (companyText && companyText !== location && !span.contains(locElement)){ return companyText; }
        }
        // Strategy 2: Previous sibling
        const prevSibling = locElement.previousElementSibling;
        if (prevSibling) {
            const companyText = safeGetText(prevSibling);
             const forbiddenTags = ['HR', 'BR', 'STYLE', 'SCRIPT', 'BUTTON'];
             if (companyText && !forbiddenTags.includes(prevSibling.tagName) && !prevSibling.contains(locElement)) { return companyText; }
        }
        return null;
    };

    // --- Company Name ---
    let company =
        trySelector('div[data-testid="jobsearch-JobInfoHeader-companyName"]', 'Company').text ||
        trySelector('div[data-testid="simpler-simplified-header"] [data-testid="companyLink"]', 'Company').text ||
        trySelector('div[data-testid="simpler-company-name"]', 'Company').text ||
        trySelector('div[data-testid="inlineHeader-companyName"]', 'Company').text ||
        getCompanyNameNearLocation(locationElement) || // Near location strategy
        (() => { // Subtitle strategy
            const subtitleSelectors = [
                'div[data-testid="jobsearch-JobInfoHeader-subtitle"] > div:nth-child(1)', '.jobsearch-JobInfoHeader-subtitle > div:nth-child(1)',
                'div[data-testid="jobsearch-JobInfoHeader-subtitle"] > span:first-of-type', '.jobsearch-JobInfoHeader-subtitle > span:first-of-type'
            ];
            for (const sel of subtitleSelectors) {
                const text = trySelector(sel, 'Company (Subtitle)').text;
                if (text && (!location || text !== location)) { return text; }
            } return null;
        })() ||
        trySelector('div[data-company-name="true"]', 'Company').text ||
        trySelector('a.jobsearch-JobInfoHeader-companyNameLink', 'Company').text ||
        trySelector('.icl-u-lg-mr--sm .icl-u-textColor--success', 'Company').text ||
        trySelector('.jobsearch-CompanyReview--heading', 'Company').text ||
        getCompanyNameFromInitialData() || // From JS data
        (() => { // Desperation fallback
            const fallbackText = trySelector('div[data-testid="jobsearch-JobInfoHeader-header"]', 'Company (Header Fallback)').text;
            return fallbackText; // Cleanup happens later
        })();


    // --- Cleanup Company Name ---
    if (company) {
        let initialCompany = company;
        if (location && company.includes(location)) { /* ... remove location ... */
             const trimmedCompany = company.trim(); const trimmedLocation = location.trim();
             const potentialEndings = [ trimmedLocation, `- ${trimmedLocation}`, ` - ${trimmedLocation}`, `| ${trimmedLocation}`, `, ${trimmedLocation}` ];
             for (const ending of potentialEndings) {
                 if (trimmedCompany.endsWith(ending)) {
                     let potentialCompany = trimmedCompany.substring(0, trimmedCompany.length - ending.length).trim();
                     if (potentialCompany && potentialCompany !== trimmedCompany) { company = potentialCompany; break; }
                 }
             }
        }
        if (positionName && company.includes(positionName)) { /* ... remove position ... */
             const trimmedCompany = company.trim(); const trimmedPosition = positionName.trim();
             const potentialStarts = [ trimmedPosition ];
             for (const start of potentialStarts) {
                  if (trimmedCompany.startsWith(start)) {
                      let potentialCompany = trimmedCompany.substring(start.length).trim().replace(/^(\s*-\s*|\s*\|\s*|,\s*)/, '').trim();
                      if (potentialCompany && potentialCompany !== trimmedCompany) { company = potentialCompany; break; }
                  }
              }
        }
        company = company.trim();
        // if (DEBUG_MODE && company !== initialCompany) console.log(`--- Company Name After Cleanup: "${company}" ---`);
    }

    // --- Description ---
    const descriptionElement = safeQuerySelector('#jobDescriptionText', detailsPanel) || safeQuerySelector('div[data-testid="jobDescriptionText"]', detailsPanel);

    // --- Details List ---
    const getDetailListItemText = (ariaLabel) => {
        let text = ""; const ariaLower = ariaLabel.toLowerCase();
        const directAriaDiv = safeQuerySelector(`div[aria-label*="${ariaLabel}" i]`, detailsPanel);
        if (directAriaDiv) { text = getJoinedTextFromAll(`li[data-testid="list-item"] span`, directAriaDiv) || getJoinedTextFromAll('div', directAriaDiv); if (text) return text; }
        const metadataContainer = safeQuerySelector('#jobDetailsSection', detailsPanel) || safeQuerySelector('div[data-testid="job-details-section"]', detailsPanel);
        if (metadataContainer) {
            const directLabelDiv = safeQuerySelector(`div[aria-label*="${ariaLabel}" i]`, metadataContainer);
            if (directLabelDiv) { text = getJoinedTextFromAll('li, span, div', directLabelDiv); if (text) return text; }
            const potentialLabels = safeQuerySelectorAll('div > div', metadataContainer);
            for (const labelDiv of potentialLabels) {
                 const labelText = safeGetText(labelDiv).trim(); const labelTextLower = labelText.toLowerCase();
                 const ariaWords = ariaLower.split(' ').filter(w => w.length > 2);
                 if (ariaWords.some(word => labelTextLower.includes(word))) {
                     const valueDiv = labelDiv.nextElementSibling;
                     if (valueDiv) { text = safeGetText(valueDiv); if (text) return text; }
                     if (labelText.includes(':')) { const parts = labelText.split(':'); if (parts.length > 1) { text = parts[1].trim(); if (text) return text; } }
                 }
            }
        }
        const svgIcon = safeQuerySelector(`#jobDetailsSection svg[aria-label*="${ariaLabel}" i]`, detailsPanel) || safeQuerySelector(`svg[aria-label*="${ariaLabel}" i]`, detailsPanel);
        if (svgIcon) {
             const parentDiv = svgIcon.closest('div');
             if (parentDiv) {
                 if (parentDiv.nextElementSibling) { text = getJoinedTextFromAll('span, div', parentDiv.nextElementSibling); if (text) return text; }
                 const parentText = safeGetText(parentDiv); const svgText = safeGetAttribute(svgIcon, 'aria-label');
                 if(parentText && svgText && parentText.toLowerCase().includes(svgText.toLowerCase())){ text = parentText.replace(new RegExp(svgText, 'i'), '').trim(); }
                 else { text = parentText; }
                 if (text) return text;
             }
        }
        return "";
    };

    // --- Assemble Data ---
    const jobData = {
        "ID": jobKey,
        "Position Name": positionName || "Non trouvé",
        "Company": company || "Non trouvé",
        "Location": location || "Non trouvé",
        "Salary": getDetailListItemText("Salaire") || getDetailListItemText("Salary"),
        "Job Type": getDetailListItemText("Type de poste") || getDetailListItemText("Job type"),
        "Shift & Schedule": getDetailListItemText("Horaires de travail") || getDetailListItemText("Shift and schedule"),
        "Education_Level": getDetailListItemText("Formation") || getDetailListItemText("Education"),
        "Skills": getDetailListItemText("Compétences") || getDetailListItemText("Qualifications") || getDetailListItemText("Hiring insights"),
        "Languages": getDetailListItemText("Langues") || getDetailListItemText("Language"),
        "Description": safeGetText(descriptionElement, true) || "Description non trouvée",
        "Indeed_View_Job_Link": `https://fr.indeed.com/viewjob?jk=${jobKey}`,
        "External_Apply_Link": getExternalUrlFromInitialData() || "",
        "Indeed_Apply_Start_Link": safeGetAttribute(safeQuerySelector('#indeedApplyButton', detailsPanel), 'href') ||
                                  safeGetAttribute(safeQuerySelector('button[data-tn-element="IndeedApplyButton"]', detailsPanel),'href') ||
                                  safeGetAttribute(safeQuerySelector('#applyButtonLinkContainer a[href]', detailsPanel), 'href') ||
                                  safeGetAttribute(safeQuerySelector('#applyButtonLinkContainer button[href]', detailsPanel), 'href') ||
                                  safeGetAttribute(safeQuerySelector('a[data-tn-element="jobTitle"]', detailsPanel), 'href'),
        "Scraped At": new Date().toISOString()
    };

    // if (DEBUG_MODE) console.log("--- Final Scraped Data ---", jobData);
    return jobData;
}


// --- Attempt Quick Injection Function ---
function attemptQuickInject(targetJobKey, retryCount = 0) {
    const callTime = Date.now();
    if (DEBUG_MODE) console.log(`[Quick Inject @ ${callTime}] Attempt #${retryCount + 1} for ${targetJobKey}. Current: ${currentJobKeyForPanel}, Active: ${isAddButtonActive}`);

    if (!isAddButtonActive || targetJobKey !== currentJobKeyForPanel) {
        if (DEBUG_MODE) console.log(`[Quick Inject @ ${callTime}] Aborted: State mismatch.`);
        return;
    }

    if (document.getElementById(SAVE_BUTTON_ID)) {
        if (DEBUG_MODE) console.log(`[Quick Inject @ ${callTime}] Aborted: Button already exists.`);
        return;
    }

    const panel = findDetailsPanel();

    if (panel) {
        const panelKey = safeGetAttribute(safeQuerySelector('[data-jk]', panel), 'data-jk') || panel.dataset.jobid;
        if (DEBUG_MODE) console.log(`[Quick Inject @ ${callTime}] Panel found. Panel Key: ${panelKey || 'None'}, Target Key: ${targetJobKey}`);

        if (!panelKey || panelKey === targetJobKey) {
             if (DEBUG_MODE) console.log(`[Quick Inject @ ${callTime}] Condition met. Injecting button.`);
             injectSaveButton(panel, targetJobKey); // Inject the button
             if (DEBUG_MODE) console.log(`[Quick Inject @ ${callTime}] Finished (Success).`);
             return; // Success, stop retrying
         } else {
             if (DEBUG_MODE) console.log(`[Quick Inject @ ${callTime}] Condition NOT met (Panel key mismatch?).`);
             // Panel has wrong key, don't retry quick inject for *this* key, let observer handle it later.
         }
    } else {
         if (DEBUG_MODE) console.log(`[Quick Inject @ ${callTime}] Panel NOT found on attempt #${retryCount + 1}.`);
         // <<< Retry Logic >>>
         if (retryCount < QUICK_INJECT_MAX_RETRIES) {
             const nextRetry = retryCount + 1;
             if (DEBUG_MODE) console.log(`[Quick Inject @ ${callTime}] Scheduling retry #${nextRetry} in ${QUICK_INJECT_RETRY_DELAY_MS}ms.`);
             // Use a new timeout specific to this retry chain if needed, or reuse quickInjectTimeout
             quickInjectTimeout = setTimeout(() => attemptQuickInject(targetJobKey, nextRetry), QUICK_INJECT_RETRY_DELAY_MS);
             return; // Waiting for retry
         } else {
              if (DEBUG_MODE) console.log(`[Quick Inject @ ${callTime}] Max retries reached. Giving up quick inject.`);
         }
    }
     if (DEBUG_MODE && !document.getElementById(SAVE_BUTTON_ID)) console.log(`[Quick Inject @ ${callTime}] Finished (Failed).`);
}


// --- Event Listener for Job Card Click ---
function handleJobCardClick(event) {
    const jobCard = event.target.closest(LEFT_LIST_JOB_CARD_SELECTOR);
    // Ignore clicks on the save button itself or if no card found
    if (!jobCard || event.target.closest(`#${SAVE_BUTTON_ID}`)) return;

    const jobKeyElement = safeQuerySelector(JOB_KEY_SELECTOR_INSIDE_CARD, jobCard);
    const newJobKey = jobKeyElement ? safeGetAttribute(jobKeyElement, 'data-jk') : null;

    if (newJobKey && newJobKey !== currentJobKeyForPanel) {
        if (DEBUG_MODE) console.log(`Click Handler: New Key ${newJobKey}. Storing as target. Current: ${currentJobKeyForPanel}`);
        currentJobKeyForPanel = newJobKey; // Set the new target key
        removeExistingSaveButton(); // Remove button for previous job
        // --- NO proactive inject scheduled here anymore ---
        // Clear any pending observer debounce check for the *previous* job
        clearTimeout(debounceTimeout);
    } else if (newJobKey && newJobKey === currentJobKeyForPanel) {
        if (DEBUG_MODE) console.log(`Click Handler: Same key ${newJobKey} clicked. No state change needed.`);
        // Maybe ensure button exists? Or let observer handle it? Let observer handle.
    } else if (!newJobKey && DEBUG_MODE) {
        // console.warn("Click Handler: Clicked card has no job key."); // Reduce noise
    }
}


// --- Mutation Observer Logic (WITH LOGGING) ---
function handlePanelMutation(mutationsList) {
    // Only proceed if active and a job key is targeted
    if (!isAddButtonActive || !currentJobKeyForPanel) return;

    let significantChange = false;
    // Check if mutation seems relevant (content change or button removal)
    for (const mutation of mutationsList) {
        if (lastFoundPanelElement && lastFoundPanelElement.contains(mutation.target) &&
           (mutation.type === 'childList' || (mutation.type === 'attributes' && ['data-jk', 'data-jobid', 'hidden', 'class', 'style'].includes(mutation.attributeName)))) {
            significantChange = true; break;
        }
        if (mutation.type === 'childList' && Array.from(mutation.removedNodes).some(node => node && node.id === SAVE_BUTTON_ID)) {
            significantChange = true; break;
        }
         if (mutation.type === 'attributes' && mutation.target === lastFoundPanelElement && ['hidden', 'style', 'class'].includes(mutation.attributeName) ) {
              significantChange = true; break;
         }
    }
    // Also trigger if button is simply missing when panel is present
    if (!significantChange) {
        const existingButton = document.getElementById(SAVE_BUTTON_ID);
        if (!existingButton && lastFoundPanelElement && document.body.contains(lastFoundPanelElement)) {
            significantChange = true;
        } else { return; } // Ignore insignificant mutations if button ok
    }

    // Schedule the debounced callback (first attempt)
    if (DEBUG_MODE) console.log(`Mutation Handler: Relevant mutation. Scheduling debounce check (${DEBOUNCE_DELAY_MS}ms) for ${currentJobKeyForPanel}.`);
    clearTimeout(debounceTimeout);
    const keyForThisCheck = currentJobKeyForPanel;
    debounceTimeout = setTimeout(() => observerDebounceCallback(keyForThisCheck, 0), DEBOUNCE_DELAY_MS);
}

// --- Debounce Callback with Retry Logic ---
function observerDebounceCallback(targetJobKey, retryCount = 0) {
    const callTime = Date.now();
    if (DEBUG_MODE) console.log(`[Observer Debounce @ ${callTime}] Attempt #${retryCount + 1}. Target: ${targetJobKey}, Current: ${currentJobKeyForPanel}, Active: ${isAddButtonActive}`);

    // --- State Check ---
    if (!isAddButtonActive || targetJobKey !== currentJobKeyForPanel) {
        if (DEBUG_MODE) console.log(`[Observer Debounce @ ${callTime}] Aborted: State mismatch (likely new job clicked).`);
        return; // Stop if state changed during debounce/retry delay
    }

    // --- Check if Button Already Exists Correctly ---
     const existingButtonPreFind = document.getElementById(SAVE_BUTTON_ID);
     if (existingButtonPreFind && existingButtonPreFind.dataset.jobKey === targetJobKey) {
         // if (DEBUG_MODE) console.log(`[Observer Debounce @ ${callTime}] Aborted: Button already exists correctly.`); // Reduce noise
         return;
     }


    // --- Find Panel ---
    let panel = findDetailsPanel(); // Will log its own findings

    if (panel) {
        // --- Panel Found ---
        const panelKey = safeGetAttribute(safeQuerySelector('[data-jk]', panel), 'data-jk') || panel.dataset.jobid;
        if (DEBUG_MODE) console.log(`[Observer Debounce @ ${callTime}] Panel found. Panel Key: ${panelKey || 'None'}, Target Key: ${targetJobKey}`);

        // Check for key mismatch - stop retries for this target key if panel shows a *different* job
        if (panelKey && panelKey !== targetJobKey) {
             if (DEBUG_MODE) console.warn(`[Observer Debounce @ ${callTime}] Panel key (${panelKey}) mismatch target (${targetJobKey}). Aborting retries for ${targetJobKey}.`);
             // If a button exists for the *wrong* key, remove it.
             if(existingButtonPreFind) removeExistingSaveButton();
             return;
         }

        // Panel found, key matches (or panel has no key yet)
        const existingButtonPostFind = document.getElementById(SAVE_BUTTON_ID);
        if (!existingButtonPostFind) {
             if (DEBUG_MODE) console.log(`[Observer Debounce @ ${callTime}] Injecting missing button for ${targetJobKey}.`);
             injectSaveButton(panel, targetJobKey);
        } else if (existingButtonPostFind.dataset.jobKey !== targetJobKey) {
            // Correct button if it exists for wrong key
            if (DEBUG_MODE) console.warn(`[Observer Debounce @ ${callTime}] Correcting button key mismatch.`);
            removeExistingSaveButton();
            injectSaveButton(panel, targetJobKey);
        } else {
             // Button exists for the correct key - should have been caught earlier, but double check
             // if (DEBUG_MODE) console.log(`[Observer Debounce @ ${callTime}] Button exists correctly (verified).`); // Reduce noise
        }
        if (DEBUG_MODE) console.log(`[Observer Debounce @ ${callTime}] Finished (Success or Correct).`);
        // --- Stop retrying on success ---

    } else {
         // --- Panel Not Found ---
         if (DEBUG_MODE) console.warn(`[Observer Debounce @ ${callTime}] Panel NOT found on attempt #${retryCount + 1}.`);
         // --- Retry Logic ---
         if (retryCount < OBSERVER_MAX_RETRIES) {
             const nextRetry = retryCount + 1;
             if (DEBUG_MODE) console.log(`[Observer Debounce @ ${callTime}] Scheduling retry #${nextRetry} in ${OBSERVER_RETRY_DELAY_MS}ms.`);
             // Schedule the *next* attempt
             setTimeout(() => observerDebounceCallback(targetJobKey, nextRetry), OBSERVER_RETRY_DELAY_MS);
             // --- Return here, don't log finished ---
             return;
         } else {
              if (DEBUG_MODE) console.error(`[Observer Debounce @ ${callTime}] Max retries reached. FAILED to find panel/inject button for ${targetJobKey}.`);
               // Clean up any potentially wrong button left over
               removeExistingSaveButton();
         }
         if (DEBUG_MODE) console.log(`[Observer Debounce @ ${callTime}] Finished (Failed after retries).`);
    }
}


// --- Setup Panel Observer ---
function setupPanelObserver() {
     if (observer) { observer.disconnect(); observer = null; }
     const targetNode = findDetailsPanel();
     if (targetNode) {
         panelFindRetries = 0;
         const config = { childList: true, subtree: true, attributes: true, attributeFilter: ['id', 'class', 'style', 'data-jobid', 'data-jk', 'aria-hidden', 'hidden'] };
         observer = new MutationObserver(handlePanelMutation);
         try {
              observer.observe(targetNode, config);
               // Initial check/inject right after attaching (keep this fairly quick)
               if (isAddButtonActive) {
                    const panelKey = safeGetAttribute(safeQuerySelector('[data-jk]', targetNode), 'data-jk') || targetNode.dataset.jobid;
                    if (panelKey) {
                        currentJobKeyForPanel = panelKey; // Set initial key if possible
                         if (!document.getElementById(SAVE_BUTTON_ID)) {
                             setTimeout(() => injectSaveButton(targetNode, panelKey), 150); // Short delay after observe starts
                         }
                    }
               }
              return true;
         } catch (error) { console.error("FAILED to attach MutationObserver:", error); observer = null; return false; }
     } else {
         // Log retry attempts for initial setup
         if (panelFindRetries === 0 || panelFindRetries === PANEL_FIND_RETRY_MAX -1 ) {
             if (DEBUG_MODE) console.warn(`Setup: Could not find details panel to observe. Attempt ${panelFindRetries + 1}/${PANEL_FIND_RETRY_MAX}`);
         }
          return false;
     }
}

// --- Activation / Deactivation ---
function activateAddButtonFeature() {
    if (isAddButtonActive) { return; }
    console.log("Activating Add Save Button feature...");
    isAddButtonActive = true;
    panelFindRetries = 0;
    document.addEventListener('click', handleJobCardClick, true);

     // Initial setup attempt + Retry Logic
     if (!setupPanelObserver()) {
          panelFindRetries++;
          const retryInterval = setInterval(() => {
               if (!isAddButtonActive) { clearInterval(retryInterval); return; }
               if (setupPanelObserver() || panelFindRetries >= PANEL_FIND_RETRY_MAX) {
                    clearInterval(retryInterval);
                    if(!observer && panelFindRetries >= PANEL_FIND_RETRY_MAX) { console.error("Observer setup failed after retries."); }
               }
               panelFindRetries++;
          }, PANEL_FIND_RETRY_DELAY_MS);
     }

     // Periodic check setup
     if (periodicCheckInterval) clearInterval(periodicCheckInterval);
     periodicCheckInterval = setInterval(() => {
         if (!isAddButtonActive) { clearInterval(periodicCheckInterval); periodicCheckInterval = null; return; }
         if (!observer || (lastFoundPanelElement && !document.body.contains(lastFoundPanelElement))) {
             if (DEBUG_MODE) console.warn(`Periodic check: Observer issue detected (Observer: ${!!observer}, Panel Attached: ${lastFoundPanelElement && document.body.contains(lastFoundPanelElement)}). Re-setting observer.`);
             setupPanelObserver();
         }
      }, PERIODIC_CHECK_INTERVAL_MS);
}

function deactivateAddButtonFeature() {
    if (!isAddButtonActive) { return; }
    console.log("Deactivating Add Save Button feature...");
    isAddButtonActive = false;
    currentJobKeyForPanel = null; panelFindRetries = 0;
    clearTimeout(debounceTimeout); // Clear observer debounce timeout
    document.removeEventListener('click', handleJobCardClick, true);
    if (observer) { observer.disconnect(); observer = null; }
    if (periodicCheckInterval) { clearInterval(periodicCheckInterval); periodicCheckInterval = null; }
    removeExistingSaveButton();
    lastFoundPanelElement = null;
}

// --- Message Listener ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "SET_SCRAPING_STATE") {
        if (request.isScraping) { activateAddButtonFeature(); }
        else { deactivateAddButtonFeature(); }
        sendResponse({ success: true }); return false;
    }
});

// --- Initial State Check ---
(async () => {
    try {
        const response = await chrome.runtime.sendMessage({ action: "GET_STATE" });
        if (chrome.runtime.lastError) { throw new Error(chrome.runtime.lastError.message); }
        if (response && typeof response.isScraping !== 'undefined') {
            if (response.isScraping) { setTimeout(activateAddButtonFeature, ACTIVATION_DELAY_MS); }
            else { deactivateAddButtonFeature(); }
        } else { throw new Error("Invalid initial state response"); }
    } catch (error) {
        console.error("Error getting initial state:", error);
        deactivateAddButtonFeature();
    }
})();


// --- END OF FILE content.js ---