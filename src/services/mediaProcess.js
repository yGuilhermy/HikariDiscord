const { spawn } = require('node:child_process');

class MediaError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function runMediaProcess(command, args, { signal, timeout = 120000, env } = {}) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const grouped = process.platform !== 'win32';
        const child = spawn(command, args, {
            detached: grouped, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env
        });
        let stdout = '';
        let stderr = '';
        let failure;
        const terminate = error => {
            if (failure) return;
            failure = error;
            try {
                if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL');
                else if (child.pid) {
                    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
                    killer.once('error', () => child.kill('SIGKILL'));
                }
            } catch (error) {
                if (error.code !== 'ESRCH') child.kill('SIGKILL');
            }
        };
        const abort = () => terminate(signal.reason);
        const timer = setTimeout(() => terminate(new MediaError('MEDIA_TIMEOUT', 'O processamento da mídia excedeu o prazo.')), timeout);
        signal?.addEventListener('abort', abort, { once: true });

        child.stdout.on('data', data => { stdout = (stdout + data).slice(-2097152); });
        child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
        child.on('error', error => { failure ||= error; });
        child.once('close', code => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (failure) return reject(failure);
            if (code === 0) return resolve({ stdout, stderr });
            const error = new MediaError('MEDIA_PROCESS_FAILED', 'O processo de mídia terminou sem concluir a operação.');
            error.stderr = stderr;
            reject(error);
        });
    });
}

function createMediaPool(limit, maxPending, maxWait) {
    let active = 0;
    const pending = [];
    function drain() {
        while (active < limit && pending.length) {
            const job = pending.shift();
            job.signal.removeEventListener('abort', job.cancel);
            if (job.signal.aborted) {
                job.reject(job.signal.reason);
                continue;
            }
            active++;
            Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => {
                active--;
                drain();
            });
        }
    }
    function submit(signal, work) {
        signal?.throwIfAborted();
        if (active >= limit && pending.length >= maxPending) {
            return Promise.reject(new MediaError('MEDIA_BUSY', 'A fila de mídia está cheia. Tente novamente em instantes.'));
        }
        const deadline = AbortSignal.timeout(maxWait);
        const waiting = signal ? AbortSignal.any([signal, deadline]) : deadline;
        return new Promise((resolve, reject) => {
            const job = { signal: waiting, resolve, reject, work };
            job.cancel = () => {
                const index = pending.indexOf(job);
                if (index >= 0) pending.splice(index, 1);
                reject(signal?.aborted ? signal.reason : new MediaError('MEDIA_TIMEOUT', 'O pedido ficou tempo demais na fila de mídia.'));
            };
            waiting.addEventListener('abort', job.cancel, { once: true });
            pending.push(job);
            drain();
        });
    }
    return { submit, busy: () => active >= limit };
}

const downloads = createMediaPool(2, 12, 60000);
function withDownloadSlot(signal, work) {
    return downloads.submit(signal, () => {
        const deadline = AbortSignal.timeout(180000);
        return work(signal ? AbortSignal.any([signal, deadline]) : deadline);
    });
}

module.exports = { MediaError, runMediaProcess, createMediaPool, withDownloadSlot };
