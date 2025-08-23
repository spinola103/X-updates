const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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

// Health check endpoint
app.get('/', (req, res) => {
  const chromePath = findChrome();
  const cookiesAvailable = !!process.env.TWITTER_COOKIES;
  res.json({ 
    status: 'Multi-Account Twitter Fresh Tweet Scraper', 
    chrome: chromePath || 'default',
    cookies_configured: cookiesAvailable,
    timestamp: new Date().toISOString() 
  });
});

// Function to scrape a single account
async function scrapeSingleAccount(page, username, tweetsPerAccount = 3) {
  const profileURL = `https://x.com/${username.replace('@', '')}`;
  
  try {
    console.log(`🎯 Scraping @${username}...`);
    
    await page.goto(profileURL, { 
      waitUntil: 'networkidle0',
      timeout: 30000
    });

    // Check if we're redirected to login
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
      throw new Error('Redirected to login page - Authentication required');
    }

    // Wait for tweets to load
    const selectors = [
      'article[data-testid="tweet"]',
      'article',
      '[data-testid="tweet"]'
    ];
    
    let tweetsFound = false;
    for (const selector of selectors) {
      try {
        await page.waitForSelector(selector, { timeout: 10000 });
        tweetsFound = true;
        break;
      } catch (e) {
        continue;
      }
    }
    
    if (!tweetsFound) {
      throw new Error(`No tweets found for @${username}`);
    }

    // Wait for content to stabilize
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Extract latest tweets (excluding pinned)
    const tweets = await page.evaluate((username, tweetsPerAccount) => {
      const tweetData = [];
      const articles = document.querySelectorAll('article');
      
      for (let i = 0; i < articles.length && tweetData.length < tweetsPerAccount; i++) {
        const article = articles[i];
        try {
          // Skip promoted content
          if (article.querySelector('[data-testid="promotedIndicator"]')) {
            continue;
          }

          // Skip pinned tweets
          if (article.querySelector('[data-testid="pin"]') || 
              article.textContent.includes('Pinned Tweet') ||
              article.querySelector('svg[data-testid="pin"]')) {
            console.log('Skipping pinned tweet');
            continue;
          }
          
          // Get tweet text
          const textElement = article.querySelector('[data-testid="tweetText"]');
          const text = textElement ? textElement.innerText.trim() : '';
          
          if (!text || text.length < 5) continue;
          
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
          
          if (!timestamp && relativeTime) {
            const now = new Date();
            if (relativeTime.includes('s') || relativeTime.includes('now')) {
              timestamp = now.toISOString();
            } else if (relativeTime.includes('m')) {
              const mins = parseInt(relativeTime) || 1;
              timestamp = new Date(now.getTime() - mins * 60000).toISOString();
            } else if (relativeTime.includes('h')) {
              const hours = parseInt(relativeTime) || 1;
              timestamp = new Date(now.getTime() - hours * 3600000).toISOString();
            }
          }
          
          if (!timestamp) continue;
          
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
      
      return tweetData.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }, username, tweetsPerAccount);

    return {
      success: true,
      username: username.replace('@', ''),
      tweets: tweets.slice(0, tweetsPerAccount),
      count: tweets.length
    };

  } catch (error) {
    console.error(`❌ Error scraping @${username}:`, error.message);
    return {
      success: false,
      username: username.replace('@', ''),
      error: error.message,
      tweets: [],
      count: 0
    };
  }
}

// MULTI-ACCOUNT SCRAPER ENDPOINT
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

  let browser;
  try {
    const chromePath = findChrome();
    
    const launchOptions = {
      headless: 'new',
      args: [
        '--no-sandbox',
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
        '--user-data-dir=/tmp/chrome-user-data-' + Date.now()
      ],
      defaultViewport: { width: 1366, height: 768 }
    };

    if (chromePath) {
      launchOptions.executablePath = chromePath;
    }

    console.log('🚀 Launching browser for multi-account scraping...');
    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setCacheEnabled(false);
    
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch (e) {}
    });

    await page.setExtraHTTPHeaders({ 
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Cache-Control': 'no-cache',
      'Upgrade-Insecure-Requests': '1'
    });

    // Load cookies
    let cookiesLoaded = false;
    if (process.env.TWITTER_COOKIES) {
      try {
        const cookies = JSON.parse(process.env.TWITTER_COOKIES);
        if (Array.isArray(cookies) && cookies.length > 0) {
          const validCookies = cookies.filter(cookie => 
            cookie.name && cookie.value && cookie.domain
          );
          
          if (validCookies.length > 0) {
            await page.setCookie(...validCookies);
            cookiesLoaded = true;
            console.log(`✅ ${validCookies.length} cookies loaded`);
          }
        }
      } catch (err) {
        console.error('❌ Cookie loading failed:', err.message);
      }
    }

    // Scrape each account
    const results = [];
    let totalTweets = 0;

    for (let i = 0; i < accounts.length; i++) {
      const username = accounts[i];
      console.log(`\n📱 Processing account ${i + 1}/${accounts.length}: @${username}`);
      
      const result = await scrapeSingleAccount(page, username, tweetsPerAccount);
      results.push(result);
      totalTweets += result.count;
      
      // Small delay between accounts to avoid rate limiting
      if (i < accounts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    console.log(`\n🎉 MULTI-ACCOUNT SCRAPING COMPLETED!`);
    console.log(`📊 Total tweets scraped: ${totalTweets}`);

    res.json({
      success: true,
      total_accounts: accounts.length,
      total_tweets: totalTweets,
      tweets_per_account: tweetsPerAccount,
      results: results,
      scraped_at: new Date().toISOString(),
      cookies_loaded: cookiesLoaded,
      summary: {
        successful_accounts: results.filter(r => r.success).length,
        failed_accounts: results.filter(r => !r.success).length,
        accounts_with_tweets: results.filter(r => r.count > 0).length
      }
    });

  } catch (error) {
    console.error('💥 MULTI-ACCOUNT SCRAPING FAILED:', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
        console.log('🔒 Browser closed');
      } catch (e) {
        console.error('Error closing browser:', e.message);
      }
    }
  }
});

// Single account endpoint (unchanged for backward compatibility)
app.post('/scrape', async (req, res) => {
  const searchURL = req.body.url || process.env.TWITTER_SEARCH_URL;
  const maxTweets = req.body.maxTweets || 10;
  
  if (!searchURL) {
    return res.status(400).json({ error: 'No Twitter URL provided' });
  }

  // Extract username from URL for single account scraping
  const usernameMatch = searchURL.match(/x\.com\/([^\/\?]+)/);
  if (!usernameMatch) {
    return res.status(400).json({ error: 'Invalid Twitter URL format' });
  }

  const username = usernameMatch[1];
  
  // Use the multi-account endpoint with single account
  req.body.accounts = [username];
  req.body.tweetsPerAccount = maxTweets;
  
  // Forward to multi-account endpoint
  return app._router.handle({ ...req, url: '/scrape-multiple', method: 'POST' }, res);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Multi-Account Twitter Scraper API running on port ${PORT}`);
  console.log(`🔍 Chrome executable:`, findChrome() || 'default');
  console.log(`🍪 Cookies configured:`, !!process.env.TWITTER_COOKIES);
  console.log(`🔥 Ready to scrape multiple accounts!`);
  console.log(`\n📡 Endpoints:`);
  console.log(`  POST /scrape-multiple - Scrape multiple accounts`);
  console.log(`  POST /scrape - Scrape single account (backward compatible)`);
  console.log(`\n📝 Example request body for /scrape-multiple:`);
  console.log(`{
    "accounts": ["phantom", "elonmusk", "OpenAI"],
    "tweetsPerAccount": 3
  }`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});