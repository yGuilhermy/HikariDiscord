# 📻 Radio Mode System & Audio Streaming

Hikari's **Radio Mode** is a complete musical playback and interactive voice ecosystem for Discord channels, combining real-time progressive audio streaming, multi-platform support, and autonomous AI control.

---

## 📂 Table of Contents

1. [🎵 1. Playback & Progressive Streaming (YouTube & PCM)](#-1-playback--progressive-streaming-youtube--pcm)
2. [🌐 2. Link Support & Media Resolution](#-2-link-support--media-resolution)
3. [🎙️ 3. Voice Control & Speech Recognition (Whisper STT)](#-3-voice-control--speech-recognition-whisper-stt)
4. [🎛️ 4. Graphical Interface & Controls (Embeds & Buttons)](#-4-graphical-interface--controls-embeds--buttons)
5. [🧹 5. Smart Cleanup & Temporary File Management](#-5-smart-cleanup--temporary-file-management)
6. [💡 Tips & Troubleshooting](#-tips--troubleshooting)

---

## 🎵 1. Playback & Progressive Streaming (YouTube & PCM)

Radio Mode eliminates the need to download full YouTube files before starting playback.

- **Real-Time Streaming (`youtubeBufferStream.js`)**: Pipes `yt-dlp` output directly into `ffmpeg`, producing a continuous stream of linear PCM s16le audio (48,000 Hz, 16-bit stereo).
- **Initial buffer.** Playback starts after buffering 4 seconds of PCM (768,000 bytes), or the full track if it is shorter. Total startup time also depends on track resolution and the network.
- **Flow control.** The buffer holds about 8 seconds of audio. The producer slows down when the buffer is full.
- **Stream failures:** If YouTube audio has yet to start, the radio tries loading a file. On a playback failure, it can advance to the next track.

---

## 🌐 2. Link Support & Media Resolution

Media resolution (`radioProviders.js`) supports multiple formats with instant extraction:

- **YouTube & YouTube Music**:
  - Individual Videos (`youtube.com/watch?v=...`, `music.youtube.com/watch?v=...`).
  - Playlists (`youtube.com/playlist?list=...`, `music.youtube.com/playlist?list=...`): Extracted via NDJSON (Line-delimited JSON) adding all valid tracks to the queue.
  - Fast Metadata: Combines **YouTube oEmbed API** (~50ms) with `yt-dlp -j` parser to fetch title, channel/artist, and HD cover without failing on warning logs.
- **Spotify**:
  - Intelligent resolution of tracks (`open.spotify.com/track/...`), albums (`/album/...`), and playlists (`/playlist/...`).
  - Extracts metadata from Spotify and automatically matches/streams high-quality audio from **Deezer**.
- **Deezer**:
  - Songs (`deezer.com/.../track/ID`), Playlists (`deezer.com/.../playlist/ID`), and Albums (`deezer.com/.../album/ID`).
- **Text Search**:
  - Non-link text queries search Deezer API with phonetic confidence scoring. Scores `>= 80%` add the track directly; ambiguous queries present a Discord selection menu.

---

## 🎙️ 3. Voice Control & Speech Recognition (Whisper STT)

- **Real-Time Voice Commands**: Integrated listener captures speech from unmuted users in the channel and decodes PCM WAV audio for the Whisper API.
- **3-Mode Voice Selector**:
  1. `🔇 Voice: Off`: Voice listening completely disabled.
  2. `🧠 Voice: AI`: Transcribes audio and sends it to Hikari's generative AI (LLM) model with MCP Tool integration (`radioMCPTools.json`).
  3. `⚡ Voice: Direct`: Ultra-low latency Alexa-style mode. Recognizes intents and keywords locally without invoking AI models.
- **Direct Mode Algorithm (Keyword & Intent Engine)**:
  - **Instant Execution**: Responds in < 50ms post-STT transcription.
  - **Mid-sentence Intent Extraction**: Identifies keywords anywhere in spoken phrases (e.g. *"Hikari stop the music then dude"*).
  - **Supported Intents**: `Pause`, `Resume`, `Stop`, `Next`, `Previous`, `Shuffle`, `Loop`, `Show Queue`, `Song Info`, `Remove Track`, and `Search/Add Songs` (e.g. *"Hikari play Welcome to the Jungle"* or *"Hikari Welcome to the Jungle"*).
  - **Temporary Notification**: Sends a chat notification tagging the user (`<@userId> ⚡ **[Direct]** ...`) auto-deleted after 4 seconds.
- **Rate Limit Protection (429/492)**: Upon hitting Whisper API quota limits, voice listening is temporarily paused for **1 minute**, showing the pause in the panel and resuming in the selected mode afterward.
- **Empty Channel Monitoring**: Closes session and disconnects call if no human users are present in the channel for over 10 seconds.

---

## 🎛️ 4. Graphical Interface & Controls (Embeds & Buttons)

The visual Radio panel (`radioEmbed.js`) provides real-time interactive controls:

- **Available Controls**:
  - `➕ Add`: Interactive modal to paste links or search songs.
  - `🗑️ Remove`: Opens a paginated track selector.
  - `⏯️ Play/Pause`: Toggles playback and pause.
  - `⏹️ Stop`: Stops playback and keeps the tracks in the queue. Use Play to restart.
  - `⏭️ Next` / `⏮️ Prev`: Navigates between queue/history tracks.
  - `🔀 Shuffle`: Toggles random queue order.
  - `🔁 Loop`: Cycles modes (Off ➔ Track ➔ Playlist).
  - `⚡ Voice: Direct` / `🧠 Voice: AI` / `🔇 Voice: Off`: Cycles through all 3 voice modes (`OFF` ➔ `IA` ➔ `DIRECT` ➔ `OFF`). *(Disabled by default per server for token economy. If disabled, alerts the user to ask a Server Admin to enable `radio_voice_stt` via `/ia_ferramentas`).*
  - `📋 Queue`: Displays ephemeral menu with upcoming tracks.
  - `👋 Leave`: Stops radio mode and disconnects the bot.
- **Ambiguous Cancel**: The `Cancel` button on ambiguous search selections removes components and clears pending state.

---

## 🧹 5. Smart Cleanup & Temporary File Management

- **Cleanup Service (`radioCleaner.js`)**: Monitors `src/music/data/temp_radio_audio`.
- **Active Track Protection**: Checks all active sessions (`getAllSessions()`) and preserves currently playing files.
- **Auto Purge**: Deletes unreferenced temporary files older than 15 minutes. Runs on startup and every 10 minutes.
- **`.gitignore` Configuration**:
  ```gitignore
  src/music/data/temp_radio_audio/
  src/music/data/
  ```

---

## 💡 Tips & Troubleshooting

- 💡 **Smooth Transitions**: Changing tracks, stopping or leaving cancels earlier loads. A late completion cannot restart playback.
- 💡 **Message Deletion**: All temporary message deletions use `.catch(() => {})` handlers against `Unknown Message` exceptions.

---

> [!TIP]
> For advanced specifications on AI tools, visit the [Tools Documentation (MCP)](./ADVANCED.md).

---

[🏠 Back to Main Menu](./README.md)

### Search modes

**Hybrid**, the default search setting, keeps YouTube links as YouTube tracks. **Fast** tries to find a matching Deezer track for each item in a YouTube link. To combine conversation and playback in a voice channel, use the hybrid call mode.
