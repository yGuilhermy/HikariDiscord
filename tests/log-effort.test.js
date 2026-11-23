const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

for (const effort of ['0', '1', '2', 'invalid']) {
    test(`Discord LOG_EFFORT=${effort} filters terminal and webhook independently of raw log text`, () => {
        const cp = spawnSync(process.execPath, ['-e', `
            const axios = require('axios');
            const sent = [];
            axios.post = async (_, body) => { sent.push(body.content); };
            const logging = require('./src/utils/logger');
            logging.init('https://example.invalid/test');
            logging.logger.event('SYSTEM', 'online');
            logging.logger.event('WARN', 'api-failure', 'user-private-123 diagnostic-test-secret', 429);
            console.warn('prompt-private-456');
            logging.flush().then(() => process.stdout.write('SINK=' + JSON.stringify(sent) + '\\n'));
        `], {
            cwd: path.resolve(__dirname, '..'),
            env: { ...process.env, LOG_EFFORT: effort, GEMINI_API_KEY: 'diagnostic-test-secret' },
            encoding: 'utf8', timeout: 5000
        });
        assert.equal(cp.status, 0, cp.stderr);
        const [terminal, sink] = cp.stdout.split('SINK=');
        const messages = JSON.parse(sink).join('\n');
        assert.match(terminal, /Hikari conectada/);
        assert.ok(!cp.stdout.includes('diagnostic-test-secret'));
        if (effort === '0') {
            assert.equal(messages, '');
            assert.doesNotMatch(terminal, /429|user-private|prompt-private/);
        } else if (effort === '2') {
            for (const output of [terminal, messages]) {
                assert.match(output, /user-private-123/);
                assert.match(output, /prompt-private-456/);
            }
        } else {
            for (const output of [terminal, messages]) {
                assert.match(output, /HTTP 429/);
                assert.doesNotMatch(output, /user-private|prompt-private/);
            }
        }
    });
}
