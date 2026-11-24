const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags
} = require('discord.js');
const {
    getSession, nextTrack, firstTrack, prevTrack, setLoopMode, toggleShuffle, cycleVoiceMode, toggleStreamMode
} = require('./radioDatabase');
const {
    playTrack, pausePlayer, resumePlayer, stopPlayback, removeQueuedTrack, updateEmbed
} = require('./radioAudioPlayer');
const { buildQueueEmbed, safeText } = require('./radioEmbed');
const { findMusic, enqueueTracks, showMusicChoices, pickMusicChoice, sessionMatches } = require('./radioSearch');
const { prefetchNextTrack } = require('./radioPrefetcher');
const { checkBan } = require('../handlers/banHandler');

const privateMessage = content => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

function canUseSession(interaction, session) {
    if (!session || session._leaving) return 'Nenhuma sessão de rádio ativa.';
    if (interaction.member?.voice?.channelId !== session.voiceChannelId) {
        return 'Você precisa estar no canal de voz do rádio para usar os controles.';
    }
    return null;
}

function isBanned(interaction) {
    return checkBan(interaction.user.id, interaction.guildId, interaction.channelId);
}

function removalPage(session, requestedPage = 0) {
    const pageCount = Math.max(1, Math.ceil(session.playlist.length / 25));
    const page = Math.max(0, Math.min(pageCount - 1, requestedPage));
    const components = [];
    if (session.playlist.length) {
        const options = session.playlist.slice(page * 25, (page + 1) * 25).map((track, index) => ({
            label: (page * 25 + index + 1 + '. ' + (track.title || 'Faixa')).slice(0, 100),
            description: String(track.artist || 'Desconhecido').slice(0, 100),
            value: track.entryId
        }));
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('radio_select_remove_' + session.id)
                .setPlaceholder('Selecione a faixa a remover').addOptions(options)
        ));
    }
    if (pageCount > 1) {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('radio_rpage_' + session.id + '_' + (page - 1))
                .setLabel('Anterior').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId('radio_rpage_' + session.id + '_' + (page + 1))
                .setLabel('Próxima').setStyle(ButtonStyle.Secondary).setDisabled(page + 1 === pageCount)
        ));
    }
    const content = session.playlist.length
        ? 'Escolha a faixa que deseja remover · Página ' + (page + 1) + '/' + pageCount
        : 'A fila está vazia.';
    return { content, components };
}

async function handleRadioButton(interaction, client) {
    try {
        const cid = interaction.customId;
        if (cid.startsWith('radio_ambiguous_cancel_')) return await handleAmbiguousSelect(interaction, client);
        if (isBanned(interaction)) return await interaction.reply(privateMessage('Acesso negado aos controles do rádio.'));

        const { guildId, channel } = interaction;
        const session = getSession(guildId);
        const error = canUseSession(interaction, session);
        if (error) return await interaction.reply(privateMessage(error));

        if (cid.startsWith('radio_rpage_')) {
            const [, , sessionId, page] = cid.split('_');
            if (sessionId !== session.id) return await interaction.reply(privateMessage('Seletor expirado.'));
            return await interaction.update(removalPage(session, Number(page)));
        }
        if (cid.startsWith('radio_qpage_')) {
            const [, , sessionId, page] = cid.split('_');
            if (sessionId !== session.id) return await interaction.reply(privateMessage('Lista expirada.'));
            const { embed, components } = buildQueueEmbed(session, Number(page));
            return await interaction.update({ embeds: [embed], components });
        }
        if (interaction.message?.id && session.embedMessageId !== interaction.message.id) {
            return await interaction.reply(privateMessage('Use o painel atual do rádio.'));
        }

        if (cid === 'radio_add') {
            const input = new TextInputBuilder().setCustomId('radio_add_input')
                .setLabel('Nome da música, artista ou link').setStyle(TextInputStyle.Short)
                .setPlaceholder('Ex.: Welcome to the Jungle').setRequired(true).setMaxLength(300);
            const modal = new ModalBuilder().setCustomId('radio_add_modal_' + session.id)
                .setTitle('Adicionar ao Rádio').addComponents(new ActionRowBuilder().addComponents(input));
            return await interaction.showModal(modal);
        }
        if (cid === 'radio_remove') {
            return await interaction.reply({ ...removalPage(session), flags: MessageFlags.Ephemeral });
        }
        if (cid === 'radio_queue') {
            const { embed, components } = buildQueueEmbed(session);
            return await interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
        }
        if (cid === 'radio_voice_toggle' && require('../handlers/llmHandler').isToolDisabled(guildId, 'radio_voice_stt')) {
            return await interaction.reply(privateMessage('A escuta por voz está desativada. Um administrador pode ativá-la em /ia_ferramentas.'));
        }

        await interaction.deferUpdate();
        if (!sessionMatches(session)) return;
        switch (cid) {
            case 'radio_leave':
                await require('./radioManager').leaveRadioCall(guildId, channel, client);
                return;
            case 'radio_playpause':
                if (session.status === 'PLAYING') pausePlayer(guildId);
                else if (session.status === 'PAUSED') resumePlayer(guildId);
                else if (session.status === 'STOPPED') {
                    const track = firstTrack(guildId);
                    if (track) await playTrack(guildId, track, channel, client);
                }
                break;
            case 'radio_stop':
                stopPlayback(guildId);
                break;
            case 'radio_next':
            case 'radio_prev': {
                const track = cid === 'radio_next' ? nextTrack(guildId) : prevTrack(guildId);
                if (track) await playTrack(guildId, track, channel, client);
                break;
            }
            case 'radio_shuffle':
                toggleShuffle(guildId);
                void prefetchNextTrack(guildId);
                break;
            case 'radio_loop':
                setLoopMode(guildId);
                void prefetchNextTrack(guildId);
                break;
            case 'radio_voice_toggle':
                cycleVoiceMode(guildId);
                break;
            case 'radio_stream_mode':
                toggleStreamMode(guildId);
                break;
        }
        await updateEmbed(guildId, channel, client);
    } catch (error) {
        console.error('[RadioModalHandler] Falha no botão:', error.code || error.name);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply(privateMessage('Ocorreu um erro ao processar esta ação.')).catch(() => {});
        }
    }
}

async function handleRadioModal(interaction, client) {
    if (!interaction.customId.startsWith('radio_add_modal')) return false;

    const { guildId, channel } = interaction;
    const session = getSession(guildId);
    const error = canUseSession(interaction, session);
    if (isBanned(interaction) || error || interaction.customId !== 'radio_add_modal_' + session.id) {
        await interaction.reply(privateMessage(error || 'Acesso negado ou painel expirado.'));
        return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const query = interaction.fields.getTextInputValue('radio_add_input').trim();
    const userId = interaction.user.id;
    const resolved = await findMusic(session, userId, query);
    if (!sessionMatches(session) || canUseSession(interaction, session)) {
        await interaction.editReply({ content: 'Sessão de rádio encerrada ou canal de voz alterado.' });
    } else if (resolved.type === 'stale') {
        await interaction.editReply({ content: 'Esta busca foi substituída por uma mais recente.' });
    } else if (resolved.type === 'ambiguous') {
        await showMusicChoices({
            session, userId, results: resolved.results, channel, client,
            send: payload => interaction.editReply(payload), edit: payload => interaction.editReply(payload)
        });
    } else {
        let content;
        if (resolved.type === 'track' || resolved.type === 'playlist') {
            const tracks = resolved.tracks || [resolved.track];
            const { status, position } = await enqueueTracks(session, tracks, userId, channel, client);
            if (status === 'closed') content = 'Sessão de rádio encerrada.';
            else if (status === 'failed') content = 'Faixas adicionadas. A primeira não pôde ser reproduzida.';
            else if (resolved.type === 'playlist') content = tracks.length + ' faixas adicionadas à fila.';
            else content = status === 'started'
                ? 'Tocando **' + safeText(tracks[0].title, 300) + '**.'
                : 'Faixa adicionada na posição #' + position + '.';
        } else {
            content = resolved.type === 'unavailable' ? 'O serviço de música está indisponível. Tente novamente.'
                : 'Não encontrei a música para **' + safeText(query, 300) + '**.';
        }
        await interaction.editReply({ content, allowedMentions: { parse: [] } });
    }
    return true;
}

async function handleAmbiguousSelect(interaction) {
    if (isBanned(interaction)) return interaction.reply(privateMessage('Acesso negado aos controles do rádio.'));
    const cancel = interaction.customId.startsWith('radio_ambiguous_cancel_');
    const id = interaction.customId.split('_').at(-1);
    const choice = pickMusicChoice(id, {
        guildId: interaction.guildId, userId: interaction.user.id,
        channelId: interaction.member?.voice?.channelId, position: Number(interaction.values?.[0]), cancel
    });
    if (choice.error) return interaction.reply(privateMessage(choice.error));
    await interaction.update({
        content: cancel ? 'Busca cancelada.' : 'Faixa selecionada: **' + safeText(choice.track.title, 300) + '**.',
        embeds: [], components: [], allowedMentions: { parse: [] }
    });
    if (choice.queued) await choice.queued;
    return true;
}

async function handleRadioSelectRemove(interaction, client) {
    const { guildId, channel } = interaction;
    const session = getSession(guildId);
    const error = canUseSession(interaction, session);
    if (isBanned(interaction) || error) {
        return interaction.reply(privateMessage(error || 'Acesso negado aos controles do rádio.'));
    }
    if (interaction.customId !== 'radio_select_remove_' + session.id) {
        return interaction.reply(privateMessage('Seletor expirado. Abra Remover no painel atual.'));
    }

    await interaction.deferUpdate();
    if (!sessionMatches(session)) return;
    const position = session.playlist.findIndex(track => track.entryId === interaction.values[0]) + 1;
    const result = position && await removeQueuedTrack(guildId, position, channel, client);
    return interaction.editReply({
        content: result ? 'Removida: **' + safeText(result.removedTrack.title, 300) + '**.'
            : 'Faixa não encontrada ou já removida.',
        components: [], allowedMentions: { parse: [] }
    });
}

module.exports = { handleRadioButton, handleRadioModal, handleAmbiguousSelect, handleRadioSelectRemove };
