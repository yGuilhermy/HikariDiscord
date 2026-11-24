const { randomUUID } = require('node:crypto');
const { ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getSession, addTrackToQueue, skipToTrack } = require('./radioDatabase');
const { playTrack, updateEmbed } = require('./radioAudioPlayer');
const { resolveInput } = require('./radioProviders');
const { prefetchNextTrack } = require('./radioPrefetcher');
const { buildAmbiguousEmbed } = require('./radioEmbed');

const pendingSearches = new Map();
const latestSearch = new WeakMap();

function sessionMatches(session) {
    return getSession(session.guildId) === session && !session._leaving;
}

async function findMusic(session, userId, query) {
    if (!sessionMatches(session)) return { type: 'stale' };
    if (!latestSearch.has(session)) latestSearch.set(session, new Map());
    const requests = latestSearch.get(session);
    const ticket = Symbol();
    requests.set(userId, ticket);
    for (const [id, pending] of pendingSearches) {
        if (pending.session === session && pending.userId === userId) {
            void expireSearch(id, 'Esta busca foi substituída por uma mais recente.');
        }
    }
    try {
        const result = await resolveInput(query, session.guildId);
        return sessionMatches(session) && requests.get(userId) === ticket ? result : { type: 'stale' };
    } finally {
        if (requests.get(userId) === ticket) requests.delete(userId);
    }
}

async function enqueueTracks(session, tracks, userId, channel, client) {
    if (!sessionMatches(session)) return { status: 'closed' };
    const position = session.playlist.length + 1;
    for (const track of tracks) addTrackToQueue(session.guildId, { ...track, addedBy: userId });

    if (session.status === 'STOPPED') {
        const target = skipToTrack(session.guildId, position)?.currentTrack;
        const started = target && await playTrack(session.guildId, target, channel, client);
        if (!sessionMatches(session)) return { status: 'closed' };
        return { position, status: started ? 'started' : 'failed' };
    }
    void prefetchNextTrack(session.guildId);
    void updateEmbed(session.guildId, channel, client);
    return { position, status: 'queued' };
}

function finishSearch(id) {
    const pending = pendingSearches.get(id);
    if (!pending) return null;
    pendingSearches.delete(id);
    clearTimeout(pending.timer);
    return pending;
}

async function expireSearch(id, content) {
    const pending = finishSearch(id);
    if (pending) await pending.edit({ content, embeds: [], components: [] }).catch(() => {});
}

function cancelSearches(session) {
    for (const [id, pending] of pendingSearches) {
        if (pending.session === session) void expireSearch(id, 'A sessão de rádio foi encerrada.');
    }
}

async function showMusicChoices({ session, userId, results, channel, client, send, edit }) {
    if (!sessionMatches(session)) return;
    for (const [id, pending] of pendingSearches) {
        if (pending.session === session && pending.userId === userId) {
            void expireSearch(id, 'Esta busca foi substituída por uma mais recente.');
        }
    }

    const id = randomUUID();
    const candidates = results.slice(0, 10);
    const select = new StringSelectMenuBuilder()
        .setCustomId('radio_ambiguous_select_' + id)
        .setPlaceholder('Escolha a música')
        .addOptions(candidates.map((track, index) => ({
            value: String(index),
            label: (index + 1 + '. ' + (track.title || 'Faixa')).slice(0, 100),
            description: String(track.artist || 'Desconhecido').slice(0, 100)
        })));
    const cancel = new ButtonBuilder().setCustomId('radio_ambiguous_cancel_' + id)
        .setLabel('Cancelar').setStyle(ButtonStyle.Danger);
    const messagePromise = Promise.resolve().then(() => send({
        content: 'Qual faixa você quer? A primeira será selecionada após 10 segundos.',
        allowedMentions: { parse: [] },
        embeds: [buildAmbiguousEmbed(candidates)],
        components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(cancel)]
    }));
    const pending = {
        session, userId, results: candidates, channel, client,
        edit: payload => messagePromise.then(message => edit ? edit(payload) : message.edit(payload))
    };
    pendingSearches.set(id, pending);
    try {
        await messagePromise;
    } catch (error) {
        finishSearch(id);
        throw error;
    }
    if (pendingSearches.get(id) !== pending) return;
    if (!sessionMatches(session)) return expireSearch(id, 'A sessão de rádio foi encerrada.');

    pending.timer = setTimeout(async () => {
        if (finishSearch(id) !== pending || !sessionMatches(session)) return;
        const voiceChannel = client?.channels?.cache?.get(session.voiceChannelId);
        if (!voiceChannel?.members?.has(userId)) {
            await pending.edit({ content: 'Busca expirada. Entre no canal de voz para tentar novamente.', embeds: [], components: [] }).catch(() => {});
            return;
        }
        const track = candidates[0];
        const result = enqueueTracks(session, [track], userId, channel, client);
        try {
            await pending.edit({ content: 'Tempo esgotado. Primeira opção selecionada.', embeds: [], components: [] });
            await result;
        } catch (error) {
            console.error('[RadioSearch] Falha ao confirmar busca:', error.code || error.name);
        }
    }, 10000);
    pending.timer.unref();
}

function pickMusicChoice(id, { guildId, userId, channelId, position, cancel }) {
    const pending = pendingSearches.get(id);
    if (!pending || pending.session.guildId !== guildId || !sessionMatches(pending.session)) {
        return { error: 'Seleção expirada. Faça a busca novamente.' };
    }
    if (pending.userId !== userId) return { error: 'Esta seleção pertence a outro usuário.' };
    if (channelId !== pending.session.voiceChannelId) return { error: 'Você precisa estar no canal de voz do rádio.' };
    if (cancel) {
        finishSearch(id);
        return { cancelled: true };
    }
    const track = pending.results[position];
    if (!track) return { error: 'Faixa indisponível nessa seleção.' };
    finishSearch(id);
    return {
        track,
        queued: enqueueTracks(pending.session, [track], userId, pending.channel, pending.client)
    };
}

module.exports = { findMusic, enqueueTracks, showMusicChoices, pickMusicChoice, cancelSearches, sessionMatches };
