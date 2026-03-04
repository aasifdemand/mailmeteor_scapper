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

// Browser Pool Management (Single Window, Multiple Tabs)
class BrowserPool {
  constructor() {
    this.browser = null;
    this.pages = [];
    this.isInitializing = false;
  }

  async init(tabCount = 1) {
    if (this.isInitializing) {
      console.log("  ⏳ Browser is already initializing, waiting...");
      while (this.isInitializing) await wait(500);
      return;
    }

    this.isInitializing = true;
    console.log(`\n🏗️  Initializing Browser (Tabs: ${tabCount})...`);

    // Close existing if any
    await this.closeAll();

    try {
      const { browser: newBrowser, page: firstPage } = await connect({
        headless: false,
        args: ["--start-maximized"],
        turnstile: true,
        connectOption: { defaultViewport: null }
      });

      this.browser = newBrowser;
      this.pages.push({ page: firstPage, busy: false, id: 1 });
      console.log(`  ✅ Main tab ready.`);

      // Open additional tabs
      for (let i = 1; i < tabCount; i++) {
        const newPage = await this.browser.newPage();
        this.pages.push({ page: newPage, busy: false, id: i + 1 });
        console.log(`  ✅ Tab #${i + 1} ready.`);
      }

      console.log(`  🚀 Browser Window ready with ${this.pages.length} tabs.`);
    } catch (err) {
      console.error(`  ❌ Failed to launch browser:`, err.message);
    } finally {
      this.isInitializing = false;
    }
  }

  async getAvailable() {
    const pageData = this.pages.find(p => !p.busy);
    if (pageData) {
      pageData.busy = true;
      return pageData;
    }
    return null;
  }

  async closeAll() {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (e) { }
    }
    this.browser = null;
    this.pages = [];
  }
}

const pool = new BrowserPool();

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
    const { items, maxBrowsers } = req.body;

    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: "No items provided" });
    }

    console.log(`\n📦 Starting New Batch Scrape (${items.length} records, Parallel Tabs: ${maxBrowsers})`);

    // Reset Session State
    sessionState = {
      active: true,
      results: [],
      total: items.length,
      processed: 0,
      items: items,
      settings: {
        batchSize: parseInt(req.body.batchSize) || 2,
        maxBrowsers: parseInt(maxBrowsers) || 3,
        delayTime: parseInt(req.body.delayTime) || 3000
      }
    };

    // SEND IMMEDIATE RESPONSE
    res.json({ success: true, message: "Scraping initializing in background", total: items.length });

    // BACKGROUND INITIALIZATION AND PROCESSING
    (async () => {
      try {
        console.log(`  🏗️  Background Init: Launching browser with ${sessionState.settings.maxBrowsers} tabs...`);
        await pool.init(sessionState.settings.maxBrowsers);

        if (pool.pages.length === 0) {
          sessionState.active = false;
          console.error("  ❌ Background Init Failed: No tabs ready.");
          return;
        }

        // Task Queue: Thread-safe worker pattern
        const results = new Array(items.length);
        let sharedIndex = 0;

        const worker = async () => {
          while (sharedIndex < items.length) {
            const currentIndex = sharedIndex++;
            const item = items[currentIndex];
            if (!item) break;

            let browserData = await pool.getAvailable();
            while (!browserData) {
              await wait(1000);
              browserData = await pool.getAvailable();
            }

            try {
              const result = await scrapeWithPage(item, browserData);
              const resultObj = { ...result, row: item.row, name: item.name };
              results[currentIndex] = resultObj;

              sessionState.results.push(resultObj);
              sessionState.processed++;
            } catch (e) {
              console.error(`  ❌ Critical Worker Error on ${item.name}:`, e.message);
              const errorObj = { email: "Worker Error", status: "error", row: item.row, name: item.name };
              results[currentIndex] = errorObj;
              sessionState.results.push(errorObj);
              sessionState.processed++;
            } finally {
              const delay = sessionState.settings.delayTime;
              await wait(delay + Math.random() * 2000);
              browserData.busy = false;
            }
          }
        };

        // Launch parallel workers
        const workers = [];
        const workerCount = Math.min(pool.pages.length, items.length);
        console.log(`  🧵 Launching ${workerCount} parallel workers for ${items.length} items...`);

        for (let i = 0; i < workerCount; i++) {
          workers.push(worker());
        }

        if (workers.length === 0) {
          console.warn("  ⚠️ No workers launched. (Tabs: " + pool.pages.length + ", Items: " + items.length + ")");
        }

        await Promise.all(workers);

        sessionState.active = false;
        console.log(`\n✅ Background session complete. Scraped ${items.length} records.`);
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

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Mailmeteor Pro running on http://localhost:${PORT}`);
  console.log(`🤖 Browser Pool Ready (Bypass Enabled)`);
});
