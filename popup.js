// DOM Elements
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const downloadButton = document.getElementById('downloadButton');
const clearButton = document.getElementById('clearButton');
const statusDiv = document.getElementById('status');

// Add job counter element
let jobCounterElement = document.createElement('div');
jobCounterElement.id = 'jobCounter';
jobCounterElement.style.textAlign = 'center';
jobCounterElement.style.marginTop = '10px';
jobCounterElement.style.fontSize = '13px';
jobCounterElement.style.color = 'var(--misty-blue)';
statusDiv.after(jobCounterElement);

// Add auto-delete checkbox
let autoDeleteContainer = document.createElement('div');
autoDeleteContainer.style.marginTop = '15px';
autoDeleteContainer.style.display = 'flex';
autoDeleteContainer.style.alignItems = 'center';
autoDeleteContainer.style.justifyContent = 'center';

let autoDeleteCheckbox = document.createElement('input');
autoDeleteCheckbox.type = 'checkbox';
autoDeleteCheckbox.id = 'autoDeleteCheckbox';
autoDeleteCheckbox.checked = true;

let autoDeleteLabel = document.createElement('label');
autoDeleteLabel.htmlFor = 'autoDeleteCheckbox';
autoDeleteLabel.style.marginLeft = '5px';
autoDeleteLabel.style.fontSize = '12px';
autoDeleteLabel.style.color = 'var(--misty-blue)';
autoDeleteLabel.textContent = 'Auto-delete after download (keep IDs for deduplication)';

autoDeleteContainer.appendChild(autoDeleteCheckbox);
autoDeleteContainer.appendChild(autoDeleteLabel);
jobCounterElement.after(autoDeleteContainer);

// UI update function
function updateUI(isScraping, message = null, jobCount = null) {
  const statusDefault = isScraping ? 'Status: Scraping active. Click jobs on the page.' : 'Status: Idle. Press Start.';
  if (isScraping) {
    startButton.classList.add('hidden');
    stopButton.classList.remove('hidden');
  } else {
    startButton.classList.remove('hidden');
    stopButton.classList.add('hidden');
  }
  statusDiv.textContent = message || statusDefault;
  downloadButton.disabled = false;
  clearButton.disabled = false;
  
  // Update job counter if provided
  if (jobCount !== null) {
    jobCounterElement.textContent = `Jobs in memory: ${jobCount}`;
  }
}

// Function to update job count
async function updateJobCount() {
    try {
        const response = await chrome.runtime.sendMessage({ action: "GET_JOB_COUNT" });
        if (response && response.success) {
            jobCounterElement.textContent = `Jobs in memory: ${response.count}`;
            return response.count;
        }
    } catch (error) {
        console.error("Error updating job count:", error);
    }
    return 0;
}

// Convert jobs to CSV - simplified with additional error handling
function convertToCSV(jobs) {
    if (!jobs || jobs.length === 0) return "";
    
    const headers = [
        "Position Name", "Company", "Location", "Salary", "Job Type",
        "Shift & Schedule", "Education_Level", "Skills", "Description",
        "ID", "Indeed_View_Job_Link", "External_Apply_Link",
        "Indeed_Apply_Start_Link", "Scraped At"
    ];
    
    // Enhanced CSV escaping function
    const escapeCSV = (value) => {
        if (value === null || value === undefined) return "";
        try {
            const stringValue = String(value);
            if (stringValue.includes('"') || stringValue.includes(',') || stringValue.includes('\n') || stringValue.includes('\r')) {
                return `"${stringValue.replace(/"/g, '""')}"`;
            }
            return stringValue;
        } catch (e) {
            console.error("Error converting value to string:", value, e);
            return "";
        }
    };
    
    try {
        const headerRow = headers.map(escapeCSV).join(',');
        const dataRows = jobs.map(job => {
            return headers.map(header => {
                try {
                    return escapeCSV(job[header]);
                } catch (e) {
                    console.error(`Error processing field ${header}:`, e);
                    return "";
                }
            }).join(',');
        });
        
        return [headerRow, ...dataRows].join('\r\n');
    } catch (e) {
        console.error("CSV conversion error:", e);
        return "";
    }
}

// Download function moved directly to popup
async function downloadJobs() {
    statusDiv.textContent = 'Status: Preparing download...';
    downloadButton.disabled = true;
    clearButton.disabled = true;
    
    try {
        // Get jobs directly from storage
        const response = await chrome.runtime.sendMessage({ action: "GET_STORED_JOBS" });
        console.log("Got jobs response:", response);
        
        if (!response.success || !response.jobs || response.jobs.length === 0) {
            statusDiv.textContent = 'Status: No jobs to download';
            downloadButton.disabled = false;
            clearButton.disabled = false;
            return;
        }
        
        console.log(`Converting ${response.jobs.length} jobs to CSV...`);
        
        // Convert to CSV
        const csvContent = convertToCSV(response.jobs);
        if (!csvContent) {
            statusDiv.textContent = 'Status: CSV generation failed';
            downloadButton.disabled = false;
            clearButton.disabled = false;
            return;
        }
        
        console.log(`CSV created, length: ${csvContent.length} characters`);
        
        // Create download
        const blob = new Blob([`\uFEFF${csvContent}`], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const timestamp = new Date().toISOString().slice(0, 19).replace(/[-T:]/g, '');
        const filename = `indeed_jobs_${timestamp}.csv`;
        
        console.log(`Initiating download: ${filename}`);
        const downloadId = await chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: true
        });
        
        console.log("Download started with ID:", downloadId);
        statusDiv.textContent = 'Status: Download started!';
        
        // Auto-delete if option is checked
        if (autoDeleteCheckbox.checked) {
            console.log("Auto-delete option enabled, clearing data but keeping IDs...");
            const clearResponse = await chrome.runtime.sendMessage({ 
                action: "CLEAR_DATA", 
                keepIds: true 
            });
            
            if (clearResponse && clearResponse.success) {
                console.log("Data cleared successfully after download");
                // Update job counter
                updateJobCount();
            } else {
                console.error("Failed to clear data after download:", clearResponse);
            }
        }
        
        // Cleanup
        setTimeout(() => {
            URL.revokeObjectURL(url);
            downloadButton.disabled = false;
            clearButton.disabled = false;
        }, 5000);
        
    } catch (error) {
        console.error("Download error:", error);
        statusDiv.textContent = `Status: Error: ${error.message}`;
        downloadButton.disabled = false;
        clearButton.disabled = false;
    }
}

// Event listeners
startButton.addEventListener('click', () => {
    console.log("Start button clicked");
    updateUI(true, 'Status: Starting...');
    chrome.runtime.sendMessage({ action: "TOGGLE_SCRAPING", start: true }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("Error sending start message:", chrome.runtime.lastError.message);
            updateUI(false, `Status: Error: ${chrome.runtime.lastError.message}`);
        } else {
            console.log("Start message response:", response);
            updateUI(response.isScraping);
            // Update job count after toggling
            updateJobCount();
        }
    });
});

stopButton.addEventListener('click', () => {
    console.log("Stop button clicked");
    updateUI(false, 'Status: Stopping...');
    chrome.runtime.sendMessage({ action: "TOGGLE_SCRAPING", start: false }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("Error sending stop message:", chrome.runtime.lastError.message);
            updateUI(true, `Status: Error stopping: ${chrome.runtime.lastError.message}`);
        } else {
            console.log("Stop message response:", response);
            updateUI(response.isScraping);
            // Update job count after toggling
            updateJobCount();
        }
    });
});

downloadButton.addEventListener('click', () => {
    console.log("Download button clicked");
    downloadJobs();
});

clearButton.addEventListener('click', () => {
    console.log("Clear button clicked");
    if (confirm("Are you sure you want to clear all stored job data?")) {
        statusDiv.textContent = 'Status: Clearing data...';
        clearButton.disabled = true;
        downloadButton.disabled = true;
        
        // Determine if we should keep IDs
        const keepIds = autoDeleteCheckbox.checked;
        
        chrome.runtime.sendMessage({ action: "CLEAR_DATA", keepIds: keepIds }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Error sending clear message:", chrome.runtime.lastError.message);
                statusDiv.textContent = `Status: Error: ${chrome.runtime.lastError.message}`;
            } else if (response && response.success) {
                console.log("Data cleared.");
                if (keepIds) {
                    statusDiv.textContent = 'Status: Data cleared, but IDs kept for deduplication.';
                } else {
                    statusDiv.textContent = 'Status: All data cleared.';
                }
                // Update job counter
                updateJobCount();
            } else {
                console.log("Clear failed:", response);
                statusDiv.textContent = 'Status: Error clearing data.';
            }
            clearButton.disabled = false;
            downloadButton.disabled = false;
        });
    }
});

// Add a context menu option to clear button (right-click)
clearButton.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (confirm("ADVANCED: Are you sure you want to clear ALL data including job IDs? This will reset deduplication.")) {
        statusDiv.textContent = 'Status: Clearing ALL data...';
        clearButton.disabled = true;
        downloadButton.disabled = true;
        
        chrome.runtime.sendMessage({ action: "CLEAR_ALL_DATA" }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Error sending clear all message:", chrome.runtime.lastError.message);
                statusDiv.textContent = `Status: Error: ${chrome.runtime.lastError.message}`;
            } else if (response && response.success) {
                console.log("All data cleared including IDs.");
                statusDiv.textContent = 'Status: All data and job IDs cleared.';
                // Update job counter
                updateJobCount();
            } else {
                console.log("Clear all failed:", response);
                statusDiv.textContent = 'Status: Error clearing all data.';
            }
            clearButton.disabled = false;
            downloadButton.disabled = false;
        });
    }
    return false;
});

// Initial state check and job count update
document.addEventListener('DOMContentLoaded', () => {
    chrome.runtime.sendMessage({ action: "GET_STATE" }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("Error getting state:", chrome.runtime.lastError.message);
            updateUI(false, `Status: Error: ${chrome.runtime.lastError.message}`);
        } else if (response && typeof response.isScraping !== 'undefined') {
            console.log("Initial state:", response.isScraping);
            updateUI(response.isScraping, null, response.jobCount);
        } else {
            console.warn("Could not get initial state from background, assuming inactive.");
            updateUI(false, "Status: Initializing...");
            setTimeout(() => {
                chrome.runtime.sendMessage({ action: "GET_STATE" }, (response) => {
                    if (response) {
                        updateUI(response.isScraping, null, response.jobCount);
                    }
                });
            }, 500);
        }
        
        // Also explicitly update job count
        updateJobCount();
    });
});