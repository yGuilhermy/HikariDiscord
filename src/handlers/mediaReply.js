const { EmbedBuilder, escapeMarkdown } = require('discord.js');
const { setTimeout: delay } = require('node:timers/promises');
const { downloadAudio, downloadVideo, prepareMediaDelivery, mediaScope, forgetPendingVideo, getAttachmentLimit } = require('./youtubeAudioHandler');
const config = require('../config');

async function retryMediaEdit(send, payload, signal) {
    signal?.throwIfAborted();
    try {
        return await send(payload);
    } catch (error) {
        if (!(error.status >= 500 && error.status < 600)) throw error;
        await delay(350, undefined, { signal });
        return send(payload);
    }
}

async function deliverMediaLink(target, userId, type, url, details, send, signal) {
    const download = type === 'audio' ? downloadAudio : downloadVideo;
    const result = await download(url, { signal });
    let pendingId;
    let delivered = false;
    try {
        const delivery = prepareMediaDelivery(result, type, target, mediaScope(target, userId), details);
        pendingId = delivery.pendingId;
        await retryMediaEdit(send, delivery.payload, signal);
        delivered = true;
    } finally {
        if (pendingId && !delivered) forgetPendingVideo(pendingId);
        else if (!pendingId) result.cleanup();
    }
}

function musicOptions(target, userId, signal) {
    return { ...mediaScope(target, userId), signal, maxBytes: getAttachmentLimit(target) };
}

function safeLabel(value) {
    return escapeMarkdown(String(value || '').replace(/[\r\n\t]/g, ' ').slice(0, 240));
}

function musicActivityEmbed(activity, userId) {
    const lines = ['**' + safeLabel(activity.title) + '**', safeLabel(activity.artist)];
    if (activity.album) lines.push(safeLabel(activity.album));
    const embed = new EmbedBuilder().setColor(0x1DB954).setTitle('Música identificada na atividade')
        .setDescription(lines.join('\n')).addFields({ name: 'Plataforma', value: safeLabel(activity.platformLabel) });
    if (activity.targetUser?.id !== userId && /^\d{17,20}$/.test(activity.targetUser?.id || '')) {
        embed.addFields({ name: 'Usuário', value: '<@' + activity.targetUser.id + '>' });
    }
    try {
        if (['https:', 'http:'].includes(new URL(activity.coverUrl).protocol)) embed.setThumbnail(activity.coverUrl);
    } catch (_) {}
    return embed;
}

async function deliverMusicResult(result, send, signal, activityEmbed) {
    const embeds = config.keepMusicEmbed !== false ? [result.infoEmbed || activityEmbed].filter(Boolean) : [];
    const base = { embeds: [], components: [], allowedMentions: { parse: [] } };
    if (result.error) return send({ ...base, content: '❌ ' + String(result.error).slice(0, 1200) });
    if (result.isAmbiguous) return send({ ...base, content: '', embeds: [result.embed], components: result.components });
    try {
        await retryMediaEdit(send, {
            ...base, content: '🎵 **' + safeLabel(result.track.title) + '** — ' + safeLabel(result.track.artist),
            embeds, files: [result.attachment]
        }, signal);
    } finally {
        result.cleanup?.();
    }
}

module.exports = { deliverMediaLink, deliverMusicResult, musicOptions, musicActivityEmbed, retryMediaEdit };
