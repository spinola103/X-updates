const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const crypto = require('crypto');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// 🔥 ENHANCED BROWSER POOL WITH CONCURRENCY PROTECTION
class EnhancedBrowserPool {
  constructor() {
    this.browser = null;
    this.pages = new Map(); // Track pages with their usage
    this.maxPages = 3;
    this.isInitializing = false;
    this.lastHealthCheck = Date.now();
    this.cookiesLoaded = false;
    this.instanceId = crypto.randomBytes(8).toString('hex'); // Unique instance ID
    this.activeScrapes = new Set(); // Track active scraping operations
    this.maxConcurrentScrapes = 2; // Limit concurrent scrapes to prevent conflicts
    
    // Auto health check every 5 minutes
    setInterval(() => this.healthCheck(), 5 * 60 * 1000);
  }

  async initialize() {
    if (this.isInitializing) {
      console.log('⏳ Browser initialization already in progress...');
      while (this.isInitializing) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      return this.browser;
    }

    if (this.browser && !this.browser.isConnected()) {
      console.log('🔄 Browser disconnected, reinitializing...');
      this.browser = null;
    }

    if (this.browser) {
      console.log('✅ Reusing existing browser instance');
      return this.browser;
    }

    this.isInitializing = true;
    
    try {
      const chromePath = findChrome();
      
      const launchOptions = {
        headless: 'new',
        args: [
          '--no-sandbox',
          '--single-process',
          '--max_old_space_size=512',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-features=TranslateUI',
          '--disable-ipc-flooding-protection',
          '--window-size=1366,768',
          '--memory-pressure-off',
          '--disable-blink-features=AutomationControlled',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor',
          // Use unique user data dir to prevent conflicts between instances
          `--user-data-dir=/tmp/chrome-pool-data-${this.instanceId}`
        ],
        defaultViewport: { width: 1366, height: 768 }
      };

      if (chromePath) {
        launchOptions.executablePath = chromePath;
      }

      console.log(`🚀 Launching new browser instance [${this.instanceId}]...`);
      this.browser = await puppeteer.launch(launchOptions);
      
      this.browser.on('disconnected', () => {
        console.log('🔴 Browser disconnected, will reinitialize on next request');
        this.browser = null;
        this.pages.clear();
        this.cookiesLoaded = false;
        this.activeScrapes.clear();
      });

      console.log(`✅ Browser pool initialized successfully [${this.instanceId}]`);
      this.lastHealthCheck = Date.now();
      
    } catch (error) {
      console.error('💥 Failed to initialize browser:', error.message);
      this.browser = null;
      throw error;
    } finally {
      this.isInitializing = false;
    }

    return this.browser;
  }

  async acquirePage(scrapeId) {
    // Check concurrent scrape limit
    if (this.activeScrapes.size >= this.maxConcurrentScrapes) {
      throw new Error(`Maximum concurrent scrapes (${this.maxConcurrentScrapes}) reached. Please try again in a moment.`);
    }

    const browser = await this.initialize();
    
    if (this.pages.size >= this.maxPages) {
      console.log('⚠️ Max pages reached, waiting for available page...');
      let waitCount = 0;
      while (this.pages.size >= this.maxPages && waitCount < 30) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        waitCount++;
      }
      
      if (this.pages.size >= this.maxPages) {
        throw new Error('Browser pool exhausted. Please try again later.');
      }
    }

    const page = await browser.newPage();
    const pageId = crypto.randomBytes(4).toString('hex');
    
    this.pages.set(pageId, {
      page,
      scrapeId,
      created: Date.now(),
      inUse: true
    });
    
    this.activeScrapes.add(scrapeId);
    
    // Configure page
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setCacheEnabled(false);
    
    await page.setExtraHTTPHeaders({ 
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Cache-Control': 'no-cache',
      'Upgrade-Insecure-Requests': '1',
      'X-Instance-Id': this.instanceId // Help identify this instance in logs
    });

    // Clear storage on new page
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch (e) {}
    });

    // Load cookies if not already loaded for this browser instance
    if (!this.cookiesLoaded && process.env.TWITTER_COOKIES) {
      await this.loadCookies(page);
    }

    console.log(`📄 Created page ${pageId} for scrape ${scrapeId} (${this.pages.size}/${this.maxPages} active, ${this.activeScrapes.size} concurrent scrapes)`);
    return { pageId, page };
  }

  async loadCookies(page) {
    try {
      if (!process.env.TWITTER_COOKIES) return false;

      let cookies;
      
      if (process.env.TWITTER_COOKIES.trim().startsWith('[') || process.env.TWITTER_COOKIES.trim().startsWith('{')) {
        cookies = JSON.parse(process.env.TWITTER_COOKIES);
      } else {
        console.log('⚠️ TWITTER_COOKIES appears to be in string format');
        return false;
      }
      
      if (!Array.isArray(cookies)) {
        if (typeof cookies === 'object' && cookies.name) {
          cookies = [cookies];
        } else {
          return false;
        }
      }
      
      const validCookies = cookies.filter(cookie => 
        cookie.name && cookie.value && cookie.domain
      );
      
      if (validCookies.length > 0) {
        await page.setCookie(...validCookies);
        this.cookiesLoaded = true;
        console.log(`✅ ${validCookies.length} cookies loaded to browser pool [${this.instanceId}]`);
        return true;
      }
      
    } catch (err) {
      console.error('❌ Cookie loading failed:', err.message);
    }
    
    return false;
  }

  async releasePage(pageId, scrapeId) {
    const pageInfo = this.pages.get(pageId);
    if (!pageInfo) return;
    
    try {
      await pageInfo.page.close();
    } catch (e) {
      console.error('Error closing page:', e.message);
    }
    
    this.pages.delete(pageId);
    this.activeScrapes.delete(scrapeId);
    console.log(`📄 Released page ${pageId} for scrape ${scrapeId} (${this.pages.size}/${this.maxPages} active, ${this.activeScrapes.size} concurrent scrapes)`);
  }

  async healthCheck() {
    if (!this.browser) return;
    
    try {
      const version = await this.browser.version();
      console.log(`💊 Health check passed [${this.instanceId}] - Browser version: ${version}`);
      this.lastHealthCheck = Date.now();
      
      // Clean up stale pages (older than 10 minutes)
      const now = Date.now();
      for (const [pageId, pageInfo] of this.pages.entries()) {
        const age = now - pageInfo.created;
        if (age > 10 * 60 * 1000) { // 10 minutes
          console.log(`🧹 Cleaning up stale page ${pageId} (${Math.round(age/60000)} minutes old)`);
          await this.releasePage(pageId, pageInfo.scrapeId);
        }
      }
      
    } catch (error) {
      console.error('💥 Health check failed:', error.message);
      await this.restart();
    }
  }

  async restart() {
    console.log(`🔄 Restarting browser pool [${this.instanceId}]...`);
    
    try {
      if (this.browser) {
        await this.browser.close();
      }
    } catch (e) {
      console.error('Error closing browser during restart:', e.message);
    }
    
    this.browser = null;
    this.pages.clear();
    this.cookiesLoaded = false;
    this.activeScrapes.clear();
    
    // Generate new instance ID to avoid conflicts
    this.instanceId = crypto.randomBytes(8).toString('hex');
    
    // Reinitialize
    await this.initialize();
  }

  getStats() {
    return {
      instance_id: this.instanceId,
      browser_connected: this.browser?.isConnected() || false,
      active_pages: this.pages.size,
      max_pages: this.maxPages,
      active_scrapes: this.activeScrapes.size,
      max_concurrent_scrapes: this.maxConcurrentScrapes,
      cookies_loaded: this.cookiesLoaded,
      last_health_check: new Date(this.lastHealthCheck).toISOString(),
      uptime_minutes: Math.round((Date.now() - this.lastHealthCheck) / 60000)
    };
  }
}

// Global browser pool instance
const browserPool = new EnhancedBrowserPool();

// Function to find Chrome executable
function findChrome() {
  const possiblePaths = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    process.env.PUPPETEER_EXECUTABLE_PATH
  ].filter(Boolean);

  for (const path of possiblePaths) {
    if (fs.existsSync(path)) {
      console.log(`✅ Found Chrome at: ${path}`);
      return path;
    }
  }
  
  console.log('⚠️ No Chrome executable found, using default');
  return null;
}

// Enhanced single account scraper function
async function scrapeSingleAccount(page, username, tweetsPerAccount = 3, scrapeId) {
  const cleanUsername = username.replace('@', '');
  const profileURL = `https://x.com/${cleanUsername}`;
  
  try {
    console.log(`🎯 [${scrapeId}] Scraping @${cleanUsername}...`);
    
    const response = await page.goto(profileURL, { 
      waitUntil: 'networkidle0',
      timeout: 60000
    });

    console.log(`✅ [${scrapeId}] Navigation completed, status:`, response?.status());

    // Check if we're redirected to login
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
      throw new Error('Redirected to login page - Authentication required');
    }

    // Wait for tweets to load with multiple strategies
    console.log(`⏳ [${scrapeId}] Waiting for tweets to load...`);
    
    const selectors = [
      'article[data-testid="tweet"]',
      'article',
      '[data-testid="tweet"]',
      '[data-testid="tweetText"]'
    ];
    
    let tweetsFound = false;
    for (const selector of selectors) {
      try {
        await page.waitForSelector(selector, { timeout: 15000 });
        console.log(`✅ [${scrapeId}] Found content with selector: ${selector}`);
        tweetsFound = true;
        break;
      } catch (e) {
        console.log(`⏳ [${scrapeId}] Trying next selector...`);
      }
    }
    
    if (!tweetsFound) {
      const pageContent = await page.content();
      
      if (pageContent.includes('Log in to Twitter') || 
          pageContent.includes('Sign up for Twitter') ||
          currentUrl.includes('/login')) {
        throw new Error('Login required - Please check your TWITTER_COOKIES');
      }
      
      if (pageContent.includes('rate limit')) {
        throw new Error('Rate limited by Twitter - Please try again later');
      }
      
      throw new Error(`No tweets found for @${cleanUsername} - Account may be private or protected`);
    }

    // Wait for content to stabilize
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Scroll to top for freshest content
    console.log(`📍 [${scrapeId}] Scrolling to top for freshest content...`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Light scrolling to load more tweets
    console.log(`🔄 [${scrapeId}] Loading more tweets...`);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Go back to top
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Extract tweets with enhanced pinned detection
    console.log(`🎯 [${scrapeId}] Extracting tweets...`);
    const tweets = await page.evaluate((username, tweetsPerAccount, scrapeId) => {
      const tweetData = [];
      const articles = document.querySelectorAll('article');
      const now = new Date();
      const freshnessDays = 7; // Allow tweets up to 7 days old
      const cutoffDate = new Date(now.getTime() - (freshnessDays * 24 * 60 * 60 * 1000));

      console.log(`Found ${articles.length} articles to process for ${username}`);

      for (let i = 0; i < articles.length && tweetData.length < tweetsPerAccount; i++) {
        const article = articles[i];
        try {
          // Skip promoted content
          if (article.querySelector('[data-testid="promotedIndicator"]')) {
            continue;
          }

          // Enhanced pinned tweet detection
          const isPinned = (
            // Direct pin indicators
            article.querySelector('[data-testid="pin"]') ||
            article.querySelector('svg[data-testid="pin"]') ||
            article.querySelector('[aria-label*="Pinned"]') ||
            article.querySelector('[aria-label*="pinned"]') ||
            article.querySelector('[data-testid="socialContext"]')?.textContent?.toLowerCase().includes('pinned') ||
            
            // Text-based detection
            article.textContent.toLowerCase().includes('pinned tweet') ||
            article.textContent.toLowerCase().includes('pinned') ||
            article.innerHTML.toLowerCase().includes('pin') ||
            
            // Icon-based detection
            article.querySelector('svg title')?.textContent?.toLowerCase().includes('pin') ||
            article.querySelector('[role="img"][aria-label*="pin"]') ||
            
            // Parent container checks
            article.closest('[data-testid*="pin"]') ||
            article.querySelector('[class*="pin" i]') ||
            
            // Social context checks (where pin info usually appears)
            article.querySelector('[data-testid="socialContext"]')?.querySelector('svg') ||
            
            // Additional heuristics for first tweet
            (i === 0 && (() => {
              const timeElement = article.querySelector('time');
              if (!timeElement) return false;
              const timestamp = timeElement.getAttribute('datetime');
              if (!timestamp) return false;
              const tweetAge = now - new Date(timestamp);
              // If first tweet is more than 7 days old, likely pinned
              return tweetAge > (7 * 24 * 60 * 60 * 1000);
            })())
          );
          
          if (isPinned) {
            console.log(`🔒 [${scrapeId}] Skipping pinned tweet for ${username} at position ${i}`);
            continue;
          }

          // Get tweet text
          const textElement = article.querySelector('[data-testid="tweetText"]');
          const text = textElement ? textElement.innerText.trim() : '';
          
          // Skip tweets without meaningful content
          if (!text && !article.querySelector('img')) continue;
          if (text.length < 3) continue;

          // Get tweet link and ID
          const linkElement = article.querySelector('a[href*="/status/"]');
          if (!linkElement) continue;
          
          const href = linkElement.getAttribute('href');
          const link = href.startsWith('http') ? href : 'https://twitter.com' + href;
          const tweetId = link.match(/status\/(\d+)/)?.[1];
          if (!tweetId) continue;

          // Get timestamp
          const timeElement = article.querySelector('time');
          let timestamp = timeElement ? timeElement.getAttribute('datetime') : null;
          const relativeTime = timeElement ? timeElement.innerText.trim() : '';

          // Parse relative time if no absolute timestamp
          if (!timestamp && relativeTime) {
            if (relativeTime.includes('s') || relativeTime.toLowerCase().includes('now')) {
              timestamp = new Date().toISOString();
            } else if (relativeTime.includes('m')) {
              const mins = parseInt(relativeTime) || 1;
              timestamp = new Date(now.getTime() - mins * 60000).toISOString();
            } else if (relativeTime.includes('h')) {
              const hours = parseInt(relativeTime) || 1;
              timestamp = new Date(now.getTime() - hours * 3600000).toISOString();
            } else if (relativeTime.includes('d')) {
              const days = parseInt(relativeTime) || 1;
              timestamp = new Date(now.getTime() - days * 86400000).toISOString();
            }
          }

          if (!timestamp) continue;
          const tweetDate = new Date(timestamp);
          if (isNaN(tweetDate.getTime()) || tweetDate < cutoffDate) continue;

          // Get user info
          const userElement = article.querySelector('[data-testid="User-Names"] a, [data-testid="User-Name"] a');
          let displayName = '';
          
          const displayNameElement = article.querySelector('[data-testid="User-Names"] span, [data-testid="User-Name"] span');
          if (displayNameElement) {
            displayName = displayNameElement.textContent.trim();
          }

          // Get metrics
          const getMetric = (testId) => {
            const element = article.querySelector(`[data-testid="${testId}"]`);
            if (!element) return 0;
            const text = element.getAttribute('aria-label') || element.textContent || '';
            const match = text.match(/(\d+(?:,\d+)*)/);
            return match ? parseInt(match[1].replace(/,/g, '')) : 0;
          };

          const tweetObj = {
            id: tweetId,
            username: username.replace('@', ''),
            displayName: displayName,
            text,
            link,
            likes: getMetric('like'),
            retweets: getMetric('retweet'),
            replies: getMetric('reply'),
            timestamp,
            relativeTime,
            scraped_at: new Date().toISOString()
          };
          
          tweetData.push(tweetObj);

        } catch (e) {
          console.error(`Error processing article ${i}:`, e.message);
        }
      }

      // Sort by timestamp (newest first)
      const sortedTweets = tweetData.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      
      console.log(`Extracted ${sortedTweets.length} tweets for ${username}`);
      return sortedTweets;
    }, cleanUsername, tweetsPerAccount, scrapeId);

    // Filter out very old tweets as final safeguard (configurable freshness)
    const freshnessDays = process.env.TWEET_FRESHNESS_DAYS || 7; // Default 7 days instead of 1
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - freshnessDays);

    const finalTweets = tweets
      .filter(t => {
        const tweetAge = new Date() - new Date(t.timestamp);
        const isOld = tweetAge > (freshnessDays * 24 * 60 * 60 * 1000);
        return !isOld;
      })
      .slice(0, tweetsPerAccount);

    return {
      success: true,
      username: cleanUsername,
      tweets: finalTweets,
      count: finalTweets.length
    };

  } catch (error) {
    console.error(`❌ [${scrapeId}] Error scraping @${cleanUsername}:`, error.message);
    return {
      success: false,
      username: cleanUsername,
      error: error.message,
      tweets: [],
      count: 0
    };
  }
}

// Health check endpoint with enhanced browser stats
app.get('/', (req, res) => {
  const chromePath = findChrome();
  const stats = browserPool.getStats();
  
  res.json({ 
    status: 'Enhanced Twitter Scraper - Multi-Account + Browser Pool + Concurrency Protection', 
    chrome: chromePath || 'default',
    browser_pool: stats,
    timestamp: new Date().toISOString(),
    features: [
      'Browser Pool Optimization',
      'Multi-Account Scraping', 
      'Concurrency Protection',
      'Enhanced Pinned Tweet Detection',
      'Rate Limit Protection',
      'Instance Isolation'
    ]
  });
});

// Manual browser restart endpoint
app.post('/restart-browser', async (req, res) => {
  try {
    await browserPool.restart();
    res.json({ 
      success: true, 
      message: 'Browser pool restarted successfully',
      new_instance_id: browserPool.instanceId,
      timestamp: new Date().toISOString() 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString() 
    });
  }
});

// ENHANCED MULTI-ACCOUNT SCRAPER ENDPOINT
app.post('/scrape-multiple', async (req, res) => {
  const accounts = req.body.accounts || [
    'phantom',
    'elonmusk', 
    'OpenAI',
    'sundarpichai',
    'tim_cook'
  ];
  const tweetsPerAccount = req.body.tweetsPerAccount || 3;
  
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return res.status(400).json({ error: 'Accounts array is required' });
  }

  if (accounts.length > 10) {
    return res.status(400).json({ error: 'Maximum 10 accounts allowed' });
  }

  const scrapeId = crypto.randomBytes(6).toString('hex');
  const startTime = Date.now();
  
  console.log(`\n🚀 [${scrapeId}] Starting multi-account scrape for ${accounts.length} accounts`);

  let pageId, page;
  try {
    // Acquire page from pool with concurrency protection
    const pageInfo = await browserPool.acquirePage(scrapeId);
    pageId = pageInfo.pageId;
    page = pageInfo.page;
    
    console.log(`⚡ [${scrapeId}] Got page from pool in ${Date.now() - startTime}ms`);

    // Scrape each account
    const results = [];
    let totalTweets = 0;

    for (let i = 0; i < accounts.length; i++) {
      const username = accounts[i];
      console.log(`\n📱 [${scrapeId}] Processing account ${i + 1}/${accounts.length}: @${username}`);
      
      const result = await scrapeSingleAccount(page, username, tweetsPerAccount, scrapeId);
      results.push(result);
      totalTweets += result.count;
      
      // Adaptive delay between accounts based on success rate
      if (i < accounts.length - 1) {
        const successRate = results.filter(r => r.success).length / results.length;
        const delay = successRate > 0.8 ? 2000 : 5000; // Longer delay if failures
        console.log(`⏳ [${scrapeId}] Waiting ${delay}ms before next account...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    const totalTime = Date.now() - startTime;
    console.log(`\n🎉 [${scrapeId}] MULTI-ACCOUNT SCRAPING COMPLETED in ${totalTime}ms!`);
    console.log(`📊 Total tweets scraped: ${totalTweets}`);

    res.json({
      success: true,
      scrape_id: scrapeId,
      total_accounts: accounts.length,
      total_tweets: totalTweets,
      tweets_per_account: tweetsPerAccount,
      results: results,
      scraped_at: new Date().toISOString(),
      performance: {
        total_time_ms: totalTime,
        browser_reused: true,
        instance_id: browserPool.instanceId
      },
      browser_pool: browserPool.getStats(),
      summary: {
        successful_accounts: results.filter(r => r.success).length,
        failed_accounts: results.filter(r => !r.success).length,
        accounts_with_tweets: results.filter(r => r.count > 0).length,
        success_rate: `${Math.round((results.filter(r => r.success).length / results.length) * 100)}%`
      }
    });

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`💥 [${scrapeId}] MULTI-ACCOUNT SCRAPING FAILED:`, error.message);
    
    res.status(500).json({ 
      success: false, 
      scrape_id: scrapeId,
      error: error.message,
      timestamp: new Date().toISOString(),
      performance: {
        total_time_ms: totalTime,
        browser_reused: true,
        instance_id: browserPool.instanceId
      },
      suggestion: error.message.includes('concurrent scrapes') ? 
        'Another scraping operation is in progress. Please try again in a moment.' :
        error.message.includes('login') || error.message.includes('Authentication') ? 
        'Please provide valid Twitter cookies in TWITTER_COOKIES environment variable' :
        'Twitter might be rate limiting or blocking requests. Try again in a few minutes.'
    });
  } finally {
    // Return page to pool
    if (pageId && page) {
      await browserPool.releasePage(pageId, scrapeId);
    }
  }
});

// OPTIMIZED SINGLE ACCOUNT ENDPOINT
app.post('/scrape', async (req, res) => {
  const searchURL = req.body.url || process.env.TWITTER_SEARCH_URL;
  const maxTweets = req.body.maxTweets || 10;
  
  if (!searchURL) {
    return res.status(400).json({ error: 'No Twitter URL provided' });
  }

  // Extract username from URL
  const usernameMatch = searchURL.match(/x\.com\/([^\/\?]+)/);
  if (!usernameMatch) {
    return res.status(400).json({ error: 'Invalid Twitter URL format' });
  }

  const username = usernameMatch[1];
  
  // Use multi-account endpoint with single account for consistency
  const multiReq = {
    body: {
      accounts: [username],
      tweetsPerAccount: maxTweets
    }
  };

  return new Promise((resolve) => {
    const originalJson = res.json;
    res.json = (data) => {
      // Transform multi-account response to single-account format
      if (data.success && data.results && data.results[0]) {
        const result = data.results[0];
        const singleResponse = {
          success: true,
          count: result.count,
          requested: maxTweets,
          tweets: result.tweets,
          scraped_at: data.scraped_at,
          profile_url: searchURL,
          performance: data.performance,
          browser_pool: data.browser_pool
        };
        resolve();
        return originalJson.call(res, singleResponse);
      } else {
        resolve();
        return originalJson.call(res, data);
      }
    };
    
    // Forward to multi-account endpoint
    app.handle({ ...req, ...multiReq, url: '/scrape-multiple', method: 'POST' }, res);
  });
});

// User-friendly endpoint
app.post('/scrape-user', async (req, res) => {
  const username = req.body.username;
  const maxTweets = req.body.maxTweets || 10;
  
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  
  const cleanUsername = username.replace(/^@/, '');
  const profileURL = `https://x.com/${cleanUsername}`;
  
  console.log(`🎯 Scraping user: @${cleanUsername}`);
  
  // Forward to single account endpoint
  req.body.url = profileURL;
  req.body.maxTweets = maxTweets;
  
  return new Promise((resolve) => {
    const originalJson = res.json;
    res.json = (data) => {
      resolve();
      return originalJson.call(res, data);
    };
    
    // Call scrape endpoint
    app.handle({ ...req, url: '/scrape', method: 'POST' }, res);
  });
});

// BATCH PROCESSING ENDPOINT - For handling large lists efficiently
app.post('/scrape-batch', async (req, res) => {
  const accounts = req.body.accounts || [];
  const tweetsPerAccount = req.body.tweetsPerAccount || 3;
  const batchSize = req.body.batchSize || 5; // Process in batches to avoid overwhelming
  
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return res.status(400).json({ error: 'Accounts array is required' });
  }

  if (accounts.length > 50) {
    return res.status(400).json({ error: 'Maximum 50 accounts allowed for batch processing' });
  }

  const batchId = crypto.randomBytes(8).toString('hex');
  const startTime = Date.now();
  
  console.log(`\n🔄 [${batchId}] Starting batch processing of ${accounts.length} accounts in batches of ${batchSize}`);

  try {
    const allResults = [];
    let totalTweets = 0;
    let totalSuccessful = 0;

    // Process in batches to manage resources
    for (let i = 0; i < accounts.length; i += batchSize) {
      const batch = accounts.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(accounts.length / batchSize);
      
      console.log(`\n📦 [${batchId}] Processing batch ${batchNum}/${totalBatches}: ${batch.join(', ')}`);

      try {
        // Use multi-account endpoint for this batch
        const batchResponse = await new Promise((resolve, reject) => {
          const mockReq = {
            body: {
              accounts: batch,
              tweetsPerAccount: tweetsPerAccount
            }
          };
          
          const mockRes = {
            json: (data) => resolve(data),
            status: (code) => ({
              json: (data) => reject(new Error(`HTTP ${code}: ${data.error || 'Unknown error'}`))
            })
          };

          app.handle({ ...mockReq, url: '/scrape-multiple', method: 'POST' }, mockRes);
        });

        if (batchResponse.success) {
          allResults.push(...batchResponse.results);
          totalTweets += batchResponse.total_tweets;
          totalSuccessful += batchResponse.summary.successful_accounts;
        }

        // Longer delay between batches to prevent rate limiting
        if (i + batchSize < accounts.length) {
          const delay = 10000; // 10 second delay between batches
          console.log(`⏳ [${batchId}] Waiting ${delay/1000}s before next batch...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

      } catch (batchError) {
        console.error(`❌ [${batchId}] Batch ${batchNum} failed:`, batchError.message);
        // Add failed results for this batch
        batch.forEach(username => {
          allResults.push({
            success: false,
            username: username.replace('@', ''),
            error: `Batch processing failed: ${batchError.message}`,
            tweets: [],
            count: 0
          });
        });
      }
    }

    const totalTime = Date.now() - startTime;
    console.log(`\n🎉 [${batchId}] BATCH PROCESSING COMPLETED in ${totalTime}ms!`);
    console.log(`📊 Total results: ${allResults.length}, Successful: ${totalSuccessful}, Tweets: ${totalTweets}`);

    res.json({
      success: true,
      batch_id: batchId,
      total_accounts: accounts.length,
      total_tweets: totalTweets,
      tweets_per_account: tweetsPerAccount,
      batch_size: batchSize,
      results: allResults,
      scraped_at: new Date().toISOString(),
      performance: {
        total_time_ms: totalTime,
        batches_processed: Math.ceil(accounts.length / batchSize),
        instance_id: browserPool.instanceId
      },
      summary: {
        successful_accounts: totalSuccessful,
        failed_accounts: allResults.length - totalSuccessful,
        accounts_with_tweets: allResults.filter(r => r.count > 0).length,
        success_rate: `${Math.round((totalSuccessful / allResults.length) * 100)}%`
      }
    });

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`💥 [${batchId}] BATCH PROCESSING FAILED:`, error.message);
    
    res.status(500).json({ 
      success: false, 
      batch_id: batchId,
      error: error.message,
      timestamp: new Date().toISOString(),
      performance: {
        total_time_ms: totalTime,
        instance_id: browserPool.instanceId
      }
    });
  }
});

// STATS ENDPOINT - Get detailed browser and performance stats
app.get('/stats', (req, res) => {
  const stats = browserPool.getStats();
  const uptime = process.uptime();
  const memUsage = process.memoryUsage();
  
  res.json({
    server: {
      uptime_seconds: Math.round(uptime),
      uptime_formatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`,
      memory_usage_mb: {
        rss: Math.round(memUsage.rss / 1024 / 1024),
        heap_used: Math.round(memUsage.heapUsed / 1024 / 1024),
        heap_total: Math.round(memUsage.heapTotal / 1024 / 1024),
        external: Math.round(memUsage.external / 1024 / 1024)
      },
      node_version: process.version,
      platform: process.platform,
      arch: process.arch
    },
    browser_pool: stats,
    chrome_path: findChrome() || 'default',
    cookies_configured: !!process.env.TWITTER_COOKIES,
    timestamp: new Date().toISOString()
  });
});

// Initialize browser pool on startup
async function startServer() {
  try {
    console.log('🔥 Initializing enhanced browser pool...');
    await browserPool.initialize();
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Enhanced Twitter Scraper API running on port ${PORT}`);
      console.log(`🔍 Chrome executable:`, findChrome() || 'default');
      console.log(`🍪 Cookies configured:`, !!process.env.TWITTER_COOKIES);
      console.log(`🔥 Browser pool ready with instance ID: ${browserPool.instanceId}`);
      console.log(`⚡ Features: Browser Pool + Multi-Account + Concurrency Protection`);
      console.log(`📊 Max concurrent scrapes: ${browserPool.maxConcurrentScrapes}`);
      console.log(`📄 Max pages: ${browserPool.maxPages}`);
      console.log(`\n📡 Available Endpoints:`);
      console.log(`  GET  /          - Health check & status`);
      console.log(`  GET  /stats     - Detailed server & browser stats`);
      console.log(`  POST /scrape    - Single account scraping`);
      console.log(`  POST /scrape-user - User-friendly single account`);
      console.log(`  POST /scrape-multiple - Multi-account scraping (up to 10)`);
      console.log(`  POST /scrape-batch    - Batch processing (up to 50)`);
      console.log(`  POST /restart-browser - Restart browser pool`);
    });
  } catch (error) {
    console.error('💥 Failed to start server:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown with cleanup
async function gracefulShutdown(signal) {
  console.log(`\n${signal} received, shutting down gracefully...`);
  
  try {
    if (browserPool.browser) {
      console.log('🔒 Closing browser...');
      await browserPool.browser.close();
    }
    
    console.log('✅ Cleanup completed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error.message);
    process.exit(1);
  }
}

// Handle various shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // Nodemon restart

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

// Start the server
startServer();