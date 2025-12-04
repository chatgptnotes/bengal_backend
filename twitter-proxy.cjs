const express = require('express');
const cors = require('cors');
const { parseStringPromise } = require('xml2js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// CORS configuration - Allow Vercel deployments and local development
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5173',
    /\.vercel\.app$/,  // All Vercel preview/production URLs
    /\.onrender\.com$/  // Render URLs
  ],
  credentials: true
}));

app.use(express.json());

// Twitter API Configuration
const TWITTER_BEARER_TOKEN = process.env.VITE_TWITTER_BEARER_TOKEN;
const TWITTER_API_BASE = 'https://api.twitter.com/2';

// BJP Bengal specific queries
const BJP_BENGAL_CONFIG = {
  hashtags: ['#BJP', '#BJPBengal', '#BJP4Bengal', '#WestBengal', '#Kolkata', '#BengalPolitics', '#ModiInBengal', '#BJPWestBengal'],
  keywords: ['BJP West Bengal', 'BJP Bengal', 'BJP Kolkata', 'Suvendu Adhikari', 'Sukanta Majumdar'],
  accounts: ['BJP4Bengal', 'BJP4India']
};

// Helper function to make Twitter API requests
async function twitterRequest(endpoint, params = {}) {
  const url = new URL(`${TWITTER_API_BASE}${endpoint}`);
  Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));

  console.log(`[Twitter API] Fetching: ${url.toString()}`);

  const response = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${TWITTER_BEARER_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`[Twitter API] Error: ${response.status} - ${error}`);
    throw new Error(`Twitter API Error: ${response.status} - ${error}`);
  }

  return response.json();
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    bearerTokenConfigured: !!TWITTER_BEARER_TOKEN
  });
});

// BJP Bengal combined feed - Fetches up to 50 tweets per request
app.get('/api/twitter/bjp-bengal', async (req, res) => {
  try {
    const { max_results = 50 } = req.query;

    // Build search query for BJP Bengal
    const hashtagQuery = BJP_BENGAL_CONFIG.hashtags.slice(0, 5).join(' OR ');
    const query = `(${hashtagQuery}) -is:retweet lang:en`;

    console.log(`[BJP Bengal] Search query: ${query}`);
    console.log(`[BJP Bengal] Requesting ${max_results} tweets`);

    const data = await twitterRequest('/tweets/search/recent', {
      query: query,
      max_results: Math.min(parseInt(max_results), 100), // Twitter API max is 100
      'tweet.fields': 'created_at,public_metrics,author_id,entities',
      'user.fields': 'name,username,profile_image_url',
      'expansions': 'author_id'
    });

    console.log(`[BJP Bengal] Fetched ${data.data?.length || 0} tweets`);

    res.json({
      success: true,
      data: data.data || [],
      includes: data.includes || {},
      meta: data.meta || {},
      fromCache: false,
      fetchedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[BJP Bengal] Error:', error.message);
    // Return 200 with error info so frontend can handle gracefully
    res.json({
      success: false,
      error: error.message,
      rateLimited: error.message.includes('429'),
      data: [],
      meta: { result_count: 0 },
      fetchedAt: new Date().toISOString()
    });
  }
});

// Search tweets by query
app.get('/api/twitter/search', async (req, res) => {
  try {
    const { query, max_results = 10 } = req.query;

    if (!query) {
      return res.status(400).json({ error: 'Query parameter required' });
    }

    const data = await twitterRequest('/tweets/search/recent', {
      query: `${query} -is:retweet`,
      max_results: Math.min(parseInt(max_results), 100),
      'tweet.fields': 'created_at,public_metrics,author_id,entities',
      'user.fields': 'name,username,profile_image_url',
      'expansions': 'author_id'
    });

    res.json({
      success: true,
      data: data.data || [],
      includes: data.includes || {},
      meta: data.meta || {}
    });
  } catch (error) {
    console.error('[Search] Error:', error.message);
    res.json({ success: false, error: error.message, rateLimited: error.message.includes('429'), data: [] });
  }
});

// Search by hashtag
app.get('/api/twitter/hashtags', async (req, res) => {
  try {
    const { hashtag, max_results = 10 } = req.query;

    if (!hashtag) {
      return res.status(400).json({ error: 'Hashtag parameter required' });
    }

    const query = hashtag.startsWith('#') ? hashtag : `#${hashtag}`;

    const data = await twitterRequest('/tweets/search/recent', {
      query: `${query} -is:retweet`,
      max_results: Math.min(parseInt(max_results), 100),
      'tweet.fields': 'created_at,public_metrics,author_id,entities',
      'user.fields': 'name,username,profile_image_url',
      'expansions': 'author_id'
    });

    res.json({
      success: true,
      data: data.data || [],
      includes: data.includes || {},
      meta: data.meta || {}
    });
  } catch (error) {
    console.error('[Hashtags] Error:', error.message);
    res.json({ success: false, error: error.message, rateLimited: error.message.includes('429'), data: [] });
  }
});

// Get user tweets
app.get('/api/twitter/user-tweets', async (req, res) => {
  try {
    const { username } = req.query;

    if (!username) {
      return res.status(400).json({ error: 'Username parameter required' });
    }

    // First get user ID
    const userData = await twitterRequest(`/users/by/username/${username}`, {
      'user.fields': 'name,username,profile_image_url,public_metrics'
    });

    if (!userData.data) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = userData.data.id;

    // Get user tweets
    const tweetsData = await twitterRequest(`/users/${userId}/tweets`, {
      max_results: 10,
      'tweet.fields': 'created_at,public_metrics,entities',
      exclude: 'retweets,replies'
    });

    res.json({
      success: true,
      user: userData.data,
      data: tweetsData.data || [],
      meta: tweetsData.meta || {}
    });
  } catch (error) {
    console.error('[User Tweets] Error:', error.message);
    res.json({ success: false, error: error.message, rateLimited: error.message.includes('429'), data: [] });
  }
});

// Get mentions of BJP Bengal
app.get('/api/twitter/mentions', async (req, res) => {
  try {
    const query = '@BJP4Bengal -is:retweet';

    const data = await twitterRequest('/tweets/search/recent', {
      query: query,
      max_results: 10,
      'tweet.fields': 'created_at,public_metrics,author_id,entities',
      'user.fields': 'name,username,profile_image_url',
      'expansions': 'author_id'
    });

    res.json({
      success: true,
      data: data.data || [],
      includes: data.includes || {},
      meta: data.meta || {}
    });
  } catch (error) {
    console.error('[Mentions] Error:', error.message);
    res.json({ success: false, error: error.message, rateLimited: error.message.includes('429'), data: [] });
  }
});

// =====================================================
// RSS PROXY FOR GOOGLE NEWS (CORS bypass)
// =====================================================

// Google News RSS Proxy - Fetches news for West Bengal constituencies
app.get('/api/rss-proxy', async (req, res) => {
  try {
    const { url, keyword, constituency } = req.query;

    let rssUrl;
    if (url) {
      // Direct URL provided
      rssUrl = decodeURIComponent(url);
    } else if (keyword) {
      // Build Google News RSS URL with keyword
      const searchQuery = encodeURIComponent(`${keyword} West Bengal`);
      rssUrl = `https://news.google.com/rss/search?q=${searchQuery}&hl=en-IN&gl=IN&ceid=IN:en`;
    } else if (constituency) {
      // Use constituency name as keyword
      const searchQuery = encodeURIComponent(`${constituency} West Bengal politics`);
      rssUrl = `https://news.google.com/rss/search?q=${searchQuery}&hl=en-IN&gl=IN&ceid=IN:en`;
    } else {
      return res.status(400).json({ error: 'URL, keyword, or constituency parameter required' });
    }

    console.log(`[RSS Proxy] Fetching: ${rssUrl}`);

    const response = await fetch(rssUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`RSS fetch failed: ${response.status}`);
    }

    const xmlText = await response.text();

    // Parse XML to JSON
    const result = await parseStringPromise(xmlText, { explicitArray: false });
    const channel = result.rss?.channel;

    if (!channel) {
      return res.json({ success: true, articles: [], message: 'No news found' });
    }

    // Extract articles from RSS items
    let items = channel.item || [];
    if (!Array.isArray(items)) {
      items = [items];
    }

    const articles = items.slice(0, 10).map((item, index) => {
      // Extract source from title (Google News format: "Title - Source")
      const titleParts = (item.title || '').split(' - ');
      const source = titleParts.length > 1 ? titleParts.pop() : 'Google News';
      const title = titleParts.join(' - ');

      // Clean description (remove HTML tags)
      let description = item.description || '';
      description = description.replace(/<[^>]*>/g, '').trim();

      return {
        id: `news_${Date.now()}_${index}`,
        title: title || item.title,
        description: description.substring(0, 200),
        url: item.link || '',
        source: source,
        published_at: item.pubDate || new Date().toISOString(),
        image_url: null // Google News RSS doesn't include images
      };
    });

    console.log(`[RSS Proxy] Found ${articles.length} articles`);

    res.json({
      success: true,
      articles: articles,
      total: articles.length,
      fetchedAt: new Date().toISOString(),
      source: 'google_news_rss'
    });

  } catch (error) {
    console.error('[RSS Proxy] Error:', error.message);
    res.json({
      success: false,
      error: error.message,
      articles: [],
      fetchedAt: new Date().toISOString()
    });
  }
});

// Constituency-specific news endpoint
app.get('/api/news/constituency/:constituencyId', async (req, res) => {
  try {
    const { constituencyId } = req.params;

    // Map constituency IDs to search keywords
    const CONSTITUENCY_KEYWORDS = {
      // Kolkata Metro
      'wb_kolkata_bhowanipore': ['Bhowanipore', 'Mamata Banerjee', 'Kolkata South'],
      'wb_kolkata_beleghata': ['Beleghata', 'Kolkata East'],
      'wb_kolkata_entally': ['Entally', 'Central Kolkata'],
      'wb_kolkata_ballygunge': ['Ballygunge', 'South Kolkata'],
      'wb_kolkata_chowringhee': ['Chowringhee', 'Park Street Kolkata'],
      'wb_kolkata_rashbehari': ['Rashbehari', 'South Kolkata'],
      'wb_kolkata_tollygunge': ['Tollygunge', 'Tolly Kolkata'],
      'wb_kolkata_jadavpur': ['Jadavpur', 'Jadavpur University'],
      'wb_kolkata_kasba': ['Kasba', 'East Kolkata'],
      'wb_kolkata_behala_west': ['Behala', 'West Behala'],

      // Howrah
      'wb_howrah_howrah_uttar': ['Howrah North', 'Howrah politics'],
      'wb_howrah_howrah_madhya': ['Howrah Central', 'Howrah'],
      'wb_howrah_shibpur': ['Shibpur', 'Howrah Shibpur'],
      'wb_howrah_bally': ['Bally', 'Howrah Bally'],
      'wb_howrah_uttarpara': ['Uttarpara', 'Hooghly Uttarpara'],

      // North 24 Parganas
      'wb_north_24_parganas_barrackpore': ['Barrackpore', 'Arjun Singh'],
      'wb_north_24_parganas_dum_dum': ['Dum Dum', 'North Kolkata'],
      'wb_north_24_parganas_rajarhat_new_town': ['Rajarhat', 'New Town Kolkata'],
      'wb_north_24_parganas_bidhannagar': ['Bidhannagar', 'Salt Lake'],
      'wb_north_24_parganas_madhyamgram': ['Madhyamgram', 'North 24 Parganas'],
      'wb_north_24_parganas_barasat': ['Barasat', 'North 24 Parganas'],

      // South 24 Parganas
      'wb_south_24_parganas_jadavpur': ['Jadavpur South', 'South Kolkata'],
      'wb_south_24_parganas_sonarpur_uttar': ['Sonarpur', 'South 24 Parganas'],
      'wb_south_24_parganas_budge_budge': ['Budge Budge', 'South 24 Parganas'],
      'wb_south_24_parganas_diamond_harbour': ['Diamond Harbour', 'Abhishek Banerjee'],

      // North Bengal
      'wb_darjeeling_darjeeling': ['Darjeeling', 'GTA', 'Gorkhaland'],
      'wb_darjeeling_siliguri': ['Siliguri', 'North Bengal'],
      'wb_jalpaiguri_jalpaiguri': ['Jalpaiguri', 'North Bengal'],
      'wb_cooch_behar_cooch_behar_uttar': ['Cooch Behar', 'North Bengal'],

      // Malda / Murshidabad
      'wb_malda_english_bazar': ['Malda', 'English Bazar'],
      'wb_murshidabad_berhampore': ['Berhampore', 'Murshidabad'],

      // Nadia
      'wb_nadia_krishnanagar_uttar': ['Krishnanagar', 'Nadia'],
      'wb_nadia_ranaghat_uttar_paschim': ['Ranaghat', 'Nadia'],

      // Hooghly
      'wb_hooghly_serampore': ['Serampore', 'Hooghly'],
      'wb_hooghly_chandannagar': ['Chandannagar', 'Hooghly'],
      'wb_hooghly_chinsurah': ['Chinsurah', 'Hooghly'],
      'wb_hooghly_arambag': ['Arambag', 'Hooghly'],

      // Bardhaman
      'wb_purba_bardhaman_asansol_uttar': ['Asansol', 'Asansol North'],
      'wb_purba_bardhaman_asansol_dakshin': ['Asansol South', 'Bardhaman'],
      'wb_purba_bardhaman_durgapur_purba': ['Durgapur', 'East Durgapur'],
      'wb_purba_bardhaman_durgapur_paschim': ['Durgapur West', 'Bardhaman'],
      'wb_purba_bardhaman_bardhaman_uttar': ['Bardhaman', 'Burdwan'],
      'wb_paschim_bardhaman_pandaveswar': ['Pandaveswar', 'West Bardhaman'],

      // Medinipur
      'wb_purba_medinipur_tamluk': ['Tamluk', 'Purba Medinipur'],
      'wb_purba_medinipur_haldia': ['Haldia', 'Purba Medinipur'],
      'wb_paschim_medinipur_midnapore': ['Midnapore', 'Paschim Medinipur'],

      // Others
      'wb_bankura_bankura': ['Bankura', 'Bankura politics'],
      'wb_purulia_purulia': ['Purulia', 'Purulia politics'],
      'wb_birbhum_bolpur': ['Bolpur', 'Shantiniketan'],
      'wb_birbhum_suri': ['Suri', 'Birbhum']
    };

    // Get keywords for this constituency (or use generic West Bengal)
    const keywords = CONSTITUENCY_KEYWORDS[constituencyId] || ['West Bengal politics'];
    const searchKeyword = keywords[0]; // Use first keyword

    // Fetch from Google News RSS
    const searchQuery = encodeURIComponent(`${searchKeyword} West Bengal`);
    const rssUrl = `https://news.google.com/rss/search?q=${searchQuery}&hl=en-IN&gl=IN&ceid=IN:en`;

    console.log(`[Constituency News] ${constituencyId} -> ${searchKeyword}`);

    const response = await fetch(rssUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`RSS fetch failed: ${response.status}`);
    }

    const xmlText = await response.text();
    const result = await parseStringPromise(xmlText, { explicitArray: false });
    const channel = result.rss?.channel;

    let items = channel?.item || [];
    if (!Array.isArray(items)) items = [items];

    const articles = items.slice(0, 5).map((item, index) => {
      const titleParts = (item.title || '').split(' - ');
      const source = titleParts.length > 1 ? titleParts.pop() : 'Google News';
      const title = titleParts.join(' - ');
      let description = (item.description || '').replace(/<[^>]*>/g, '').trim();

      return {
        id: `${constituencyId}_${Date.now()}_${index}`,
        constituency_id: constituencyId,
        title: title || item.title,
        description: description.substring(0, 200),
        url: item.link || '',
        source: source,
        published_at: item.pubDate || new Date().toISOString(),
        sentiment: 'neutral',
        fetch_source: 'google_rss'
      };
    });

    res.json({
      success: true,
      constituency_id: constituencyId,
      keywords: keywords,
      articles: articles,
      total: articles.length,
      fetchedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('[Constituency News] Error:', error.message);
    res.json({
      success: false,
      error: error.message,
      articles: [],
      fetchedAt: new Date().toISOString()
    });
  }
});

// =====================================================
// ALL CONSTITUENCIES NEWS (for Geographic Heatmap)
// =====================================================

// Constituency keywords mapping (shared)
const CONSTITUENCY_KEYWORDS = {
  // Kolkata Metro
  'wb_kolkata_bhowanipore': ['Bhowanipore', 'Mamata Banerjee', 'Kolkata South'],
  'wb_kolkata_beleghata': ['Beleghata', 'Kolkata East'],
  'wb_kolkata_entally': ['Entally', 'Central Kolkata'],
  'wb_kolkata_ballygunge': ['Ballygunge', 'South Kolkata'],
  'wb_kolkata_chowringhee': ['Chowringhee', 'Park Street Kolkata'],
  'wb_kolkata_rashbehari': ['Rashbehari', 'South Kolkata'],
  'wb_kolkata_tollygunge': ['Tollygunge', 'Tolly Kolkata'],
  'wb_kolkata_jadavpur': ['Jadavpur', 'Jadavpur University'],
  'wb_kolkata_kasba': ['Kasba', 'East Kolkata'],
  'wb_kolkata_behala_west': ['Behala', 'West Behala'],
  // Howrah
  'wb_howrah_howrah_uttar': ['Howrah North', 'Howrah politics'],
  'wb_howrah_howrah_madhya': ['Howrah Central', 'Howrah'],
  'wb_howrah_shibpur': ['Shibpur', 'Howrah Shibpur'],
  'wb_howrah_bally': ['Bally', 'Howrah Bally'],
  'wb_howrah_uttarpara': ['Uttarpara', 'Hooghly Uttarpara'],
  // North 24 Parganas
  'wb_north_24_parganas_barrackpore': ['Barrackpore', 'Arjun Singh'],
  'wb_north_24_parganas_dum_dum': ['Dum Dum', 'North Kolkata'],
  'wb_north_24_parganas_rajarhat_new_town': ['Rajarhat', 'New Town Kolkata'],
  'wb_north_24_parganas_bidhannagar': ['Bidhannagar', 'Salt Lake'],
  'wb_north_24_parganas_madhyamgram': ['Madhyamgram', 'North 24 Parganas'],
  'wb_north_24_parganas_barasat': ['Barasat', 'North 24 Parganas'],
  // South 24 Parganas
  'wb_south_24_parganas_jadavpur': ['Jadavpur South', 'South Kolkata'],
  'wb_south_24_parganas_sonarpur_uttar': ['Sonarpur', 'South 24 Parganas'],
  'wb_south_24_parganas_budge_budge': ['Budge Budge', 'South 24 Parganas'],
  'wb_south_24_parganas_diamond_harbour': ['Diamond Harbour', 'Abhishek Banerjee'],
  // North Bengal
  'wb_darjeeling_darjeeling': ['Darjeeling', 'GTA', 'Gorkhaland'],
  'wb_darjeeling_siliguri': ['Siliguri', 'North Bengal'],
  'wb_jalpaiguri_jalpaiguri': ['Jalpaiguri', 'North Bengal'],
  'wb_cooch_behar_cooch_behar_uttar': ['Cooch Behar', 'North Bengal'],
  // Malda / Murshidabad
  'wb_malda_english_bazar': ['Malda', 'English Bazar'],
  'wb_murshidabad_berhampore': ['Berhampore', 'Murshidabad'],
  // Nadia
  'wb_nadia_krishnanagar_uttar': ['Krishnanagar', 'Nadia'],
  'wb_nadia_ranaghat_uttar_paschim': ['Ranaghat', 'Nadia'],
  // Hooghly
  'wb_hooghly_serampore': ['Serampore', 'Hooghly'],
  'wb_hooghly_chandannagar': ['Chandannagar', 'Hooghly'],
  'wb_hooghly_chinsurah': ['Chinsurah', 'Hooghly'],
  'wb_hooghly_arambag': ['Arambag', 'Hooghly'],
  // Bardhaman
  'wb_purba_bardhaman_asansol_uttar': ['Asansol', 'Asansol North'],
  'wb_purba_bardhaman_asansol_dakshin': ['Asansol South', 'Bardhaman'],
  'wb_purba_bardhaman_durgapur_purba': ['Durgapur', 'East Durgapur'],
  'wb_purba_bardhaman_durgapur_paschim': ['Durgapur West', 'Bardhaman'],
  'wb_purba_bardhaman_bardhaman_uttar': ['Bardhaman', 'Burdwan'],
  'wb_paschim_bardhaman_pandaveswar': ['Pandaveswar', 'West Bardhaman'],
  // Medinipur
  'wb_purba_medinipur_tamluk': ['Tamluk', 'Purba Medinipur'],
  'wb_purba_medinipur_haldia': ['Haldia', 'Purba Medinipur'],
  'wb_paschim_medinipur_midnapore': ['Midnapore', 'Paschim Medinipur'],
  // Others
  'wb_bankura_bankura': ['Bankura', 'Bankura politics'],
  'wb_purulia_purulia': ['Purulia', 'Purulia politics'],
  'wb_birbhum_bolpur': ['Bolpur', 'Shantiniketan'],
  'wb_birbhum_suri': ['Suri', 'Birbhum']
};

// Constituency name mapping
const CONSTITUENCY_NAMES = {
  'wb_kolkata_bhowanipore': 'Bhowanipore',
  'wb_kolkata_beleghata': 'Beleghata',
  'wb_kolkata_entally': 'Entally',
  'wb_kolkata_ballygunge': 'Ballygunge',
  'wb_kolkata_chowringhee': 'Chowringhee',
  'wb_kolkata_rashbehari': 'Rashbehari',
  'wb_kolkata_tollygunge': 'Tollygunge',
  'wb_kolkata_jadavpur': 'Jadavpur',
  'wb_kolkata_kasba': 'Kasba',
  'wb_kolkata_behala_west': 'Behala West',
  'wb_howrah_howrah_uttar': 'Howrah Uttar',
  'wb_howrah_howrah_madhya': 'Howrah Madhya',
  'wb_howrah_shibpur': 'Shibpur',
  'wb_howrah_bally': 'Bally',
  'wb_howrah_uttarpara': 'Uttarpara',
  'wb_north_24_parganas_barrackpore': 'Barrackpore',
  'wb_north_24_parganas_dum_dum': 'Dum Dum',
  'wb_north_24_parganas_rajarhat_new_town': 'Rajarhat New Town',
  'wb_north_24_parganas_bidhannagar': 'Bidhannagar',
  'wb_north_24_parganas_madhyamgram': 'Madhyamgram',
  'wb_north_24_parganas_barasat': 'Barasat',
  'wb_south_24_parganas_jadavpur': 'Jadavpur (South)',
  'wb_south_24_parganas_sonarpur_uttar': 'Sonarpur Uttar',
  'wb_south_24_parganas_budge_budge': 'Budge Budge',
  'wb_south_24_parganas_diamond_harbour': 'Diamond Harbour',
  'wb_darjeeling_darjeeling': 'Darjeeling',
  'wb_darjeeling_siliguri': 'Siliguri',
  'wb_jalpaiguri_jalpaiguri': 'Jalpaiguri',
  'wb_cooch_behar_cooch_behar_uttar': 'Cooch Behar Uttar',
  'wb_malda_english_bazar': 'English Bazar',
  'wb_murshidabad_berhampore': 'Berhampore',
  'wb_nadia_krishnanagar_uttar': 'Krishnanagar Uttar',
  'wb_nadia_ranaghat_uttar_paschim': 'Ranaghat',
  'wb_hooghly_serampore': 'Serampore',
  'wb_hooghly_chandannagar': 'Chandannagar',
  'wb_hooghly_chinsurah': 'Chinsurah',
  'wb_hooghly_arambag': 'Arambag',
  'wb_purba_bardhaman_asansol_uttar': 'Asansol Uttar',
  'wb_purba_bardhaman_asansol_dakshin': 'Asansol Dakshin',
  'wb_purba_bardhaman_durgapur_purba': 'Durgapur Purba',
  'wb_purba_bardhaman_durgapur_paschim': 'Durgapur Paschim',
  'wb_purba_bardhaman_bardhaman_uttar': 'Bardhaman Uttar',
  'wb_paschim_bardhaman_pandaveswar': 'Pandaveswar',
  'wb_purba_medinipur_tamluk': 'Tamluk',
  'wb_purba_medinipur_haldia': 'Haldia',
  'wb_paschim_medinipur_midnapore': 'Midnapore',
  'wb_bankura_bankura': 'Bankura',
  'wb_purulia_purulia': 'Purulia',
  'wb_birbhum_bolpur': 'Bolpur',
  'wb_birbhum_suri': 'Suri'
};

// Simple sentiment analysis based on keywords
function analyzeSentiment(text) {
  const lowerText = text.toLowerCase();
  const positiveWords = ['win', 'victory', 'success', 'rally', 'support', 'growth', 'development', 'inaugurat', 'launch', 'welfare', 'scheme', 'benefit'];
  const negativeWords = ['attack', 'scam', 'corrupt', 'protest', 'violence', 'arrest', 'accus', 'fail', 'crisis', 'contro', 'scandal', 'allegation'];

  let positiveCount = 0;
  let negativeCount = 0;

  positiveWords.forEach(word => {
    if (lowerText.includes(word)) positiveCount++;
  });
  negativeWords.forEach(word => {
    if (lowerText.includes(word)) negativeCount++;
  });

  if (positiveCount > negativeCount) return { score: 0.5, label: 'positive' };
  if (negativeCount > positiveCount) return { score: -0.5, label: 'negative' };
  return { score: 0, label: 'neutral' };
}

// Cache for news data (5 minute TTL)
let newsCache = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Fetch news for all constituencies (for heatmap)
app.get('/api/news/all-constituencies', async (req, res) => {
  try {
    const now = Date.now();

    // Check cache
    if (newsCache.data && (now - newsCache.timestamp) < CACHE_TTL) {
      console.log('[All Constituencies News] Returning cached data');
      return res.json({
        success: true,
        data: newsCache.data,
        fromCache: true,
        fetchedAt: new Date(newsCache.timestamp).toISOString()
      });
    }

    console.log('[All Constituencies News] Fetching fresh data for', Object.keys(CONSTITUENCY_KEYWORDS).length, 'constituencies');

    // Fetch news for all constituencies in parallel (batch of 10 at a time to avoid rate limiting)
    const constituencyIds = Object.keys(CONSTITUENCY_KEYWORDS);
    const results = [];

    // Process in batches
    const batchSize = 10;
    for (let i = 0; i < constituencyIds.length; i += batchSize) {
      const batch = constituencyIds.slice(i, i + batchSize);

      const batchPromises = batch.map(async (constituencyId) => {
        try {
          const keywords = CONSTITUENCY_KEYWORDS[constituencyId];
          const searchKeyword = keywords[0];
          const searchQuery = encodeURIComponent(`${searchKeyword} West Bengal`);
          const rssUrl = `https://news.google.com/rss/search?q=${searchQuery}&hl=en-IN&gl=IN&ceid=IN:en`;

          const response = await fetch(rssUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });

          if (!response.ok) {
            return {
              constituency_id: constituencyId,
              constituency_name: CONSTITUENCY_NAMES[constituencyId] || constituencyId,
              news_count: 0,
              sentiment_score: 0,
              sentiment_label: 'neutral',
              top_headlines: []
            };
          }

          const xmlText = await response.text();
          const result = await parseStringPromise(xmlText, { explicitArray: false });
          const channel = result.rss?.channel;

          let items = channel?.item || [];
          if (!Array.isArray(items)) items = [items];

          // Get top 3 headlines
          const headlines = items.slice(0, 3).map(item => {
            const titleParts = (item.title || '').split(' - ');
            if (titleParts.length > 1) titleParts.pop(); // Remove source
            return titleParts.join(' - ').substring(0, 80);
          });

          // Calculate sentiment from headlines
          const allText = headlines.join(' ');
          const sentiment = analyzeSentiment(allText);

          return {
            constituency_id: constituencyId,
            constituency_name: CONSTITUENCY_NAMES[constituencyId] || constituencyId,
            news_count: items.length,
            sentiment_score: sentiment.score,
            sentiment_label: sentiment.label,
            top_headlines: headlines
          };

        } catch (err) {
          console.error(`[All Constituencies News] Error for ${constituencyId}:`, err.message);
          return {
            constituency_id: constituencyId,
            constituency_name: CONSTITUENCY_NAMES[constituencyId] || constituencyId,
            news_count: 0,
            sentiment_score: 0,
            sentiment_label: 'neutral',
            top_headlines: []
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Small delay between batches to avoid rate limiting
      if (i + batchSize < constituencyIds.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Cache the results
    newsCache = {
      data: results,
      timestamp: now
    };

    console.log('[All Constituencies News] Fetched', results.length, 'constituencies');

    res.json({
      success: true,
      data: results,
      fromCache: false,
      fetchedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('[All Constituencies News] Error:', error.message);
    res.json({
      success: false,
      error: error.message,
      data: [],
      fetchedAt: new Date().toISOString()
    });
  }
});

// Get replies/comments for a specific tweet
app.get('/api/twitter/replies/:tweet_id', async (req, res) => {
  try {
    const { tweet_id } = req.params;
    const { max_results = 20 } = req.query;

    if (!tweet_id) {
      return res.status(400).json({ error: 'Tweet ID parameter required' });
    }

    console.log(`[Replies] Fetching replies for tweet: ${tweet_id}`);

    // Search for tweets that are replies to this conversation
    const query = `conversation_id:${tweet_id}`;

    const data = await twitterRequest('/tweets/search/recent', {
      query: query,
      max_results: Math.min(parseInt(max_results), 100),
      'tweet.fields': 'created_at,public_metrics,author_id,entities,in_reply_to_user_id,conversation_id',
      'user.fields': 'name,username,profile_image_url,verified',
      'expansions': 'author_id,in_reply_to_user_id'
    });

    res.json({
      success: true,
      data: data.data || [],
      includes: data.includes || {},
      meta: data.meta || {},
      tweetId: tweet_id
    });
  } catch (error) {
    console.error('[Replies] Error:', error.message);
    res.json({
      success: false,
      error: error.message,
      rateLimited: error.message.includes('429'),
      data: [],
      tweetId: req.params.tweet_id
    });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  console.log(`\n========================================`);
  console.log(`Twitter & News Proxy Server - Port ${PORT}`);
  console.log(`========================================`);
  console.log(`Health: ${baseUrl}/health`);
  console.log(`----------------------------------------`);
  console.log(`TWITTER ENDPOINTS:`);
  console.log(`  BJP Bengal: ${baseUrl}/api/twitter/bjp-bengal`);
  console.log(`  Search: ${baseUrl}/api/twitter/search?query=BJP`);
  console.log(`----------------------------------------`);
  console.log(`NEWS ENDPOINTS (Google News RSS):`);
  console.log(`  RSS Proxy: ${baseUrl}/api/rss-proxy?keyword=Kolkata`);
  console.log(`  Constituency: ${baseUrl}/api/news/constituency/wb_kolkata_bhowanipore`);
  console.log(`========================================`);
  console.log(`Bearer Token: ${TWITTER_BEARER_TOKEN ? 'Configured' : 'NOT CONFIGURED!'}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`========================================\n`);
});
