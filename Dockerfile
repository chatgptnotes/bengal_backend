# BJP Bengal Backend - Proxy + Transcription Server
FROM node:20-slim

# Install ffmpeg and yt-dlp dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy server files
COPY . .

# Create temp directory for audio processing
RUN mkdir -p temp_audio

# Expose ports (Render will use PORT env var)
EXPOSE 10000

# Start both servers
CMD ["node", "start-server.cjs"]
