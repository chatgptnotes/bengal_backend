/**
 * Combined Server - Proxy + Transcription
 * Runs both services on a single port for Render deployment
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { parseStringPromise } = require('xml2js');
const { setupSocketIO, initOpenAI } = require('./transcription-service.cjs');

// Use Render's PORT or default to 10000
const PORT = process.env.PORT || 10000;

// Create Express app
const app = express();

// CORS configuration
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5173',
    /\.vercel\.app$/,
    /\.onrender\.com$/
  ],
  credentials: true
}));

app.use(express.json());

// Create HTTP server
const server = http.createServer(app);

// Setup Socket.IO for transcription
const io = setupSocketIO(server);

// =====================================================
// HEALTH CHECK
// =====================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      proxy: true,
      transcription: true,
      ffmpeg: true,
      ytdlp: true
    },
    bearerTokenConfigured: !!process.env.VITE_TWITTER_BEARER_TOKEN,
    openaiConfigured: !!process.env.OPENAI_API_KEY
  });
});

// =====================================================
// TWITTER API ENDPOINTS (from twitter-proxy.cjs)
// =====================================================
const TWITTER_BEARER_TOKEN = process.env.VITE_TWITTER_BEARER_TOKEN;
const TWITTER_API_BASE = 'https://api.twitter.com/2';

const BJP_BENGAL_CONFIG = {
  hashtags: ['#BJP', '#BJPBengal', '#BJP4Bengal', '#WestBengal', '#Kolkata', '#BengalPolitics', '#ModiInBengal', '#BJPWestBengal'],
  keywords: ['BJP West Bengal', 'BJP Bengal', 'BJP Kolkata', 'Suvendu Adhikari', 'Sukanta Majumdar'],
  accounts: ['BJP4Bengal', 'BJP4India']
};

async function twitterRequest(endpoint, params = {}) {
  const url = new URL(`${TWITTER_API_BASE}${endpoint}`);
  Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));

  const response = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${TWITTER_BEARER_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Twitter API Error: ${response.status} - ${error}`);
  }

  return response.json();
}

// BJP Bengal feed
app.get('/api/twitter/bjp-bengal', async (req, res) => {
  try {
    const { max_results = 50 } = req.query;
    const hashtagQuery = BJP_BENGAL_CONFIG.hashtags.slice(0, 5).join(' OR ');
    const query = `(${hashtagQuery}) -is:retweet lang:en`;

    const data = await twitterRequest('/tweets/search/recent', {
      query: query,
      max_results: Math.min(parseInt(max_results), 100),
      'tweet.fields': 'created_at,public_metrics,author_id,entities',
      'user.fields': 'name,username,profile_image_url',
      'expansions': 'author_id'
    });

    res.json({
      success: true,
      data: data.data || [],
      includes: data.includes || {},
      meta: data.meta || {},
      fetchedAt: new Date().toISOString()
    });
  } catch (error) {
    res.json({
      success: false,
      error: error.message,
      rateLimited: error.message.includes('429'),
      data: [],
      fetchedAt: new Date().toISOString()
    });
  }
});

// Twitter search
app.get('/api/twitter/search', async (req, res) => {
  try {
    const { query, max_results = 10 } = req.query;
    if (!query) return res.status(400).json({ error: 'Query parameter required' });

    const data = await twitterRequest('/tweets/search/recent', {
      query: `${query} -is:retweet`,
      max_results: Math.min(parseInt(max_results), 100),
      'tweet.fields': 'created_at,public_metrics,author_id,entities',
      'user.fields': 'name,username,profile_image_url',
      'expansions': 'author_id'
    });

    res.json({ success: true, data: data.data || [], includes: data.includes || {}, meta: data.meta || {} });
  } catch (error) {
    res.json({ success: false, error: error.message, data: [] });
  }
});

// =====================================================
// RSS/NEWS PROXY ENDPOINTS
// =====================================================
app.get('/api/rss-proxy', async (req, res) => {
  try {
    const { url, keyword, constituency } = req.query;

    let rssUrl;
    if (url) {
      rssUrl = decodeURIComponent(url);
    } else if (keyword) {
      const searchQuery = encodeURIComponent(`${keyword} West Bengal`);
      rssUrl = `https://news.google.com/rss/search?q=${searchQuery}&hl=en-IN&gl=IN&ceid=IN:en`;
    } else if (constituency) {
      const searchQuery = encodeURIComponent(`${constituency} West Bengal politics`);
      rssUrl = `https://news.google.com/rss/search?q=${searchQuery}&hl=en-IN&gl=IN&ceid=IN:en`;
    } else {
      return res.status(400).json({ error: 'URL, keyword, or constituency parameter required' });
    }

    const response = await fetch(rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    if (!response.ok) throw new Error(`RSS fetch failed: ${response.status}`);

    const xmlText = await response.text();
    const result = await parseStringPromise(xmlText, { explicitArray: false });
    const channel = result.rss?.channel;

    if (!channel) return res.json({ success: true, articles: [], message: 'No news found' });

    let items = channel.item || [];
    if (!Array.isArray(items)) items = [items];

    const articles = items.slice(0, 10).map((item, index) => {
      const titleParts = (item.title || '').split(' - ');
      const source = titleParts.length > 1 ? titleParts.pop() : 'Google News';
      const title = titleParts.join(' - ');
      let description = (item.description || '').replace(/<[^>]*>/g, '').trim();

      return {
        id: `news_${Date.now()}_${index}`,
        title: title || item.title,
        description: description.substring(0, 200),
        url: item.link || '',
        source: source,
        published_at: item.pubDate || new Date().toISOString(),
        image_url: null
      };
    });

    res.json({
      success: true,
      articles: articles,
      total: articles.length,
      fetchedAt: new Date().toISOString(),
      source: 'google_news_rss'
    });
  } catch (error) {
    res.json({ success: false, error: error.message, articles: [], fetchedAt: new Date().toISOString() });
  }
});

// =====================================================
// TRANSCRIPTION INIT ENDPOINT
// =====================================================
app.post('/api/transcription/init', (req, res) => {
  const { apiKey } = req.body;
  if (apiKey) {
    initOpenAI(apiKey);
    res.json({ success: true, message: 'OpenAI initialized' });
  } else if (process.env.OPENAI_API_KEY) {
    initOpenAI(process.env.OPENAI_API_KEY);
    res.json({ success: true, message: 'OpenAI initialized from env' });
  } else {
    res.status(400).json({ success: false, message: 'API key required' });
  }
});

// =====================================================
// START SERVER
// =====================================================
server.listen(PORT, '0.0.0.0', () => {
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const wsUrl = baseUrl.replace('http', 'ws');

  console.log(`\n========================================`);
  console.log(`BJP Bengal Combined Server - Port ${PORT}`);
  console.log(`========================================`);
  console.log(`Health: ${baseUrl}/health`);
  console.log(`----------------------------------------`);
  console.log(`PROXY ENDPOINTS:`);
  console.log(`  Twitter: ${baseUrl}/api/twitter/bjp-bengal`);
  console.log(`  News RSS: ${baseUrl}/api/rss-proxy?keyword=Kolkata`);
  console.log(`----------------------------------------`);
  console.log(`TRANSCRIPTION:`);
  console.log(`  WebSocket: ${wsUrl}/transcription`);
  console.log(`========================================`);
  console.log(`Twitter Bearer: ${TWITTER_BEARER_TOKEN ? 'Configured' : 'NOT SET'}`);
  console.log(`OpenAI: ${process.env.OPENAI_API_KEY ? 'Configured' : 'NOT SET'}`);
  console.log(`========================================\n`);

  // Auto-init OpenAI if key exists
  if (process.env.OPENAI_API_KEY) {
    initOpenAI(process.env.OPENAI_API_KEY);
    console.log('OpenAI initialized from environment');
  }
});
