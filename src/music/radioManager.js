const {
    joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState, EndBehaviorType
} = require('@discordjs/voice');
const { PermissionFlagsBits } = require('discord.js');
const { randomUUID } = require('node:crypto');
const prism = require('prism-media');
const { checkBan } = require('../handlers/banHandler');
const { transcribeAudio } = require('../services/sttService');
const { createSession, getSession, destroySession, setSessionHybridMode } = require('./radioDatabase');
const { stopPlayer, updateEmbed, deletePanel } = require('./radioAudioPlayer');
const { cleanupSessionAudioFiles } = require('./radioPrefetcher');
const { sessionMatches, cancelSearches } = require('./radioSearch');
const { parseRadioIntent } = require('./radioIntentEngine');
const radioMCPTools = require('./radioMCPTools.json');

const starts = new Map();
const voiceCooldownMs = 60000;
const maxCaptureBytes = 48000 * 2 * 2 * 30;
const RADIO_TRIGGER_REGEX = /\b(hikari|hikare|hikary|hikarii|hikarie|hikaris|hicari|hicare|hicary|hicarii|hicaris|hikario|hicario|hikaru|hicaru|hikar|hicar|ikari|ikare|ikary|ikarii|ikaris|icari|icare|icaro|icary|icarii|icaris|icara|icaras|icaros|ikario|icario|ikaru|icaru|ikar|icar|ricardo|ricard|ricardi|ricari|ricare|rikari|rikare|ricario|ricarto|recari|recaro|ricar|ricardin|ricardinho|ficari|ficare|vicari|vicare|ficardo|vicardo|dicari|dicare|kikari|kicari|ticari|ih\s*cari|e\s*cari|eh\s*cari|i\s*cari|re\s*cari|ri\s*cari|hi\s*cari|he\s*cari|a\s*cari|o\s*cari|ei\s*cari|oh\s*cari|oi\s*cari)\b/i;
const ignoredTranscripts = [
    'legendas pela comunidade', 'subtítulos', 'subtitulos', 'obrigado por assistir',
    'inscreva-se', 'curta e compartilhe', 'amara.org'
];

function createWavHeader(pcmLength, sampleRate = 48000, numChannels = 2, bitsPerSample = 16) {
    const header = Buffer.alloc(44);
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcmLength, 40);
    return header;
}

function calculatePcmRms(pcmBuffer) {
    if (!pcmBuffer || pcmBuffer.length < 2) return 0;
    const numSamples = Math.floor(pcmBuffer.length / 2);
    let sumSquares = 0;
    for (let i = 0; i < numSamples; i++) {
        const sample = pcmBuffer.readInt16LE(i * 2);
        sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / numSamples);
}

async function connectRadio(member, textChannel, client, isHybrid) {
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) return { success: false, error: 'Entre em um canal de voz primeiro.' };
    const guildId = voiceChannel.guild.id;
    const pending = starts.get(guildId);
    if (pending) {
        await pending.catch(() => {});
        return connectRadio(member, textChannel, client, isHybrid);
    }
    const work = openRadio(voiceChannel, textChannel, client, isHybrid);
    starts.set(guildId, work);
    try {
        return await work;
    } finally {
        if (starts.get(guildId) === work) starts.delete(guildId);
    }
}

async function openRadio(voiceChannel, textChannel, client, isHybrid) {
    const { guild } = voiceChannel;
    const guildId = guild.id;
    const permissions = voiceChannel.permissionsFor(guild.members.me);
    const required = [
        [PermissionFlagsBits.ViewChannel, 'Ver canal'],
        [PermissionFlagsBits.Connect, 'Conectar'],
        [PermissionFlagsBits.Speak, 'Falar']
    ];
    const missing = required.find(([flag]) => !permissions?.has(flag));
    if (missing) return { success: false, error: 'Não tenho a permissão `' + missing[1] + '` neste canal.' };

    let connection = getVoiceConnection(guildId);
    const current = getSession(guildId);
    if (current && !current._leaving) {
        if (current.voiceChannelId !== voiceChannel.id) {
            return { success: false, error: 'Já existe uma sessão de rádio em outro canal de voz.' };
        }
        if (connection?.state.status === VoiceConnectionStatus.Ready) {
            if (current.isHybrid !== isHybrid) setSessionHybridMode(guildId, isHybrid);
            const panel = await updateEmbed(guildId, textChannel, client, { move: true });
            return panel ? { success: true } : { success: false, error: 'Não consegui publicar o painel neste canal.' };
        }
        await closeSession(current, textChannel, client);
    }

    const alreadyConnected = connection?.state.status === VoiceConnectionStatus.Ready &&
        connection.joinConfig.channelId === voiceChannel.id;
    if (!alreadyConnected && voiceChannel.userLimit > 0 && voiceChannel.members.size >= voiceChannel.userLimit &&
        !permissions.has(PermissionFlagsBits.MoveMembers)) {
        return { success: false, error: 'O canal de voz está lotado.' };
    }
    if (!isHybrid || !alreadyConnected) {
        if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
        connection = joinVoiceChannel({
            channelId: voiceChannel.id, guildId, adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false, selfMute: false
        });
    }
    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15000);
    } catch (_) {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
        return { success: false, error: 'A conexão ao canal de voz falhou ou excedeu o tempo limite.' };
    }

    const session = createSession(guildId, voiceChannel.id, textChannel.id, isHybrid);
    session.voiceDisabled = require('../handlers/llmHandler').isToolDisabled(guildId, 'radio_voice_stt');
    session.closeReceiver = setupRadioVoiceReceiver(connection, guildId, textChannel, client, voiceChannel);
    const disconnected = () => {
        if (sessionMatches(session)) void closeSession(session, textChannel, client, connection);
    };
    connection.once(VoiceConnectionStatus.Disconnected, disconnected);
    connection.once(VoiceConnectionStatus.Destroyed, disconnected);
    session.detachConnection = () => {
        connection.off(VoiceConnectionStatus.Disconnected, disconnected);
        connection.off(VoiceConnectionStatus.Destroyed, disconnected);
    };
    session.emptyTimer = setInterval(() => {
        if (sessionMatches(session) && !voiceChannel.members.some(member => !member.user.bot)) disconnected();
    }, 10000).unref();

    const panel = await updateEmbed(guildId, textChannel, client);
    if (!panel) {
        await closeSession(session, textChannel, client, connection);
        return { success: false, error: 'Não consegui publicar o painel neste canal.' };
    }
    return { success: true };
}

function startRadioMode(member, textChannel, client) {
    return connectRadio(member, textChannel, client, false);
}

function startHybridMode(member, textChannel, client) {
    return connectRadio(member, textChannel, client, true);
}

async function setupCooldown(session, textChannel, client) {
    if (session.voiceCooldownUntil > Date.now()) return;
    session.voiceCooldownUntil = Date.now() + voiceCooldownMs;
    clearTimeout(session.cooldownTimer);
    session.cooldownTimer = setTimeout(() => {
        if (!sessionMatches(session)) return;
        session.voiceCooldownUntil = 0;
        void updateEmbed(session.guildId, textChannel, client);
    }, voiceCooldownMs).unref();
    await updateEmbed(session.guildId, textChannel, client);
}

function setupRadioVoiceReceiver(connection, guildId, textChannel, client, voiceChannel) {
    const receiver = connection.receiver;
    const captures = new Map();
    const recentCommands = new Map();

    function onSpeaking(userId) {
        const session = getSession(guildId);
        const { isToolDisabled } = require('../handlers/llmHandler');
        const enabled = () => session && sessionMatches(session) && session.voiceMode !== 'OFF' &&
            session.voiceCooldownUntil <= Date.now() && !isToolDisabled(guildId, 'radio_voice_stt') &&
            !checkBan(userId, guildId, session.textChannelId) && !checkBan(userId, guildId, session.voiceChannelId);
        if (!enabled() || captures.has(userId)) return;
        const member = voiceChannel.members.get(userId);
        if (!member || member.user.bot || member.voice.selfMute || member.voice.serverMute) return;

        const opus = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1200 } });
        const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
        const chunks = [];
        let bytes = 0;
        const cleanup = () => {
            if (captures.get(userId) === cleanup) captures.delete(userId);
            opus.destroy();
            decoder.destroy();
        };
        captures.set(userId, cleanup);
        opus.on('error', cleanup);
        decoder.on('error', cleanup);
        decoder.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > maxCaptureBytes) cleanup();
            else chunks.push(chunk);
        });
        decoder.once('end', async () => {
            try {
                const { isBotPaused } = require('../handlers/ownerCommandHandler');
                if (!enabled() || isBotPaused() || bytes < 9600) return;
                const pcm = Buffer.concat(chunks, bytes);
                if (calculatePcmRms(pcm) < 250) return;
                const result = await transcribeAudio(Buffer.concat([createWavHeader(bytes), pcm]));
                if (!enabled() || !voiceChannel.members.has(userId)) return;
                if (result?.isRateLimit) {
                    await setupCooldown(session, textChannel, client);
                    return;
                }
                if (typeof result !== 'string' || ignoredTranscripts.some(text => result.toLowerCase().includes(text))) return;
                const trigger = result.match(RADIO_TRIGGER_REGEX);
                if (!trigger) return;
                const prompt = result.slice(trigger.index + trigger[0].length).replace(/^[,\s.!?-]+/, '').trim();
                const now = Date.now();
                if (prompt.length < 2 || now - (recentCommands.get(userId) || 0) < 3000) return;
                recentCommands.set(userId, now);
                const channel = client?.channels?.cache?.get(session.textChannelId) || textChannel;
                await processVoiceCommand(session, prompt, member, channel, client);
            } catch (error) {
                console.error('[RadioVoice] Falha ao tratar fala:', error.code || error.name);
            } finally {
                cleanup();
            }
        });
        opus.pipe(decoder);
    }

    receiver.speaking.on('start', onSpeaking);
    return () => {
        receiver.speaking.off('start', onSpeaking);
        for (const cleanup of captures.values()) cleanup();
        recentCommands.clear();
    };
}

const directTools = {
    STOP: 'radio_stop_music', LEAVE: 'radio_leave_call', NEXT: 'radio_next_track',
    PREVIOUS: 'radio_prev_track', SHUFFLE: 'radio_toggle_shuffle', LOOP: 'radio_set_repeat',
    QUEUE: 'radio_show_queue', INFO: 'radio_get_current', REMOVE: 'radio_remove_track',
    ADD: 'radio_play_music', PAUSE: 'radio_pause_resume', RESUME: 'radio_pause_resume'
};

async function processVoiceCommand(session, prompt, member, channel, client) {
    const { guildId, voiceMode } = session;
    const { id: userId, username, tag } = member.user;
    if (voiceMode === 'DIRECT' || voiceMode === 'MUSIC_DIRECT') {
        const intent = parseRadioIntent(prompt);
        if (!intent) return;
        const { type, ...args } = intent;
        if (type === 'PAUSE' || type === 'RESUME') args.action = type.toLowerCase();
        const { handleRadioMCPCall } = require('./radioMCPHandler');
        const result = await handleRadioMCPCall(directTools[type], args, userId, guildId, channel, client, session.id);
        if (result && sessionMatches(session)) await channel.send({ content: result, allowedMentions: { parse: [] } });
        return;
    }

    const radioMode = voiceMode === 'IA' || voiceMode === 'MUSIC_IA';
    const hybridMode = voiceMode === 'HYBRID';
    const { addToQueue } = require('../handlers/llmHandler');
    const context = {
        id: 'radio_voice_' + randomUUID(), isVoice: true, content: prompt,
        isRadioMode: radioMode, radioGuildId: guildId, radioTextChannel: channel,
        radioClient: client, radioUserId: userId, radioSessionId: session.id,
        isHybridVoice: hybridMode, hybridGuildId: guildId, hybridTextChannel: channel,
        hybridClient: client, hybridUserId: userId,
        author: { id: userId, username, tag, bot: false },
        guild: channel.guild, guildId, channel, channelId: channel.id,
        mentions: { has: () => false, everyone: false },
        reply: async payload => {
            if (!sessionMatches(session)) return null;
            return channel.send(typeof payload === 'string' ? { content: payload } : payload);
        }
    };
    await addToQueue(prompt, context, 'mention', {
        radioMode, hybridMode, isHybridVoice: hybridMode,
        radioMCPTools: radioMode || hybridMode ? radioMCPTools : undefined, guildId, userId
    });
}

async function closeSession(session, textChannel, client, connection = getVoiceConnection(session.guildId)) {
    if (!sessionMatches(session)) return;
    session._leaving = true;
    clearInterval(session.emptyTimer);
    clearTimeout(session.cooldownTimer);
    session.detachConnection?.();
    session.closeReceiver?.();
    stopPlayer(session.guildId);
    cancelSearches(session);
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    cleanupSessionAudioFiles(session);
    destroySession(session.guildId);
    await deletePanel(session, textChannel, client);
}

async function leaveRadioCall(guildId, textChannel, client) {
    const session = getSession(guildId);
    if (!session) return false;
    await closeSession(session, textChannel, client);
    return true;
}

module.exports = { startRadioMode, startHybridMode, leaveRadioCall, setupRadioVoiceReceiver };
