const { randomUUID } = require('node:crypto');
const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder,
    PermissionFlagsBits, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const config = require('../config');
const memory = require('./databaseHandler');

const sessions = new Map();
const confirmations = new Map();
const pageSize = 15;
const mentionSettings = { parse: [] };
const views = [
    { label: 'Anotações', value: 'active' },
    { label: 'Lixeira', value: 'trash' },
    { label: 'Histórico de edições', value: 'history' }
];
const verbs = { write: 'Sobrescrever', edit: 'Editar', delete: 'Excluir', restore: 'Restaurar', purge: 'Eliminar definitivamente', move: 'Mover para o servidor' };

function memoryActor(interaction) {
    const user = interaction.user || interaction.author;
    const permissions = interaction.memberPermissions || interaction.member?.permissions;
    const staffPermissions = [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageMessages];
    return {
        userId: user?.id,
        userTag: user?.tag || user?.username,
        isOwner: Boolean(user?.id && config.isOwner(user.id)),
        isStaff: Boolean(interaction.guildId && user?.id &&
            (interaction.guild?.ownerId === user.id || staffPermissions.some(permission => permissions?.has?.(permission))))
    };
}

function bind(interaction) {
    return { userId: (interaction.user || interaction.author)?.id, guildId: interaction.guildId || null, channelId: interaction.channelId || null };
}

function remember(cache, value, interaction, ttl) {
    const now = Date.now();
    for (const [id, entry] of cache) if (entry.expires <= now) cache.delete(id);
    if (cache.size >= 500) cache.delete(cache.keys().next().value);
    const id = randomUUID();
    cache.set(id, { ...value, ...bind(interaction), expires: now + ttl });
    return id;
}

function getBound(cache, id, interaction) {
    const stored = cache.get(id);
    if (!stored || stored.expires <= Date.now()) {
        cache.delete(id);
        return null;
    }
    const { userId, guildId, channelId } = bind(interaction);
    return stored.userId === userId && stored.guildId === guildId && stored.channelId === channelId ? stored : null;
}

const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const row = (...components) => new ActionRowBuilder().addComponents(components);
const payload = (content, components = []) => ({ content, components, allowedMentions: mentionSettings });
const privateReply = (interaction, content, components) => interaction.reply({
    ...payload(content, components), flags: MessageFlags.Ephemeral
});

const excerpt = (value, length = 420) => {
    const text = String(value || '').replace(/\r/g, '').replace(/([\\`*_~|>])/g, '\\$1');
    return text.length > length ? text.slice(0, length) + '…' : text;
};

function request(action, interaction, expected) {
    const guildId = interaction.guildId || null;
    const actor = memoryActor(interaction);
    if (action.type === 'change') {
        return memory.requestChange(action.operation, action.key, action.content, action.options || {}, guildId, actor,
            { forceReview: action.forceReview, expected });
    }
    if (action.type === 'archive') return memory.changeArchive(action.operation, action.id, guildId, actor, expected);
    if (!guildId && actor.isOwner) {
        if (!interaction.client?.guilds?.cache?.get(action.targetGuildId)?.available) {
            return { success: false, message: 'O servidor de destino não está disponível para a Hikari.' };
        }
        return memory.moveLegacy(action.key, action.targetGuildId, actor, expected);
    }
    return { success: false, message: 'A migração só pode ser feita pelo dono em DM.' };
}

function registerConfirmation(action, result, interaction) {
    return remember(confirmations, { action, review: result.review }, interaction, 5 * 60 * 1000);
}

function reviewButton(action, result, interaction) {
    const id = registerConfirmation(action, result, interaction);
    return button('mem:review:' + id, action.operation === 'delete' ? 'Revisar exclusão' : 'Revisar alteração', ButtonStyle.Primary);
}

function reviewPayload(id, pending) {
    const { action, review } = pending;
    let content = '**' + verbs[action.operation] + '**\nChave: ' + excerpt(review.key, 125);
    if (action.targetName) content += '\nDestino: ' + excerpt(action.targetName, 100) + ' (' + action.targetGuildId + ')';
    content += '\n\n**Conteúdo atual ou arquivado**\n' + (excerpt(review.content) || 'Sem texto.');
    if (review.replacement !== undefined) content += '\n\n**Novo conteúdo**\n' + excerpt(review.replacement);
    if (action.operation === 'delete') content += '\n\nA anotação vai para a lixeira por até 7 dias.';
    if (action.operation === 'purge') content += '\n\nEssa eliminação é definitiva.';
    return payload(content, [row(
        button('mem:confirm:' + id, 'Confirmar', ['delete', 'purge'].includes(action.operation) ? ButtonStyle.Danger : ButtonStyle.Primary),
        button('mem:cancel:' + id, 'Cancelar')
    )]);
}

function panel(interaction, { view = 'active', page = 0, query = '', picked = null } = {}) {
    const actor = memoryActor(interaction);
    const result = memory.manageList(view, interaction.guildId || null, actor, query);
    if (!result.success) return payload(result.message);
    const maxPage = Math.max(0, Math.ceil(result.records.length / pageSize) - 1);
    page = Math.min(maxPage, Math.max(0, page));
    const items = result.records.slice(page * pageSize, (page + 1) * pageSize);
    const selected = items.find(item => (item.id || item.key) === picked);
    const id = remember(sessions, { view, page, query, items, selected }, interaction, 10 * 60 * 1000);
    const menu = new StringSelectMenuBuilder().setCustomId('mem:view:' + id).setPlaceholder('Escolha uma seção')
        .addOptions([...views, ...(actor.isOwner && !interaction.guildId ? [{ label: 'Anotações legadas', value: 'legacy' }] : [])]
            .map(option => ({ ...option, default: view === option.value })));
    const components = [row(menu)];
    if (items.length) {
        components.push(row(new StringSelectMenuBuilder().setCustomId('mem:item:' + id).setPlaceholder('Escolha uma anotação')
            .addOptions(items.map((item, index) => ({
                label: (item.savedAt ? item.key + ' · ' + new Date(item.savedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : item.key).slice(0, 100),
                value: String(index), default: selected === item
            })))));
    }
    components.push(row(
        button('mem:prev:' + id, 'Anterior').setDisabled(page === 0),
        button('mem:next:' + id, 'Próxima').setDisabled(page >= maxPage),
        button('mem:find:' + id, 'Buscar'),
        button('mem:clear:' + id, 'Limpar busca').setDisabled(!query),
        ...(view === 'active' && memory.canWrite(interaction.guildId) ? [button('mem:new:' + id, 'Nova anotação', ButtonStyle.Primary)] : [])
    ));
    let content = '**Memória da Hikari**\n' + result.records.length + ' registro(s) · Página ' + (page + 1) + ' de ' + (maxPage + 1);
    if (query) content += '\nBusca: ' + excerpt(query, 120);
    if (!items.length) content += '\n\nNenhuma anotação encontrada.';
    if (selected) {
        content += '\n\n**' + excerpt(selected.key, 130) + '**\nAutor: ' + excerpt(selected.author, 100) + '\n\n' + excerpt(selected.content, 900);
        if (selected.expiresAt) content += '\n\nExpira <t:' + Math.floor(selected.expiresAt / 1000) + ':R>.';
        if (view === 'active' && (selected.canEdit || selected.canDelete)) {
            const actions = [];
            if (selected.canEdit) actions.push(button('mem:edit:' + id, 'Editar'));
            if (selected.canDelete) actions.push(button('mem:delete:' + id, 'Excluir', ButtonStyle.Danger));
            components.push(row(...actions));
        }
        if (view === 'trash' || view === 'history') components.push(row(button('mem:restore:' + id, 'Restaurar'), button('mem:purge:' + id, 'Eliminar cópia', ButtonStyle.Danger)));
        if (view === 'legacy') components.push(row(button('mem:move:' + id, 'Mover para servidor', ButtonStyle.Primary)));
    }
    return payload(content, components);
}

function showModal(interaction, id, title, label, style = TextInputStyle.Short, value = '', maxLength = 120) {
    const input = new TextInputBuilder().setCustomId('value').setLabel(label).setStyle(style).setMaxLength(maxLength);
    if (value) input.setValue(value);
    return interaction.showModal(new ModalBuilder().setCustomId(id).setTitle(title).addComponents(row(input)));
}

async function showReview(interaction, action, result) {
    if (result.error !== 'confirmation_required') return privateReply(interaction, result.message);
    const id = registerConfirmation(action, result, interaction);
    const { content, components } = reviewPayload(id, confirmations.get(id));
    return privateReply(interaction, content, components);
}

async function handleMemoryInteraction(interaction) {
    if (interaction.commandName === 'memoria' && interaction.isChatInputCommand()) {
        return interaction.reply({ ...panel(interaction, { query: interaction.options.getString('busca') || '' }), flags: MessageFlags.Ephemeral });
    }
    const [, action, id] = interaction.customId.split(':');
    if (['review', 'confirm', 'cancel'].includes(action)) {
        const pending = getBound(confirmations, id, interaction);
        if (!pending) return privateReply(interaction, 'Esta confirmação expirou ou pertence a quem iniciou a operação.');
        if (action === 'review') {
            if (!memory.canRead(interaction.guildId) || (pending.action.type === 'legacy' && !memoryActor(interaction).isOwner)) {
                return privateReply(interaction, 'Você não tem acesso à revisão desta anotação.');
            }
            const { content, components } = reviewPayload(id, pending);
            return privateReply(interaction, content, components);
        }
        confirmations.delete(id);
        if (action === 'cancel') return interaction.update(payload('Operação cancelada.'));
        const result = request(pending.action, interaction, pending.review.revision);
        return interaction.update(payload(result.message || 'Abra /memoria para revisar a anotação novamente.'));
    }

    const state = getBound(sessions, id, interaction);
    if (!state) return privateReply(interaction, 'Este painel expirou. Use /memoria para abrir outro.');
    if (action === 'view') return interaction.update(panel(interaction, { view: interaction.values[0] }));
    if (action === 'item') {
        const item = state.items[Number(interaction.values[0])];
        return interaction.update(panel(interaction, { ...state, picked: item?.id || item?.key }));
    }
    if (action === 'prev' || action === 'next') return interaction.update(panel(interaction, { ...state, page: state.page + (action === 'prev' ? -1 : 1) }));
    if (action === 'clear') return interaction.update(panel(interaction, { view: state.view }));
    if (action === 'find') return showModal(interaction, 'mem:search:' + id, 'Buscar na memória', 'Chave ou trecho da anotação');
    if (action === 'search') return interaction.update(panel(interaction, { view: state.view, query: interaction.fields.getTextInputValue('value') }));

    if (action === 'new' && state.view === 'active') {
        const key = new TextInputBuilder().setCustomId('key').setLabel('Chave').setStyle(TextInputStyle.Short).setMaxLength(120);
        const content = new TextInputBuilder().setCustomId('value').setLabel('Conteúdo da anotação').setStyle(TextInputStyle.Paragraph).setMaxLength(4000);
        return interaction.showModal(new ModalBuilder().setCustomId('mem:create:' + id).setTitle('Nova anotação').addComponents(row(key), row(content)));
    }
    if (action === 'create' && state.view === 'active') {
        const operation = { type: 'change', operation: 'write',
            key: interaction.fields.getTextInputValue('key'), content: interaction.fields.getTextInputValue('value') };
        return showReview(interaction, operation, request(operation, interaction));
    }
    const selected = state.selected;
    if (!selected) return privateReply(interaction, 'Selecione uma anotação primeiro.');
    if (action === 'edit') return showModal(interaction, 'mem:save:' + id, 'Editar anotação', 'Novo conteúdo', TextInputStyle.Paragraph, '', 4000);
    if (action === 'move') return showModal(interaction, 'mem:destination:' + id, 'Mover anotação legada', 'ID do servidor de destino', TextInputStyle.Short, '', 20);
    let operation;
    if (action === 'save' && state.view === 'active') {
        operation = { type: 'change', operation: 'edit', key: selected.key, content: interaction.fields.getTextInputValue('value'), forceReview: true };
    } else if (action === 'delete' && state.view === 'active') {
        operation = { type: 'change', operation: 'delete', key: selected.key };
    } else if ((action === 'restore' || action === 'purge') && selected.id) {
        operation = { type: 'archive', operation: action, id: selected.id };
    } else if (action === 'destination' && state.view === 'legacy' && memoryActor(interaction).isOwner && !interaction.guildId) {
        const targetGuildId = interaction.fields.getTextInputValue('value').trim();
        const guild = interaction.client.guilds.cache.get(targetGuildId);
        if (!guild?.available) return privateReply(interaction, 'Escolha um servidor disponível em que a Hikari esteja instalada.');
        operation = { type: 'legacy', operation: 'move', key: selected.key, targetGuildId, targetName: guild.name };
    } else {
        return privateReply(interaction, 'Esta ação não está disponível nesta seção.');
    }
    const result = request(operation, interaction);
    if (result.review && operation.type !== 'archive' && selected.revision !== result.review.revision) {
        return privateReply(interaction, 'A anotação mudou desde que o painel foi aberto. Abra /memoria novamente.');
    }
    return showReview(interaction, operation, result);
}

module.exports = { handleMemoryInteraction, memoryActor, reviewButton };
