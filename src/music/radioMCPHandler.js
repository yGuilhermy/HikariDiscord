const { getSession, nextTrack, prevTrack, firstTrack, skipToTrack, setLoopMode, toggleShuffle } = require('./radioDatabase');
const { playTrack, pausePlayer, resumePlayer, stopPlayback, removeQueuedTrack, updateEmbed } = require('./radioAudioPlayer');
const { checkBan } = require('../handlers/banHandler');
const { buildQueueEmbed, safeText } = require('./radioEmbed');
const { findMusic, enqueueTracks, showMusicChoices, sessionMatches } = require('./radioSearch');
const { prefetchNextTrack } = require('./radioPrefetcher');

async function sendTempMessage(textChannel, content, delayMs = 5000) {
    try {
        const msg = await textChannel.send({ content, allowedMentions: { parse: [] } });
        setTimeout(() => {
            msg?.delete?.().catch(() => {});
        }, delayMs).unref();
    } catch (_) {}
}

async function handleRadioMCPCall(toolName, toolArgs, userId, guildId, textChannel, client, expectedSessionId) {
    toolArgs ||= {};
    const session = getSession(guildId);
    if (!session || session._leaving || (expectedSessionId && session.id !== expectedSessionId)) return `❌ Nenhuma sessão de rádio ativa neste servidor.`;

    if (checkBan(userId, guildId, textChannel?.id || session.textChannelId) ||
        checkBan(userId, guildId, session.voiceChannelId)) return 'Acesso negado aos controles do rádio.';

    const userMention = `<@${userId}>`;

    if (toolName === 'radio_play_music') {
        const query = toolArgs.query || toolArgs.music || toolArgs.song || toolArgs.track || toolArgs.name || '';
        if (!query) return 'Nenhuma música informada.';
        const resolved = await findMusic(session, userId, query);
        if (!sessionMatches(session)) return 'A sessão de rádio foi encerrada.';
        if (resolved.type === 'stale') return null;
        if (resolved.type === 'unavailable') return 'O serviço de música está indisponível. Tente novamente.';
        if (resolved.type === 'not_found') return 'Não encontrei **' + safeText(query, 300) + '**.';
        if (resolved.type === 'ambiguous') {
            await showMusicChoices({
                session, userId, results: resolved.results, channel: textChannel, client,
                send: payload => textChannel.send(payload)
            });
            return null;
        }

        const tracks = resolved.tracks || [resolved.track];
        const result = await enqueueTracks(session, tracks, userId, textChannel, client);
        if (result.status === 'closed') return 'A sessão de rádio foi encerrada.';
        if (result.status === 'failed') return 'Adicionei à fila, mas o áudio da primeira faixa não pôde ser reproduzido.';
        if (resolved.type === 'playlist') {
            await sendTempMessage(textChannel, '🎶 ' + userMention + ' Adicionei **' + tracks.length + '** faixas da playlist à fila.');
        } else {
            const title = safeText(tracks[0].title, 300);
            const action = result.status === 'started' ? 'Tocando **' + title + '**.' :
                'Adicionada à fila (#' + result.position + '): **' + title + '**.';
            await sendTempMessage(textChannel, userMention + ' ' + action);
        }
        return null;
    }

    if (toolName === 'radio_pause_resume') {
        const action = toolArgs.action;
        if (action !== 'pause' && action !== 'resume') return 'Informe se deseja pausar ou retomar a reprodução.';
        let changed = false;
        if (action === 'pause' && session.status === 'PLAYING') changed = pausePlayer(guildId);
        if (action === 'resume' && session.status === 'PAUSED') changed = resumePlayer(guildId);
        if (action === 'resume' && session.status === 'STOPPED') {
            const first = firstTrack(guildId);
            if (first) changed = await playTrack(guildId, first, textChannel, client);
        }
        if (!changed) {
            if (action === 'pause' && session.status === 'PAUSED') return 'A reprodução já está pausada.';
            if (action === 'resume' && session.status === 'PLAYING') return 'A reprodução já está em andamento.';
            return action === 'pause' ? 'O rádio não está tocando.' : 'A reprodução não foi retomada.';
        }
        await updateEmbed(guildId, textChannel, client);
        await sendTempMessage(textChannel, userMention + (action === 'pause' ? ' Música pausada.' : ' Reprodução retomada.'));
        return null;
    }

    if (toolName === 'radio_stop_music') {
        stopPlayback(guildId);
        await updateEmbed(guildId, textChannel, client);
        await sendTempMessage(textChannel, userMention + ' Reprodução parada.');
        return null;
    }

    if (['radio_next_track', 'radio_prev_track', 'radio_skip_to'].includes(toolName)) {
        const target = toolName === 'radio_next_track' ? nextTrack(guildId) :
            toolName === 'radio_prev_track' ? prevTrack(guildId) :
                skipToTrack(guildId, Number(toolArgs.position ?? toolArgs.pos ?? toolArgs.track_number))?.currentTrack;
        if (!target) return 'Não há faixa nessa posição da fila.';
        if (!await playTrack(guildId, target, textChannel, client)) return 'A faixa não pôde ser reproduzida.';
        await sendTempMessage(textChannel, userMention + ' Tocando **' + safeText(target.title, 300) + '**.');
        return null;
    }

    if (toolName === 'radio_remove_track') {
        const position = Number(toolArgs.position ?? toolArgs.pos ?? toolArgs.track_number);
        const result = await removeQueuedTrack(guildId, position, textChannel, client);
        if (!result) return 'Faixa não encontrada na fila.';
        await sendTempMessage(textChannel, userMention + ' Removida: **' + safeText(result.removedTrack.title, 300) + '**.');
        return null;
    }

    if (toolName === 'radio_toggle_shuffle') {
        const enabled = toggleShuffle(guildId);
        prefetchNextTrack(guildId).catch(() => {});
        await updateEmbed(guildId, textChannel, client);
        await sendTempMessage(textChannel, `🔀 ${userMention} Modo aleatório ${enabled ? 'ativado' : 'desativado'}.`);
        return null;
    }

    if (toolName === 'radio_set_repeat') {
        const newMode = setLoopMode(guildId);
        prefetchNextTrack(guildId).catch(() => {});
        const label = newMode === 'TRACK' ? 'repetir faixa atual 🔂' : newMode === 'QUEUE' ? 'repetir playlist 🔁' : 'desativada ❌';
        await updateEmbed(guildId, textChannel, client);
        await sendTempMessage(textChannel, `🔁 ${userMention} Repetição: ${label}`);
        return null;
    }

    if (toolName === 'radio_show_queue') {
        const { embed, components } = buildQueueEmbed(session, 1);
        try { await textChannel.send({ embeds: [embed], components }); } catch (_) {}
        return null;
    }

    if (toolName === 'radio_get_current') {
        if (session.currentTrack) {
            const status = session.status === 'BUFFERING' ? 'Carregando' : session.status === 'PAUSED' ? 'Pausada' : 'Tocando';
            await sendTempMessage(textChannel, `${userMention} ${status}: **${safeText(session.currentTrack.title, 300)}** — ${safeText(session.currentTrack.artist, 150)}`);
        } else {
            await sendTempMessage(textChannel, `ℹ️ ${userMention} Nenhuma música tocando no momento.`);
        }
        return null;
    }

    if (toolName === 'radio_leave_call') {
        const { leaveRadioCall } = require('./radioManager');
        await leaveRadioCall(guildId, textChannel, client);
        return null;
    }

    if (toolName === 'radio_unknown_command') {
        return null;
    }

    await sendTempMessage(textChannel, `❓ ${userMention} Não entendi, tente de novo!`);
    return null;
}

module.exports = { handleRadioMCPCall };
