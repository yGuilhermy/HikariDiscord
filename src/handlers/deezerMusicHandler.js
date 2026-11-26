const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
    EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder,
    ButtonStyle, AttachmentBuilder, escapeMarkdown
} = require('discord.js');
const { searchDeezerTracks, downloadDeezerTrack, cleanupTempAudio } = require('../services/deezerMusicService');
const { MediaError } = require('../services/mediaProcess');
const { checkBan } = require('./banHandler');
const telemetryLogger = require('../utils/telemetryLogger');

const MUSIC_SEARCH_TTL = 10 * 60 * 1000;
const MAX_ACTIVE_SEARCHES = 200;
const musicSessions = new Map();

function text(value, limit, fallback = '') {
    const clean = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim() || fallback;
    return clean.length > limit ? clean.slice(0, limit - 1).trimEnd() + '…' : clean;
}

function displayText(value, limit, fallback) {
    return escapeMarkdown(text(value, limit, fallback)).replace(/@/g, '@\u200b');
}

function formatDuration(duration) {
    const seconds = Math.floor(Number(duration));
    if (!Number.isFinite(seconds) || seconds <= 0) return 'duração indisponível';
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

function scopeOf(context) {
    return {
        userId: context.user?.id || context.userId || '',
        guildId: context.guild?.id || context.guildId || '',
        channelId: context.channel?.id || context.channelId || ''
    };
}

function sameScope(session, scope) {
    return session && session.userId === scope.userId && session.guildId === scope.guildId &&
        session.channelId === scope.channelId;
}

function findSession(scope, searchId) {
    const now = Date.now();
    for (const [id, session] of musicSessions) {
        if (session.expiresAt <= now) musicSessions.delete(id);
    }
    if (!scope.userId || !scope.channelId) return null;

    if (searchId) {
        const session = musicSessions.get(searchId);
        return sameScope(session, scope) ? session : null;
    }

    return [...musicSessions.values()].reverse().find(session => sameScope(session, scope)) || null;
}

function normalized(value) {
    return String(value ?? '').toLowerCase().normalize('NFKD').replace(/\p{Mark}/gu, '')
        .replace(/[^\p{Letter}\p{Number}]+/gu, ' ').trim();
}

function matchingTrack(results, query, activity) {
    const target = normalized(query);
    const wantedTitle = normalized(activity?.title);
    const wantedArtist = normalized(activity?.artist);
    const wantedAlbum = normalized(activity?.album);
    const exact = results.filter(track => {
        const title = normalized(track.title);
        const artist = normalized(track.artist);
        if (!title) return false;
        if (activity) {
            const album = normalized(track.album);
            return title === wantedTitle && wantedArtist && artist === wantedArtist &&
                (!wantedAlbum || album === wantedAlbum);
        }
        return target === title || (artist && (target === title + ' ' + artist || target === artist + ' ' + title));
    });
    return exact.length === 1 ? exact[0] : null;
}

function formatChoices(session) {
    const { results } = session;
    const embed = new EmbedBuilder()
        .setTitle('🎵 Escolha uma faixa')
        .setDescription('Selecione o título, o artista e a versão que você quer baixar. O menu expira em 10 minutos.')
        .setColor(0x9b59b6);

    try {
        const cover = new URL(results[0].cover);
        if (['https:', 'http:'].includes(cover.protocol) && !cover.username && !cover.password && cover.href.length <= 2000) {
            embed.setThumbnail(cover.href);
        }
    } catch (_) {}

    const options = results.map((track, index) => {
        const album = displayText(track.album, 90, 'Álbum não informado');
        const artist = displayText(track.artist, 80, 'Artista desconhecido');
        embed.addFields({
            name: (index + 1) + '. ' + displayText(track.title, 100, 'Faixa sem título'),
            value: artist + '\n' + album + ' · ' + formatDuration(track.duration)
        });
        return {
            label: (index + 1) + '. ' + text(track.title, 85, 'Faixa sem título'),
            description: text(text(track.artist, 45, 'Artista desconhecido') + ' · ' + text(track.album, 55), 100),
            value: String(index + 1)
        };
    });

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('music_select_' + session.searchId)
        .setPlaceholder('Selecione uma faixa')
        .addOptions(options);

    const cancelButton = new ButtonBuilder()
        .setCustomId('music_cancel_' + session.searchId)
        .setLabel('Cancelar')
        .setStyle(ButtonStyle.Danger);

    return {
        isAmbiguous: true,
        searchId: session.searchId,
        textList: 'Escolha uma opção no menu ou diga o número da faixa nesta conversa.',
        embed,
        components: [
            new ActionRowBuilder().addComponents(selectMenu),
            new ActionRowBuilder().addComponents(cancelButton)
        ]
    };
}

async function handleMusicSearchAndDownload(query, selectedIndex = null, context = {}) {
    const scope = scopeOf(context);
    if (checkBan(scope.userId, scope.guildId || null, scope.channelId || null)) {
        return { error: 'Você não tem acesso ao download de música.' };
    }
    context.signal?.throwIfAborted();

    if (selectedIndex !== null && selectedIndex !== undefined) {
        const session = findSession(scope, context.searchId);
        if (!session) {
            return { error: 'Nenhuma pesquisa válida nesta conversa. Faça uma nova busca ou abra seu menu.' };
        }

        const index = Number(selectedIndex) - 1;
        if (!/^\d+$/.test(String(selectedIndex)) || !Number.isInteger(index) || !session.results[index]) {
            return { error: 'Escolha uma opção de 1 a ' + session.results.length + '.' };
        }

        musicSessions.delete(session.searchId);
        const result = await executeDownloadAndPackage(session.results[index], context);
        if (result.success && session.infoEmbed) result.infoEmbed = session.infoEmbed;
        return { ...result, consumed: true };
    }

    if (typeof query !== 'string' || !query.trim() || query.length > 350) {
        return { error: 'Informe o nome da música e, se possível, o artista.' };
    }

    let results;
    try {
        results = await searchDeezerTracks(query.trim(), { signal: context.signal, throwOnError: true, limit: 15 });
    } catch (error) {
        context.signal?.throwIfAborted();
        if (error instanceof MediaError) return { error: error.message };
        return { error: 'A busca no Deezer está indisponível no momento. Tente mais tarde.' };
    }
    if (!results?.length) {
        return { error: 'Nenhuma música foi encontrada no catálogo para “' + displayText(query, 150) + '”.' };
    }

    const exact = matchingTrack(results, query, context.activity);
    if (exact) return executeDownloadAndPackage(exact, context);

    findSession(scope);
    if (musicSessions.size >= MAX_ACTIVE_SEARCHES) {
        musicSessions.delete(musicSessions.keys().next().value);
    }
    const session = {
        ...scope,
        searchId: randomUUID(),
        results: results.slice(0, 5),
        infoEmbed: context.infoEmbed || null,
        expiresAt: Date.now() + MUSIC_SEARCH_TTL
    };
    const choices = formatChoices(session);
    musicSessions.set(session.searchId, session);
    return choices;
}

async function executeDownloadAndPackage(track, { signal, maxBytes } = {}) {
    const startTime = Date.now();
    let filePath;
    try {
        filePath = await downloadDeezerTrack(track.id ?? track.link, { signal, maxBytes });
        signal?.throwIfAborted();
        const extension = path.extname(filePath).toLowerCase();
        if (extension !== '.mp3' && extension !== '.flac') {
            throw new MediaError('FORMAT_UNAVAILABLE', 'O Deezer entregou um formato de áudio incompatível.');
        }
        if (Number.isFinite(maxBytes) && (await fs.stat(filePath)).size > maxBytes) {
            throw new MediaError('MEDIA_TOO_LARGE', 'O áudio ultrapassa o limite de envio desta conversa.');
        }

        const name = text(String(track.title || '').replace(/[<>:"/\\|?*!#$\u0000-\u001f]/g, ' '), 95, 'faixa');
        const attachment = new AttachmentBuilder(filePath, { name: name + extension });
        telemetryLogger.media({ type: 'Música Deezer', durationMs: Date.now() - startTime });

        return {
            success: true,
            filePath,
            attachment,
            track,
            cleanup: () => cleanupTempAudio(filePath)
        };
    } catch (error) {
        if (filePath) cleanupTempAudio(filePath);
        signal?.throwIfAborted();
        telemetryLogger.warn('Falha ao preparar download de música: ' + (error.code || error.name));
        const message = error instanceof MediaError ? error.message : 'Não foi possível baixar esta faixa do Deezer.';
        return { error: message };
    }
}

function clearSession(userId, context = {}) {
    const session = findSession(scopeOf({ ...context, userId }), context.searchId);
    if (!session) return false;
    return musicSessions.delete(session.searchId);
}

module.exports = { handleMusicSearchAndDownload, executeDownloadAndPackage, clearSession };
