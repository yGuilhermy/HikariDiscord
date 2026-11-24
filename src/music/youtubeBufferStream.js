const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const config = require('../config');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * 2;

class YouTubeBufferStream extends Readable {
    constructor(url, { signal, minBufferSec = 4, maxBufferSec = 8 } = {}) {
        const minBytes = BYTES_PER_SECOND * minBufferSec;
        super({ highWaterMark: Math.max(minBytes, BYTES_PER_SECOND * maxBufferSec), signal });

        this.ready = new Promise((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
        this.ready.catch(() => {});
        this.on('error', () => {});

        const cookies = config.ytdlpCookiesPath;
        const cookieFlags = cookies && fs.existsSync(cookies) ? ['--cookies', cookies] : [];
        this.downloader = spawn('yt-dlp', [
            ...cookieFlags, ...(config.ytdlpExtraFlags || []),
            '--no-playlist', '--no-update', '-f', 'bestaudio/best', '-o', '-', '--', url
        ], { stdio: ['ignore', 'pipe', 'ignore'] });
        this.decoder = spawn('ffmpeg', [
            '-nostdin', '-i', 'pipe:0', '-f', 's16le',
            '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), 'pipe:1'
        ], { stdio: ['pipe', 'pipe', 'ignore'] });

        this.downloader.stdout.pipe(this.decoder.stdin);
        this.decoder.stdin.on('error', error => {
            if (error.code !== 'EPIPE') this.destroy(error);
        });
        let buffered = 0;
        this.decoder.stdout.on('data', chunk => {
            buffered += chunk.length;
            if (!this.push(chunk)) this.decoder.stdout.pause();
            if (buffered >= minBytes) this.resolveReady();
        });

        let closed = 0;
        for (const [process, name] of [[this.downloader, 'yt-dlp'], [this.decoder, 'FFmpeg']]) {
            process.on('error', error => this.destroy(error));
            process.on('close', code => {
                if (this.destroyed) return;
                if (code !== 0) {
                    this.destroy(new Error(name + ' encerrou com código ' + code));
                } else if (++closed === 2) {
                    if (buffered === 0) return this.destroy(new Error('O stream do YouTube não contém áudio.'));
                    this.resolveReady();
                    this.push(null);
                }
            });
        }
    }

    _read() {
        this.decoder?.stdout.resume();
    }

    _destroy(error, callback) {
        this.rejectReady?.(error || new Error('Stream encerrado.'));
        for (const process of [this.downloader, this.decoder]) {
            if (process && process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
        }
        callback(error);
    }

    async waitUntilReady(timeoutMs = 25000) {
        let timer;
        try {
            await Promise.race([this.ready, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new DOMException('Tempo limite do stream do YouTube.', 'TimeoutError')), timeoutMs);
                timer.unref();
            })]);
        } finally {
            clearTimeout(timer);
        }
    }
}

function createYouTubeProgressiveStream(url, options) {
    return new YouTubeBufferStream(url, options);
}

module.exports = { YouTubeBufferStream, createYouTubeProgressiveStream };
