const {
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    getVoiceConnection,
    StreamType
} = require('@discordjs/voice');
const fs = require('node:fs');
const {
    getSession, updateSession, nextTrack, stopRadio, removeTrackFromPlaylist
} = require('./radioDatabase');
const { resolvePlaybackTrack } = require('./radioProviders');
const { buildRadioEmbed } = require('./radioEmbed');
const { createYouTubeProgressiveStream } = require('./youtubeBufferStream');
const { getTrackAudio, prefetchNextTrack, cancelPrefetch } = require('./radioPrefetcher');

const players = new Map();
const playbacks = new Map();
const panelUpdates = new Map();

function getPlayer(guildId) {
    return players.get(guildId) || null;
}

function isCurrent(guildId, playback) {
    const session = getSession(guildId);
    return playbacks.get(guildId) === playback && session === playback.session &&
        !session._leaving && session.currentTrack === playback.track &&
        !playback.controller.signal.aborted;
}

function getOrCreatePlayer(guildId, connection) {
    let player = players.get(guildId);
    if (!player) {
        player = createAudioPlayer();
        players.set(guildId, player);
        player.on(AudioPlayerStatus.Idle, oldState => {
            const playback = oldState.resource?.metadata;
            if (playback?.started) queueMicrotask(() => advance(guildId, playback, playback.error ? 'failed' : 'ended'));
        });
        player.on('error', error => {
            const playback = error.resource?.metadata;
            if (!playback || !isCurrent(guildId, playback)) return;
            playback.error = error;
            playback.rejectStart?.(error);
            if (playback.started) queueMicrotask(() => advance(guildId, playback, 'failed'));
        });
    }
    connection.subscribe(player);
    return player;
}

function cancelPlayback(guildId) {
    const playback = playbacks.get(guildId);
    playbacks.delete(guildId);
    playback?.controller.abort();
    getPlayer(guildId)?.stop(true);
    playback?.stream?.destroy();
}

function waitForPlaying(player, playback) {
    const signal = AbortSignal.any([playback.controller.signal, AbortSignal.timeout(12000)]);
    return new Promise((resolve, reject) => {
        function cleanup() {
            player.off('stateChange', onStateChange);
            signal.removeEventListener('abort', onAbort);
            playback.rejectStart = null;
        }
        function fail(error) {
            cleanup();
            reject(error);
        }
        function onAbort() {
            fail(signal.reason);
        }
        function onStateChange(oldState, newState) {
            if (newState.resource === playback.resource && newState.status === AudioPlayerStatus.Playing) {
                playback.started = true;
                cleanup();
                resolve();
            } else if (oldState.resource === playback.resource && newState.status === AudioPlayerStatus.Idle) {
                fail(playback.error || new Error('O áudio terminou antes de começar a tocar.'));
            }
        }
        playback.rejectStart = fail;
        player.on('stateChange', onStateChange);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) return onAbort();
        try {
            player.play(playback.resource);
        } catch (error) {
            fail(error);
        }
    });
}

async function loadAudio(guildId, playback) {
    const { track, controller } = playback;
    const { signal } = controller;
    const prefetched = getTrackAudio(guildId, track, signal, { existingOnly: true });
    if (prefetched) {
        try {
            return { input: await prefetched };
        } catch (error) {
            signal.throwIfAborted();
            if (track.source !== 'youtube') throw error;
        }
    }

    const source = await resolvePlaybackTrack(track, signal);
    signal.throwIfAborted();
    if (source.source === 'youtube') {
        const stream = createYouTubeProgressiveStream(source.link, { signal });
        playback.stream = stream;
        try {
            await stream.waitUntilReady(8000);
            return { input: stream, inputType: StreamType.Raw };
        } catch (_) {
            stream.destroy();
            playback.stream = null;
            signal.throwIfAborted();
        }
    }
    return { input: await getTrackAudio(guildId, track, signal, { source }) };
}

async function playTrack(guildId, track, textChannel, client, failed = new Set()) {
    const session = getSession(guildId);
    if (!session || session._leaving || session.currentTrack !== track) return false;

    cancelPlayback(guildId);
    const connection = getVoiceConnection(guildId);
    if (!connection || connection.state?.status === 'destroyed') {
        updateSession(guildId, { status: 'STOPPED', playbackError: 'A conexão de voz foi encerrada.' });
        void updateEmbed(guildId, textChannel, client);
        return false;
    }

    const playback = { session, track, textChannel, client, failed, controller: new AbortController() };
    playbacks.set(guildId, playback);
    updateSession(guildId, { status: 'BUFFERING', playbackError: null });
    void updateEmbed(guildId, textChannel, client);

    try {
        const player = getOrCreatePlayer(guildId, connection);
        const audio = track.localPath && fs.existsSync(track.localPath)
            ? { input: track.localPath }
            : await loadAudio(guildId, playback);
        if (!isCurrent(guildId, playback)) return false;
        playback.resource = createAudioResource(audio.input, { inputType: audio.inputType, metadata: playback });
        await waitForPlaying(player, playback);
        if (!isCurrent(guildId, playback)) return false;
        updateSession(guildId, { status: 'PLAYING' });
        void updateEmbed(guildId, textChannel, client);
        void prefetchNextTrack(guildId);
        return true;
    } catch (error) {
        if (!isCurrent(guildId, playback)) return false;
        playback.error = error;
        queueMicrotask(() => advance(guildId, playback, 'failed'));
        return false;
    }
}

function advance(guildId, playback, reason) {
    if (!isCurrent(guildId, playback)) return;
    const { track, textChannel, client } = playback;
    const failed = reason === 'failed' ? playback.failed : new Set();
    if (reason === 'failed') {
        failed.add(track.entryId);
        console.error('[RadioPlayer] Falha de reprodução:', playback.error?.code || playback.error?.name);
    }
    cancelPlayback(guildId);
    const next = nextTrack(guildId, { reason, excluded: failed });
    if (next) {
        void playTrack(guildId, next, textChannel, client, failed);
    } else {
        if (reason === 'failed') {
            const timedOut = playback.error?.name === 'TimeoutError' ||
                ['ETIMEDOUT', 'ECONNABORTED'].includes(playback.error?.code);
            updateSession(guildId, {
                playbackError: timedOut ? 'O áudio excedeu o tempo limite de carregamento.' : 'Não foi possível reproduzir o áudio.'
            });
        }
        void updateEmbed(guildId, textChannel, client);
    }
}

function pausePlayer(guildId) {
    if (!getPlayer(guildId)?.pause()) return false;
    updateSession(guildId, { status: 'PAUSED' });
    return true;
}

function resumePlayer(guildId) {
    if (!getPlayer(guildId)?.unpause()) return false;
    updateSession(guildId, { status: 'PLAYING' });
    return true;
}

function stopPlayer(guildId) {
    cancelPlayback(guildId);
    cancelPrefetch(guildId);
    players.delete(guildId);
}

function stopPlayback(guildId) {
    stopPlayer(guildId);
    return stopRadio(guildId);
}

async function removeQueuedTrack(guildId, position, channel, client) {
    const result = removeTrackFromPlaylist(guildId, position);
    if (!result) return null;
    if (result.isCurrent) {
        cancelPlayback(guildId);
        if (result.newCurrentTrack) {
            const started = await playTrack(guildId, result.newCurrentTrack, channel, client);
            if (started && result.previousStatus === 'PAUSED' &&
                getSession(guildId)?.currentTrack === result.newCurrentTrack) pausePlayer(guildId);
        }
    }
    void prefetchNextTrack(guildId);
    await updateEmbed(guildId, channel, client);
    return result;
}

async function getPanelChannel(session, fallback, client) {
    if (fallback?.id === session.textChannelId) return fallback;
    const channels = client?.channels || fallback?.client?.channels;
    return channels?.cache?.get(session.textChannelId) ||
        (channels?.fetch ? await channels.fetch(session.textChannelId).catch(() => null) : null);
}

async function deletePanel(session, fallback, client) {
    if (!session?.embedMessageId) return;
    const channel = await getPanelChannel(session, fallback, client);
    await channel?.messages?.delete(session.embedMessageId).catch(error => {
        if (error.code !== 10008) console.error('[RadioPlayer] Falha ao remover painel:', error.code);
    });
}

function updateEmbed(guildId, textChannel, client, { move = false } = {}) {
    const session = getSession(guildId);
    if (!session || session._leaving) return Promise.resolve(null);
    const valid = () => getSession(guildId) === session && !session._leaving;
    const previous = panelUpdates.get(guildId);
    if (previous && !move && previous.session === session && previous.pending) return previous.promise;
    const job = { session, pending: !move };
    job.promise = Promise.resolve(previous?.promise).then(async () => {
        job.pending = false;
        if (!valid()) return null;
        const moving = move && textChannel?.id !== session.textChannelId;
        const channel = moving ? textChannel : await getPanelChannel(session, textChannel, client);
        if (!channel || !valid()) return null;
        const payload = buildRadioEmbed(session);
        if (!moving && session.embedMessageId) {
            try {
                return await channel.messages.edit(session.embedMessageId, payload);
            } catch (error) {
                if (error.code !== 10008) throw error;
            }
        }
        const oldPanel = { textChannelId: session.textChannelId, embedMessageId: session.embedMessageId };
        const message = await channel.send(payload);
        if (!valid()) {
            await message.delete().catch(() => {});
            return null;
        }
        updateSession(guildId, { embedMessageId: message.id, textChannelId: channel.id });
        if (moving) await deletePanel(oldPanel, textChannel, client);
        return message;
    }).catch(error => {
        console.error('[RadioPlayer] Falha ao atualizar painel:', error.code || error.message);
        return null;
    }).finally(() => {
        if (panelUpdates.get(guildId) === job) panelUpdates.delete(guildId);
    });
    panelUpdates.set(guildId, job);
    return job.promise;
}

module.exports = {
    getPlayer, playTrack, pausePlayer, resumePlayer, stopPlayer, stopPlayback,
    removeQueuedTrack, updateEmbed, deletePanel
};
