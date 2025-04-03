console.log("Background service worker started - ENHANCED VERSION");

// Storage keys
const STORAGE_KEY = 'scrapedIndeedJobs';
const JOB_IDS_KEY = 'processedJobIds';
let isScrapingActive = false;

// Initialize state
chrome.storage.local.get(['isScrapingActive'], (result) => {
    isScrapingActive = !!result.isScrapingActive;
    console.log("Initial scraping state:", isScrapingActive);
});

// Initialize job IDs set if not exists
chrome.storage.local.get([JOB_IDS_KEY], (result) => {
    if (!result[JOB_IDS_KEY]) {
        chrome.storage.local.set({ [JOB_IDS_KEY]: {} });
        console.log("Initialized empty job IDs tracking object");
    }
});

// Helper Functions
async function getJobCount() {
    try {
        const result = await chrome.storage.local.get([STORAGE_KEY]);
        const jobs = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
        return jobs.length;
    } catch (error) {
        console.error("Error getting job count:", error);
        return 0;
    }
}

async function clearDataButKeepIds() {
    try {
        // Get current jobs and extract IDs
        const result = await chrome.storage.local.get([STORAGE_KEY, JOB_IDS_KEY]);
        const jobs = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
        let processedIds = result[JOB_IDS_KEY] || {};
        
        // Add current job IDs to the processed set with timestamps
        const now = new Date().toISOString();
        jobs.forEach(job => {
            if (job.ID && !processedIds[job.ID]) {
                processedIds[job.ID] = {
                    processedAt: now,
                    title: job["Position Name"] || "Unknown", 
                    company: job["Company"] || "Unknown"
                };
            }
        });
        
        // Save the updated IDs and clear the full job data
        await chrome.storage.local.set({ [JOB_IDS_KEY]: processedIds });
        await chrome.storage.local.remove([STORAGE_KEY]);
        
        console.log(`Cleared ${jobs.length} jobs but kept ${Object.keys(processedIds).length} IDs for deduplication`);
        return true;
    } catch (error) {
        console.error("Error clearing data but keeping IDs:", error);
        return false;
    }
}

// Message handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log("Background received message:", request.action);
    
    if (request.action === "TOGGLE_SCRAPING") {
        isScrapingActive = !!request.start;
        chrome.storage.local.set({ isScrapingActive }).then(() => {
            chrome.tabs.query({ url: "*://*.indeed.com/*" }).then(tabs => {
                tabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, { action: "SET_SCRAPING_STATE", isScraping: isScrapingActive })
                        .catch(error => console.warn(`Could not send state to tab ${tab.id}: ${error.message}`));
                });
            });
            sendResponse({ success: true, isScraping: isScrapingActive });
        }).catch(err => {
            sendResponse({ success: false, error: err.message });
        });
        return true;
    } 
    
    else if (request.action === "GET_STATE") {
        // Also include job count when getting state
        getJobCount().then(count => {
            sendResponse({ success: true, isScraping: isScrapingActive, jobCount: count });
        }).catch(err => {
            sendResponse({ success: true, isScraping: isScrapingActive, jobCount: 0, error: err.message });
        });
        return true;
    } 
    
    else if (request.action === "GET_JOB_COUNT") {
        getJobCount().then(count => {
            sendResponse({ success: true, count: count });
        }).catch(err => {
            sendResponse({ success: false, count: 0, error: err.message });
        });
        return true;
    }
    
    else if (request.action === "SAVE_JOB_DATA") {
        chrome.storage.local.get([STORAGE_KEY, JOB_IDS_KEY]).then(result => {
            const jobs = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
            const processedIds = result[JOB_IDS_KEY] || {};
            
            if (request.payload && request.payload.ID) {
                // Check if job already exists in current jobs or processed IDs
                if (!jobs.some(job => job.ID === request.payload.ID) && !processedIds[request.payload.ID]) {
                    jobs.push(request.payload);
                    chrome.storage.local.set({ [STORAGE_KEY]: jobs }).then(() => {
                        console.log(`Job saved. Total: ${jobs.length}`);
                        sendResponse({ success: true, jobCount: jobs.length });
                    }).catch(err => {
                        sendResponse({ success: false, error: err.message });
                    });
                } else {
                    console.log("Job already exists or was previously processed");
                    sendResponse({ success: true, jobCount: jobs.length, duplicate: true });
                }
            } else {
                sendResponse({ success: false, error: "Invalid job data" });
            }
        }).catch(err => {
            sendResponse({ success: false, error: err.message });
        });
        return true;
    } 
    
    else if (request.action === "GET_STORED_JOBS") {
        chrome.storage.local.get([STORAGE_KEY]).then(result => {
            const jobs = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
            sendResponse({ success: true, jobs: jobs, count: jobs.length });
        }).catch(err => {
            sendResponse({ success: false, error: err.message });
        });
        return true;
    } 
    
    else if (request.action === "CLEAR_DATA") {
        if (request.keepIds) {
            clearDataButKeepIds().then(success => {
                sendResponse({ success: success });
            }).catch(err => {
                sendResponse({ success: false, error: err.message });
            });
        } else {
            chrome.storage.local.remove([STORAGE_KEY]).then(() => {
                sendResponse({ success: true });
            }).catch(err => {
                sendResponse({ success: false, error: err.message });
            });
        }
        return true;
    }
    
    else if (request.action === "CLEAR_ALL_DATA") {
        chrome.storage.local.remove([STORAGE_KEY, JOB_IDS_KEY]).then(() => {
            console.log("All job data and IDs cleared");
            sendResponse({ success: true });
        }).catch(err => {
            sendResponse({ success: false, error: err.message });
        });
        return true;
    }
    
    return false;
});