const axios = require('axios');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { searchDeezerTracks, calculateConfidenceScore } = require('../services/deezerMusicService');
const { randomUUID } = require('node:crypto');
const config = require('../config');

const { TEMP_RADIO_DIR } = require('./radioCleaner');

function extractUrl(str) {
    if (!str) return '';
    const match = str.match(/(https?:\/\/[^\s]+)/i);
    return match ? match[1] : str.trim();
}

function isValidHttpUrl(string) {
    if (!string || typeof string !== 'string') return false;
    try {
        const parsed = new URL(string);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

function onDomain(host, domain) {
    return host === domain || host.endsWith('.' + domain);
}

function isYouTubeUrl(url) {
    const id = /^[a-zA-Z0-9_-]{11}$/;
    if (url.hostname === 'youtu.be') return id.test(url.pathname.split('/')[1] || '');
    if (!onDomain(url.hostname, 'youtube.com')) return false;
    if (url.pathname === '/playlist') return /^[\w-]+$/.test(url.searchParams.get('list') || '');
    if (url.pathname === '/watch') return id.test(url.searchParams.get('v') || '');
    const [, kind, segment] = url.pathname.split('/');
    return ['shorts', 'embed', 'live'].includes(kind) && id.test(segment || '');
}

function deezerRoute(url) {
    if (!onDomain(url.hostname, 'deezer.com')) return null;
    return url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(track|album|playlist)\/(\d+)\/?$/i);
}

async function resolveDeezer(route) {
    const [, type, id] = route;
    const { data } = await axios.get('https://api.deezer.com/' + type + '/' + id, { timeout: 5000 });
    if (!data || data.error) return null;
    const mapTrack = track => ({
        id: String(track.id),
        title: track.title,
        artist: track.artist?.name || data.artist?.name || 'Desconhecido',
        album: track.album?.title || (type === 'album' ? data.title : ''),
        duration: track.duration,
        cover: track.album?.cover_medium || (type === 'album' ? data.cover_medium : ''),
        link: track.link,
        source: 'deezer'
    });
    if (type === 'track') return data.id ? { type: 'track', track: mapTrack(data) } : null;
    const tracks = (data.tracks?.data || []).filter(track => track.id).slice(0, 100).map(mapTrack);
    return tracks.length ? { type: 'playlist', tracks } : null;
}

async function resolveYouTubeTrack(url) {
    const cleanUrl = extractUrl(url);
    if (!isValidHttpUrl(cleanUrl)) {
        return null;
    }
    const videoIdMatch = cleanUrl.match(/(?:v=|\/|embed\/|shorts\/)([0-9A-Za-z_-]{11})/);
    const videoId = videoIdMatch ? videoIdMatch[1] : null;

    let oembedData = null;
    if (videoId) {
        try {
            const res = await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, { timeout: 4000 });
            if (res.data && res.data.title) {
                oembedData = res.data;
            }
        } catch (_) {}
    }

    if (oembedData) {
        return { id: videoId, title: oembedData.title, artist: oembedData.author_name || 'YouTube',
            cover: oembedData.thumbnail_url, link: cleanUrl, source: 'youtube' };
    }

    return new Promise((resolve, reject) => {
        const cookies = config.ytdlpCookiesPath;
        const args = [
            ...(cookies && fs.existsSync(cookies) ? ['--cookies', cookies] : []),
            ...(config.ytdlpExtraFlags || []), '--no-warnings', '--no-update',
            '--no-playlist', '-j', '--', cleanUrl
        ];
        const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill('SIGKILL');
        }, 15000);

        proc.stdout.on('data', chunk => { output += chunk; });
        proc.once('close', code => {
            clearTimeout(timer);
            if (timedOut) return reject(new DOMException('Metadados do YouTube excederam o prazo.', 'TimeoutError'));
            if (code !== 0 || !output.trim()) return reject(new Error('Metadados do YouTube indisponíveis.'));
            try {
                const data = JSON.parse(output.trim());
                if (!data.title || !data.id) return resolve(null);
                resolve({
                    id: data.id, title: data.title, artist: data.uploader || data.channel || 'YouTube',
                    duration: data.duration, cover: data.thumbnail, link: cleanUrl, source: 'youtube'
                });
            } catch (error) {
                reject(error);
            }
        });
        proc.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

function resolveYouTubePlaylist(url) {
    return new Promise((resolve) => {
        const cleanUrl = extractUrl(url);
        if (!isValidHttpUrl(cleanUrl)) {
            return resolve([]);
        }
        const config = require('../config');
        const cookiesPath = config.ytdlpCookiesPath;
        const args = ['--no-warnings', '--no-update'];
        if (cookiesPath && fs.existsSync(cookiesPath)) {
            args.push('--cookies', cookiesPath);
        }
        args.push('--flat-playlist', '--playlist-end', '100', '-j', '--', cleanUrl);

        const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'ignore'] });
        let stdout = '';
        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
        }, 35000);

        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.on('close', () => {
            clearTimeout(timer);
            if (!stdout) return resolve([]);
            const tracks = [];
            const lines = stdout.split('\n');

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const firstBrace = trimmed.indexOf('{');
                    const lastBrace = trimmed.lastIndexOf('}');
                    if (firstBrace === -1 || lastBrace <= firstBrace) continue;

                    const jsonStr = trimmed.substring(firstBrace, lastBrace + 1);
                    const parsed = JSON.parse(jsonStr);

                    if (parsed.entries && Array.isArray(parsed.entries)) {
                        for (const e of parsed.entries) {
                            if (e && e.id && !e.title?.includes('[Private') && !e.title?.includes('[Deleted')) {
                                tracks.push({
                                    id: e.id,
                                    title: e.title || 'Faixa YouTube',
                                    artist: e.uploader || e.channel || 'YouTube',
                                    album: '',
                                    duration: e.duration || 0,
                                    cover: e.thumbnails?.[0]?.url || `https://img.youtube.com/vi/${e.id}/hqdefault.jpg`,
                                    link: `https://www.youtube.com/watch?v=${e.id}`,
                                    source: 'youtube'
                                });
                            }
                        }
                    } else if (parsed.id && !parsed.title?.includes('[Private') && !parsed.title?.includes('[Deleted')) {
                        tracks.push({
                            id: parsed.id,
                            title: parsed.title || 'Faixa YouTube',
                            artist: parsed.uploader || parsed.channel || parsed.playlist_uploader || 'YouTube',
                            album: '',
                            duration: parsed.duration || 0,
                            cover: parsed.thumbnails?.[0]?.url || `https://img.youtube.com/vi/${parsed.id}/hqdefault.jpg`,
                            link: `https://www.youtube.com/watch?v=${parsed.id}`,
                            source: 'youtube'
                        });
                    }
                } catch (_) {}
            }

            resolve(tracks);
        });
        proc.on('error', () => {
            clearTimeout(timer);
            resolve([]);
        });
    });
}

function searchYouTubeTrack(query, signal) {
    return new Promise((resolve) => {
        if (!query || !query.trim()) return resolve(null);
        const config = require('../config');
        const cookiesPath = config.ytdlpCookiesPath;
        const args = [];
        if (cookiesPath && fs.existsSync(cookiesPath)) {
            args.push('--cookies', cookiesPath);
        }
        if (Array.isArray(config.ytdlpExtraFlags)) {
            args.push(...config.ytdlpExtraFlags);
        }
        args.push(
            '--default-search', 'ytsearch1',
            '--print', '%(id)s:::%(title)s:::%(uploader)s:::%(duration)s:::%(thumbnail)s',
            '--no-warnings',
            '--no-playlist',
            `ytsearch1:${query.trim()}`
        );

        const proc = spawn('yt-dlp', args, { signal, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'] });
        let stdout = '';
        const timer = setTimeout(() => proc.kill('SIGKILL'), 25000);

        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0 || !stdout) return resolve(null);
            const line = stdout.split('\n').map(l => l.trim()).find(l => l.includes(':::'));
            if (!line) return resolve(null);
            const parts = line.split(':::');
            if (parts.length < 2 || !parts[0]) return resolve(null);
            const id = parts[0].trim();
            const title = parts[1]?.trim() || 'Faixa YouTube';
            const artist = parts[2]?.trim() || 'YouTube';
            const duration = parseInt(parts[3], 10) || 0;
            const cover = parts[4]?.trim() || `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
            resolve({
                id,
                title,
                artist,
                album: '',
                duration,
                cover,
                link: `https://www.youtube.com/watch?v=${id}`,
                source: 'youtube'
            });
        });
        proc.on('error', () => {
            clearTimeout(timer);
            resolve(null);
        });
    });
}

async function searchByName(query) {
    let results;
    let providerError;
    try { results = await searchDeezerTracks(query, { throwOnError: true }); }
    catch (error) { providerError = error; }
    if (!results || results.length === 0) {
        const ytTrack = await searchYouTubeTrack(query);
        if (ytTrack) {
            return {
                track: ytTrack,
                ambiguous: false,
                results: []
            };
        }
        if (providerError) throw providerError;
        return { track: null, ambiguous: false, results: [] };
    }

    const top = results[0];
    const score = calculateConfidenceScore(query, top);

    if (score >= 80) {
        return {
            track: {
                id: String(top.id),
                title: top.title,
                artist: top.artist,
                album: top.album || '',
                duration: top.duration,
                cover: top.cover,
                link: top.link,
                source: 'deezer'
            },
            ambiguous: false,
            results: []
        };
    }

    return {
        track: null,
        ambiguous: true,
        results: results.map(r => ({
            id: String(r.id),
            title: r.title,
            artist: r.artist,
            album: r.album || '',
            duration: r.duration,
            cover: r.cover,
            link: r.link,
            source: 'deezer'
        }))
    };
}

function downloadProcess(command, args, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const grouped = process.platform !== 'win32';
        const child = spawn(command, args, { detached: grouped, stdio: ['ignore', 'ignore', 'ignore'] });
        function abort() {
            try {
                if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL');
                else child.kill('SIGKILL');
            } catch (error) {
                if (error.code !== 'ESRCH') child.kill('SIGKILL');
            }
        }
        signal.addEventListener('abort', abort, { once: true });
        child.once('error', reject);
        child.once('close', code => {
            signal.removeEventListener('abort', abort);
            if (signal.aborted) reject(signal.reason);
            else if (code !== 0) reject(new Error(command + ' encerrou com código ' + code));
            else resolve();
        });
    });
}

async function downloadTrackToDisk(track, { signal: callerSignal } = {}) {
    const deadline = AbortSignal.timeout(60000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
    signal.throwIfAborted();
    const directory = await fs.promises.mkdtemp(path.join(TEMP_RADIO_DIR, '.download-'));
    const downloadYouTube = link => {
        const cookies = config.ytdlpCookiesPath;
        return downloadProcess('yt-dlp', [
            ...(cookies && fs.existsSync(cookies) ? ['--cookies', cookies] : []),
            ...(config.ytdlpExtraFlags || []), '--no-playlist', '--no-update',
            '-f', 'bestaudio/best', '-o', path.join(directory, 'audio.%(ext)s'), '--', link
        ], signal);
    };

    const outputFile = async () => (await fs.promises.readdir(directory, { withFileTypes: true }))
        .find(file => file.isFile() && /\.(?:mp3|flac|m4a|webm|ogg|opus|mp4|aac|wav)$/i.test(file.name))?.name;
    async function fromDeezer(id) {
        if (!/^\d+$/.test(id)) return null;
        const python = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
        try {
            await downloadProcess(python, [
                path.join(__dirname, '../services/download_deezer.py'),
                'https://www.deezer.com/track/' + id, directory
            ], signal);
            return await outputFile();
        } catch (_) {
            signal.throwIfAborted();
            return null;
        }
    }

    try {
        let file;
        if (track.source === 'youtube') {
            try {
                await downloadYouTube(track.link);
                file = await outputFile();
            } catch (_) {
                signal.throwIfAborted();
            }
            if (!file && !track.preferDeezer) {
                const match = await convertYouTubeTrackToDeezer(track, signal);
                if (match.source === 'deezer') file = await fromDeezer(match.id);
            }
        } else if (track.source === 'deezer') {
            file = await fromDeezer(track.id);
            if (!file) {
                const fallback = track.youtubeFallback ||
                    (await searchYouTubeTrack([track.title, track.artist].filter(Boolean).join(' '), signal))?.link;
                if (!fallback) throw new Error('Nenhuma fonte de áudio disponível.');
                await downloadYouTube(fallback);
                file = await outputFile();
            }
        }
        signal.throwIfAborted();
        if (!file) throw new Error('O provedor não entregou um arquivo de áudio.');
        const destination = path.join(TEMP_RADIO_DIR, randomUUID() + path.extname(file));
        await fs.promises.rename(path.join(directory, file), destination);
        return destination;
    } finally {
        await fs.promises.rm(directory, { recursive: true, force: true });
    }
}

async function resolveSpotify(url) {
    const [, type, id] = url.pathname.match(/^\/(?:intl-[a-z]+\/|embed\/)?(track|album|playlist)\/([a-zA-Z0-9]+)\/?$/) || [];
    if (!id) return null;
    const { data } = await axios.get('https://open.spotify.com/embed/' + type + '/' + id, { timeout: 7000 });
    const script = data.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    const entity = script && JSON.parse(script[1])?.props?.pageProps?.state?.data?.entity;
    const artist = item => item.subtitle || item.artists?.map(value => value.name).join(', ') || '';
    const toTrack = item => ({
        title: item.title || item.name, artist: artist(item),
        duration: item.duration ? Math.round(item.duration / 1000) : 0,
        source: 'spotify'
    });
    if (type === 'track') {
        const track = entity && toTrack(entity);
        if (track?.title) {
            track.cover = entity.visualIdentity?.image?.[0]?.url;
            return { type: 'track', track };
        }
        const { data: preview } = await axios.get('https://open.spotify.com/oembed', {
            params: { url: url.href }, timeout: 5000
        });
        return preview?.title ? {
            type: 'track', track: { title: preview.title, cover: preview.thumbnail_url, source: 'spotify' }
        } : null;
    }
    const tracks = (entity?.trackList || []).slice(0, 100).map(toTrack).filter(track => track.title);
    return tracks.length ? { type: 'playlist', tracks } : null;
}

async function convertYouTubeTrackToDeezer(ytTrack, signal) {
    if (!ytTrack || !ytTrack.title || ytTrack.title === 'Vídeo do YouTube') return ytTrack;

    const rawTitle = ytTrack.title
        .replace(/\(official audio.*?\)/gi, '')
        .replace(/\[official audio.*?\]/gi, '')
        .replace(/\(official video.*?\)/gi, '')
        .replace(/\[official video.*?\]/gi, '')
        .replace(/\(lyric video.*?\)/gi, '')
        .replace(/\[lyric video.*?\]/gi, '')
        .replace(/\(clipe oficial.*?\)/gi, '')
        .replace(/\[clipe oficial.*?\]/gi, '')
        .replace(/\(vídeo oficial.*?\)/gi, '')
        .replace(/\[vídeo oficial.*?\]/gi, '')
        .replace(/\(audio.*?\)/gi, '')
        .replace(/\[audio.*?\]/gi, '')
        .trim();

    const artistStr = (ytTrack.artist && ytTrack.artist !== 'YouTube') ? ytTrack.artist : '';
    const query = `${rawTitle} ${artistStr}`.trim();

    try {
        let deezerRes = await searchDeezerTracks(query, { signal });
        signal?.throwIfAborted();
        if (query !== rawTitle && (!deezerRes || deezerRes.length === 0)) {
            deezerRes = await searchDeezerTracks(rawTitle, { signal });
        }

        if (deezerRes && deezerRes.length > 0) {
            for (const candidate of deezerRes) {
                const score = calculateConfidenceScore(query, candidate);
                const titleScore = calculateConfidenceScore(rawTitle, candidate);
                const bestScore = Math.max(score, titleScore);

                const durationDiff = (ytTrack.duration && candidate.duration) 
                    ? Math.abs(ytTrack.duration - candidate.duration) 
                    : 0;

                const isDurationOk = !ytTrack.duration || !candidate.duration || durationDiff <= 45;

                if (bestScore >= 50 && isDurationOk) {
                    return {
                        id: String(candidate.id),
                        title: candidate.title,
                        artist: candidate.artist,
                        album: candidate.album || '',
                        duration: candidate.duration,
                        cover: candidate.cover,
                        link: candidate.link,
                        source: 'deezer'
                    };
                }
            }
        }
    } catch (_) {}
    return ytTrack;
}

async function resolvePlaybackTrack(track, signal) {
    signal?.throwIfAborted();
    if (track.source === 'spotify' || track.preferDeezer) {
        const target = await convertYouTubeTrackToDeezer(track, signal);
        signal?.throwIfAborted();
        if (target.source === 'deezer') {
            return { ...target, youtubeFallback: track.source === 'youtube' ? track.link : undefined };
        }
        if (track.source === 'spotify') {
            const fallback = await searchYouTubeTrack([track.title, track.artist].filter(Boolean).join(' '), signal);
            signal?.throwIfAborted();
            if (!fallback) throw new Error('Nenhuma fonte compatível para a faixa do Spotify.');
            return fallback;
        }
    }
    return track;
}

async function resolveInput(input, guildId = null) {
    input = (input || '').trim();
    const cleanUrl = extractUrl(input);
    const { getSession } = require('./radioDatabase');
    const isFast = guildId && getSession(guildId)?.streamMode === 'FAST';

    try {
        if (isValidHttpUrl(cleanUrl)) {
            const url = new URL(cleanUrl);
            const deezer = deezerRoute(url);
            let result;
            if (deezer) {
                result = await resolveDeezer(deezer);
            } else if (url.hostname === 'open.spotify.com' || url.hostname === 'spoti.fi') {
                if (url.hostname === 'spoti.fi') {
                    const redirect = await axios.get(url.href, {
                        timeout: 5000, maxRedirects: 0, validateStatus: status => status >= 300 && status < 400
                    });
                    const target = new URL(redirect.headers.location);
                    if (target.protocol !== 'https:' || target.hostname !== 'open.spotify.com') return { type: 'not_found' };
                    result = await resolveSpotify(target);
                } else {
                    result = await resolveSpotify(url);
                }
            } else if (isYouTubeUrl(url)) {
                if (url.searchParams.has('list')) {
                    const tracks = await resolveYouTubePlaylist(cleanUrl);
                    if (tracks.length) {
                        return { type: 'playlist', tracks: tracks.map(track => ({ ...track, preferDeezer: !!isFast })) };
                    }
                    if (!url.searchParams.has('v')) return { type: 'not_found' };
                }
                const track = await resolveYouTubeTrack(cleanUrl);
                if (track) result = { type: 'track', track: { ...track, preferDeezer: !!isFast } };
            }
            return result || { type: 'not_found' };
        }

        const result = await searchByName(input);
        if (result.ambiguous) return { type: 'ambiguous', results: result.results.slice(0, 10) };
        if (result.track) return { type: 'track', track: result.track };
        return { type: 'not_found' };
    } catch (error) {
        if (error?.response?.status === 404) return { type: 'not_found' };
        return { type: 'unavailable' };
    }
}

module.exports = {
    resolveInput, resolvePlaybackTrack, downloadTrackToDisk, searchByName,
    searchYouTubeTrack, TEMP_RADIO_DIR
};
