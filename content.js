console.log("Indeed Scraper: Content script loaded (Manual Save Button Mode).");

// --- Configuration ---
const DEBUG_MODE = false; // Mettre à true pour réactiver les logs détaillés
const LEFT_LIST_JOB_CARD_SELECTOR = 'div[data-testid="slider_item"]';
const JOB_KEY_SELECTOR_INSIDE_CARD = '[data-jk]';

const DETAILS_PANEL_SELECTORS = [
    '#jobsearch-ViewjobPaneWrapper',
    'div[data-testid="viewJobSSRRoot"] > div > div:nth-child(2)',
    '.jobsearch-ViewJobLayout-mainPane',
    '#vjs-container',
    '.jobsearch-ViewJobLayout',
    'aside[aria-label="description détaillée du poste"]',
    'aside[aria-labelledby="jobsearch-ViewJobViewComponent-heading"]',
    '#viewJobSSRRoot',
    '#jobsearch-ViewJob'
];

const INJECTION_POINT_SELECTORS = [
    '.jobsearch-JobInfoHeader-headerContainer',
    'div[data-testid="jobsearch-JobInfoHeader-header"]',
    'h1.jobsearch-JobInfoHeader-title',
    'h2[data-testid="simpler-jobTitle"]',
    'h1[data-testid="jobTitle"]',
    '.jobsearch-JobInfoHeader-title-container',
    '.jobsearch-ViewJobLayout-viewIndicator',
    '#jobDescriptionText',
    'div[data-testid="jobDescriptionText"]'
];

const SAVE_BUTTON_ID = 'manualSaveJobButtonIndeedExt';
const DEBOUNCE_DELAY_MS = 200; // Légèrement augmenté pour laisser le temps au DOM
const PANEL_FIND_RETRY_MAX = 5; // Moins de tentatives rapides, on se fie plus au periodic check
const PANEL_FIND_RETRY_DELAY_MS = 1000;
const PERIODIC_CHECK_INTERVAL_MS = 15000; // Vérifier toutes les 15 secondes

// --- State Variables ---
let isAddButtonActive = false;
let currentJobKeyForPanel = null;
let observer = null;
let debounceTimeout = null;
let panelFindRetries = 0;
let periodicCheckInterval = null;
let lastFoundPanelElement = null; // Garder une référence au dernier panneau trouvé

// --- Helper Functions ---
function safeQuerySelector(selector, parentElement = document) {
    try {
        document.createDocumentFragment().querySelector(selector); // Vérifie la validité
        return parentElement.querySelector(selector);
    } catch (e) { return null; }
}
function safeQuerySelectorAll(selector, parentElement = document) {
    try {
        document.createDocumentFragment().querySelector(selector); // Vérifie la validité
        return parentElement.querySelectorAll(selector);
    } catch (e) { return []; }
}
function safeGetText(element, useInnerHTML = false) {
    if (!element) return "";
    try {
        const text = useInnerHTML ? element.innerHTML : element.innerText;
        return text ? text.trim() : "";
    } catch (e) { console.error("Error getting text:", e, element); return ""; }
}
function safeGetAttribute(element, attributeName) {
    if (!element) return "";
    try {
        return element.getAttribute(attributeName) || "";
    } catch (e) { console.error(`Error getting attribute "${attributeName}":`, e, element); return ""; }
}
function getJoinedTextFromAll(selector, parentElement) {
    const elements = safeQuerySelectorAll(selector, parentElement);
    if (!elements || elements.length === 0) return "";
    const texts = Array.from(elements).map(el => safeGetText(el)).filter(text => text);
    return texts.join(', ');
}
function getExternalUrlFromInitialData() {
    try {
        const results = window._initialData?.hostQueryExecutionResult?.data?.jobData?.results;
        if (results && results.length > 0) {
             const jobUrl = results[0]?.job?.url;
             if (jobUrl && typeof jobUrl === 'string' && jobUrl.startsWith('http') && !jobUrl.includes('indeed.com/viewjob') && !jobUrl.includes('indeed.com/pagead') ) {
                return jobUrl;
             }
        }
    } catch (error) { if (DEBUG_MODE) console.warn("Could not access _initialData for external URL:", error); }
    return null;
}

// --- Fonction findDetailsPanel (Simplifiée) ---
function findDetailsPanel() {
    // if (DEBUG_MODE) console.log("Attempting to find details panel...");
    for (const selector of DETAILS_PANEL_SELECTORS) {
        const panel = safeQuerySelector(selector);
        if (panel) {
            // if (DEBUG_MODE) console.log(`Found potential details panel using selector: "${selector}"`);
            lastFoundPanelElement = panel; // Store reference
            return panel; // Retourne dès qu'un panneau est trouvé par un sélecteur principal
        }
    }
    // Fallback via description
    // if (DEBUG_MODE) console.log("Trying fallback search via job description parent...");
    const descriptionContainer = safeQuerySelector('#jobDescriptionText') || safeQuerySelector('div[data-testid="jobDescriptionText"]');
    if (descriptionContainer) {
        let parent = descriptionContainer.parentElement;
        for (let i = 0; i < 6; i++) {
            if (!parent) break;
            for (const selector of DETAILS_PANEL_SELECTORS) {
                 try {
                     if (parent.matches(selector)) {
                         // if (DEBUG_MODE) console.log(`Found panel via description parent traversal matching "${selector}"`);
                         lastFoundPanelElement = parent; // Store reference
                         return parent;
                     }
                 } catch(e) { /* ignore invalid selectors */ }
            }
             if (parent.id && (parent.id.includes('viewjob') || parent.id.includes('ViewJob') || parent.id.includes('jobsearch'))) {
                 // if (DEBUG_MODE) console.log("Found potential panel via description parent traversal (ID match):", parent.id);
                 lastFoundPanelElement = parent; // Store reference
                 return parent;
            }
            if (parent.classList.contains('jobsearch-ViewJobLayout') || parent.tagName === 'ASIDE') {
                // if (DEBUG_MODE) console.log("Found potential panel via description parent traversal (class/tag):", parent.tagName, parent.className);
                 lastFoundPanelElement = parent; // Store reference
                return parent;
            }
            parent = parent.parentElement;
        }
    }
    // Log CRITICAL seulement si TOUT échoue après toutes les tentatives.
    // console.error("CRITICAL: Could not find details panel using any known selector or fallback.");
    lastFoundPanelElement = null;
    return null;
}


// --- Button Injection Logic ---
function removeExistingSaveButton() {
    const existingButton = document.getElementById(SAVE_BUTTON_ID);
    if (existingButton) {
        existingButton.remove();
    }
}

function injectSaveButton(panelElement, jobKey) {
    if (!panelElement || !jobKey) {
        if (DEBUG_MODE) console.warn("Cannot inject button: Missing panel or job key.");
        return;
    }
    // if (DEBUG_MODE) console.log("Attempting to inject save button inside panel:", panelElement);
    removeExistingSaveButton();

    let injectionPoint = null;
    let foundSelector = null;

    // if (DEBUG_MODE) console.log("Searching for injection point within the panel...");
    for (const selector of INJECTION_POINT_SELECTORS) {
        injectionPoint = safeQuerySelector(selector, panelElement);
        if (injectionPoint) {
            foundSelector = selector;
            // if (DEBUG_MODE) console.log(`Found injection point using selector: "${foundSelector}"`);
            break;
        }
    }

    if (!injectionPoint) {
        console.error(`Could not find ANY specific injection point using selectors [${INJECTION_POINT_SELECTORS.join(', ')}] inside the panel. Cannot inject button.`);
        return;
    }

    const saveButton = document.createElement('button');
    saveButton.id = SAVE_BUTTON_ID;
    saveButton.textContent = '💾 Sauvegarder cette offre';
    saveButton.dataset.jobKey = jobKey;
    // Styles (gardés)
    saveButton.style.backgroundColor = '#198754'; saveButton.style.color = 'white';
    saveButton.style.padding = '8px 15px'; saveButton.style.border = 'none';
    saveButton.style.borderRadius = '6px'; saveButton.style.cursor = 'pointer';
    saveButton.style.marginTop = '15px'; saveButton.style.marginBottom = '15px';
    saveButton.style.fontSize = '14px'; saveButton.style.fontWeight = '500';
    saveButton.style.display = 'block'; saveButton.style.width = 'fit-content';
    saveButton.style.marginLeft = '0'; saveButton.style.marginRight = '0';
    saveButton.style.transition = 'background-color 0.2s ease, opacity 0.2s ease';

    saveButton.addEventListener('click', handleSaveButtonClick);

    if (injectionPoint.parentNode) {
        injectionPoint.parentNode.insertBefore(saveButton, injectionPoint.nextSibling);
        if (DEBUG_MODE) console.log(`Injected save button AFTER element found by selector "${foundSelector}" for Job Key: ${jobKey}`);
    } else {
         console.error("Could not inject button: The identified injection point has no parent node.", injectionPoint);
         panelElement.prepend(saveButton); // Fallback très peu probable
         if (DEBUG_MODE) console.warn(`Injection after element failed (no parent), using Fallback Prepend for Job Key: ${jobKey}`);
    }
}

// --- Event Handler for the NEW Save Button ---
async function handleSaveButtonClick(event) {
    const button = event.currentTarget;
    const jobKeyToSave = button.dataset.jobKey;

    if (!jobKeyToSave) {
        console.error("Save button clicked, but no job key found!");
        button.textContent = 'Erreur (pas de clé)';
        return;
    }

    if (DEBUG_MODE) console.log(`Manual save requested for Job Key: ${jobKeyToSave}`);
    button.disabled = true;
    button.textContent = '💾 Sauvegarde en cours...';
    button.style.opacity = '0.7';

    const jobData = await scrapeJobDetails(jobKeyToSave);

    if (jobData) {
        chrome.runtime.sendMessage({ action: "SAVE_JOB_DATA", payload: jobData }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Error sending scraped data:", chrome.runtime.lastError.message, jobData);
                button.textContent = '❌ Erreur Envoi';
                button.style.backgroundColor = '#dc3545';
            } else {
                if (DEBUG_MODE) console.log("Scraped data sent to background:", response);
                if (response && response.success) {
                    button.textContent = response.duplicate ? '✅ Déjà Sauvegardé' : '✅ Offre Sauvegardée!';
                    button.style.backgroundColor = response.duplicate ? '#ffc107' : '#0d6efd';
                } else {
                    button.textContent = '❌ Erreur Sauvegarde';
                    button.style.backgroundColor = '#dc3545';
                }
            }
        });
    } else {
        console.error("Scraping failed for job key:", jobKeyToSave);
        button.textContent = '❌ Erreur Scraping';
        button.style.backgroundColor = '#dc3545';
    }
}


// --- Modified Scraping Function (accepts jobKey) ---
async function scrapeJobDetails(jobKey) {
    // if (DEBUG_MODE) console.log(`Scraping details requested for Job Key: ${jobKey}`);
    if (!jobKey) {
        console.warn("Scrape triggered, but no jobKey provided.");
        return null;
    }

    // Utilise la dernière référence connue si disponible, sinon cherche
    const detailsPanel = lastFoundPanelElement && document.body.contains(lastFoundPanelElement)
                         ? lastFoundPanelElement
                         : findDetailsPanel();

    if (!detailsPanel) {
        console.error(`Details panel not found for scraping job ${jobKey}.`);
        return null;
    }
    // if (DEBUG_MODE) console.log("Scraping details within panel:", detailsPanel);

    // --- Extract Data ---
    let positionName = safeGetText(safeQuerySelector('h2[data-testid="simpler-jobTitle"]', detailsPanel)) ||
                      safeGetText(safeQuerySelector('h1.jobsearch-JobInfoHeader-title', detailsPanel)) ||
                      safeGetText(safeQuerySelector('h1[data-testid="jobTitle"]', detailsPanel)) ||
                      safeGetText(safeQuerySelector('.jobsearch-JobInfoHeader-title', detailsPanel));

    let company = safeGetText(safeQuerySelector('div[data-testid="simpler-simplified-header"] a[data-testid="companyLink"]', detailsPanel)) ||
                 safeGetText(safeQuerySelector('div[data-testid="jobsearch-JobInfoHeader-companyName"]', detailsPanel)) ||
                 safeGetText(safeQuerySelector('div[data-company-name="true"] a', detailsPanel)) ||
                 safeGetText(safeQuerySelector('a.jobsearch-JobInfoHeader-companyNameLink', detailsPanel));

    let location = safeGetText(safeQuerySelector('div[data-testid="jobsearch-JobInfoHeader-companyLocation"]', detailsPanel)) ||
                   safeGetText(safeQuerySelector('div[data-testid="company-location"]', detailsPanel)) ||
                   safeGetText(safeQuerySelector('.jobsearch-JobInfoCompanyLocation', detailsPanel));

    const descriptionElement = safeQuerySelector('#jobDescriptionText', detailsPanel) ||
                              safeQuerySelector('div[data-testid="jobDescriptionText"]', detailsPanel);

    const getDetailListItemText = (ariaLabel) => {
        let text = "";
        text = getJoinedTextFromAll(`div[aria-label*="${ariaLabel}"] li[data-testid="list-item"] span`, detailsPanel);
        if (text) return text;

        const metadataContainer = safeQuerySelector('#jobDetailsSection', detailsPanel) || safeQuerySelector('div[data-testid="job-details-section"]', detailsPanel);
        if(metadataContainer) {
             const directLabelDiv = safeQuerySelector(`div[aria-label*="${ariaLabel}"]`, metadataContainer);
             if(directLabelDiv) {
                 text = getJoinedTextFromAll('li, span', directLabelDiv);
                 if(text) return text;
             }
             const potentialLabels = safeQuerySelectorAll('div > div', metadataContainer);
             for(const labelDiv of potentialLabels) {
                 const labelText = safeGetText(labelDiv);
                 if (labelText && ariaLabel.toLowerCase().split(' ').some(word => labelText.toLowerCase().includes(word) && word.length > 3)) {
                     const valueDiv = labelDiv.nextElementSibling;
                      if(valueDiv) {
                         text = safeGetText(valueDiv);
                         if (text) return text;
                     }
                     if (labelText.includes(':')) {
                        text = labelText.split(':')[1]?.trim();
                         if (text) return text;
                     }
                 }
             }
        }
        text = getJoinedTextFromAll(`#jobDetailsSection div:has(> svg[aria-label*="${ariaLabel}"]) + div span`, detailsPanel);
        if (text) return text;

        return "";
    };

    const jobData = {
        "ID": jobKey,
        "Position Name": positionName || "Non trouvé",
        "Company": company || "Non trouvé",
        "Location": location || "Non trouvé",
        "Salary": getDetailListItemText("Salaire"),
        "Job Type": getDetailListItemText("Type de poste") || getDetailListItemText("Job type"),
        "Shift & Schedule": getDetailListItemText("Horaires de travail") || getDetailListItemText("Shift and schedule"),
        "Education_Level": getDetailListItemText("Formation") || getDetailListItemText("Education"),
        "Skills": getDetailListItemText("Compétences") || getDetailListItemText("Qualifications") || getDetailListItemText("Hiring insights"),
        "Languages": getDetailListItemText("Langues"),
        "Description": safeGetText(descriptionElement, true) || "Description non trouvée",
        "Indeed_View_Job_Link": `https://fr.indeed.com/viewjob?jk=${jobKey}`,
        "External_Apply_Link": getExternalUrlFromInitialData() || "",
        "Indeed_Apply_Start_Link": safeGetAttribute(safeQuerySelector('#indeedApplyButton', detailsPanel), 'href') ||
                                  safeGetAttribute(safeQuerySelector('a[data-tn-element="jobTitle"]', detailsPanel), 'href') ||
                                  safeGetAttribute(safeQuerySelector('#applyButtonLinkContainer button[href]', detailsPanel), 'href') ||
                                  safeGetAttribute(safeQuerySelector('button[data-tn-element="IndeedApplyButton"]', detailsPanel),'href'),
        "Scraped At": new Date().toISOString()
    };

    // if (DEBUG_MODE) console.log("Scraped Data:", jobData);
    return jobData;
}

// --- Modified Event Listener for Job Card Click ---
function handleJobCardClick(event) {
    const jobCard = event.target.closest(LEFT_LIST_JOB_CARD_SELECTOR);
    if (!jobCard) return;

    const jobKeyElement = safeQuerySelector(JOB_KEY_SELECTOR_INSIDE_CARD, jobCard);
    const jobKey = jobKeyElement ? safeGetAttribute(jobKeyElement, 'data-jk') : null;

    if (jobKey) {
        if (DEBUG_MODE) console.log(`Detected click for Job Key: ${jobKey}. Panel update expected.`);
        currentJobKeyForPanel = jobKey;
        removeExistingSaveButton(); // Remove button immediately on click
    } else {
        // if (DEBUG_MODE) console.warn("Could not find job key (data-jk) on clicked card.");
        currentJobKeyForPanel = null;
        removeExistingSaveButton();
    }
}

// --- Modified Mutation Observer Logic ---
function handlePanelMutation(mutationsList) {
    if (!isAddButtonActive || !currentJobKeyForPanel) return;

    // Simple trigger on mutation is enough, debounce will handle frequency
    // if (DEBUG_MODE) console.log("Relevant details panel mutation detected. Debouncing button injection...");

    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(() => {
        // if (DEBUG_MODE) console.log("Debounced action triggered: Attempting button injection.");
        if (isAddButtonActive && currentJobKeyForPanel) {
            // Tentative de retrouver le panneau APRES le délai
            const panel = findDetailsPanel();
            if(panel) {
                 // Vérification de clé (optionnelle mais utile si possible)
                 const panelKey = safeGetAttribute(safeQuerySelector('[data-jk]', panel), 'data-jk') || panel.dataset.jobid;
                 if (panelKey && panelKey !== currentJobKeyForPanel) {
                      if (DEBUG_MODE) console.warn(`Panel content key (${panelKey}) does not match expected key (${currentJobKeyForPanel}). Aborting injection for this mutation.`);
                      removeExistingSaveButton();
                      // Ne pas réinitialiser currentJobKeyForPanel ici, une autre mutation pourrait corriger
                 } else {
                      // if (DEBUG_MODE) console.log(`Panel confirmed/updated for ${currentJobKeyForPanel}. Injecting save button.`);
                      injectSaveButton(panel, currentJobKeyForPanel);
                 }
            } else {
                 // C'est ici que l'erreur se produisait dans vos logs
                 console.warn(`Panel not found AFTER debounce for key ${currentJobKeyForPanel}. Button not injected for this update.`);
                 removeExistingSaveButton();
                 // Ne pas logguer comme CRITICAL ici. periodicCheck s'en chargera si ça persiste.
            }
        } else {
            // if (DEBUG_MODE) console.log("Debounced call: Button adding stopped or key cleared before injection.");
            removeExistingSaveButton();
        }
    }, DEBOUNCE_DELAY_MS);
}

// --- Setup Panel Observer ---
function setupPanelObserver() {
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    const targetNode = findDetailsPanel();
    if (targetNode) {
        panelFindRetries = 0;
        const config = { childList: true, subtree: true, attributes: true, attributeFilter: ['id', 'class', 'style', 'data-jobid', 'aria-hidden'] };
        observer = new MutationObserver(handlePanelMutation);
        try {
             observer.observe(targetNode, config);
             // if (DEBUG_MODE) console.log("MutationObserver attached to details panel:", targetNode);
        } catch (error) {
             console.error("FAILED to attach MutationObserver:", error, "Target node:", targetNode);
             lastFoundPanelElement = null; // Invalidate cache on error
             return false;
        }

        if (isAddButtonActive) {
             const currentPanelJobKey = safeGetAttribute(safeQuerySelector('[data-jk]', targetNode), 'data-jk') || targetNode.dataset.jobid;
             if(currentPanelJobKey) {
                  // if (DEBUG_MODE) console.log("Initial check: Panel already visible with Job Key", currentPanelJobKey, ". Injecting button.");
                  currentJobKeyForPanel = currentPanelJobKey;
                  setTimeout(() => injectSaveButton(targetNode, currentPanelJobKey), 100);
             } else {
                 // if (DEBUG_MODE) console.log("Initial check: Panel visible, but no Job Key found inside it.");
             }
        }
        return true;

    } else {
        if (panelFindRetries === 0 || panelFindRetries === PANEL_FIND_RETRY_MAX -1 ) {
            if (DEBUG_MODE) console.warn(`Could not find details panel to observe. Attempt ${panelFindRetries + 1}/${PANEL_FIND_RETRY_MAX}`);
        }
        return false;
    }
}


// --- Activation / Deactivation ---
function activateAddButtonFeature() {
    if (isAddButtonActive && observer && lastFoundPanelElement && document.body.contains(lastFoundPanelElement)) {
         // if (DEBUG_MODE) console.log("Add Button feature already active and observer seems attached.");
         return;
    }
     if (isAddButtonActive && (!observer || !lastFoundPanelElement || !document.body.contains(lastFoundPanelElement))) {
         if (DEBUG_MODE) console.log("Add Button feature was active but observer/panel needs re-attaching...");
         if (!setupPanelObserver()) { // Tenter de rattacher
             if (DEBUG_MODE) console.warn("Re-attach failed immediately.");
         }
         return;
     }

    console.log("Activating Add Save Button feature...");
    isAddButtonActive = true;
    panelFindRetries = 0;

    document.addEventListener('click', handleJobCardClick, true);
    // if (DEBUG_MODE) console.log(`Attached delegated click listener.`);

    if (!setupPanelObserver() && panelFindRetries < PANEL_FIND_RETRY_MAX) {
        panelFindRetries++;
        const retryInterval = setInterval(() => {
            if (!isAddButtonActive) {
                clearInterval(retryInterval);
                return;
            }
            // if (DEBUG_MODE) console.log(`Retrying panel observer setup (${panelFindRetries}/${PANEL_FIND_RETRY_MAX})...`);
            if (setupPanelObserver() || panelFindRetries >= PANEL_FIND_RETRY_MAX) {
                 clearInterval(retryInterval);
                 if(panelFindRetries >= PANEL_FIND_RETRY_MAX) {
                     console.error("Failed to setup panel observer after multiple retries.");
                 }
            }
            panelFindRetries++;
        }, PANEL_FIND_RETRY_DELAY_MS);
    }

    // Vérification périodique
    if (periodicCheckInterval) clearInterval(periodicCheckInterval);
    periodicCheckInterval = setInterval(() => {
        if (!isAddButtonActive) {
            clearInterval(periodicCheckInterval); periodicCheckInterval = null; return;
        }
        // Vérifier si le noeud observé (ou le dernier trouvé) est toujours dans le DOM
        if (observer && (!lastFoundPanelElement || !document.body.contains(lastFoundPanelElement))) {
             if (DEBUG_MODE) console.warn("Periodic check: Observed panel node detached. Attempting re-setup...");
             setupPanelObserver(); // Tenter de retrouver et ré-observer
        } else if (!observer) { // Si pas d'observateur actif
             if (DEBUG_MODE) console.log("Periodic check: No observer active. Attempting setup...");
             setupPanelObserver();
        }
    }, PERIODIC_CHECK_INTERVAL_MS);
}

function deactivateAddButtonFeature() {
    if (!isAddButtonActive && !observer && !document.getElementById(SAVE_BUTTON_ID)) {
         return; // Déjà inactif
    }
    console.log("Deactivating Add Save Button feature...");
    isAddButtonActive = false;
    currentJobKeyForPanel = null;
    panelFindRetries = 0;
    lastFoundPanelElement = null;

    document.removeEventListener('click', handleJobCardClick, true);
    // if (DEBUG_MODE) console.log(`Removed delegated click listener.`);

    if (observer) {
        observer.disconnect();
        observer = null;
        // if (DEBUG_MODE) console.log("MutationObserver disconnected.");
    }
    if (periodicCheckInterval) {
        clearInterval(periodicCheckInterval);
        periodicCheckInterval = null;
        // if (DEBUG_MODE) console.log("Stopped periodic observer check.");
    }
    clearTimeout(debounceTimeout);
    removeExistingSaveButton();
}

// --- Message Listener ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "SET_SCRAPING_STATE") {
         // if (DEBUG_MODE) console.log("Received SET_SCRAPING_STATE message:", request.isScraping);
        if (request.isScraping) {
            activateAddButtonFeature();
        } else {
            deactivateAddButtonFeature();
        }
        sendResponse({ success: true });
        return false; // Indique une réponse asynchrone non utilisée ici
    }
});

// --- Initial State Check ---
chrome.runtime.sendMessage({ action: "GET_STATE" })
    .then(response => {
        if (chrome.runtime.lastError) { // Gérer l'erreur de communication
             console.error("Error getting initial state:", chrome.runtime.lastError.message);
             deactivateAddButtonFeature(); // Assumer inactif en cas d'erreur
             return;
        }
        if (response && typeof response.isScraping !== 'undefined') {
             // if (DEBUG_MODE) console.log("Initial state from background: isScraping =", response.isScraping);
            if (response.isScraping) {
                // if (DEBUG_MODE) console.log("Initial state is active, activating feature.");
                setTimeout(activateAddButtonFeature, 500); // Délai initial
            } else {
                // if (DEBUG_MODE) console.log("Initial state is inactive.");
                 deactivateAddButtonFeature(); // Assurer la désactivation
            }
        } else {
             console.warn("Invalid or missing initial state from background. Assuming inactive.");
             deactivateAddButtonFeature();
        }
    })
    .catch(error => { // Gérer les erreurs de promesse (ex: background script non prêt)
        console.error("Error getting initial state via promise:", error);
        deactivateAddButtonFeature();
    });