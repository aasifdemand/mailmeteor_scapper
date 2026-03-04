const express = require("express");
const cors = require("cors");
const multer = require("multer");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");
const { connect } = require("puppeteer-real-browser");
require("dotenv").config();


const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(express.static("public"));

// File utility helper
async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Browser Pool Management (Multiple Instances, Multiple Tabs)
class BrowserPool {
  constructor() {
    this.browsers = []; // List of { browser, pages: [{page, busy, id}] }
    this.isInitializing = false;
  }

  async init(browserCount = 1, tabsPerBrowser = 3) {
    if (this.isInitializing) {
      console.log("  ⏳ Pool is already initializing, waiting...");
      while (this.isInitializing) await wait(500);
      return;
    }

    this.isInitializing = true;
    console.log(`\n🏗️  Initializing Browser Pool (${browserCount} Browsers, ${tabsPerBrowser} Tabs each)...`);

    // Close existing if any
    await this.closeAll();

    try {
      for (let b = 0; b < browserCount; b++) {
        if (stopSignal) break;
        console.log(`  🌐 Launching Browser Instance #${b + 1}...`);
        const { browser: newBrowser, page: firstPage } = await connect({
          headless: false,
          args: ["--start-maximized"],
          turnstile: true,
          connectOption: { defaultViewport: null }
        });

        const browserEntry = { browser: newBrowser, pages: [] };
        browserEntry.pages.push({ page: firstPage, busy: false, id: `${b + 1}-1` });
        console.log(`    ✅ Browser #${b + 1}: Main tab ready.`);

        // Open additional tabs
        for (let t = 1; t < tabsPerBrowser; t++) {
          const newPage = await newBrowser.newPage();
          browserEntry.pages.push({ page: newPage, busy: false, id: `${b + 1}-${t + 1}` });
          console.log(`    ✅ Browser #${b + 1}: Tab #${t + 1} ready.`);
        }

        this.browsers.push(browserEntry);
      }

      console.log(`  🚀 Pool Ready: ${this.browsers.length} Browsers, ${this.getAllPages().length} Total Tabs.`);
    } catch (err) {
      console.error(`  ❌ Failed to launch pool:`, err.message);
    } finally {
      this.isInitializing = false;
    }
  }

  getAllPages() {
    return this.browsers.flatMap(b => b.pages);
  }

  async getAvailable() {
    const allPages = this.getAllPages();
    const pageData = allPages.find(p => !p.busy);
    if (pageData) {
      pageData.busy = true;
      return pageData;
    }
    return null;
  }

  async closeAll() {
    console.log("  🧹 Closing all browsers in pool...");
    const currentBrowsers = [...this.browsers];
    this.browsers = []; // Clear immediately to avoid re-use attempts

    for (const b of currentBrowsers) {
      try {
        // Kill the underlying process if possible or just close
        await b.browser.close();
      } catch (e) {
        console.error("    ⚠️ Error closing a browser instance:", e.message);
      }
    }
  }
}

const pool = new BrowserPool();
let stopSignal = false;

// Real-time Session State
let sessionState = {
  active: false,
  results: [],
  total: 0,
  processed: 0,
  items: [],
  settings: {
    batchSize: 2,
    maxBrowsers: 3,
    delayTime: 3000
  }
};

// Main scraping function with real-browser bypass (Now using pooled page)
async function scrapeWithPage(item, pageData) {
  const { page, id } = pageData;
  const url = item.url;

  try {
    console.log(`\n🚀 [Browser #${id}] Scraping: ${item.name}`);

    // Parse URL to get name and domain for direct result URL
    const parsedUrl = new URL(url);
    const fullName = parsedUrl.searchParams.get('name') || "";
    const domain = parsedUrl.searchParams.get('domain') || "";

    // Use Direct URL to avoid interaction-based shadow-bans
    const directUrl = `https://mailmeteor.com/tools/email-finder?name=${encodeURIComponent(fullName)}&domain=${encodeURIComponent(domain)}`;

    console.log(`  🌐 Navigation: ${fullName} @ ${domain}`);
    await page.goto(directUrl, { waitUntil: "networkidle2", timeout: 60000 });


    await wait(8000 + Math.random() * 4000);

    // Monitor for the email result
    console.log(`  🔍 Extracting result...`);
    const result = await page.evaluate(async () => {
      const waitInner = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      let attempts = 0;
      const maxAttempts = 60; // 60 seconds

      while (attempts < maxAttempts) {
        const text = document.body.innerText;
        // Improved regex to avoid capturing the mailmeteor branding links
        const emailRegex = /\b[A-Za-z0-9._%+-]+@(?![a-zA-Z0-9.-]*mailmeteor\.com)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/;
        const emailMatch = text.match(emailRegex);

        if (emailMatch) {
          return { email: emailMatch[0], status: "valid" };
        }

        if (text.includes("No results found") || text.includes("couldn't find")) {
          return { email: "No email found", status: "not found" };
        }

        await waitInner(2000);
        attempts += 2;
      }

      return { email: "Search timed out", status: "error" };
    });

    if (result.status === "valid") {
      console.log(`  ✅ Found: ${result.email}`);
    } else {
      console.log(`  ⚠️ Result: ${result.email}`);
    }

    return result;
  } catch (error) {
    console.error(`  ❌ Browser #${id} Error:`, error.message);
    return {
      email: `Error: ${error.message}`,
      status: "error",
    };
  }
}

// Upload Excel endpoint
app.post("/api/upload-excel", upload.single("file"), async (req, res) => {
  try {
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

    // Find columns
    const headers = data[0] || [];
    let nameCol = -1,
      domainCol = -1;

    headers.forEach((header, index) => {
      const h = String(header).toLowerCase();
      if (h.includes("name")) nameCol = index;
      if (h.includes("website") || h.includes("url") || h.includes("domain"))
        domainCol = index;
    });

    // Extract data
    const items = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row) continue;

      const name = nameCol >= 0 ? String(row[nameCol] || "").trim() : "";
      const website = domainCol >= 0 ? String(row[domainCol] || "").trim() : "";

      if (name && website) {
        let domain = website
          .toLowerCase()
          .replace(/^https?:\/\//i, "")
          .replace(/^www\./i, "")
          .split("/")[0];

        items.push({
          row: i + 1,
          name: name,
          domain: domain,
          url: `https://mailmeteor.com/tools/email-finder?name=${encodeURIComponent(name)}&domain=${domain}`,
        });
      }
    }

    res.json({ success: true, count: items.length, items: items });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET session status endpoint
app.get("/api/scrape-status", (req, res) => {
  res.json(sessionState);
});

// Batch scrape endpoint
app.post("/api/scrape-batch", async (req, res) => {
  try {
    const { items, maxBrowsers, startRow } = req.body;

    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: "No items provided" });
    }

    const startIndex = Math.max(0, (parseInt(startRow) || 1) - 1);
    const subset = items.slice(startIndex);

    if (subset.length === 0) {
      return res.status(400).json({ error: `Start row (${startRow}) is beyond total items (${items.length}).` });
    }

    console.log(`\n📦 STARTING BATCH: Offset=${startIndex} (Row ${startIndex + 1}), First Item: "${subset[0]?.name || 'N/A'}"`);
    console.log(`📦 Subset Size: ${subset.length} of ${items.length} total.`);

    stopSignal = false;

    // Reset Session State
    sessionState = {
      active: true,
      results: [],
      total: items.length,
      processed: startIndex,
      items: items,
      settings: {
        batchSize: parseInt(req.body.batchSize) || 2,
        maxBrowsers: parseInt(maxBrowsers) || 2,
        delayTime: parseInt(req.body.delayTime) || 3000
      }
    };

    // SEND IMMEDIATE RESPONSE
    res.json({ success: true, message: "Scraping initializing", total: subset.length });

    // BACKGROUND INITIALIZATION AND PROCESSING
    (async () => {
      try {
        // Multi-browser architecture: User maxBrowsers is now instances (max 2)
        const instanceCount = Math.min(2, sessionState.settings.maxBrowsers);
        const tabsPerInstance = 3;

        await pool.init(instanceCount, tabsPerInstance);

        const allTabs = pool.getAllPages();
        if (allTabs.length === 0) {
          sessionState.active = false;
          console.error("  ❌ Background Init Failed: No tabs ready.");
          return;
        }

        let sharedIndex = 0;
        const worker = async () => {
          while (sharedIndex < subset.length) {
            if (stopSignal) break;

            const currentIndex = sharedIndex++;
            const item = subset[currentIndex];
            if (!item) break;

            let browserData = await pool.getAvailable();
            while (!browserData && !stopSignal) {
              await wait(1000);
              browserData = await pool.getAvailable();
            }

            if (stopSignal) break;

            try {
              const result = await scrapeWithPage(item, browserData);
              const resultObj = { ...result, row: item.row, name: item.name };

              sessionState.results.push(resultObj);
              sessionState.processed++;
            } catch (e) {
              console.error(`  ❌ Critical Worker Error on ${item.name}:`, e.message);
              const errorObj = { email: "Worker Error", status: "error", row: item.row, name: item.name };
              sessionState.results.push(errorObj);
              sessionState.processed++;
            } finally {
              const delay = sessionState.settings.delayTime;
              await wait(delay + Math.random() * 2000);
              if (browserData) browserData.busy = false;
            }
          }
        };

        const workers = [];
        const workerCount = Math.min(allTabs.length, subset.length);
        console.log(`  🧵 Launching ${workerCount} parallel workers...`);

        for (let i = 0; i < workerCount; i++) {
          workers.push(worker());
        }

        await Promise.all(workers);

        sessionState.active = false;
        console.log(`\n✅ Background session complete/stopped.`);
      } catch (err) {
        sessionState.active = false;
        console.error("  ❌ Background Process Error:", err.message);
      }
    })();

  } catch (error) {
    sessionState.active = false;
    console.error("Critical server error during batch scrape initialization:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Stop scraping endpoint
app.post("/api/stop", async (req, res) => {
  console.log("\n⏹  Stop signal received.");
  stopSignal = true;
  sessionState.active = false;
  await pool.closeAll();
  res.json({ success: true, message: "Scraping stopped" });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Mailmeteor Pro running on http://localhost:${PORT}`);
  console.log(`🤖 Browser Pool Ready (Bypass Enabled)`);
});
