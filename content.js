console.log("Indeed Scraper: Content script loaded.");

// --- Configuration ---
const LEFT_LIST_JOB_CARD_SELECTOR = 'div[data-testid="slider_item"]'; // Clickable container on the left
const JOB_KEY_SELECTOR_INSIDE_CARD = '[data-jk]'; // Element containing data-jk inside the card
// Try multiple possible selectors for the details panel
const DETAILS_PANEL_SELECTORS = [
    '#vjs-container', // Original selector
    '#jobsearch-ViewjobPaneWrapper', // Alternative selector
    'div[data-testid="viewJobSSRRoot"]', // Another possible selector
    '#viewJobSSRRoot', // Another variation
    '#jobsearch-ViewJob', // Yet another possible container
    '.jobsearch-ViewJobLayout' // Additional container class
];
const DEBOUNCE_DELAY_MS = 600; // Wait slightly longer after panel updates before scraping
const PANEL_FIND_RETRY_MAX = 10; // Maximum number of retries to find the panel
const PANEL_FIND_RETRY_DELAY_MS = 1000; // Delay between retries

// --- State Variables ---
let isScrapingActive = false; // Tracks if scraping should be happening
let currentJobKey = null; // Temporarily stores the Job Key of the *last clicked* job card
let observer = null; // Holds the MutationObserver instance
let debounceTimeout = null; // Holds the timeout ID for debouncing
let panelFindRetries = 0; // Counter for panel finding retries
let periodicCheckInterval = null; // For ongoing panel checks

// --- Helper Functions ---

function safeQuerySelector(selector, parentElement = document) {
    try {
        return parentElement.querySelector(selector);
    } catch (e) {
        // console.error(`Error querying selector "${selector}":`, e); // Reduced console noise
        return null;
    }
}

function safeQuerySelectorAll(selector, parentElement = document) {
    try {
        return parentElement.querySelectorAll(selector);
    } catch (e) {
        // console.error(`Error querying selector all "${selector}":`, e); // Reduced console noise
        return [];
    }
}

function safeGetText(element, useInnerHTML = false) {
    if (!element) return "";
    try {
        const text = useInnerHTML ? element.innerHTML : element.innerText;
        return text ? text.trim() : "";
    } catch (e) {
        console.error("Error getting text:", e, element);
        return "";
    }
}

function safeGetAttribute(element, attributeName) {
    if (!element) return "";
    try {
        return element.getAttribute(attributeName) || "";
    } catch (e) {
        console.error(`Error getting attribute "${attributeName}":`, e, element);
        return "";
    }
}

function getJoinedTextFromAll(selector, parentElement) {
    const elements = safeQuerySelectorAll(selector, parentElement);
    if (!elements || elements.length === 0) return "";
    const texts = Array.from(elements).map(el => safeGetText(el)).filter(text => text); // Filter out empty strings
    return texts.join(', ');
}

function getExternalUrlFromInitialData() {
    try {
        // Added more null checks for robustness
        const jobUrl = window._initialData?.hostQueryExecutionResult?.data?.jobData?.results?.[0]?.job?.url;
        if (jobUrl && typeof jobUrl === 'string' && jobUrl.startsWith('http') && !jobUrl.includes('indeed.com/viewjob') && !jobUrl.includes('indeed.com/pagead') ) {
             // Added check against pagead links which are also internal
            return jobUrl;
        }
    } catch (error) {
        console.warn("Could not access _initialData for external URL:", error);
    }
    return null;
}

function findDetailsPanel() {
    // Try each selector in order
    for (const selector of DETAILS_PANEL_SELECTORS) {
        const panel = safeQuerySelector(selector);
        if (panel) {
            console.log(`Found details panel using selector: ${selector}`);
            return panel;
        }
    }
    
    // If we still can't find the panel, try a more general approach
    // Look for elements that might contain the job description
    const descriptionContainer = safeQuerySelector('#jobDescriptionText') || 
                                 safeQuerySelector('div[data-testid="jobDescriptionText"]');
    
    if (descriptionContainer) {
        // Try to find the nearest container that would be suitable for observation
        let parent = descriptionContainer.parentElement;
        // Go up a few levels to find a suitable container
        for (let i = 0; i < 5; i++) {
            if (!parent) break;
            console.log("Found potential panel via job description parent traversal");
            return parent;
            parent = parent.parentElement;
        }
    }
    
    return null;
}

function scrapeJobDetails() {
    console.log(`Scraping details for Job Key: ${currentJobKey}`);
    if (!currentJobKey) {
        console.warn("Scrape triggered, but no currentJobKey is set. Skipping.");
        return;
    }

    const detailsPanel = findDetailsPanel();
    if (!detailsPanel) {
        console.error("Details panel not found for scraping.");
        currentJobKey = null; // Prevent retry with stale key
        return;
    }

    // --- Extract Data ---
    // First try with the original selectors
    let positionName = safeGetText(safeQuerySelector('h2[data-testid="simpler-jobTitle"]', detailsPanel));
    let company = safeGetText(safeQuerySelector('div[data-testid="simpler-simplified-header"] a.jobsearch-JobInfoHeader-companyNameLink', detailsPanel));
    let location = safeGetText(safeQuerySelector('div[data-testid="jobsearch-JobInfoHeader-companyLocation"]', detailsPanel));
    
    // If we couldn't get basic info, try alternative selectors
    if (!positionName) {
        positionName = safeGetText(safeQuerySelector('h1.jobsearch-JobInfoHeader-title', detailsPanel)) ||
                      safeGetText(safeQuerySelector('h1[data-testid="jobTitle"]', detailsPanel));
    }
    
    if (!company) {
        company = safeGetText(safeQuerySelector('div.jobsearch-CompanyInfo a', detailsPanel)) ||
                 safeGetText(safeQuerySelector('div[data-testid="company-name"]', detailsPanel));
    }
    
    if (!location) {
        location = safeGetText(safeQuerySelector('div.jobsearch-CompanyInfo div.css-1p0jwwu', detailsPanel)) ||
                  safeGetText(safeQuerySelector('div[data-testid="company-location"]', detailsPanel));
    }

    // Flexible approach for description to handle different structures
    const descriptionElement = safeQuerySelector('#jobDescriptionText', detailsPanel) || 
                              safeQuerySelector('div[data-testid="jobDescriptionText"]', detailsPanel);
    
    const jobData = {
        "ID": currentJobKey,
        "Position Name": positionName,
        "Company": company,
        "Location": location,
        "Salary": safeGetText(safeQuerySelector('div[aria-label="Salaire"] li[data-testid="list-item"] span', detailsPanel)),
        "Job Type": getJoinedTextFromAll('div[aria-label="Type de poste"] li[data-testid="list-item"] span', detailsPanel),
        "Shift & Schedule": getJoinedTextFromAll('div[aria-label="Horaires de travail"] li[data-testid="list-item"] span', detailsPanel),
        "Education_Level": getJoinedTextFromAll('div[aria-label="Formation"] li[data-testid="list-item"] span', detailsPanel),
        "Skills": getJoinedTextFromAll('div[aria-label="Compétences"] li[data-testid="list-item"] span', detailsPanel),
        "Description": safeGetText(descriptionElement, true),
        "Indeed_View_Job_Link": `https://fr.indeed.com/viewjob?jk=${currentJobKey}`,
        "External_Apply_Link": getExternalUrlFromInitialData() || "",
        "Indeed_Apply_Start_Link": safeGetAttribute(safeQuerySelector('#applyButtonLinkContainer button[href]', detailsPanel), 'href'),
        "Scraped At": new Date().toISOString()
    };

    console.log("Scraped Data:", jobData);

    // Send scraped data to background script
    chrome.runtime.sendMessage({ action: "SAVE_JOB_DATA", payload: jobData }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("Error sending scraped data:", chrome.runtime.lastError.message, jobData);
        } else {
            console.log("Scraped data sent to background:", response);
        }
    });

    currentJobKey = null; // Reset key after successful scrape attempt
}

function handleJobCardClick(event) {
    if (!isScrapingActive) return;

    // Find the card container, even if the click was on a child element
    const jobCard = event.target.closest(LEFT_LIST_JOB_CARD_SELECTOR);
    if (!jobCard) {
        console.log("Click detected, but not inside a recognized job card.");
        return; // Exit if the click wasn't on or inside a job card
    }

    console.log("Job card clicked:", jobCard);
    const jobKeyElement = safeQuerySelector(JOB_KEY_SELECTOR_INSIDE_CARD, jobCard);
    const jobKey = jobKeyElement ? safeGetAttribute(jobKeyElement, 'data-jk') : null;

    if (jobKey) {
        console.log(`Captured Job Key: ${jobKey}`);
        currentJobKey = jobKey;
        
        // After capturing the job key, try to manually trigger a scrape after a delay
        // This serves as a backup in case the mutation observer fails
        setTimeout(() => {
            if (isScrapingActive && currentJobKey === jobKey) {
                console.log("Attempting backup scrape after delay");
                scrapeJobDetails();
            }
        }, 1500); // Wait 1.5 seconds
        
    } else {
        console.warn("Could not find job key (data-jk) on clicked card or its children.");
        currentJobKey = null;
    }
}

function handlePanelMutation(mutationsList) {
    if (!isScrapingActive || !currentJobKey) return;

    // Basic check if the panel content likely changed significantly
    let panelChanged = false;
    for (const mutation of mutationsList) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
             // Check if added nodes contain potentially identifying info like job title selector
             for(const node of mutation.addedNodes) {
                 if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.querySelector('h2[data-testid="simpler-jobTitle"]') || 
                        node.querySelector('h1.jobsearch-JobInfoHeader-title') ||
                        node.querySelector('h1[data-testid="jobTitle"]') ||
                        node.querySelector('#jobDescriptionText')) {
                        panelChanged = true;
                        break;
                    }
                 }
             }
        }
        if(panelChanged) break;
        // Could add more checks (e.g., attribute changes on specific elements) if needed
    }

    if (!panelChanged) {
       // console.log("Mutation detected, but doesn't look like a panel content update. Ignoring.");
        return; // Ignore minor mutations
    }

    console.log("Relevant details panel mutation detected.");
    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(() => {
        if (isScrapingActive && currentJobKey) {
            scrapeJobDetails();
        } else {
            console.log("Debounced call: Scraping stopped or key cleared before scrape.");
        }
    }, DEBOUNCE_DELAY_MS);
}

function setupPanelObserver() {
    // If an observer is already set up, disconnect it first
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    
    const targetNode = findDetailsPanel();
    if (targetNode) {
        panelFindRetries = 0; // Reset retry counter on success
        const config = { childList: true, subtree: true };
        observer = new MutationObserver(handlePanelMutation);
        observer.observe(targetNode, config);
        console.log("MutationObserver attached to details panel.");
        return true;
    } else {
        console.warn(`Could not find details panel to observe. Attempt ${panelFindRetries + 1}/${PANEL_FIND_RETRY_MAX}`);
        return false;
    }
}

function activateScraping() {
    console.log("Activating scraping listeners...");
    isScrapingActive = true;

    // Use event delegation on the document for clicks - more robust
    // than attaching to individual cards that might load dynamically
    document.addEventListener('click', handleJobCardClick, true); // Use capture phase
    console.log(`Attached delegated click listener for job cards.`);

    // Try to set up the panel observer
    if (!setupPanelObserver() && panelFindRetries < PANEL_FIND_RETRY_MAX) {
        // If we couldn't find the panel, try again after a delay
        panelFindRetries++;
        setTimeout(() => {
            if (isScrapingActive) { // Only retry if scraping is still active
                console.log(`Retrying panel observer setup (${panelFindRetries}/${PANEL_FIND_RETRY_MAX})...`);
                setupPanelObserver();
            }
        }, PANEL_FIND_RETRY_DELAY_MS);
    }
    
    // Also set up a periodic check to ensure we have an observer
    // This helps if the panel is dynamically added to the DOM later
    if (periodicCheckInterval) {
        clearInterval(periodicCheckInterval);
    }
    
    periodicCheckInterval = setInterval(() => {
        if (!isScrapingActive) {
            clearInterval(periodicCheckInterval);
            periodicCheckInterval = null;
            return;
        }
        
        if (!observer && panelFindRetries < PANEL_FIND_RETRY_MAX) {
            console.log("Periodic check: No observer found, attempting to set up...");
            panelFindRetries++;
            setupPanelObserver();
        }
    }, PANEL_FIND_RETRY_DELAY_MS * 2);
}

function deactivateScraping() {
    if (!isScrapingActive && !observer) return; // Already inactive
    console.log("Deactivating scraping listeners...");
    isScrapingActive = false;
    currentJobKey = null;
    panelFindRetries = 0;

    // Remove delegated click listener
    document.removeEventListener('click', handleJobCardClick, true);
    console.log(`Removed delegated click listener.`);

    if (observer) {
        observer.disconnect();
        observer = null;
        console.log("MutationObserver disconnected.");
    }
    
    if (periodicCheckInterval) {
        clearInterval(periodicCheckInterval);
        periodicCheckInterval = null;
    }
    
    clearTimeout(debounceTimeout);
}

// --- Message Listener ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log("Content script received message:", request);

    if (request.action === "SET_SCRAPING_STATE") {
        if (request.isScraping) {
            activateScraping();
        } else {
            deactivateScraping();
        }
        // Send simple ack response, state management is primarily in background
        sendResponse({ success: true });
        return false; // Synchronous response sufficient
    }
});

// --- Initial State Check ---
chrome.runtime.sendMessage({ action: "GET_STATE" })
    .then(response => {
        if (response && response.isScraping) {
            console.log("Initial state is active, activating listeners.");
            activateScraping();
        } else {
            console.log("Initial state is inactive.");
            // Ensure deactivated if background says inactive
            deactivateScraping();
        }
    })
    .catch(error => {
        console.error("Error getting initial state:", error);
        // Assume inactive on error
        deactivateScraping();
    });