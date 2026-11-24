const path = require('node:path');
const fs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const config = require('../config');

let dbPath = path.join(__dirname, '../data/ai_database.json');
const settings = { aiDbRead: true, aiDbWrite: true, aiDbEdit: true, aiDbDelete: true };
const officialKeys = new Set(['creator_info', 'hikari_info']);
const bulkKeys = new Set(['*', 'all', 'todos', 'tudo', 'todas', 'dump', 'banco', 'banco de dados', 'database', 'geral', 'global', 'completo', 'full']);
const metadata = new Set(['protected', 'important', 'salvo_por', 'savedById', 'savedByTag', 'updatedAt', 'recordId', 'subjectUserId']);

const archiveKey = '@memory_archive';
const retentionMs = 7 * 24 * 60 * 60 * 1000;
const maxRevisions = 5;

function setDatabasePath(customPath) { dbPath = customPath; }
function getDatabasePath() { return dbPath; }

function loadDatabase() {
    try {
        const data = JSON.parse(fs.readFileSync(dbPath, 'utf8').replace(/^\uFEFF/, ''));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Formato de memória inválido.');
        return data;
    } catch (error) {
        if (error.code === 'ENOENT') return Object.create(null);
        console.warn('[databaseHandler] Não foi possível carregar a memória:', error.message);
        return null;
    }
}

function saveDatabase(data) {
    pruneArchive(data);
    const temporary = path.join(path.dirname(dbPath), '.' + path.basename(dbPath) + '.' + randomUUID() + '.tmp');
    let fd;
    try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporary, dbPath);
        return true;
    } catch (error) {
        if (fd !== undefined) try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(temporary); } catch {}
        console.warn('[databaseHandler] Não foi possível gravar a memória:', error.message);
        return false;
    }
}

function getDbSettings() {
    return Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, value && config[key + 'Enabled'] !== false]));
}

function updateDbSetting(key, value) {
    if (!Object.hasOwn(settings, key)) return false;
    settings[key] = Boolean(value);
    return true;
}

function permitted(guildId, operation) {
    const flag = 'aiDb' + operation[0].toUpperCase() + operation.slice(1);
    if (!getDbSettings()[flag]) return false;
    if (!guildId) return true;
    try {
        const { isToolDisabled } = require('./llmHandler');
        return typeof isToolDisabled === 'function' && !isToolDisabled(guildId, 'db_' + operation);
    } catch {
        return false;
    }
}
const canRead = guildId => permitted(guildId, 'read');
const canWrite = guildId => canRead(guildId) && permitted(guildId, 'write');
const canEdit = guildId => canRead(guildId) && permitted(guildId, 'edit');
const canDelete = guildId => canRead(guildId) && permitted(guildId, 'delete');

function normalize(key) { return typeof key === 'string' ? key.trim().toLowerCase() : ''; }
function fold(value) { return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(); }
function isForbiddenKey(key) {
    const clean = normalize(key);
    return !clean || clean.length > 120 || /^@|[\x00-\x1f\x7f]/.test(clean) || ['__proto__', 'constructor', 'prototype'].includes(clean);
}
function isBulkQuery(key) { return bulkKeys.has(normalize(key)); }
function failure(error, message) { return { success: false, error, message }; }
function unavailable() { return failure('storage_unavailable', 'A memória está indisponível. Nenhuma alteração foi confirmada.'); }
function context(value) { return typeof value === 'boolean' ? { isOwner: value } : value || {}; }
function prefix(guildId, actor) {
    if (guildId) return '@guild:' + guildId + ':';
    if (actor.userId) return '@dm:' + actor.userId + ':';
    return '';
}

function owns(entry, actor) {
    const originalId = entry?.savedById || (typeof entry?.salvo_por === 'string' && entry.salvo_por.match(/ - (\d+)$/)?.[1]);
    return Boolean(originalId && actor.userId && String(originalId) === String(actor.userId));
}

function visibleEntries(data, guildId, actor) {
    const scope = prefix(guildId, actor);
    const entries = new Map();
    for (const [storageKey, entry] of Object.entries(data)) {
        const scoped = scope && storageKey.startsWith(scope);
        const legacy = !storageKey.startsWith('@');
        const official = legacy && officialKeys.has(normalize(storageKey)) && entry?.protected === true;
        const accessibleLegacy = legacy && !guildId && (actor.isOwner || owns(entry, actor));
        if (!scoped && !official && !accessibleLegacy) continue;
        const key = scoped ? storageKey.slice(scope.length) : storageKey;
        if (isForbiddenKey(key)) continue;
        const normalized = normalize(key);
        // Anotação do escopo atual tem prioridade sobre uma versão legada.
        if (!entries.has(normalized) || scoped) entries.set(normalized, { key, storageKey, entry });
    }
    return entries;
}

function publicData(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).filter(([key]) => !metadata.has(key)));
}

function format(entry) {
    const value = publicData(entry);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const fields = Object.entries(value);
        if (typeof value.content === 'string' && fields.every(([key]) => ['content', 'resumo'].includes(key))) return value.content;
        if (fields.length === 1 && typeof value.resumo === 'string') return value.resumo;
        return fields.map(([key, field]) => key + ': ' + (typeof field === 'object' ? JSON.stringify(field) : field)).join('\n');
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
}

function match(entries, key) {
    const query = fold(key);
    const candidates = [...entries.values()];
    const exactAndRelated = candidates.filter(({ key }) => {
        const candidate = fold(key);
        return candidate === query || ['_', '-', ' '].some(separator => candidate.startsWith(query + separator));
    });
    if (exactAndRelated.length) {
        const exact = entries.get(key);
        return exact ? [exact, ...exactAndRelated.filter(item => item !== exact)] : exactAndRelated;
    }
    if (query.length < 3) return [];
    const partial = candidates.filter(({ key }) => fold(key).includes(query));
    return partial.length ? partial : candidates.filter(({ entry }) => fold(format(entry) || '').includes(query));
}

function readDb(key, guildId = null, userContext = false) {
    if (!canRead(guildId)) return failure('disabled', 'A leitura da memória está desativada.');
    const clean = normalize(key);
    if (isForbiddenKey(clean)) return failure('reserved_key', 'Informe uma chave válida para consultar.');
    const actor = context(userContext);
    if (isBulkQuery(clean) && !actor.isOwner) return failure('bulk_denied', 'Informe um tópico específico para consultar.');
    const data = loadDatabase();
    if (!data) return unavailable();
    const entries = visibleEntries(data, guildId, actor);
    const official = officialKeys.has(clean);
    const matches = official ? [entries.get(clean)].filter(item => item?.entry?.protected === true)
        : isBulkQuery(clean) ? [...entries.values()].filter(item => !officialKeys.has(normalize(item.key)))
        : match(new Map([...entries].filter(([key]) => !officialKeys.has(key))), clean);
    if (!matches.length) return {
        ...failure('not_found', 'Nenhuma anotação encontrada para esse tópico.'),
        availableKeys: actor.isOwner ? [...entries.keys()] : []
    };
    if (matches.length > 8 && !isBulkQuery(clean)) return failure('too_many_matches', 'Encontrei muitos registros. Informe um tópico mais específico.');
    const selected = matches.slice(0, 8);
    if (selected.length === 1) {
        const [{ key, entry }] = selected;
        return { success: true, key, data: publicData(entry), formatted: format(entry), count: 1, isProtected: entry?.protected === true };
    }
    const formatted = selected.map(({ key, entry }) => 'Registro "' + key + '":\n' + format(entry)).join('\n\n');
    return {
        success: true, key: clean, data: Object.fromEntries(selected.map(({ key, entry }) => [key, publicData(entry)])),
        formatted, matchedKeys: selected.map(item => item.key), count: selected.length, isProtected: selected.some(item => item.entry?.protected === true)
    };
}

function pruneArchive(data, now = Date.now()) {
    if (!Array.isArray(data[archiveKey])) return false;
    const active = data[archiveKey].filter(item => item.expiresAt > now);
    if (active.length === data[archiveKey].length) return false;
    if (active.length) data[archiveKey] = active;
    else delete data[archiveKey];
    return true;
}

function archiveRecord(data, storageKey, record, recordId, deleted) {
    const now = Date.now();
    pruneArchive(data, now);
    const archive = data[archiveKey] ||= [];
    archive.unshift({ id: randomUUID(), storageKey, record, recordId, deleted, savedAt: now, expiresAt: now + retentionMs });
    const versions = archive.filter(item => item.recordId === recordId && !item.deleted);
    const expiredIds = new Set(versions.slice(maxRevisions).map(item => item.id));
    data[archiveKey] = archive.filter(item => !expiredIds.has(item.id));
}

function revision(storageKey, record) {
    return createHash('sha256').update(JSON.stringify([storageKey, record])).digest('hex');
}

function canChange(record, actor) {
    return actor.isOwner || (!record?.protected && (actor.isStaff || owns(record, actor)));
}

function author(entry) {
    return entry?.savedByTag || entry?.salvo_por?.split?.(' - ')?.[0] || 'Autoria não registrada';
}

function describe(key, storageKey, record) {
    return { key, content: format(record) || '', author: author(record), revision: revision(storageKey, record) };
}

function review(key, storageKey, record, extra = {}) {
    return { success: false, error: 'confirmation_required', review: { ...describe(key, storageKey, record), ...extra } };
}

function mutate(operation, key, content, options, guildId, actor, meta, approval = {}) {
    if (!operation.can(guildId)) return failure('disabled', 'Esta operação de memória está desativada.');
    const clean = normalize(key);
    if (isForbiddenKey(clean) || isBulkQuery(clean)) return failure('reserved_key', 'Informe a chave exata de uma anotação.');
    const data = loadDatabase();
    if (!data) return unavailable();
    const existing = visibleEntries(data, guildId, actor).get(clean);
    if (!existing && operation.name !== 'write') return failure('not_found', 'Nenhuma anotação encontrada com essa chave exata.');
    const record = existing?.entry;
    const protectedRecord = record?.protected === true;
    if ((protectedRecord || officialKeys.has(clean)) && !actor.isOwner) return failure('protected', 'Esta chave é reservada ao proprietário da instância.');
    if (existing && !canChange(record, actor)) {
        return failure('permission_denied', 'Apenas o autor, a moderação deste servidor ou o proprietário da instância podem alterar esta anotação.');
    }
    if (!existing && !actor.userId && !actor.isOwner) return failure('permission_denied', 'Não foi possível identificar o autor da anotação.');
    const storageKey = existing?.storageKey || (officialKeys.has(clean) ? clean : prefix(guildId, actor) + clean);
    const currentRevision = revision(storageKey, record);
    if (approval.expected && approval.expected !== currentRevision) {
        return failure('changed', 'A anotação mudou desde a revisão. Abra o painel novamente.');
    }
    const requiresReview = Boolean(existing && (approval.forceReview || operation.name !== 'edit'));
    if (operation.name === 'delete') {
        if (approval.requireReview && !approval.expected) return review(clean, storageKey, record);
        archiveRecord(data, storageKey, record, record?.recordId || randomUUID(), true);
        delete data[storageKey];
        return saveDatabase(data) ? { success: true, key: existing.key, message: 'Anotação excluída.' } : unavailable();
    }
    const text = typeof content === 'string' ? content.trim() : null;
    const objectContent = operation.name === 'write' && content && typeof content === 'object' && !Array.isArray(content);
    if (!text && !objectContent) return failure('invalid_content', 'Informe o conteúdo da anotação.');
    const next = operation.name === 'edit' && record && typeof record === 'object' && !Array.isArray(record) ? publicData(record) : {};
    if (objectContent) {
        const fields = publicData(content);
        if (!Object.keys(fields).length) return failure('invalid_content', 'Informe o conteúdo da anotação.');
        Object.assign(next, Object.fromEntries(Object.entries(fields).filter(([field]) => !isForbiddenKey(field))));
        if (!Object.keys(next).length) return failure('invalid_content', 'Informe o conteúdo da anotação.');
    } else {
        const previous = typeof record === 'string' ? record : record?.content || record?.resumo;
        next.content = options.append && previous ? String(previous) + '\n' + text : text;
        if (Object.hasOwn(next, 'resumo')) next.resumo = next.content;
    }
    if (JSON.stringify(next).length > 16000) return failure('invalid_content', 'A anotação excede o limite de tamanho.');
    if (approval.requireReview && requiresReview && !approval.expected) {
        return review(clean, storageKey, record, { replacement: format(next) });
    }
    const sourceRecordId = record?.recordId || randomUUID();
    if (existing) archiveRecord(data, storageKey, record, sourceRecordId, false);
    data[storageKey] = {
        ...next,
        recordId: sourceRecordId,
        subjectUserId: (existing ? owns(record, actor) : actor.userId) && options.subjectUserId === actor.userId
            ? actor.userId : null,
        protected: protectedRecord || officialKeys.has(clean),
        salvo_por: existing ? record?.salvo_por ?? null : meta.salvo_por ?? null,
        savedById: existing ? record?.savedById ?? null : actor.userId ?? null,
        savedByTag: existing ? record?.savedByTag ?? null : meta.userTag ?? meta.savedByTag ?? null,
        important: options.important ?? record?.important ?? false,
        updatedAt: new Date().toISOString()
    };
    const action = operation.name === 'edit' ? 'atualizada' : 'gravada';
    return saveDatabase(data) ? { success: true, key: existing?.key || clean, data: next, message: 'Anotação ' + action + '.' } : unavailable();
}

function writeDb(key, data, guildId = null, isOwner = false, meta = {}) {
    return mutate({ name: 'write', can: canWrite }, key, data, { important: meta.important }, guildId,
        { isOwner, isStaff: Boolean(guildId && (meta.isStaff || meta.isAdmin)), userId: meta.userId || meta.savedById }, meta);
}
function editDb(key, content, options = {}, guildId = null, userContext = {}, meta = {}) {
    const actor = context(userContext);
    return mutate({ name: 'edit', can: canEdit }, key, content, typeof options === 'boolean' ? { append: options } : options || {},
        guildId, { ...actor, userId: actor.userId || meta.userId, isStaff: Boolean(guildId && (actor.isStaff || actor.isAdmin)) }, meta);
}
function deleteDb(key, guildId = null, userContext = {}) {
    const actor = context(userContext);
    return mutate({ name: 'delete', can: canDelete }, key, null, {}, guildId,
        { ...actor, isStaff: Boolean(guildId && (actor.isStaff || actor.isAdmin)) }, {});
}

const operations = { write: canWrite, edit: canEdit, delete: canDelete };

function requestChange(operation, key, content, options, guildId, userContext, approval = {}) {
    if (!Object.hasOwn(operations, operation)) return failure('invalid_operation', 'Operação inválida.');
    const actor = context(userContext);
    const meta = { userTag: actor.userTag, salvo_por: actor.userTag ? actor.userTag + ' - ' + actor.userId : null };
    return mutate({ name: operation, can: operations[operation] }, key, content, options, guildId,
        { ...actor, isStaff: Boolean(guildId && actor.isStaff) }, meta, { requireReview: true, ...approval });
}

function archiveInScope(item, scope, guildId, actor) {
    if (scope && item.storageKey.startsWith(scope)) return true;
    return !guildId && !item.storageKey.startsWith('@') && (actor.isOwner || owns(item.record, actor));
}

function archiveDisplayKey(item, scope) {
    return scope && item.storageKey.startsWith(scope) ? item.storageKey.slice(scope.length) : item.storageKey;
}

function readPersonalNotes(guildId, actor) {
    if (!canRead(guildId)) return failure('disabled', 'A leitura da memória está desativada.');
    if (!actor?.userId) return failure('permission_denied', 'Não foi possível identificar o autor da mensagem.');
    const data = loadDatabase();
    if (!data) return unavailable();
    const scope = prefix(guildId, actor);
    const notes = Object.entries(data).filter(([key, entry]) => key.startsWith(scope) &&
        entry?.subjectUserId === actor.userId && owns(entry, actor)).slice(0, 8);
    if (!notes.length) return failure('not_found', 'Ainda não tenho uma anotação confirmada sobre seus gostos neste contexto.');
    return { success: true, formatted: notes.map(([, entry]) => format(entry)).join('\n').slice(0, 4000) };
}

function manageList(view, guildId, actor, query = '') {
    if (!canRead(guildId)) return failure('disabled', 'A leitura da memória está desativada.');
    const data = loadDatabase();
    if (!data) return unavailable();
    const scope = prefix(guildId, actor);
    const filter = fold(query.trim());
    let records;
    if (view === 'legacy') {
        if (!actor.isOwner || guildId) return failure('permission_denied', 'Abra o painel de legados em DM como dono da instância.');
        records = Object.entries(data).filter(([key, entry]) => !isForbiddenKey(key) && !entry?.protected && !officialKeys.has(normalize(key)))
            .map(([key, entry]) => describe(key, key, entry));
    } else if (view === 'trash' || view === 'history') {
        if (!scope) return failure('permission_denied', 'Não foi possível identificar esta conversa.');
        records = (data[archiveKey] || []).filter(item => item.expiresAt > Date.now() && item.deleted === (view === 'trash') &&
            archiveInScope(item, scope, guildId, actor) && canChange(item.record, actor))
            .map(item => ({ ...describe(archiveDisplayKey(item, scope), item.storageKey, item.record),
                id: item.id, savedAt: item.savedAt, expiresAt: item.expiresAt }));
    } else {
        const editEnabled = canEdit(guildId);
        const deleteEnabled = canDelete(guildId);
        records = [...visibleEntries(data, guildId, actor).values()].map(({ key, storageKey, entry }) => ({
            ...describe(key, storageKey, entry),
            canEdit: editEnabled && canChange(entry, actor),
            canDelete: deleteEnabled && canChange(entry, actor)
        }));
        records.sort((a, b) => a.key.localeCompare(b.key, 'pt-BR'));
    }
    return { success: true, records: records.filter(record => !filter ||
        fold(record.key).includes(filter) || fold(record.content).includes(filter)) };
}

function changeArchive(action, id, guildId, actor, expected) {
    if (!['purge', 'restore'].includes(action)) return failure('invalid_operation', 'Operação inválida.');
    const allowed = action === 'purge' ? canDelete(guildId) : canEdit(guildId) && canWrite(guildId);
    if (!allowed) return failure('disabled', 'Esta operação de memória está desativada.');
    const data = loadDatabase();
    if (!data) return unavailable();
    pruneArchive(data);
    const scope = prefix(guildId, actor);
    const item = scope && data[archiveKey]?.find(entry => entry.id === id && archiveInScope(entry, scope, guildId, actor));
    if (!item || !canChange(item.record, { ...actor, isStaff: Boolean(guildId && actor.isStaff) })) {
        return failure('not_found', 'Esta versão saiu da lista ou você perdeu a permissão para alterá-la.');
    }
    const key = archiveDisplayKey(item, scope);
    const current = data[item.storageKey];
    if (action !== 'purge' && (item.deleted ? Object.hasOwn(data, item.storageKey) : current?.recordId !== item.recordId)) {
        return failure('conflict', 'A chave está ocupada ou a anotação foi excluída. Confira a lista atual.');
    }
    const snapshot = revision(item.storageKey, [item, current]);
    if (!expected) return review(key, item.storageKey, item.record, { revision: snapshot });
    if (snapshot !== expected) return failure('changed', 'Esta anotação mudou. Revise a operação novamente.');
    if (action === 'purge') {
        data[archiveKey] = data[archiveKey].filter(entry => item.deleted ? entry.recordId !== item.recordId : entry.id !== id);
    } else {
        data[archiveKey] = data[archiveKey].filter(entry => entry.id !== id);
        if (current) archiveRecord(data, item.storageKey, current, item.recordId, false);
        const record = typeof item.record === 'object' && item.record && !Array.isArray(item.record) ? item.record : { content: format(item.record) };
        data[item.storageKey] = { ...record, recordId: item.recordId, updatedAt: new Date().toISOString() };
    }
    return saveDatabase(data) ? { success: true, message: action === 'purge' ? 'Cópia eliminada definitivamente da memória.' : 'Anotação restaurada.' } : unavailable();
}

function moveLegacy(key, targetGuildId, actor, expected) {
    if (!actor.isOwner) return failure('permission_denied', 'A migração de legados é reservada ao dono da instância.');
    if (!/^\d{17,20}$/.test(targetGuildId) || isForbiddenKey(key) || officialKeys.has(normalize(key))) return failure('invalid_target', 'Informe uma anotação legada e um servidor válido.');
    if (!canWrite(targetGuildId)) return failure('disabled', 'A gravação está desativada no servidor de destino.');
    const data = loadDatabase();
    if (!data) return unavailable();
    const record = data[key];
    if (!Object.hasOwn(data, key) || record?.protected) return failure('not_found', 'Esta anotação legada não pode ser movida.');
    const destination = prefix(targetGuildId, actor) + normalize(key);
    if (Object.hasOwn(data, destination)) return failure('conflict', 'O servidor de destino já tem uma anotação com essa chave.');
    if (!expected) return review(key, key, record);
    if (revision(key, record) !== expected) return failure('changed', 'O registro legado mudou. Revise a operação novamente.');
    data[destination] = record;
    delete data[key];
    return saveDatabase(data) ? { success: true, message: 'Anotação movida para o servidor escolhido.' } : unavailable();
}

function startMemoryMaintenance() {
    const run = () => {
        const data = loadDatabase();
        if (data && pruneArchive(data)) saveDatabase(data);
    };
    run();
    setInterval(run, 60 * 60 * 1000).unref();
}

module.exports = {
    loadDatabase, getDbSettings, updateDbSetting, canRead, canWrite, canEdit, canDelete,
    readDb, writeDb, editDb, deleteDb, isBulkQuery, isForbiddenKey, setDatabasePath, getDatabasePath,
    requestChange, readPersonalNotes, manageList, changeArchive, moveLegacy, startMemoryMaintenance
};
