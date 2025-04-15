// DOM Elements
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const downloadButton = document.getElementById('downloadButton');
const clearButton = document.getElementById('clearButton');
const statusDiv = document.getElementById('status');

// --- Insertion dynamique du compteur et de la checkbox ---
// Créer le conteneur pour le compteur
let jobCounterElement = document.createElement('div');
jobCounterElement.id = 'jobCounter';
// Styles appliqués directement ou via CSS si préférez
// jobCounterElement.style.textAlign = 'center';
// jobCounterElement.style.marginTop = '8px'; // Ajusté par rapport à #status
// jobCounterElement.style.fontSize = '13px';
// jobCounterElement.style.color = 'var(--misty-blue)';
// jobCounterElement.style.textShadow = '0 1px 3px rgba(0, 0, 0, 0.4)';
statusDiv.after(jobCounterElement); // Insérer APRÈS la div status

// Créer le conteneur pour la checkbox et le label
let autoDeleteContainer = document.createElement('div');
autoDeleteContainer.id = 'autoDeleteContainer'; // Donner un ID au conteneur
// Styles appliqués directement ou via CSS
// autoDeleteContainer.style.marginTop = '15px';
// autoDeleteContainer.style.display = 'flex';
// autoDeleteContainer.style.alignItems = 'center';
// autoDeleteContainer.style.justifyContent = 'center';

let autoDeleteCheckbox = document.createElement('input');
autoDeleteCheckbox.type = 'checkbox';
autoDeleteCheckbox.id = 'autoDeleteCheckbox';
autoDeleteCheckbox.checked = true; // Garder la valeur par défaut si souhaité

let autoDeleteLabel = document.createElement('label');
autoDeleteLabel.htmlFor = 'autoDeleteCheckbox';
// Styles appliqués directement ou via CSS
// autoDeleteLabel.style.marginLeft = '5px';
// autoDeleteLabel.style.fontSize = '12px';
// autoDeleteLabel.style.color = 'var(--misty-blue)';
// autoDeleteLabel.style.cursor = 'pointer';
autoDeleteLabel.textContent = 'Auto-vider après téléchargement (garde IDs pour déduplication)'; // Texte ajusté

autoDeleteContainer.appendChild(autoDeleteCheckbox);
autoDeleteContainer.appendChild(autoDeleteLabel);
jobCounterElement.after(autoDeleteContainer); // Insérer APRÈS le compteur

// --- UI update function (MODIFIED status messages) ---
function updateUI(isFeatureActive, message = null, jobCount = null) {
  // Nouveaux messages par défaut
  const statusDefault = isFeatureActive ? 'Status: Bouton Sauvegarde ACTIF sur la page Indeed.' : 'Status: Inactif. Appuyez sur Activer.';
  if (isFeatureActive) {
    startButton.classList.add('hidden');
    stopButton.classList.remove('hidden');
  } else {
    startButton.classList.remove('hidden');
    stopButton.classList.add('hidden');
  }
  statusDiv.textContent = message || statusDefault;
  downloadButton.disabled = false; // Téléchargement/Vidage toujours possible
  clearButton.disabled = false;

  // Mettre à jour le compteur d'offres
  if (jobCount !== null) {
    jobCounterElement.textContent = `Offres sauvegardées: ${jobCount}`; // Texte ajusté
  } else {
     // S'assurer que le compteur est mis à jour même si jobCount est null au début
     updateJobCount();
  }
}

// updateJobCount() reste identique
async function updateJobCount() {
    try {
        const response = await chrome.runtime.sendMessage({ action: "GET_JOB_COUNT" });
        if (response && response.success) {
            jobCounterElement.textContent = `Offres sauvegardées: ${response.count}`; // Texte ajusté
            return response.count;
        } else {
             jobCounterElement.textContent = 'Offres sauvegardées: Erreur';
        }
    } catch (error) {
        console.error("Error updating job count:", error);
        jobCounterElement.textContent = 'Offres sauvegardées: Erreur';
    }
    return 0;
}

// convertToCSV() reste identique
function convertToCSV(jobs) {
    if (!jobs || jobs.length === 0) return "";
    const headers = [
        "Position Name", "Company", "Location", "Salary", "Job Type",
        "Shift & Schedule", "Education_Level", "Skills", "Languages", "Description",
        "ID", "Indeed_View_Job_Link", "External_Apply_Link",
        "Indeed_Apply_Start_Link", "Scraped At"
    ];
    const escapeCSV = (value) => {
        if (value === null || value === undefined) return "";
        try {
            const stringValue = String(value);
            // Amélioration: Gérer les nouvelles lignes correctement dans les champs CSV
            if (stringValue.includes('"') || stringValue.includes(',') || stringValue.includes('\n') || stringValue.includes('\r')) {
                // Remplacer les guillemets par des doubles guillemets et encadrer le tout
                return `"${stringValue.replace(/"/g, '""')}"`;
            }
            return stringValue;
        } catch (e) { console.error("Error converting value to string:", value, e); return ""; }
    };
    try {
        const headerRow = headers.map(escapeCSV).join(',');
        // Utiliser \r\n pour les sauts de ligne Windows standard dans CSV
        const dataRows = jobs.map(job => headers.map(header => escapeCSV(job[header])).join(','));
        return [headerRow, ...dataRows].join('\r\n');
    } catch (e) { console.error("CSV conversion error:", e); return ""; }
}

// downloadJobs() reste identique (utilise GET_STORED_JOBS, CLEAR_DATA)
async function downloadJobs() {
    statusDiv.textContent = 'Status: Préparation du téléchargement...';
    downloadButton.disabled = true;
    clearButton.disabled = true;
    try {
        const response = await chrome.runtime.sendMessage({ action: "GET_STORED_JOBS" });
        console.log("Got jobs response for download:", response);
        if (!response.success || !response.jobs || response.jobs.length === 0) {
            statusDiv.textContent = 'Status: Aucune offre sauvegardée à télécharger';
            downloadButton.disabled = false; clearButton.disabled = false; return;
        }
        console.log(`Converting ${response.jobs.length} jobs to CSV...`);
        const csvContent = convertToCSV(response.jobs);
        if (!csvContent) {
            statusDiv.textContent = 'Status: Échec de la génération CSV';
            downloadButton.disabled = false; clearButton.disabled = false; return;
        }
        console.log(`CSV created, length: ${csvContent.length} characters`);
        // Utiliser UTF-8 BOM pour une meilleure compatibilité Excel
        const blob = new Blob([`\uFEFF${csvContent}`], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const timestamp = new Date().toISOString().slice(0, 19).replace(/[-T:]/g, '');
        const filename = `indeed_jobs_sauvegardes_${timestamp}.csv`; // Nom de fichier ajusté

        console.log(`Initiating download: ${filename}`);
        // Utiliser l'API chrome.downloads pour le téléchargement
        const downloadId = await chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: true // Demander à l'utilisateur où sauvegarder
        });

        console.log("Download started with ID:", downloadId);
        statusDiv.textContent = 'Status: Téléchargement démarré!';

        // Gérer l'auto-vidage si l'option est cochée
        if (autoDeleteCheckbox.checked) {
            console.log("Auto-delete option enabled, clearing data but keeping IDs...");
            // Attendre un court instant pour s'assurer que le téléchargement a bien démarré
            setTimeout(async () => {
                const clearResponse = await chrome.runtime.sendMessage({ action: "CLEAR_DATA", keepIds: true });
                if (clearResponse && clearResponse.success) {
                    console.log("Data cleared successfully after download start");
                    updateJobCount(); // Mettre à jour le compteur
                } else {
                    console.error("Failed to clear data after download:", clearResponse);
                    // Informer l'utilisateur si le vidage échoue ? Peut-être juste un log.
                }
            }, 1000); // Délai de 1 seconde
        }

        // Nettoyer l'URL de l'objet blob après un délai pour permettre au téléchargement de se terminer
        setTimeout(() => {
            URL.revokeObjectURL(url);
            console.log("Blob URL revoked");
            // Réactiver les boutons après le nettoyage
            downloadButton.disabled = false;
            clearButton.disabled = false;
            // Potentiellement remettre le statut à 'Idle' ou 'Actif' selon l'état
             chrome.runtime.sendMessage({ action: "GET_STATE" }, (stateResponse) => {
                if (stateResponse && typeof stateResponse.isScraping !== 'undefined') {
                    updateUI(stateResponse.isScraping, null, stateResponse.jobCount);
                }
            });

        }, 5000); // Augmenter légèrement le délai si nécessaire

    } catch (error) {
        console.error("Download error:", error);
        statusDiv.textContent = `Status: Erreur: ${error.message}`;
        // S'assurer que les boutons sont réactivés en cas d'erreur
        downloadButton.disabled = false;
        clearButton.disabled = false;
        // Nettoyer l'URL si elle a été créée
        if (typeof url !== 'undefined') {
            URL.revokeObjectURL(url);
        }
    }
}

// --- Event listeners (MODIFIED messages sent to background/content) ---
startButton.addEventListener('click', () => {
    console.log("Start button clicked (Enable Save Button)");
    updateUI(true, 'Status: Activation...');
    // Message à background.js pour changer l'état et notifier content.js
    chrome.runtime.sendMessage({ action: "TOGGLE_SCRAPING", start: true }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("Error sending start message:", chrome.runtime.lastError.message);
            updateUI(false, `Status: Erreur: ${chrome.runtime.lastError.message}`);
        } else if (response && response.success) {
            console.log("Start message response:", response);
            // Mettre à jour l'UI basé sur la réponse de background (qui contient isScraping)
            updateUI(response.isScraping); // isScraping contrôle maintenant l'état "Actif/Inactif" de la feature
            updateJobCount(); // Mettre à jour le compteur immédiatement
        } else {
             console.error("Start message failed:", response);
             updateUI(false, 'Status: Erreur activation.');
        }
    });
});

stopButton.addEventListener('click', () => {
    console.log("Stop button clicked (Disable Save Button)");
    updateUI(false, 'Status: Désactivation...');
    // Message à background.js
    chrome.runtime.sendMessage({ action: "TOGGLE_SCRAPING", start: false }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("Error sending stop message:", chrome.runtime.lastError.message);
            // Si erreur, l'état n'a peut-être pas changé, revenir à l'état précédent ?
            // Pour la simplicité, on affiche juste l'erreur mais on garde l'UI comme si c'était stoppé.
             updateUI(false, `Status: Erreur désactivation: ${chrome.runtime.lastError.message}`);
        } else if (response && response.success) {
            console.log("Stop message response:", response);
            updateUI(response.isScraping);
            updateJobCount(); // Mettre à jour le compteur
        } else {
            console.error("Stop message failed:", response);
            updateUI(true, 'Status: Erreur désactivation.'); // Revenir à l'état actif supposé ? Prudence.
        }
    });
});

// downloadButton listener reste identique
downloadButton.addEventListener('click', () => {
    console.log("Download button clicked");
    downloadJobs();
});

// clearButton listener reste identique (utilise CLEAR_DATA)
clearButton.addEventListener('click', () => {
    console.log("Clear button clicked");
    // Demander confirmation
    if (confirm("Êtes-vous sûr de vouloir vider toutes les offres sauvegardées ?")) {
        statusDiv.textContent = 'Status: Vidage des données...';
        clearButton.disabled = true; downloadButton.disabled = true;
        const keepIds = autoDeleteCheckbox.checked; // Vérifier l'état de la checkbox
        chrome.runtime.sendMessage({ action: "CLEAR_DATA", keepIds: keepIds }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Error sending clear message:", chrome.runtime.lastError.message);
                statusDiv.textContent = `Status: Erreur: ${chrome.runtime.lastError.message}`;
            } else if (response && response.success) {
                console.log("Data cleared.");
                statusDiv.textContent = keepIds ? 'Status: Données vidées (IDs gardés).' : 'Status: Toutes les données vidées.';
                updateJobCount(); // Mettre à jour le compteur
            } else {
                console.log("Clear failed:", response);
                statusDiv.textContent = 'Status: Erreur vidage données.';
            }
            // Réactiver les boutons après l'opération
            clearButton.disabled = false;
            downloadButton.disabled = false;
        });
    }
});

// clearButton context menu listener reste identique (utilise CLEAR_ALL_DATA)
clearButton.addEventListener('contextmenu', (e) => {
    e.preventDefault(); // Empêcher le menu contextuel normal
    if (confirm("AVANCÉ: Vider TOUTES les données y compris les IDs (réinitialise la déduplication) ?")) {
        statusDiv.textContent = 'Status: Vidage TOTAL en cours...';
        clearButton.disabled = true; downloadButton.disabled = true;
        // Envoyer le message pour vider absolument tout
        chrome.runtime.sendMessage({ action: "CLEAR_ALL_DATA" }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Error sending clear all message:", chrome.runtime.lastError.message);
                statusDiv.textContent = `Status: Erreur: ${chrome.runtime.lastError.message}`;
            } else if (response && response.success) {
                console.log("All data cleared including IDs.");
                statusDiv.textContent = 'Status: Toutes données et IDs vidés.';
                updateJobCount(); // Mettre à jour le compteur (devrait être 0)
            } else {
                console.log("Clear all failed:", response);
                statusDiv.textContent = 'Status: Erreur vidage total.';
            }
            // Réactiver les boutons
            clearButton.disabled = false;
            downloadButton.disabled = false;
        });
    }
    return false; // Empêcher la propagation de l'événement
});


// Initial state check (reste identique, utilise GET_STATE de background.js)
document.addEventListener('DOMContentLoaded', () => {
    // Demander l'état initial au script d'arrière-plan
    chrome.runtime.sendMessage({ action: "GET_STATE" }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("Error getting state:", chrome.runtime.lastError.message);
            updateUI(false, `Status: Erreur: ${chrome.runtime.lastError.message}`);
            updateJobCount(); // Essayer de mettre à jour le compteur même en cas d'erreur d'état
        } else if (response && typeof response.isScraping !== 'undefined') {
            console.log("Initial state (isFeatureActive):", response.isScraping, "Job Count:", response.jobCount);
            // response.isScraping détermine si la feature "Ajouter Bouton" est active
            updateUI(response.isScraping, null, response.jobCount);
        } else {
            // Cas où la réponse est invalide ou le background script n'a pas encore répondu
            console.warn("Could not get initial state from background, assuming inactive.");
            updateUI(false, "Status: Initialisation...");
            // Retenter après un court délai
            setTimeout(() => {
                chrome.runtime.sendMessage({ action: "GET_STATE" }, (retryResponse) => {
                    if (retryResponse && typeof retryResponse.isScraping !== 'undefined') {
                        updateUI(retryResponse.isScraping, null, retryResponse.jobCount);
                    } else {
                         updateUI(false, "Status: Erreur Init."); // Échec après tentative
                         updateJobCount(); // Mettre à jour le compteur qd même
                    }
                });
            }, 500); // Délai de 500ms
        }
        // S'assurer que le compteur est mis à jour au moins une fois au chargement
        // updateJobCount(); // Déjà appelé dans updateUI ou en cas d'erreur
    });
});