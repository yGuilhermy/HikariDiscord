const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { runMediaProcess, withDownloadSlot, MediaError } = require('./mediaProcess');
const activeDeezerJobs = new Set();
require('dotenv').config();

const TEMP_AUDIO_DIR = path.join(__dirname, '../data/temp_audio');
if (!fs.existsSync(TEMP_AUDIO_DIR)) {
    fs.mkdirSync(TEMP_AUDIO_DIR, { recursive: true });
}

function calculateConfidenceScore(query, track) {
    const cleanQuery = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const cleanTitle = (track.title || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const cleanArtist = (track.artist?.name || track.artist || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    
    let score = 0;
    const queryTokens = cleanQuery.split(/\s+/).filter(Boolean);
    const combinedText = `${cleanTitle} ${cleanArtist}`;
    
    let matchedTokens = 0;
    for (const token of queryTokens) {
        if (combinedText.includes(token)) {
            matchedTokens++;
        }
    }
    
    if (queryTokens.length > 0) {
        score = (matchedTokens / queryTokens.length) * 100;
    }
    return score;
}


async function searchDeezerTracks(query, { signal, throwOnError = false, limit = 5 } = {}) {
    try {
        const response = await axios.get('https://api.deezer.com/search', {
            params: { q: query, limit },
            timeout: 5000,
            signal
        });
        if (response.data?.error) {
            const limited = Number(response.data.error.code) === 4;
            throw new MediaError(limited ? 'DEEZER_LIMITED' : 'DEEZER_UNAVAILABLE', limited
                ? 'O Deezer atingiu o limite de requisições. Tente em instantes.'
                : 'A busca no Deezer está indisponível no momento.');
        }
        if (!Array.isArray(response.data?.data)) {
            throw new MediaError('DEEZER_UNAVAILABLE', 'A busca no Deezer está indisponível no momento.');
        }

        const tracks = new Map();
        for (const item of response.data.data) {
            if (!item || !/^\d+$/.test(String(item.id)) || typeof item.title !== 'string') continue;
            tracks.set(String(item.id), {
                id: item.id,
                title: item.title,
                artist: item.artist?.name || 'Desconhecido',
                album: item.album?.title || '',
                duration: item.duration,
                link: item.link,
                cover: item.album?.cover_medium || item.album?.cover || ''
            });
        }
        return [...tracks.values()].slice(0, limit);
    } catch (error) {
        signal?.throwIfAborted();
        const limited = error.response?.status === 429;
        const mapped = error instanceof MediaError ? error : new MediaError(
            limited ? 'DEEZER_LIMITED' : 'DEEZER_UNAVAILABLE',
            limited ? 'O Deezer atingiu o limite de requisições. Tente em instantes.'
                : 'A busca no Deezer está indisponível no momento.'
        );
        if (throwOnError) throw mapped;
        console.error('[DeezerService] Falha na busca:', mapped.code);
        return [];
    }
}

function parseTrackId(value) {
    const input = String(value ?? '').trim();
    if (/^\d{1,20}$/.test(input)) return input;

    try {
        const url = new URL(input);
        if (['http:', 'https:'].includes(url.protocol) && /^(?:www\.)?deezer\.com$/i.test(url.hostname) &&
            !url.username && !url.password && !url.port) {
            return url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?track\/(\d{1,20})\/?$/i)?.[1] || null;
        }
    } catch (_) {}
    return null;
}

async function locateOutput(jobFolder, stdout) {
    const candidate = stdout.match(/^DOWNLOADED_FILE:([^\r\n]+)$/m)?.[1];
    if (!candidate) throw new MediaError('DEEZER_NO_AUDIO', 'O Deezer não entregou um arquivo de áudio.');

    const resolved = path.resolve(jobFolder, candidate);
    const real = await fs.promises.realpath(resolved).catch(() => null);
    const jobRoot = await fs.promises.realpath(jobFolder);
    if (!real || !real.startsWith(jobRoot + path.sep)) {
        throw new MediaError('DEEZER_NO_AUDIO', 'O Deezer não entregou um arquivo de áudio válido.');
    }
    const stat = await fs.promises.stat(real);
    if (!stat.isFile() || stat.size === 0) {
        throw new MediaError('DEEZER_NO_AUDIO', 'O Deezer não entregou um arquivo de áudio válido.');
    }
    return { file: real, size: stat.size };
}

async function verifyAudio(file, jobFolder, signal) {
    let probe;
    try {
        probe = await runMediaProcess(process.env.FFPROBE_PATH || 'ffprobe', [
            '-v', 'error', '-select_streams', 'a:0',
            '-show_entries', 'stream=codec_name:format=duration',
            '-of', 'json', file
        ], { signal, timeout: 10000 });
    } catch (error) {
        signal?.throwIfAborted();
        throw new MediaError('FORMAT_UNAVAILABLE', 'Não consegui verificar o formato do áudio do Deezer.');
    }

    let audio;
    try { audio = JSON.parse(probe.stdout); } catch (_) {}
    const codec = audio?.streams?.[0]?.codec_name;
    const seconds = Number(audio?.format?.duration);
    if (!['mp3', 'flac'].includes(codec) || !Number.isFinite(seconds) || seconds <= 0) {
        throw new MediaError('FORMAT_UNAVAILABLE', 'O Deezer entregou um arquivo de áudio inválido.');
    }
    const finalPath = path.join(jobFolder, 'faixa.' + codec);
    if (path.resolve(file) !== path.resolve(finalPath)) await fs.promises.rename(file, finalPath);
    return finalPath;
}

async function downloadDeezerTrack(trackUrlOrId, { signal, maxBytes } = {}) {
    const trackId = parseTrackId(trackUrlOrId);
    if (!trackId) throw new MediaError('DEEZER_INVALID_TRACK', 'Informe uma faixa válida do Deezer.');
    const arl = process.env.DEEZER_ARL || process.env.DEEMIX_ARL;
    if (!arl?.trim()) {
        throw new MediaError('DEEZER_AUTH_REQUIRED', 'O download do Deezer precisa de uma conta configurada pelo administrador.');
    }

    return withDownloadSlot(signal, async (jobSignal) => {
        const jobFolder = await fs.promises.mkdtemp(path.join(TEMP_AUDIO_DIR, 'dz_'));
        activeDeezerJobs.add(jobFolder);
        try {
            const python = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
            const script = path.join(__dirname, 'download_deezer.py');
            let result;
            try {
                result = await runMediaProcess(python, [script, 'https://www.deezer.com/track/' + trackId, jobFolder], {
                    signal: jobSignal,
                    timeout: 120000,
                    env: { ...process.env, DEEZER_ARL: arl, PYTHONIOENCODING: 'utf-8' }
                });
            } catch (error) {
                jobSignal?.throwIfAborted();
                if (error.stderr?.includes('DEEZER_AUTH_REQUIRED')) {
                    throw new MediaError('DEEZER_AUTH_REQUIRED', 'A conta do Deezer precisa ser autenticada novamente pelo administrador.');
                }
                if (error.stderr?.includes('DEEZER_NO_AUDIO')) {
                    throw new MediaError('DEEZER_NO_AUDIO', 'Esta faixa está indisponível para download no Deezer.');
                }
                if (error.stderr?.includes('ModuleNotFoundError')) {
                    throw new MediaError('DEEZER_UNAVAILABLE', 'As dependências do downloader Deezer precisam ser instaladas.');
                }
                throw error;
            }

            const { file, size } = await locateOutput(jobFolder, result.stdout);
            if (Number.isFinite(maxBytes) && size > maxBytes) {
                throw new MediaError('MEDIA_TOO_LARGE', 'O áudio ultrapassa o limite de envio desta conversa.');
            }
            return await verifyAudio(file, jobFolder, jobSignal);
        } catch (error) {
            activeDeezerJobs.delete(jobFolder);
            await fs.promises.rm(jobFolder, { recursive: true, force: true }).catch(() => {});
            throw error;
        }
    });
}

function cleanupTempAudio(filePath) {
    const directory = path.dirname(filePath);
    if (!activeDeezerJobs.has(directory)) return;
    try {
        fs.rmSync(directory, { recursive: true, force: true });
    } catch (error) {
        console.error('[DeezerService] Não consegui remover o temporário:', error.code);
    } finally {
        activeDeezerJobs.delete(directory);
    }
}

function getActiveDeezerJobs() {
    return new Set(activeDeezerJobs);
}

module.exports = {
    searchDeezerTracks, calculateConfidenceScore, downloadDeezerTrack, cleanupTempAudio, getActiveDeezerJobs
};
