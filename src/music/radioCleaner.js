const fs = require('node:fs');
const path = require('node:path');
const { getAllSessions } = require('./radioDatabase');

const TEMP_RADIO_DIR = path.join(__dirname, 'data', 'temp_radio_audio');
fs.mkdirSync(TEMP_RADIO_DIR, { recursive: true });

function cleanTempRadioAudio(maxAgeMs = 15 * 60 * 1000) {
    const activePaths = new Set(getAllSessions().flatMap(session =>
        session.playlist.filter(track => track.localPath).map(track => path.resolve(track.localPath))));
    try {
        for (const name of fs.readdirSync(TEMP_RADIO_DIR)) {
            const file = path.join(TEMP_RADIO_DIR, name);
            if (activePaths.has(file)) continue;
            try {
                const stat = fs.lstatSync(file);
                if (Date.now() - stat.mtimeMs <= maxAgeMs) continue;
                if (stat.isFile()) fs.unlinkSync(file);
                else if (stat.isDirectory() && name.startsWith('.download-')) {
                    fs.rmSync(file, { recursive: true, force: true });
                }
            } catch (_) {}
        }
    } catch (_) {}
}

function startAutoCleaner(intervalMs = 10 * 60 * 1000) {
    cleanTempRadioAudio();
    return setInterval(cleanTempRadioAudio, intervalMs).unref();
}

startAutoCleaner();

module.exports = { TEMP_RADIO_DIR, cleanTempRadioAudio, startAutoCleaner };
