console.log("Background service worker started.");

// --- Storage Key and State ---
const STORAGE_KEY = 'scrapedIndeedJobs';
let isScrapingActive = false; // Default state is inactive

// --- Initialization ---
chrome.storage.local.get(['isScrapingActive'], (result) => {
    isScrapingActive = !!result.isScrapingActive; // Ensure boolean
    console.log("Initial scraping state loaded:", isScrapingActive);
});

// --- Helper Functions ---
async function getStoredJobs() {
    try {
        const result = await chrome.storage.local.get([STORAGE_KEY]);
        console.log("Retrieved from storage:", result);
        return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
    } catch (error) {
        console.error("Error retrieving jobs from storage:", error);
        return [];
    }
}

async function saveJobData(newJobData) {
    if (!newJobData || !newJobData.ID) {
        console.error("Attempted to save invalid job data (missing ID):", newJobData);
        return false;
    }
    try {
        const jobs = await getStoredJobs();
        const existingIndex = jobs.findIndex(job => job.ID === newJobData.ID);
        if (existingIndex === -1) {
            jobs.push(newJobData);
            await chrome.storage.local.set({ [STORAGE_KEY]: jobs });
            console.log(`Job ${newJobData.ID} saved. Total jobs: ${jobs.length}`);
            return true;
        } else {
            console.log(`Job ${newJobData.ID} is already stored. Skipping save.`);
            return false; // Indicate duplicate
        }
    } catch (error) {
        console.error("Error saving job data:", error);
        return false;
    }
}

async function clearStoredJobs() {
    try {
        await chrome.storage.local.remove([STORAGE_KEY]);
        console.log("Stored job data cleared.");
        return true;
    } catch (error) {
        console.error("Error clearing stored jobs:", error);
        return false;
    }
}

function convertToCSV(jobs) {
    if (!jobs || jobs.length === 0) {
        console.warn("No jobs to convert to CSV");
        return "";
    }
    
    console.log("Converting jobs to CSV:", jobs.length, "jobs");
    
    const headers = [
        "Position Name", "Company", "Location", "Salary", "Job Type",
        "Shift & Schedule", "Education_Level", "Skills", "Description",
        "ID", "Indeed_View_Job_Link", "External_Apply_Link",
        "Indeed_Apply_Start_Link", "Scraped At"
    ];
    
    const escapeCSV = (value) => {
        if (value === null || value === undefined) return "";
        const stringValue = String(value);
        if (stringValue.includes('"') || stringValue.includes(',') || stringValue.includes('\n') || stringValue.includes('\r')) {
            return `"${stringValue.replace(/"/g, '""')}"`;
        }
        return stringValue;
    };
    
    const headerRow = headers.map(escapeCSV).join(',');
    const dataRows = jobs.map(job => {
        return headers.map(header => {
            const value = job[header];
            return escapeCSV(value);
        }).join(',');
    });
    
    return [headerRow, ...dataRows].join('\r\n');
}

async function downloadCSV(csvContent) {
    if (!csvContent) {
        console.warn("No CSV content to download.");
        return false;
    }
    
    try {
        console.log("Creating blob for download...");
        const blob = new Blob([`\uFEFF${csvContent}`], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const timestamp = new Date().toISOString().slice(0, 19).replace(/[-T:]/g, '');
        const filename = `indeed_jobs_${timestamp}.csv`;

        console.log("Initiating download with filename:", filename);
        const downloadId = await chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: true
        });

        console.log("Download started with ID:", downloadId);
        // Revoke URL after a delay
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return true;
    } catch (error) {
        console.error("Download failed:", error);
        return false;
    }
}

// --- Message Listener ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const action = request.action;
    console.log("Background received message:", action, "from:", sender.tab ? "content script" : "popup");

    if (action === "TOGGLE_SCRAPING") {
        isScrapingActive = !!request.start; // Ensure boolean
        chrome.storage.local.set({ isScrapingActive: isScrapingActive }).then(() => {
            console.log("Scraping state updated:", isScrapingActive);
            // Notify content scripts
            chrome.tabs.query({ url: "*://*.indeed.com/*" }).then(tabs => {
                console.log("Found tabs to notify:", tabs.length);
                tabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, { action: "SET_SCRAPING_STATE", isScraping: isScrapingActive })
                        .catch(error => console.warn(`Could not send state to tab ${tab.id}: ${error.message}`));
                });
            }).catch(err => console.error("Error querying tabs:", err));
            // Respond to popup
            sendResponse({ success: true, isScraping: isScrapingActive });
        }).catch(err => {
             console.error("Error saving scraping state:", err);
             sendResponse({ success: false, error: err.message });
        });
        return true; // Async response

    } else if (action === "GET_STATE") {
        sendResponse({ success: true, isScraping: isScrapingActive });
        return false; // Sync response

    } else if (action === "SAVE_JOB_DATA") {
        saveJobData(request.payload).then(success => {
            sendResponse({ success: success });
        });
        return true; // Async response

    } else if (action === "DOWNLOAD_CSV") {
        console.log("Processing DOWNLOAD_CSV request");
        getStoredJobs().then(jobs => {
            console.log("Retrieved jobs for download:", jobs.length);
            if (jobs.length > 0) {
                const csv = convertToCSV(jobs);
                console.log("CSV created, length:", csv.length);
                downloadCSV(csv).then(success => {
                    console.log("Download result:", success);
                    sendResponse({ success: success });
                });
            } else {
                console.log("No jobs to download");
                sendResponse({ success: false, message: "No job data stored." });
            }
        }).catch(error => {
            console.error("Error in DOWNLOAD_CSV handler:", error);
            sendResponse({ success: false, message: error.message });
        });
        return true; // Async response

    } else if (action === "CLEAR_DATA") {
        clearStoredJobs().then(success => {
            sendResponse({ success: success });
        });
        return true; // Async response
    }

    // Default for unhandled actions
    console.warn("Unhandled action received:", action);
    return false;
});