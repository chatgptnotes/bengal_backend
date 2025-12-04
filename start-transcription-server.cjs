/**
 * Standalone Transcription Server
 * Runs on port 3002 with WebSocket support
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { setupSocketIO, initOpenAI } = require('./transcription-service.cjs');

// Use PORT (Render's default) or TRANSCRIPTION_PORT or fallback to 3002
const PORT = process.env.PORT || process.env.TRANSCRIPTION_PORT || 3002;

// Create Express app
const app = express();

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

// Create HTTP server
const server = http.createServer(app);

// Setup Socket.IO
const io = setupSocketIO(server);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'transcription' });
});

// Initialize OpenAI from environment
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

// Start server
server.listen(PORT, '0.0.0.0', () => {
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const wsUrl = baseUrl.replace('http', 'ws');
  console.log(`\n========================================`);
  console.log(`Transcription Server - Port ${PORT}`);
  console.log(`========================================`);
  console.log(`Health: ${baseUrl}/health`);
  console.log(`WebSocket: ${wsUrl}/transcription`);
  console.log(`========================================`);

  // Auto-initialize if env key exists
  if (process.env.OPENAI_API_KEY) {
    initOpenAI(process.env.OPENAI_API_KEY);
    console.log(`OpenAI: Initialized from environment`);
  } else {
    console.log(`OpenAI: NOT CONFIGURED - Set OPENAI_API_KEY`);
  }
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`========================================\n`);
});
