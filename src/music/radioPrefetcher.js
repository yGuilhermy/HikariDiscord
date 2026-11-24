const fs = require('node:fs');
const { getSession, peekNextTrack } = require('./radioDatabase');
const { downloadTrackToDisk, resolvePlaybackTrack } = require('./radioProviders');

const downloads = new Map();

function sourceKey(track) {
    return JSON.stringify([track.source, track.link || track.id || track.title, track.artist, !!track.preferDeezer]);
}

function getDownloads(session) {
    if (!downloads.has(session)) downloads.set(session, new Map());
    return downloads.get(session);
}

function getTrackAudio(guildId, track, signal, { existingOnly = false, source } = {}) {
    const session = getSession(guildId);
    if (!session || session._leaving || signal?.aborted) {
        return existingOnly ? null : Promise.reject(signal?.reason || new Error('Sessão de rádio encerrada.'));
    }
    const key = sourceKey(track);
    const cached = session.playlist.find(entry =>
        entry.localPath && sourceKey(entry) === key && fs.existsSync(entry.localPath));
    if (cached) {
        track.localPath = cached.localPath;
        return Promise.resolve(cached.localPath);
    }

    const jobs = getDownloads(session);
    let job = jobs.get(key);
    if (job?.controller.signal.aborted) job = null;
    if (!job && existingOnly) return null;

    if (!job) {
        const controller = new AbortController();
        const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(signal ? 60000 : 35000)]);
        job = { controller, foreground: !!signal };
        const current = job;
        job.promise = (async () => {
            const target = source || await resolvePlaybackTrack(track, deadline);
            const file = await downloadTrackToDisk(target, { signal: deadline });
            if (deadline.aborted || getSession(guildId) !== session || session._leaving) {
                await fs.promises.unlink(file).catch(() => {});
                deadline.throwIfAborted();
                throw new Error('Sessão de rádio encerrada.');
            }
            for (const entry of session.playlist) {
                if (sourceKey(entry) === key) entry.localPath = file;
            }
            return file;
        })().finally(() => {
            if (jobs.get(key) === current) jobs.delete(key);
            if (!jobs.size && downloads.get(session) === jobs) downloads.delete(session);
        });
        jobs.set(key, job);
    }

    if (!signal) return job.promise;
    job.foreground = true;
    const controller = job.controller;
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return job.promise.finally(() => signal.removeEventListener('abort', abort));
}

async function prefetchNextTrack(guildId) {
    const session = getSession(guildId);
    if (!session) return;
    const track = ['PLAYING', 'PAUSED'].includes(session.status) ? peekNextTrack(guildId) : null;
    const key = track && track !== session.currentTrack ? sourceKey(track) : null;
    for (const [jobKey, job] of downloads.get(session) || []) {
        if (!job.foreground && jobKey !== key) job.controller.abort();
    }
    if (!key) return;
    try {
        await getTrackAudio(guildId, track);
    } catch (_) {}
}

function cancelPrefetch(guildId) {
    const jobs = downloads.get(getSession(guildId));
    for (const job of jobs?.values() || []) job.controller.abort();
}

function cleanupSessionAudioFiles(session) {
    for (const entry of session.playlist) {
        if (entry.localPath) {
            try { fs.unlinkSync(entry.localPath); } catch (_) {}
        }
    }
}

module.exports = { getTrackAudio, prefetchNextTrack, cancelPrefetch, cleanupSessionAudioFiles };
