document.addEventListener("DOMContentLoaded", function () {
  const API_URL = "http://localhost:3000";

  // IndexedDB Helper
  const dbName = "MailmeteorDB";
  const storeName = "kv";

  function initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };
    });
  }

  async function dbGet(key) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function dbSet(key, value) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const request = store.put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // DOM Elements
  const uploadArea = document.getElementById("uploadArea");
  const excelFile = document.getElementById("excelFile");
  const fileName = document.getElementById("fileName");
  const maxBrowsers = document.getElementById("maxBrowsers");
  const batchSize = document.getElementById("batchSize");
  const delayTime = document.getElementById("delayTime");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const downloadCsvBtn = document.getElementById("downloadCsvBtn");
  const downloadExcelBtn = document.getElementById("downloadExcelBtn");
  const logMessages = document.getElementById("logMessages");
  const resultsBody = document.getElementById("resultsBody");
  const progressBar = document.getElementById("progressBar");
  const progressText = document.getElementById("progressText");
  const logCount = document.getElementById("logCount");
  const startRowInput = document.getElementById("startRow");
  const clearBtn = document.getElementById("clearBtn");

  // Stats elements
  const totalCountEl = document.getElementById("totalCount");
  const processedCountEl = document.getElementById("processedCount");
  const validCountEl = document.getElementById("validCount");
  const notFoundCountEl = document.getElementById("notFoundCount");

  // State
  let items = [];
  let results = [];
  let isProcessing = false;
  let logCounter = 0;
  let statusPollInterval = null;

  // Initial state load
  loadInitialState();

  async function loadInitialState() {
    try {
      // 1. Load from IndexedDB first (Prioritize local state)
      const cachedItems = await dbGet("items");
      const cachedResults = await dbGet("results");
      const cachedSettings = await dbGet("settings");

      if (cachedItems) items = cachedItems;
      if (cachedResults) results = cachedResults;
      if (cachedSettings) {
        if (cachedSettings.batchSize) batchSize.value = cachedSettings.batchSize;
        if (cachedSettings.maxBrowsers) maxBrowsers.value = cachedSettings.maxBrowsers;
        if (cachedSettings.delayTime) delayTime.value = cachedSettings.delayTime;
        if (cachedSettings.startRow) startRowInput.value = cachedSettings.startRow;
      }

      if (items.length > 0) {
        totalCountEl.textContent = items.length;
        updateStats();
        updateResultsTable();
        addLog(`📂 Restored ${results.length}/${items.length} records from browser storage`, "info");
      }

      // 2. Check server for active session
      const response = await fetch(`${API_URL}/api/scrape-status`);
      const session = await response.json();

      if (session.active) {
        isProcessing = true;
        startBtn.disabled = true;
        stopBtn.disabled = false;

        // If server has more results, merge them
        if (session.results && session.results.length > results.length) {
          results = session.results;
          await dbSet("results", results);
          updateStats();
          updateResultsTable();
        }

        startStatusPolling();
      }
    } catch (e) {
      console.error("Failed to load initial state:", e);
    }
  }

  // Upload handlers
  uploadArea.addEventListener("click", () => excelFile.click());
  excelFile.addEventListener("change", handleFileUpload);

  // Button handlers
  startBtn.addEventListener("click", startScraping);
  stopBtn.addEventListener("click", async () => {
    addLog("⏹ Stopping scraper... please wait.", "warning");
    stopBtn.disabled = true;
    try {
      await fetch(`${API_URL}/api/stop`, { method: "POST" });
      isProcessing = false;
      clearInterval(statusPollInterval);
      startBtn.disabled = false;
      addLog("🛑 Scraping stopped and browsers closed.", "info");
      // Save current progress as next start point
      const nextRow = results.length + 1;
      startRowInput.value = nextRow;
      await saveSettings();
    } catch (e) {
      addLog("❌ Failed to stop server cleanly", "error");
      location.reload();
    }
  });

  downloadCsvBtn.addEventListener("click", () => downloadResults("csv"));
  downloadExcelBtn.addEventListener("click", () => downloadResults("excel"));
  clearBtn.addEventListener("click", async () => {
    if (confirm("Clear all items and results?")) {
      await dbSet("items", []);
      await dbSet("results", []);
      items = [];
      results = [];
      totalCountEl.textContent = 0;
      updateStats();
      updateResultsTable();
      addLog("🗑️ All data cleared", "info");
    }
  });

  // File upload handler
  async function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    fileName.textContent = file.name;
    addLog(`Uploading ${file.name}...`, "info");

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch(`${API_URL}/api/upload-excel`, {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (data.success) {
        items = data.items;
        totalCountEl.textContent = data.count;
        await dbSet("items", items);
        await dbSet("results", []); // New upload, clear old results
        results = [];
        updateStats();
        updateResultsTable();
        addLog(`✅ Loaded ${data.count} records from Excel`, "success");
      }
    } catch (error) {
      addLog(`❌ Upload error: ${error.message}`, "error");
    }
  }

  // Start status polling
  function startStatusPolling() {
    if (statusPollInterval) clearInterval(statusPollInterval);

    statusPollInterval = setInterval(async () => {
      try {
        const response = await fetch(`${API_URL}/api/scrape-status`);
        const session = await response.json();

        if (session.results && session.results.length > 0) {
          // Robust merge: find new results from server
          let hasNew = false;
          session.results.forEach(sr => {
            // Check if we already have this row
            if (!results.some(r => r.row === sr.row)) {
              results.push(sr);
              hasNew = true;
            }
          });

          if (hasNew) {
            await dbSet("results", results);
            updateStats();
            updateResultsTable();
          }
        }

        if (!session.active && isProcessing) {
          // Session internally finished
          isProcessing = false;
          clearInterval(statusPollInterval);
          addLog("✅ Scraping session complete!", "success");

          // Re-enable UI
          startBtn.disabled = false;
          stopBtn.disabled = true;
          updateDownloadButtons();
        }
      } catch (e) {
        console.error("Polling error:", e);
      }
    }, 2000); // Poll every 2 seconds
  }

  // Start scraping
  async function startScraping() {
    if (items.length === 0) {
      addLog("❌ Please upload an Excel file first", "error");
      return;
    }

    isProcessing = true;

    const startRowVal = parseInt(startRowInput.value) || 1;

    // Only clear results if starting from row 1
    if (startRowVal === 1) {
      results = [];
      resultsBody.innerHTML = '<tr><td colspan="4" class="empty-table">Starting session...</td></tr>';
      await dbSet("results", []);
    } else {
      addLog(`⏩ Resuming from row ${startRowVal}...`, "info");
    }

    startBtn.disabled = true;
    stopBtn.disabled = false;
    updateDownloadButtons();

    const maxBrowsersVal = parseInt(maxBrowsers.value);

    addLog(`🚀 Starting session: Row ${startRowVal} to ${items.length}`, "info");
    addLog(`🔧 Parallel: 2 Browsers (6 Tabs total). Bypass: ON`, "info");

    // Save settings
    await saveSettings();

    // Start polling for real-time updates
    startStatusPolling();

    try {
      const response = await fetch(`${API_URL}/api/scrape-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: items,
          maxBrowsers: maxBrowsersVal,
          batchSize: parseInt(batchSize.value),
          delayTime: parseInt(delayTime.value),
          startRow: startRowVal
        }),
      });

      const data = await response.json();

      if (data.success) {
        // Success means it started, but workers are in background
        addLog(`🚀 Scraping started... (Total: ${data.total})`, "info");
      } else if (data.error) {
        addLog(`❌ Backend error: ${data.error}`, "error");
        isProcessing = false;
        startBtn.disabled = false;
        stopBtn.disabled = true;
      }
    } catch (error) {
      addLog(`❌ Connection error: ${error.message}`, "error");
      console.error("Scrape error:", error);
      isProcessing = false;
      startBtn.disabled = false;
      stopBtn.disabled = true;
    }
  }

  async function saveSettings() {
    const settings = {
      batchSize: batchSize.value,
      maxBrowsers: maxBrowsers.value,
      delayTime: delayTime.value,
      startRow: startRowInput.value
    };
    await dbSet("settings", settings);
  }

  function updateStats() {
    const total = items.length || 0;
    processedCountEl.textContent = results.length;
    validCountEl.textContent = results.filter(r => r.status === "valid").length;
    notFoundCountEl.textContent = results.filter(r => r.status !== "valid").length;

    if (total > 0) {
      const progress = (results.length / total) * 100;
      progressBar.style.width = `${progress}%`;
      progressText.textContent = `Progress: ${Math.round(progress)}%`;
    }
    updateDownloadButtons();
  }

  function updateDownloadButtons() {
    const hasResults = results.length > 0;
    downloadCsvBtn.disabled = !hasResults;
    downloadExcelBtn.disabled = !hasResults;
  }

  // Update results table
  function updateResultsTable() {
    if (results.length === 0) return;

    let html = "";
    // Show last 50 results in reverse order for better visibility of new items
    results.slice(-50).reverse().forEach((r) => {
      const badgeClass = r.status === "valid" ? "valid" : (r.status === "not found" ? "not-found" : "error");
      html += `
            <tr>
                <td>${r.row}</td>
                <td>${escapeHtml(r.name)}</td>
                <td>${r.email}</td>
                <td><span class="status-badge ${badgeClass}">${r.status}</span></td>
            </tr>
        `;
    });

    resultsBody.innerHTML = html;
  }

  // Download results
  function downloadResults(format) {
    if (results.length === 0) {
      addLog("No results to download", "warning");
      return;
    }

    if (format === "csv") {
      let csv = "Row,Name,Email,Status\n";
      results.forEach((r) => {
        csv += `${r.row},"${r.name}","${r.email}",${r.status}\n`;
      });

      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mailmeteor_results_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } else if (format === "excel") {
      const wbData = [["Row", "Name", "Email", "Status"]];
      results.sort((a, b) => a.row - b.row).forEach((r) => wbData.push([r.row, r.name, r.email, r.status]));

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(wbData);
      XLSX.utils.book_append_sheet(wb, ws, "Results");
      XLSX.writeFile(wb, `mailmeteor_results_${new Date().toISOString().slice(0, 10)}.xlsx`);
    }

    addLog(`✅ Saved ${results.length} results as ${format.toUpperCase()}`, "success");
  }

  // Add log message
  function addLog(message, type = "info") {
    logCounter++;
    logCount.textContent = logCounter;

    const entry = document.createElement("div");
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logMessages.appendChild(entry);
    logMessages.scrollTop = logMessages.scrollHeight;

    while (logMessages.children.length > 200) {
      logMessages.removeChild(logMessages.firstChild);
    }
  }

  // Escape HTML
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
});
