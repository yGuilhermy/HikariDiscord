const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');

const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'radio_guild_settings.json');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const sessions = new Map();
let guildSettingsMap = new Map();

function _loadGuildSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
            guildSettingsMap = new Map(Object.entries(data));
        }
    } catch (_) {}
}

function _saveGuildSettings() {
    try {
        const obj = {};
        guildSettingsMap.forEach((v, k) => { obj[k] = v; });
        const temporaryFile = SETTINGS_FILE + '.tmp';
        fs.writeFileSync(temporaryFile, JSON.stringify(obj, null, 2), { mode: 0o600 });
        fs.renameSync(temporaryFile, SETTINGS_FILE);
    } catch (error) {
        try { fs.unlinkSync(SETTINGS_FILE + '.tmp'); } catch (_) {}
        console.error('[RadioDatabase] Não foi possível salvar as preferências do rádio:', error.code || error.message);
    }
}

_loadGuildSettings();

function getGuildSavedSettings(guildId) {
    return guildSettingsMap.get(guildId) || null;
}

function saveGuildSavedSettings(guildId, patch) {
    const current = guildSettingsMap.get(guildId) || {};
    const updated = { ...current, ...patch };
    guildSettingsMap.set(guildId, updated);
    _saveGuildSettings();
}

function _generateShuffleOrder(session) {
    if (!session || !Array.isArray(session.playlist) || session.playlist.length === 0) {
        session.shuffleOrder = [];
        session.shufflePos = -1;
        return;
    }
    const total = session.playlist.length;
    const current = session.currentIndex;
    const remaining = [];
    for (let i = 0; i < total; i++) {
        if (i !== current) remaining.push(i);
    }
    for (let i = remaining.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }
    session.shuffleOrder = current >= 0 ? [current, ...remaining] : remaining;
    session.shufflePos = current >= 0 ? 0 : -1;
}

function _syncLegacyFields(session) {
    if (!session) return;
    if (!Array.isArray(session.playlist)) session.playlist = [];
    if (typeof session.currentIndex !== 'number') session.currentIndex = -1;
    if (!Array.isArray(session.shuffleOrder)) session.shuffleOrder = [];
    if (typeof session.shufflePos !== 'number') session.shufflePos = -1;
    session.isHybrid = !!session.isHybrid;
    if (session.isHybrid) {
        const validModes = ['HYBRID', 'CHAT_ONLY', 'MUSIC_DIRECT', 'MUSIC_IA', 'OFF'];
        if (!session.voiceMode || !validModes.includes(session.voiceMode)) {
            session.voiceMode = session.voiceListening === false ? 'OFF' : 'HYBRID';
        }
    } else {
        const validModes = ['DIRECT', 'IA', 'OFF'];
        if (!session.voiceMode || !validModes.includes(session.voiceMode)) {
            session.voiceMode = session.voiceListening === false ? 'OFF' : 'DIRECT';
        }
    }
    session.voiceListening = (session.voiceMode !== 'OFF');
    if (!session.streamMode) session.streamMode = 'HYBRID';

    if (session.status === 'STOPPED') {
        session.currentTrack = null;
    } else {
        session.currentTrack = (session.currentIndex >= 0 && session.currentIndex < session.playlist.length) 
            ? session.playlist[session.currentIndex] 
            : null;
    }
    const order = playbackOrder(session);
    const cursor = session.shuffle ? session.shufflePos : session.currentIndex;
    session.history = order.slice(0, Math.max(0, cursor)).map(index => session.playlist[index]);
    session.queue = order.slice(Math.max(0, cursor + 1)).map(index => session.playlist[index]);
}

function createSession(guildId, voiceChannelId, textChannelId, isHybrid = false) {
    const saved = getGuildSavedSettings(guildId) || {};
    const defaultVoiceMode = isHybrid ? (saved.hybridVoiceMode || 'HYBRID') : (saved.voiceMode || 'DIRECT');
    const session = {
        id: randomUUID(),
        guildId,
        voiceChannelId,
        textChannelId,
        embedMessageId: null,
        status: 'STOPPED',
        loopMode: 'OFF',
        shuffle: false,
        shuffleOrder: [],
        shufflePos: -1,
        isHybrid: !!isHybrid,
        voiceMode: defaultVoiceMode,
        voiceListening: defaultVoiceMode !== 'OFF',
        streamMode: saved.streamMode || 'HYBRID',
        currentIndex: -1,
        playlist: [],
        listeners: [],
        exhausted: false,
        playbackError: null,
        voiceCooldownUntil: 0
    };
    _syncLegacyFields(session);
    sessions.set(guildId, session);
    return session;
}

function getSession(guildId) {
    const s = sessions.get(guildId);
    if (s) _syncLegacyFields(s);
    return s || null;
}

function updateSession(guildId, patch) {
    const s = sessions.get(guildId);
    if (!s) return null;
    const { currentTrack, ...fields } = patch;
    if (currentTrack?.localPath && s.playlist[s.currentIndex] && (!currentTrack.entryId || s.playlist[s.currentIndex].entryId === currentTrack.entryId)) {
        s.playlist[s.currentIndex].localPath = currentTrack.localPath;
    }
    Object.assign(s, fields);
    _syncLegacyFields(s);
    if (patch.voiceMode !== undefined || patch.streamMode !== undefined || patch.isHybrid !== undefined) {
        saveGuildSavedSettings(guildId, {
            ...(patch.voiceMode !== undefined && (s.isHybrid ? { hybridVoiceMode: patch.voiceMode } : { voiceMode: patch.voiceMode })),
            ...(patch.streamMode !== undefined && { streamMode: patch.streamMode })
        });
    }
    return s;
}

function destroySession(guildId) {
    sessions.delete(guildId);
}

function hasActiveSession(guildId) {
    return sessions.has(guildId);
}

function addTrackToQueue(guildId, track) {
    const s = sessions.get(guildId);
    if (!s) return null;
    if (!Array.isArray(s.playlist)) s.playlist = [];
    s.playlist.push({ ...track, entryId: randomUUID() });
    const newIdx = s.playlist.length - 1;
    if (s.shuffle && Array.isArray(s.shuffleOrder)) {
        const unplayedRange = Math.max(0, s.shuffleOrder.length - s.shufflePos - 1);
        const insertOffset = Math.floor(Math.random() * (unplayedRange + 1));
        s.shuffleOrder.splice(s.shufflePos + 1 + insertOffset, 0, newIdx);
    }
    _syncLegacyFields(s);
    return s.playlist.length;
}

function skipToTrack(guildId, position) {
    const s = sessions.get(guildId);
    if (!s || !Array.isArray(s.playlist)) return null;
    const targetIdx = position - 1;
    if (!Number.isInteger(targetIdx) || targetIdx < 0 || targetIdx >= s.playlist.length) return null;
    s.currentIndex = targetIdx;
    s.status = 'BUFFERING';
    s.exhausted = false;
    s.playbackError = null;
    if (s.shuffle) {
        _generateShuffleOrder(s);
    }
    _syncLegacyFields(s);
    return s;
}

function playbackOrder(session) {
    return session.shuffle ? session.shuffleOrder : session.playlist.map((_, index) => index);
}

function nextIndex(session, { reason = 'manual', excluded = new Set() } = {}) {
    const { playlist, currentIndex, loopMode } = session;
    if (reason === 'ended' && loopMode === 'TRACK' && playlist[currentIndex]) return currentIndex;

    const order = playbackOrder(session);
    const cursor = session.shuffle ? session.shufflePos : currentIndex;
    const candidates = order.slice(cursor + 1);
    if (loopMode === 'QUEUE') candidates.push(...order.slice(0, cursor + 1));
    return candidates.find(index => playlist[index] && !excluded.has(playlist[index].entryId)) ?? -1;
}

function peekNextTrack(guildId, options = { reason: 'ended' }) {
    const session = sessions.get(guildId);
    return session?.playlist[nextIndex(session, options)] ?? null;
}

function canGoPrevious(session) {
    return (session.shuffle ? session.shufflePos : session.currentIndex) > 0;
}

function playedIndices(session) {
    const cursor = session.shuffle ? session.shufflePos : session.currentIndex;
    return new Set(playbackOrder(session).slice(0, session.exhausted ? undefined : Math.max(0, cursor)));
}

function selectTrack(session, index) {
    session.currentIndex = index;
    if (session.shuffle) session.shufflePos = session.shuffleOrder.indexOf(index);
    session.status = 'BUFFERING';
    session.exhausted = false;
    session.playbackError = null;
    _syncLegacyFields(session);
    return session.currentTrack;
}

function firstTrack(guildId) {
    const session = sessions.get(guildId);
    if (!session?.playlist.length) return null;
    if (session.shuffle) {
        session.currentIndex = -1;
        _generateShuffleOrder(session);
    }
    return selectTrack(session, playbackOrder(session)[0]);
}

function nextTrack(guildId, options = {}) {
    const session = sessions.get(guildId);
    if (!session?.playlist.length) return null;
    const index = nextIndex(session, options);
    if (index >= 0) return selectTrack(session, index);
    if (options.reason === 'ended' || options.reason === 'failed') {
        session.status = 'STOPPED';
        session.exhausted = true;
        _syncLegacyFields(session);
    }
    return null;
}

function prevTrack(guildId) {
    const session = sessions.get(guildId);
    if (!session || !canGoPrevious(session)) return null;
    const cursor = session.shuffle ? session.shufflePos : session.currentIndex;
    return selectTrack(session, playbackOrder(session)[cursor - 1]);
}

function setLoopMode(guildId) {
    const s = sessions.get(guildId);
    if (!s) return null;
    const modes = ['OFF', 'TRACK', 'QUEUE'];
    const idx = modes.indexOf(s.loopMode);
    s.loopMode = modes[(idx + 1) % modes.length];
    return s.loopMode;
}

function toggleShuffle(guildId) {
    const s = sessions.get(guildId);
    if (!s) return null;
    s.shuffle = !s.shuffle;
    if (s.shuffle) {
        _generateShuffleOrder(s);
    } else {
        s.shuffleOrder = [];
        s.shufflePos = 0;
    }
    return s.shuffle;
}

function toggleVoiceListening(guildId) {
    const s = sessions.get(guildId);
    if (!s) return null;
    s.voiceListening = !s.voiceListening;
    s.voiceMode = s.voiceListening ? 'IA' : 'OFF';
    saveGuildSavedSettings(guildId, { voiceMode: s.voiceMode });
    return s.voiceListening;
}

function cycleVoiceMode(guildId) {
    const s = sessions.get(guildId);
    if (!s) return null;
    if (s.isHybrid) {
        const modes = ['HYBRID', 'CHAT_ONLY', 'MUSIC_DIRECT', 'MUSIC_IA', 'OFF'];
        const currentMode = s.voiceMode || (s.voiceListening ? 'HYBRID' : 'OFF');
        const currentIdx = modes.indexOf(currentMode);
        const nextMode = modes[(currentIdx + 1) % modes.length];
        s.voiceMode = nextMode;
        s.voiceListening = (nextMode !== 'OFF');
        saveGuildSavedSettings(guildId, { hybridVoiceMode: s.voiceMode });
            return s.voiceMode;
    } else {
        const modes = ['OFF', 'IA', 'DIRECT'];
        const currentMode = s.voiceMode || (s.voiceListening ? 'IA' : 'OFF');
        const currentIdx = modes.indexOf(currentMode);
        const nextMode = modes[(currentIdx + 1) % modes.length];
        s.voiceMode = nextMode;
        s.voiceListening = (nextMode !== 'OFF');
        saveGuildSavedSettings(guildId, { voiceMode: s.voiceMode });
            return s.voiceMode;
    }
}

function setSessionHybridMode(guildId, isHybrid) {
    const s = sessions.get(guildId);
    if (!s) return null;
    s.isHybrid = !!isHybrid;
    if (s.isHybrid) {
        const saved = getGuildSavedSettings(guildId) || {};
        s.voiceMode = saved.hybridVoiceMode || 'HYBRID';
        s.voiceListening = (s.voiceMode !== 'OFF');
    } else {
        const saved = getGuildSavedSettings(guildId) || {};
        s.voiceMode = saved.voiceMode || 'DIRECT';
        s.voiceListening = (s.voiceMode !== 'OFF');
    }
    _syncLegacyFields(s);
    return s;
}

function getAllSessions() {
    return Array.from(sessions.values());
}

function stopRadio(guildId) {
    const session = sessions.get(guildId);
    if (!session) return null;
    session.status = 'STOPPED';
    session.currentIndex = -1;
    session.exhausted = false;
    session.playbackError = null;
    if (session.shuffle) _generateShuffleOrder(session);
    _syncLegacyFields(session);
    return session;
}

function removeTrackFromPlaylist(guildId, position) {
    const session = sessions.get(guildId);
    const index = position - 1;
    if (!session || !Number.isInteger(index) || !session.playlist[index]) return null;

    const { currentIndex, status } = session;
    const isCurrent = index === currentIndex && status !== 'STOPPED';
    const orderIndex = session.shuffle ? session.shuffleOrder.indexOf(index) : index;
    const [removedTrack] = session.playlist.splice(index, 1);
    if (session.shuffle) {
        session.shuffleOrder.splice(orderIndex, 1);
        session.shuffleOrder = session.shuffleOrder.map(i => i > index ? i - 1 : i);
        if (orderIndex <= session.shufflePos) session.shufflePos--;
    }

    let newCurrentTrack = null;
    if (isCurrent) {
        const order = playbackOrder(session);
        const next = order[orderIndex] ?? (session.loopMode === 'QUEUE' ? order[0] : undefined);
        if (next !== undefined) {
            newCurrentTrack = selectTrack(session, next);
        } else {
            session.status = 'STOPPED';
            session.exhausted = session.playlist.length > 0;
            session.currentIndex = session.playlist.length - 1;
        }
    } else if (index <= currentIndex) {
        session.currentIndex--;
    }
    _syncLegacyFields(session);

    return { removedTrack, isCurrent, remainingCount: session.playlist.length, newCurrentTrack, previousStatus: status };
}

function toggleStreamMode(guildId) {
    const s = sessions.get(guildId);
    if (!s) return null;
    s.streamMode = s.streamMode === 'FAST' ? 'HYBRID' : 'FAST';
    saveGuildSavedSettings(guildId, { streamMode: s.streamMode });
    return s.streamMode;
}

module.exports = {
    createSession,
    getSession,
    updateSession,
    destroySession,
    hasActiveSession,
    addTrackToQueue,
    skipToTrack,
    peekNextTrack,
    nextTrack,
    firstTrack,
    canGoPrevious,
    playedIndices,
    prevTrack,
    setLoopMode,
    toggleShuffle,
    toggleVoiceListening,
    cycleVoiceMode,
    toggleStreamMode,
    setSessionHybridMode,
    getAllSessions,
    stopRadio,
    removeTrackFromPlaylist
};
