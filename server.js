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
  res.json({ 
    status: 'Twitter Fresh Tweet Scraper - LATEST TWEETS ONLY', 
    chrome: chromePath || 'default',
    timestamp: new Date().toISOString() 
  });
});

// AGGRESSIVE FRESH TWEET SCRAPER
app.post('/scrape', async (req, res) => {
  const searchURL = req.body.url || process.env.TWITTER_SEARCH_URL;
  const maxTweets = req.body.maxTweets || 10;
  
  if (!searchURL) {
    return res.status(400).json({ error: 'No Twitter URL provided' });
  }

  let browser;
  try {
    const chromePath = findChrome();
    
    // SUPER AGGRESSIVE launch options to avoid cache
    const launchOptions = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-client-side-phishing-detection',
        '--disable-default-apps',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-features=TranslateUI',
        '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
        '--enable-automation',
        '--password-store=basic',
        '--use-mock-keychain',
        '--disable-blink-features=AutomationControlled',
        '--disable-cache',              // 🔥 DISABLE CACHE
        '--aggressive-cache-discard',   // 🔥 AGGRESSIVE CACHE DISCARD  
        '--disk-cache-size=0',          // 🔥 NO DISK CACHE
        '--media-cache-size=0',         // 🔥 NO MEDIA CACHE
        '--incognito',                  // 🔥 PRIVATE MODE
        '--single-process',
        '--window-size=1200,800'
      ],
      defaultViewport: { width: 1200, height: 800 }
    };

    if (chromePath) {
      launchOptions.executablePath = chromePath;
    }

    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    
    // 🔥 NUCLEAR CACHE DESTRUCTION
    await page.setCacheEnabled(false);
    
    // Clear all possible storage
    await page.evaluate(() => {
      // Clear all caches
      if ('caches' in window) {
        caches.keys().then(names => {
          names.forEach(name => caches.delete(name));
        });
      }
      
      // Clear storage
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch (e) {}
      
      // Clear IndexedDB
      if ('indexedDB' in window) {
        try {
          const dbs = indexedDB.databases();
          dbs.then(databases => {
            databases.forEach(db => {
              indexedDB.deleteDatabase(db.name);
            });
          });
        } catch (e) {}
      }
    });

    // 🔥 FRESH HEADERS WITH RANDOM TIMESTAMP
    const timestamp = Date.now();
    await page.setExtraHTTPHeaders({ 
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Fresh-Request': timestamp.toString(),
      'User-Agent': `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36-${timestamp}`
    });

    // 🔥 AGGRESSIVE REQUEST INTERCEPTION
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      const url = req.url();
      
      if (resourceType === 'stylesheet' || resourceType === 'image' || resourceType === 'font') {
        req.abort();
      } else {
        // Add cache-busting parameters to ALL requests
        const separator = url.includes('?') ? '&' : '?';
        const cacheBustUrl = url + separator + '_t=' + Date.now() + '&_r=' + Math.random();
        
        const headers = {
          ...req.headers(),
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        };
        
        req.continue({ 
          url: cacheBustUrl,
          headers 
        });
      }
    });

    // Load cookies ONLY if provided
    try {
      if (process.env.TWITTER_COOKIES) {
        const cookies = JSON.parse(process.env.TWITTER_COOKIES);
        if (Array.isArray(cookies) && cookies.length > 0) {
          await page.setCookie(...cookies);
          console.log('🍪 Fresh cookies loaded');
        }
      }
    } catch (err) {
      console.error('❌ Cookie loading failed:', err.message);
    }

    // 🔥 CACHE-BUSTED URL
    const separator = searchURL.includes('?') ? '&' : '?';
    const freshURL = searchURL + separator + '_fresh=' + Date.now() + '&_cache_bust=' + Math.random();
    
    console.log('🌐 AGGRESSIVE FRESH NAVIGATION to:', freshURL);
    
    // Multiple navigation attempts for freshness
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`📡 Navigation attempt ${attempt}/2`);
        
        await page.goto(freshURL, { 
          waitUntil: ['networkidle0', 'domcontentloaded'],
          timeout: 60000
        });
        
        // Force a hard refresh
        await page.keyboard.press('F5');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        break; // Success, exit loop
      } catch (navError) {
        console.log(`⚠️ Navigation attempt ${attempt} failed:`, navError.message);
        if (attempt === 2) throw navError; // Last attempt failed
        
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Wait for fresh content with multiple strategies
    console.log('⏳ Waiting for FRESH tweets to load...');
    
    let tweetsFound = false;
    const maxWaitAttempts = 5;
    
    for (let waitAttempt = 1; waitAttempt <= maxWaitAttempts; waitAttempt++) {
      try {
        console.log(`🔍 Wait attempt ${waitAttempt}/${maxWaitAttempts}`);
        
        await Promise.race([
          page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 }),
          page.waitForSelector('article', { timeout: 10000 }),
          page.waitForSelector('[data-testid="tweetText"]', { timeout: 10000 })
        ]);
        
        tweetsFound = true;
        console.log('✅ FRESH tweets container found!');
        break;
        
      } catch (waitError) {
        console.log(`⏳ Wait attempt ${waitAttempt} failed, trying refresh...`);
        
        // Try different refresh strategies
        if (waitAttempt <= 2) {
          await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
        } else if (waitAttempt <= 4) {
          await page.evaluate(() => location.reload(true));
        }
        
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
    
    if (!tweetsFound) {
      // Check for login wall
      const loginRequired = await page.$('div[data-testid="login-prompt"]') || 
                            await page.$('a[href="/login"]') ||
                            await page.$('a[href="/i/flow/login"]');
      if (loginRequired) {
        throw new Error('❌ Twitter login required - FRESH COOKIES NEEDED for latest tweets');
      }
      throw new Error('❌ No tweets found - Twitter might be blocking requests');
    }

    // 🔥 FORCE SCROLL TO ABSOLUTE TOP FOR FRESHEST CONTENT
    console.log('📍 Scrolling to absolute top for freshest content...');
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    });
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Force timeline refresh pattern
    console.log('🔄 Forcing timeline refresh...');
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 100));
      await new Promise(resolve => setTimeout(resolve, 500));
      await page.evaluate(() => window.scrollBy(0, -100));
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Smart scrolling for ONLY recent content
    console.log('🎯 Collecting FRESH tweets...');
    let scrollAttempts = 0;
    const maxScrolls = 3;
    let lastCount = 0;
    
    while (scrollAttempts < maxScrolls) {
      const currentTweets = await page.$$eval('article', articles => articles.length);
      console.log(`📊 Scroll ${scrollAttempts + 1}: Found ${currentTweets} tweet containers`);
      
      if (currentTweets >= maxTweets + 5) {
        console.log('✅ Enough tweets collected, processing...');
        break;
      }
      
      if (currentTweets === lastCount && lastCount > 0) {
        console.log('📍 No new tweets loading, processing current batch...');
        break;
      }
      
      lastCount = currentTweets;
      
      // Gentle scroll to load more recent content
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.5));
      await new Promise(resolve => setTimeout(resolve, 2000));
      scrollAttempts++;
    }

    // 🔥 EXTRACT FRESH TWEETS WITH TIMESTAMP VALIDATION
    const tweets = await page.evaluate((maxTweets) => {
      const tweetData = [];
      const articles = document.querySelectorAll('article');
      const now = new Date();
      const oneWeekAgo = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000)); // Only tweets from last week
      
      console.log(`🔍 Processing ${articles.length} articles for FRESH content...`);
      
      for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        try {
          // Skip promoted/ads
          if (article.querySelector('[data-testid="promotedIndicator"]') || 
              article.querySelector('[aria-label*="Promoted"]')) {
            continue;
          }
          
          const textElement = article.querySelector('[data-testid="tweetText"]');
          const text = textElement ? textElement.innerText.trim() : '';
          
          // Skip if no text content
          if (!text) continue;
          
          const linkElement = article.querySelector('a[href*="/status/"]');
          const link = linkElement ? 'https://twitter.com' + linkElement.getAttribute('href') : '';
          const tweetId = link.match(/status\/(\d+)/)?.[1] || '';
          
          if (!link || !tweetId) continue;
          
          // Get timestamp and validate freshness
          const timeElement = article.querySelector('time');
          let timestamp = timeElement ? timeElement.getAttribute('datetime') : null;
          const relativeTime = timeElement ? timeElement.innerText.trim() : '';
          
          if (!timestamp) {
            // Try to parse from relative time for very recent tweets
            if (relativeTime.includes('m') || relativeTime.includes('h') || relativeTime.includes('now')) {
              timestamp = new Date().toISOString(); // Very recent
            } else {
              continue; // Skip tweets without clear timestamps
            }
          }
          
          const tweetDate = new Date(timestamp);
          if (isNaN(tweetDate.getTime())) continue;
          
          // 🔥 ONLY INCLUDE RECENT TWEETS (last week)
          if (tweetDate < oneWeekAgo) {
            console.log(`⏰ Skipping old tweet: ${relativeTime} (${tweetDate.toISOString()})`);
            continue;
          }
          
          // Extract engagement metrics
          const getLikeCount = () => {
            const likeElement = article.querySelector('[data-testid="like"]');
            if (!likeElement) return 0;
            const ariaLabel = likeElement.getAttribute('aria-label') || '';
            const match = ariaLabel.match(/(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)/);
            if (!match) return 0;
            const str = match[1];
            if (str.includes('K')) return Math.floor(parseFloat(str) * 1000);
            if (str.includes('M')) return Math.floor(parseFloat(str) * 1000000);
            return parseInt(str.replace(/,/g, ''), 10) || 0;
          };
          
          const getRetweetCount = () => {
            const rtElement = article.querySelector('[data-testid="retweet"]');
            if (!rtElement) return 0;
            const ariaLabel = rtElement.getAttribute('aria-label') || '';
            const match = ariaLabel.match(/(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)/);
            if (!match) return 0;
            const str = match[1];
            if (str.includes('K')) return Math.floor(parseFloat(str) * 1000);
            if (str.includes('M')) return Math.floor(parseFloat(str) * 1000000);
            return parseInt(str.replace(/,/g, ''), 10) || 0;
          };
          
          const getReplyCount = () => {
            const replyElement = article.querySelector('[data-testid="reply"]');
            if (!replyElement) return 0;
            const ariaLabel = replyElement.getAttribute('aria-label') || '';
            const match = ariaLabel.match(/(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)/);
            if (!match) return 0;
            const str = match[1];
            if (str.includes('K')) return Math.floor(parseFloat(str) * 1000);
            if (str.includes('M')) return Math.floor(parseFloat(str) * 1000000);
            return parseInt(str.replace(/,/g, ''), 10) || 0;
          };
          
          // User info
          const userElement = article.querySelector('[data-testid="User-Name"]');
          let username = '';
          let displayName = '';
          if (userElement) {
            const userText = userElement.innerText.split('\n');
            displayName = userText[0] || '';
            username = userText[1] || '';
          }
          
          const verified = !!article.querySelector('[data-testid="icon-verified"]') || 
                          !!article.querySelector('[aria-label*="Verified"]');
          
          // Check for retweet
          const isRetweet = !!article.querySelector('[data-testid="socialContext"]')?.innerText?.includes('retweeted') ||
                           text.startsWith('RT @');
          
          const ageHours = (now - tweetDate) / (1000 * 60 * 60);
          
          const tweetObj = {
            id: tweetId,
            username: username.replace(/^@/, ''),
            displayName: displayName,
            text,
            link,
            likes: getLikeCount(),
            retweets: getRetweetCount(),
            replies: getReplyCount(),
            verified,
            timestamp,
            relativeTime,
            isRetweet,
            ageHours: Math.round(ageHours * 100) / 100,
            freshness: ageHours < 1 ? 'very_fresh' : ageHours < 24 ? 'fresh' : 'recent',
            scraped_at: new Date().toISOString()
          };
          
          tweetData.push(tweetObj);
          console.log(`✅ Fresh tweet added: ${tweetId} (${relativeTime})`);
          
        } catch (e) {
          console.error(`Error processing article ${i}:`, e.message);
        }
      }
      
      console.log(`🎯 Extracted ${tweetData.length} FRESH tweets`);
      return tweetData;
    }, maxTweets);

    // Sort by timestamp - FRESHEST FIRST
    tweets.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    // Take only the freshest tweets
    const freshTweets = tweets.slice(0, maxTweets);
    
    console.log(`🚀 FINAL RESULT: ${freshTweets.length} FRESH tweets delivered!`);
    
    // Log freshness stats
    const freshnessStats = {
      very_fresh: freshTweets.filter(t => t.freshness === 'very_fresh').length,
      fresh: freshTweets.filter(t => t.freshness === 'fresh').length,
      recent: freshTweets.filter(t => t.freshness === 'recent').length
    };
    
    console.log('📊 Freshness distribution:', freshnessStats);
    
    if (freshTweets.length === 0) {
      console.log('⚠️ No fresh tweets found - account might be inactive or private');
    }

    res.json({
      success: true,
      count: freshTweets.length,
      requested: maxTweets,
      tweets: freshTweets,
      scraped_at: new Date().toISOString(),
      profile_url: searchURL,
      freshness: freshnessStats,
      debug: {
        total_processed: tweets.length,
        cache_busted: true,
        fresh_navigation: true
      }
    });

  } catch (error) {
    console.error('💥 FRESH SCRAPING FAILED:', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString(),
      suggestion: error.message.includes('login') ? 
        'Please provide fresh Twitter cookies in TWITTER_COOKIES environment variable' :
        'Twitter might be rate limiting or blocking requests'
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('Error closing browser:', e.message);
      }
    }
  }
});

// Simplified user endpoint
app.post('/scrape-user', async (req, res) => {
  const username = req.body.username;
  const maxTweets = req.body.maxTweets || 10;
  
  if (!username) {
    return res.status(400).json({ error: 'Username is required for fresh tweet scraping' });
  }
  
  const cleanUsername = username.replace(/^@/, '');
  const profileURL = `https://x.com/${cleanUsername}`;
  
  // Forward to main endpoint
  req.body.url = profileURL;
  return app._router.handle({ ...req, url: '/scrape', method: 'POST' }, res);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 FRESH Twitter Scraper API running on port ${PORT}`);
  console.log(`📊 Memory usage:`, process.memoryUsage());
  console.log(`🔍 Chrome executable:`, findChrome() || 'default');
  console.log(`🔥 OPTIMIZED FOR FRESH TWEETS ONLY - Last 7 days`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});