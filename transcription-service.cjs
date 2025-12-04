/**
 * Real-Time YouTube Live Transcription Service
 * Uses yt-dlp + OpenAI Whisper + Translation
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { Server } = require('socket.io');
// OpenAI GPT used for translation instead of rate-limited Google Translate

// Configuration
const AUDIO_CHUNK_DURATION = 30; // seconds
const TEMP_DIR = path.join(__dirname, 'temp_audio');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// OpenAI client
let openai = null;

// Active transcription processes
const activeTranscriptions = new Map();

/**
 * Initialize OpenAI client
 */
function initOpenAI(apiKey) {
  openai = new OpenAI({ apiKey });
}

/**
 * Get YouTube live stream URL using yt-dlp
 * Supports both channel IDs (UC...) and handles (@channelname)
 */
async function getYouTubeLiveStreamUrl(channelId) {
  return new Promise((resolve, reject) => {
    // Support both channel ID and handle format
    let url;
    if (channelId.startsWith('@')) {
      url = `https://www.youtube.com/${channelId}/live`;
    } else if (channelId.startsWith('UC')) {
      url = `https://www.youtube.com/channel/${channelId}/live`;
    } else {
      // Assume it's a handle without @
      url = `https://www.youtube.com/@${channelId}/live`;
    }

    const ytdlp = spawn('yt-dlp', [
      '-f', 'worst[ext=mp4]',  // Use lowest quality with audio for live streams
      '-g',
      url
    ]);

    let stdout = '';
    let stderr = '';

    ytdlp.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ytdlp.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ytdlp.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Failed to get stream URL: ${stderr}`));
      }
    });
  });
}

/**
 * Capture audio chunk from live stream
 */
async function captureAudioChunk(streamUrl, outputPath, duration = AUDIO_CHUNK_DURATION) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', streamUrl,
      '-t', duration.toString(),
      '-acodec', 'libmp3lame',
      '-ar', '16000',
      '-ac', '1',
      '-y',
      outputPath
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        reject(new Error(`FFmpeg failed: ${stderr}`));
      }
    });

    // Timeout after duration + 10 seconds
    setTimeout(() => {
      ffmpeg.kill();
      reject(new Error('Audio capture timeout'));
    }, (duration + 10) * 1000);
  });
}

/**
 * Transcribe audio using OpenAI Whisper
 */
async function transcribeAudio(audioPath) {
  if (!openai) {
    throw new Error('OpenAI not initialized');
  }

  const audioFile = fs.createReadStream(audioPath);

  const transcription = await openai.audio.transcriptions.create({
    file: audioFile,
    model: 'whisper-1',
    // Auto-detect language (Bengali 'bn' not supported as hint)
    response_format: 'text'
  });

  return transcription;
}

/**
 * Translate text to Hindi and English using OpenAI GPT
 */
async function translateText(bengaliText) {
  if (!openai) {
    return {
      bengali: bengaliText,
      hindi: bengaliText,
      english: bengaliText
    };
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a translator. Translate the given text to both Hindi and English. Return JSON format only: {"hindi": "translated hindi text", "english": "translated english text"}'
        },
        {
          role: 'user',
          content: bengaliText
        }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 500
    });

    const result = JSON.parse(response.choices[0].message.content);
    return {
      bengali: bengaliText,
      hindi: result.hindi || bengaliText,
      english: result.english || bengaliText
    };
  } catch (error) {
    console.error('Translation error:', error.message);
    return {
      bengali: bengaliText,
      hindi: bengaliText,
      english: bengaliText
    };
  }
}

/**
 * Detect BJP/TMC mentions and sentiment
 */
function analyzeContent(text) {
  const lowerText = text.toLowerCase();

  // Extended BJP keywords
  const bjpKeywords = [
    'bjp', 'bharatiya janata', 'modi', 'narendra modi', 'pm modi',
    'amit shah', 'sukanta', 'suvendu', 'adhikari', 'dilip ghosh',
    'jp nadda', 'yogi', 'shah', 'saffron', 'lotus', 'kamal',
    'বিজেপি', 'মোদি', 'অমিত শাহ', 'সুকান্ত', 'শুভেন্দু', 'দিলীপ ঘোষ',
    'भाजपा', 'मोदी', 'अमित शाह', 'बीजेपी'
  ];

  // Extended TMC keywords
  const tmcKeywords = [
    'tmc', 'trinamool', 'mamata', 'banerjee', 'didi', 'abhishek',
    'tmc', 'all india trinamool', 'grassroots', 'firhad hakim',
    'partha chatterjee', 'anubrata', 'mondal', 'kunal ghosh',
    'তৃণমূল', 'মমতা', 'দিদি', 'অভিষেক', 'বন্দ্যোপাধ্যায়',
    'तृणमूल', 'ममता', 'दीदी', 'टीएमसी'
  ];

  const positiveWords = ['success', 'win', 'victory', 'growth', 'development', 'সাফল্য', 'উন্নয়ন', 'जीत', 'विकास'];
  const negativeWords = ['fail', 'loss', 'defeat', 'crisis', 'scandal', 'ব্যর্থ', 'সংকট', 'हार', 'संकट'];

  const bjpMention = bjpKeywords.some(k => lowerText.includes(k));
  const tmcMention = tmcKeywords.some(k => lowerText.includes(k));

  let sentiment = 'neutral';
  const positiveCount = positiveWords.filter(w => lowerText.includes(w)).length;
  const negativeCount = negativeWords.filter(w => lowerText.includes(w)).length;

  if (positiveCount > negativeCount) sentiment = 'positive';
  else if (negativeCount > positiveCount) sentiment = 'negative';

  return { bjpMention, tmcMention, sentiment };
}

/**
 * Start continuous transcription for a channel
 */
async function startTranscription(channelId, io, filterPolitical = false) {
  if (activeTranscriptions.has(channelId)) {
    console.log(`Transcription already running for ${channelId}`);
    return;
  }

  console.log(`Starting transcription for channel: ${channelId} (filter: ${filterPolitical ? 'political only' : 'all content'})`);

  const transcriptionState = {
    running: true,
    streamUrl: null,
    filterPolitical: filterPolitical
  };
  activeTranscriptions.set(channelId, transcriptionState);

  try {
    // Get live stream URL
    transcriptionState.streamUrl = await getYouTubeLiveStreamUrl(channelId);
    console.log(`Got stream URL for ${channelId}`);

    // Continuous transcription loop
    let chunkIndex = 0;
    while (transcriptionState.running) {
      try {
        const audioPath = path.join(TEMP_DIR, `${channelId}_${chunkIndex}.mp3`);

        // Capture audio chunk
        await captureAudioChunk(transcriptionState.streamUrl, audioPath);

        // Transcribe
        const bengaliText = await transcribeAudio(audioPath);

        if (bengaliText && bengaliText.trim()) {
          // Translate
          const translations = await translateText(bengaliText.trim());

          // Analyze
          const analysis = analyzeContent(bengaliText);

          // Create transcript line
          const transcriptLine = {
            id: `${channelId}-${Date.now()}`,
            timestamp: new Date().toLocaleTimeString('en-IN', { hour12: false }),
            ...translations,
            ...analysis
          };

          // Broadcast based on filter setting
          const isPolitical = analysis.bjpMention || analysis.tmcMention;

          if (transcriptionState.filterPolitical) {
            // Only broadcast political content (BJP/TMC mentions)
            if (isPolitical) {
              io.emit('transcript', transcriptLine);
              console.log(`[POLITICAL] ${analysis.bjpMention ? 'BJP' : ''}${analysis.tmcMention ? ' TMC' : ''}: ${transcriptLine.english.substring(0, 50)}...`);
            } else {
              console.log(`[SKIPPED] Non-political: ${transcriptLine.english.substring(0, 30)}...`);
            }
          } else {
            // Broadcast all content
            io.emit('transcript', transcriptLine);
            const tag = isPolitical ? '[POLITICAL]' : '[ALL]';
            console.log(`${tag} ${transcriptLine.english.substring(0, 50)}...`);
          }
        }

        // Cleanup audio file
        if (fs.existsSync(audioPath)) {
          fs.unlinkSync(audioPath);
        }

        chunkIndex++;
      } catch (error) {
        console.error(`Chunk ${chunkIndex} error:`, error.message);

        // Try to refresh stream URL on error
        try {
          transcriptionState.streamUrl = await getYouTubeLiveStreamUrl(channelId);
        } catch (e) {
          console.error('Failed to refresh stream URL:', e.message);
        }
      }

      // Small delay between chunks
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (error) {
    console.error(`Transcription error for ${channelId}:`, error);
    io.emit('transcription_error', { channelId, error: error.message });
  } finally {
    activeTranscriptions.delete(channelId);
  }
}

/**
 * Stop transcription for a channel
 */
function stopTranscription(channelId) {
  const state = activeTranscriptions.get(channelId);
  if (state) {
    state.running = false;
    activeTranscriptions.delete(channelId);
    console.log(`Stopped transcription for ${channelId}`);
  }
}

/**
 * Setup Socket.IO server
 */
function setupSocketIO(server) {
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    },
    path: '/transcription'
  });

  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('start_transcription', async (data) => {
      const { channelId, openaiKey, filterPolitical = false } = data;

      if (openaiKey && !openai) {
        initOpenAI(openaiKey);
      }

      if (!openai) {
        socket.emit('error', { message: 'OpenAI API key required' });
        return;
      }

      startTranscription(channelId, io, filterPolitical);
    });

    socket.on('stop_transcription', (data) => {
      const { channelId } = data;
      stopTranscription(channelId);
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
    });
  });

  return io;
}

module.exports = {
  initOpenAI,
  setupSocketIO,
  startTranscription,
  stopTranscription,
  getYouTubeLiveStreamUrl,
  transcribeAudio,
  translateText
};
