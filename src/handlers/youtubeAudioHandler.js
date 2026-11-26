const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const axios = require('axios');
const { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const config = require('../config');
const { MediaError, runMediaProcess, withDownloadSlot, createMediaPool } = require('../services/mediaProcess');

const MiB = 1024 * 1024;
const downloadLimit = 160 * MiB;
const TEMP_AUDIO_DIR = path.join(__dirname, '../data/temp_audio');
const TEMP_VIDEO_DIR = path.join(__dirname, '../data/temp_videos');
const pendingVideoFiles = new Map();
const activeDirectories = new Set();
const activeRequests = new Map();
const compressions = createMediaPool(1, 8, 5 * 60000);
const pendingLifetime = 6 * 3600000;
const hostIn = (host, domain) => host === domain || host.endsWith('.' + domain);

function parseMediaUrl(raw, type) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048 || /[\s\\]/.test(raw.trim())) {
        throw new MediaError('URL_INVALID', 'Envie um link individual da mídia.');
    }
    let url;
    try {
        const input = raw.trim();
        url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : 'https://' + input);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error();
    } catch (_) {
        throw new MediaError('URL_INVALID', 'Envie um link válido de YouTube, Instagram, TikTok ou X.');
    }

    const host = url.hostname;
    const route = url.pathname;
    let platform;
    if (['www.instagram.com', 'instagram.com', 'm.instagram.com', 'instagr.am', 'www.instagr.am'].includes(host) &&
        /^\/(?:[\w.]+\/)?(?:(?:reels?|p|tv)\/[\w-]+|share\/(?:(?:reels?|p)\/)?[\w-]+)\/?$/i.test(route)) {
        platform = 'instagram';
        url.search = '';
    } else if (hostIn(host, 'youtube.com') || host === 'youtu.be') {
        if (route === '/playlist') throw new MediaError('PLAYLIST_DETECTED', 'Envie o link de um vídeo ou faixa individual.');
        const short = /^\/shorts\/[\w-]{11}\/?$/.test(route);
        const id = (host === 'youtu.be' || /^\/(?:embed|v|shorts|live)\//.test(route)) ? route.split('/').filter(Boolean).at(-1) : url.searchParams.get('v');
        if (!/^[\w-]{11}$/.test(id || '') || (host !== 'youtu.be' && !short && !/^\/(?:watch$|embed\/|v\/|live\/)/.test(route))) {
            throw new MediaError('URL_INVALID', 'Envie o link de um vídeo ou faixa do YouTube.');
        }
        if (type === 'video' && !short) throw new MediaError('YOUTUBE_FULL_VIDEO', 'No YouTube, o download de vídeo aceita Shorts. Para vídeos comuns, use /baixar_musica.');
        if (host === 'music.youtube.com') url.hostname = 'www.youtube.com';
        platform = short ? 'youtube_shorts' : 'youtube';
    } else if (hostIn(host, 'tiktok.com') && /^\/(?:@[\w.-]+\/(?:video|photo)\/\d+|t\/[\w-]+|v\/\d+|[\w-]+)\/?$/i.test(route)) {
        platform = 'tiktok';
    } else if (['twitter.com', 'x.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com'].some(domain => host === domain || host === 'www.' + domain)) {
        const match = route.match(/^\/(?:i\/status|[\w]+\/status)\/(\d+)(?:\/(?:video|photo)\/\d+)?\/?$/);
        if (match) return { platform: 'twitter', url: 'https://x.com/i/status/' + match[1] };
    }
    if (!platform) throw new MediaError('URL_INVALID', 'Envie um link de mídia de YouTube, Instagram, TikTok ou X.');
    url.hash = '';
    return { platform, url: url.href };
}

function detectPlatform(url) {
    try { return parseMediaUrl(url).platform; } catch (_) { return null; }
}

function sanitizeFilenameForDiscord(value) {
    return String(value || 'Mídia').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'midia';
}

const labels = { instagram: 'Instagram', tiktok: 'TikTok', twitter: 'X', youtube: 'YouTube', youtube_shorts: 'YouTube Shorts' };
function formatVideoSuccessMessage(video, details = false) {
    const data = video.metadata || {};
    const extractor = String(data.extractor_key || '').toLowerCase();
    const platform = video.platform || detectPlatform(data.webpage_url) || Object.keys(labels).find(key => extractor.includes(key));
    let text = '🎬 Vídeo baixado' + (labels[platform] ? ' · ' + labels[platform] : '') + '.';
    if (details) {
        const author = String(data.uploader || data.creator || data.channel || '').slice(0, 120);
        const description = String(data.description || '').trim().slice(0, 150);
        if (author) text += '\nAutor: ' + author;
        if (description) text += '\n' + description;
    }
    return text;
}

function getAttachmentLimit(target) {
    const limit = target?.attachmentSizeLimit ?? target?.attachment_size_limit;
    if (Number.isSafeInteger(limit) && limit > 0) return limit;
    const tier = target?.guild?.premiumTier;
    return tier === 3 ? 100 * MiB : tier === 2 ? 50 * MiB : 10 * MiB;
}

function acquireMediaRequest(userId) {
    if (activeRequests.has(userId)) throw new MediaError('MEDIA_BUSY', 'Você já tem um pedido de mídia em andamento.');
    const controller = new AbortController();
    activeRequests.set(userId, controller);
    return {
        signal: controller.signal,
        release() { if (activeRequests.get(userId) === controller) activeRequests.delete(userId); }
    };
}

function unlockAllUsers() {
    for (const request of activeRequests.values()) request.abort(new MediaError('MEDIA_CANCELLED', 'O pedido de mídia foi cancelado.'));
    return activeRequests.size;
}

function jobDirectory(root) {
    fs.mkdirSync(root, { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, 'media-'));
    activeDirectories.add(directory);
    return {
        directory,
        cleanup() {
            try { fs.rmSync(directory, { recursive: true, force: true }); }
            catch (error) { console.warn('[Media] Falha ao limpar temporário:', error.code); }
            finally { activeDirectories.delete(directory); }
        }
    };
}

async function probe(file, signal) {
    const { stdout } = await runMediaProcess('ffprobe', [
        '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file
    ], { signal, timeout: 15000 });
    const data = JSON.parse(stdout);
    return {
        video: data.streams.find(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1),
        audio: data.streams.find(stream => stream.codec_type === 'audio'),
        format: data.format?.format_name || '',
        brand: (data.format?.tags?.major_brand || '').trim(),
        duration: Number(data.format?.duration)
    };
}

function compatibleVideo(info) {
    return info.video?.codec_name === 'h264' && info.video.pix_fmt === 'yuv420p' &&
        (!info.audio || info.audio.codec_name === 'aac') && info.format.split(',').includes('mp4') &&
        !!info.brand && !/^(?:qt|3g|mj2)/i.test(info.brand);
}

async function normalizeVideo(file, directory, signal) {
    const info = await probe(file, signal);
    if (!info.video) throw new MediaError('NO_MEDIA', 'A publicação não contém uma faixa de vídeo.');
    if (compatibleVideo(info)) return file;
    const output = path.join(directory, 'normalized.mp4');
    await runMediaProcess('ffmpeg', [
        '-nostdin', '-v', 'error', '-y', '-i', file, '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264',
        '-threads', '1', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output
    ], { signal, timeout: 90000 });
    if (!compatibleVideo(await probe(output, signal))) throw new MediaError('FORMAT_UNAVAILABLE', 'Não foi possível preparar um MP4 compatível.');
    fs.unlinkSync(file);
    return output;
}

function classifyDownload(error) {
    if (error instanceof MediaError && error.code !== 'MEDIA_PROCESS_FAILED') return error;
    if (error.name === 'TimeoutError') return new MediaError('MEDIA_TIMEOUT', 'O download excedeu o prazo.');
    if (error.code === 'ENOENT') return new MediaError('MEDIA_DEPENDENCY', 'O serviço de mídia está indisponível nesta instância.');
    const detail = error.stderr || '';
    if (/timed?\s*out|etimedout|timeout/i.test(detail)) {
        return new MediaError('MEDIA_TIMEOUT', 'O provedor de mídia excedeu o prazo.');
    }
    if (/429|too many requests/i.test(detail)) return new MediaError('PROVIDER_RATE_LIMIT', 'A plataforma limitou os downloads. Tente novamente mais tarde.');
    if (/private|log in|login|sign in|authenticat|age.restrict|403/i.test(detail)) {
        return new MediaError('MEDIA_UNAVAILABLE', 'A plataforma restringiu o acesso a esta mídia.');
    }
    if (/no video|no audio|no matching format|requested format|unsupported url/i.test(detail)) {
        return new MediaError('NO_MEDIA', 'Nenhuma faixa de mídia compatível foi encontrada neste link.');
    }
    return new MediaError('MEDIA_PROCESS_FAILED', 'O provedor não conseguiu entregar a mídia. Tente novamente ou use outro link.');
}

function formatMediaError(error) {
    if (error instanceof MediaError || error?.name === 'TimeoutError') return classifyDownload(error).message;
    if ([40005, 50045, 413].includes(error?.code) || error?.status === 413) {
        return 'O arquivo excede o limite aceito pelo Discord neste canal.';
    }
    if ([50001, 50013].includes(error?.code) || error?.status === 403) {
        return 'O Discord recusou o envio. Verifique se a Hikari pode enviar arquivos neste canal.';
    }
    return 'Não foi possível concluir o envio da mídia. Tente novamente.';
}

function makeYtdlpArgs(directory, target, type) {
    const flags = ['--ignore-config', '--no-playlist', '--no-exec', '--no-write-thumbnail', '--socket-timeout', '15',
        '--retries', '2', '--max-filesize', String(downloadLimit), '--no-simulate'];
    const configured = Array.isArray(config.ytdlpExtraFlags) ? config.ytdlpExtraFlags : [];
    flags.push(...configured.filter(flag => typeof flag === 'string' && !flag.includes('exec')));
    if (config.ytdlpCookiesPath && fs.existsSync(config.ytdlpCookiesPath)) flags.push('--cookies', config.ytdlpCookiesPath);
    if (type === 'audio') flags.push('-f', 'bestaudio/best', '-x', '--audio-format', 'mp3');
    else flags.push('-f', 'bestvideo[height<=1080][ext=mp4][vcodec^=avc]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]/best',
        '--merge-output-format', 'mp4');
    return [...flags, '-o', path.join(directory, 'source.%(ext)s'), '--print-json', '--', target.url];
}

async function downloadWithYtdlp(directory, target, type, signal) {
    const { stdout } = await runMediaProcess('yt-dlp', makeYtdlpArgs(directory, target, type), { signal, timeout: 90000 });
    let metadata = {};
    for (const line of stdout.trim().split('\n').reverse()) {
        try { metadata = JSON.parse(line); break; } catch (_) {}
    }
    const accepted = type === 'audio' ? /^source\.mp3$/ : /^source\.(?:mp4|webm|mkv|mov)$/;
    const name = fs.readdirSync(directory).find(candidate => accepted.test(candidate));
    if (!name) throw new MediaError('NO_MEDIA', 'Nenhum arquivo foi entregue pelo provedor dentro do limite.');
    return { filePath: path.join(directory, name), metadata };
}

const tiktokCdn = ['tikwm.com', 'tikmate.app', 'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokv.com', 'byteoversea.com', 'ibytedtos.com'];
async function receiveTikTokFile(url, directory, signal) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.port || target.username || target.password ||
        !tiktokCdn.some(host => hostIn(target.hostname, host))) {
        throw new MediaError('MEDIA_UNAVAILABLE', 'A fonte alternativa não forneceu um endereço de mídia válido.');
    }
    const response = await axios.get(target.href, { responseType: 'stream', timeout: 30000, signal, maxRedirects: 0 });
    const type = String(response.headers['content-type'] || '');
    if (!/^(?:video\/|audio\/|application\/octet-stream)/i.test(type) ||
        Number(response.headers['content-length']) > downloadLimit) {
        response.data.destroy();
        throw new MediaError('FORMAT_UNAVAILABLE', 'A fonte alternativa não retornou mídia dentro do limite.');
    }
    let received = 0;
    const cap = new Transform({
        transform(chunk, _, done) {
            received += chunk.length;
            done(received > downloadLimit ? new MediaError('TOO_LARGE', 'O arquivo de origem é grande demais.') : null, chunk);
        }
    });
    const file = path.join(directory, 'fallback.media');
    await pipeline(response.data, cap, fs.createWriteStream(file), { signal });
    return file;
}

async function downloadTikTok(directory, target, type, signal) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const options = { headers, timeout: 10000, signal, maxRedirects: 0 };
    const providers = [
        async () => {
            const { data } = await axios.post('https://www.tikwm.com/api/', new URLSearchParams({ url: target.url }), options);
            const post = data?.code === 0 && data.data;
            const media = post && (type === 'audio' ? post.music || post.play : post.play || post.wmplay);
            return media ? { url: new URL(media, 'https://www.tikwm.com').href, title: post.title } : null;
        },
        async () => {
            const { data } = await axios.post('https://api.tikmate.app/api/lookup', new URLSearchParams({ url: target.url }), options);
            return data?.success && data.token && data.id ? {
                url: 'https://tikmate.app/download/' + encodeURIComponent(data.token) + '/' + encodeURIComponent(data.id) + '.mp4',
                title: data.desc
            } : null;
        }
    ];
    for (const findSource of providers) {
        try {
            const source = await findSource();
            if (!source) continue;
            const input = await receiveTikTokFile(source.url, directory, signal);
            if (type === 'video') return { filePath: input, metadata: { title: source.title } };
            const filePath = path.join(directory, 'fallback.mp3');
            await runMediaProcess('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', input,
                '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', filePath], { signal, timeout: 45000 });
            return { filePath, metadata: { title: source.title } };
        } catch (_) {
            signal.throwIfAborted();
        }
    }
    throw new MediaError('MEDIA_UNAVAILABLE', 'A mídia não está disponível nas fontes consultadas.');
}

async function download(url, type, context = {}) {
    const target = parseMediaUrl(url, type);
    try {
        return await withDownloadSlot(context?.signal, async signal => {
            const job = jobDirectory(type === 'audio' ? TEMP_AUDIO_DIR : TEMP_VIDEO_DIR);
            const budget = new AbortController();
            const combined = AbortSignal.any([signal, budget.signal]);
            const monitor = setInterval(() => {
                try {
                    const bytes = fs.readdirSync(job.directory).reduce((total, name) => {
                        try { return total + fs.statSync(path.join(job.directory, name)).size; }
                        catch (_) { return total; }
                    }, 0);
                    if (bytes > downloadLimit * 2) budget.abort(new MediaError('TOO_LARGE', 'O arquivo de origem é grande demais.'));
                } catch (_) {}
            }, 500).unref();
            try {
                let result;
                try { result = await downloadWithYtdlp(job.directory, target, type, combined); }
                catch (error) {
                    combined.throwIfAborted();
                    if (target.platform !== 'tiktok') throw error;
                    result = await downloadTikTok(job.directory, target, type, combined);
                }
                if (type === 'video') result.filePath = await normalizeVideo(result.filePath, job.directory, combined);
                else if ((await probe(result.filePath, combined)).audio?.codec_name !== 'mp3') {
                    throw new MediaError('FORMAT_UNAVAILABLE', 'A origem não gerou um arquivo MP3 válido.');
                }
                combined.throwIfAborted();
                const fileSize = fs.statSync(result.filePath).size;
                if (!fileSize) throw new MediaError('NO_MEDIA', 'A origem retornou um arquivo vazio.');
                if (fileSize > downloadLimit) throw new MediaError('TOO_LARGE', 'O arquivo de origem é grande demais.');
                return { ...result, fileSize, platform: target.platform, cleanup: job.cleanup };
            } catch (error) {
                job.cleanup();
                throw error;
            } finally { clearInterval(monitor); }
        });
    } catch (error) {
        throw classifyDownload(error);
    }
}

function contextMatches(entry, scope) {
    return entry.userId === scope.userId && entry.channelId === scope.channelId && entry.guildId === scope.guildId;
}

function discardEntry(entry) {
    clearTimeout(entry.timer);
    pendingVideoFiles.delete(entry.id);
    entry.video.cleanup();
}

function storeVideoForCompression(video, scope) {
    if (pendingVideoFiles.size >= 16) throw new MediaError('MEDIA_BUSY', 'Há muitos vídeos aguardando compressão. Tente novamente em instantes.');
    const entry = { ...scope, id: randomUUID(), video, reserved: false, expiresAt: Date.now() + pendingLifetime };
    entry.timer = setTimeout(() => { if (!entry.reserved) discardEntry(entry); }, pendingLifetime).unref();
    pendingVideoFiles.set(entry.id, entry);
    return entry.id;
}

function reserveVideoCompression(id, scope) {
    const entry = pendingVideoFiles.get(id);
    if (!entry || !contextMatches(entry, scope)) throw new MediaError('VIDEO_EXPIRED', 'Este botão expirou ou pertence a outro pedido.');
    if (entry.reserved) throw new MediaError('MEDIA_BUSY', 'Este vídeo já está aguardando compressão.');
    if (entry.expiresAt <= Date.now()) {
        discardEntry(entry);
        throw new MediaError('VIDEO_EXPIRED', 'Este vídeo expirou. Baixe novamente.');
    }
    entry.reserved = true;
    return entry;
}

function releasePendingVideo(entry, { discard = false } = {}) {
    if (pendingVideoFiles.get(entry.id) !== entry) return false;
    entry.reserved = false;
    if (discard || entry.expiresAt <= Date.now()) {
        discardEntry(entry);
        return false;
    }
    return true;
}

function compressionButton(id) {
    return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('compress_video_' + id)
        .setLabel('Comprimir vídeo').setStyle(ButtonStyle.Primary));
}

function mediaScope(target, userId) {
    return { userId, channelId: target.channelId || target.channel?.id, guildId: target.guildId || target.guild?.id || null };
}

function playableAttachment(result, type) {
    return new AttachmentBuilder(result.filePath, { name: sanitizeFilenameForDiscord(result.metadata?.title) + (type === 'audio' ? '.mp3' : '.mp4') });
}

function prepareMediaDelivery(result, type, target, scope, details) {
    const limit = getAttachmentLimit(target);
    if (result.fileSize <= limit) return {
        payload: {
            content: type === 'video' ? formatVideoSuccessMessage(result, details) : '🎵 Áudio baixado.',
            files: [playableAttachment(result, type)], embeds: [], components: [], allowedMentions: { parse: [] }
        }
    };
    if (type === 'audio') throw new MediaError('TOO_LARGE', 'O áudio excede o limite de anexos deste canal.');
    const pendingId = storeVideoForCompression(result, scope);
    return {
        pendingId,
        payload: {
            content: '', embeds: [new EmbedBuilder().setColor(0xF59E0B).setTitle('Vídeo acima do limite')
                .setDescription('O arquivo tem ' + (result.fileSize / MiB).toFixed(1) + ' MiB. O limite é ' +
                    (limit / MiB).toFixed(1) + ' MiB. Você pode tentar comprimir o vídeo nas próximas 6 horas.')],
            components: [compressionButton(pendingId)], allowedMentions: { parse: [] }
        }
    };
}

function forgetPendingVideo(id) {
    const entry = pendingVideoFiles.get(id);
    if (entry && !entry.reserved) discardEntry(entry);
}

async function compressPendingVideo(entry, limit, requestSignal) {
    if (!entry.reserved || pendingVideoFiles.get(entry.id) !== entry) throw new MediaError('VIDEO_EXPIRED', 'O pedido de compressão expirou.');
    return compressions.submit(requestSignal, async () => {
        const deadline = AbortSignal.timeout(180000);
        const controller = new AbortController();
        const signal = AbortSignal.any([deadline, controller.signal, ...(requestSignal ? [requestSignal] : [])]);
        signal.throwIfAborted();
        const job = jobDirectory(TEMP_VIDEO_DIR);
        const checkMemory = setInterval(() => {
            if (os.freemem() / os.totalmem() < 0.05) controller.abort(new MediaError('MEMORY_ERROR', 'A compressão parou por falta de memória disponível.'));
        }, 1000).unref();
        try {
            const info = await probe(entry.video.filePath, signal);
            if (!info.video || !Number.isFinite(info.duration) || info.duration <= 0) {
                throw new MediaError('FORMAT_UNAVAILABLE', 'A duração do vídeo não pôde ser determinada.');
            }
            const total = Math.floor(limit * 0.93 * 8 / info.duration / 1000);
            const audio = info.audio ? Math.min(96, Math.floor(total * 0.23)) : 0;
            const video = Math.min(3500, total - audio);
            if (video < 45 || (info.audio && audio < 16)) throw new MediaError('TOO_LARGE', 'O vídeo é longo demais para caber neste canal.');
            const height = video < 450 ? 360 : video < 900 ? 480 : 720;
            const passlog = path.join(job.directory, 'pass');
            const output = path.join(job.directory, 'compressed.mp4');
            const common = ['-nostdin', '-v', 'error', '-y', '-i', entry.video.filePath, '-map', '0:v:0',
                '-vf', "scale=-2:trunc(min(ih\\," + height + ")/2)*2", '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                '-b:v', video + 'k', '-preset', 'veryfast', '-threads', '1', '-passlogfile', passlog];
            await runMediaProcess('ffmpeg', [...common, '-pass', '1', '-an', '-f', 'null', '-'], { signal });
            await runMediaProcess('ffmpeg', [...common, '-pass', '2', '-map', '0:a:0?',
                ...(audio ? ['-c:a', 'aac', '-b:a', audio + 'k'] : ['-an']),
                '-movflags', '+faststart', output], { signal });
            const fileSize = fs.statSync(output).size;
            if (!fileSize || fileSize > limit) throw new MediaError('TOO_LARGE', 'O vídeo ainda excede o limite após a compressão.');
            return { filePath: output, fileSize, cleanup: job.cleanup, metadata: entry.video.metadata };
        } catch (error) {
            job.cleanup();
            throw error;
        } finally { clearInterval(checkMemory); }
    });
}

function cleanTempMedia(maxAge = 30 * 60000) {
    const active = new Set(activeDirectories);
    try {
        const { getActiveDeezerJobs } = require('../services/deezerMusicService');
        for (const file of getActiveDeezerJobs?.() || []) active.add(file);
    } catch (_) {}
    for (const root of [TEMP_AUDIO_DIR, TEMP_VIDEO_DIR]) {
        if (!fs.existsSync(root)) continue;
        for (const name of fs.readdirSync(root)) {
            const entry = path.join(root, name);
            if (active.has(entry)) continue;
            try {
                if (Date.now() - fs.lstatSync(entry).mtimeMs > maxAge) fs.rmSync(entry, { recursive: true, force: true });
            } catch (_) {}
        }
    }
}

cleanTempMedia();
setInterval(cleanTempMedia, 15 * 60000).unref();

module.exports = {
    cleanTempMedia, downloadAudio: (url, context) => download(url, 'audio', context),
    downloadVideo: (url, context) => download(url, 'video', context),
    sanitizeFilenameForDiscord, detectPlatform, formatVideoSuccessMessage, formatMediaError,
    acquireMediaRequest, unlockAllUsers, getAttachmentLimit, mediaScope, playableAttachment, prepareMediaDelivery,
    storeVideoForCompression, reserveVideoCompression, releasePendingVideo, forgetPendingVideo,
    compressPendingVideo, compressionButton, isCompressionActive: compressions.busy
};
