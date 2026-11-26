const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getCurrentMusicFromUser } = require('../services/activityMusicService');
const { handleTosInteraction } = require('../handlers/tosHandler');
const { handleBanInteraction, checkBan, addBan, removeBan, getBans, setAutoBlock } = require('../handlers/banHandler');
const {
    addToQueue,
    getDisabledTools,
    getAllMcpTools,
    setServerToolEnabled,
    resetServerTools,
    updateShowModel,
    updateShowModelThinking,
    updateErrorRetries,
    updateProviderSetting,
    getProviderSettings,
    setChannelPersona,
    setChannelChatter,
    setServerEveryoneMention,
    setServerUpdateChannel,
    setServerLastChannel,
    isChannelDisabled
} = require('../handlers/llmHandler');
const { generateImage } = require('../handlers/imageHandler');
const {
    acquireMediaRequest, reserveVideoCompression, compressPendingVideo, releasePendingVideo,
    isCompressionActive, compressionButton, getAttachmentLimit, mediaScope, playableAttachment, formatMediaError
} = require('../handlers/youtubeAudioHandler');
const { deliverMediaLink, deliverMusicResult, musicOptions, musicActivityEmbed, retryMediaEdit } = require('../handlers/mediaReply');
const { executeGameCommand } = require('../handlers/gameHandler');
const { handleSauceCommand } = require('../handlers/sauceHandler');
const { getSteamGameInfo } = require('../handlers/steamHandler');
const { convertCurrency, formatCurrencyNumber } = require('../handlers/currencyHandler');
const { generateResponse } = require('../handlers/llmHandler');
const { handleConfigCommand, handleConfigButton, handleConfigModal, handleConfigSelect } = require('../handlers/configPanelHandler');
const { handleMusicSearchAndDownload, clearSession } = require('../handlers/deezerMusicHandler');
const { handleRadioButton, handleRadioModal, handleAmbiguousSelect, handleRadioSelectRemove } = require('../music/radioModalHandler');
const { startRadioMode, startHybridMode } = require('../music/radioManager');
const { handleServerAdminCommand, handleServerAdminInteraction, handleIaFerramentasCommand } = require('../handlers/serverAdminHandler');
const { handleCreatorAdminCommand, handleCreatorAdminInteraction } = require('../handlers/creatorAdminHandler');
const { buildBanListPayload, buildBanDetailPayload } = require('../handlers/banListHandler');
const { logger } = require('../utils/logger');

module.exports = {
    name: 'interactionCreate',
    once: false,
    async execute(interaction, client) {
        const { isBotPaused } = require('../handlers/ownerCommandHandler');
        if (isBotPaused() && !config.isOwner(interaction.user.id)) {
            if (interaction.isRepliable()) {
                const pauseMsg = '⏸️ A Hikari está temporariamente pausada pelo proprietário para manutenção.';
                if (interaction.deferred || interaction.replied) {
                    return interaction.editReply({ content: pauseMsg }).catch(() => {});
                }
                return interaction.reply({ content: pauseMsg, ephemeral: true }).catch(() => {});
            }
            return;
        }
        if (interaction.guildId) {
            const isWhitelisted = config.isAutomodWhitelisted(interaction.user.id) || config.isOwner(interaction.user.id);
            if (!isWhitelisted) {
                const { isServerAccepted, sendTermsOfService } = require('../handlers/tosHandler');
                if (!isServerAccepted(interaction.guildId)) {
                    const isTosAction = (interaction.isCommand() && interaction.commandName === 'aceitar_tos') ||
                                        (interaction.isButton() && (interaction.customId === 'tos_accept' || interaction.customId === 'tos_decline' || interaction.customId.startsWith('tos_nav_')));
                    if (!isTosAction) {
                        if (interaction.isAutocomplete()) {
                            return interaction.respond([]).catch(() => {});
                        }
                        await sendTermsOfService(interaction);
                        return;
                    }
                }
            }
        }
        if (interaction.guildId && isChannelDisabled(interaction.guildId, interaction.channelId) && !config.isOwner(interaction.user.id)) {
            const isSrvConfig = (interaction.isCommand() && interaction.commandName === 'config_servidor') ||
                                (interaction.customId && interaction.customId.startsWith('srvcfg_'));
            if (!isSrvConfig) {
                if (interaction.isAutocomplete()) {
                    return interaction.respond([]).catch(() => {});
                }
                const disabledEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('🔇 Canal Desativado')
                    .setDescription('A Hikari foi completamente desativada neste canal pela administração do servidor.\nPara interagir com ela, utilize um dos outros canais autorizados.');
                if (interaction.isRepliable()) {
                    return interaction.reply({ embeds: [disabledEmbed], ephemeral: true }).catch(() => {});
                }
                return;
            }
        }
        if (interaction.customId) {
            const isBanExempt = interaction.customId.startsWith('appeal_ban_') ||
                                interaction.customId.startsWith('unban_') ||
                                interaction.customId.startsWith('keepban_') ||
                                interaction.customId.startsWith('adm_') ||
                                interaction.customId.startsWith('banlist_') ||
                                interaction.customId.startsWith('crtcfg_') ||
                                interaction.customId.startsWith('cfgpanel_');
            if (!isBanExempt) {
                const banInfo = checkBan(interaction.user.id, interaction.guildId, interaction.channelId);
                if (banInfo) {
                    if (interaction.isRepliable()) {
                        return interaction.reply({ content: '🛑 **ACESSO NEGADO:** Você ou este servidor/canal está banido da Hikari.', ephemeral: true });
                    }
                    return;
                }
            }
            if (interaction.customId.startsWith('mem:')) {
                const { handleMemoryInteraction } = require('../handlers/memoryPanelHandler');
                return await handleMemoryInteraction(interaction);
            }
            if (interaction.customId.startsWith('srvcfg_')) {
                return await handleServerAdminInteraction(interaction);
            }
            if (interaction.customId.startsWith('crtcfg_')) {
                return await handleCreatorAdminInteraction(interaction, client);
            }
            if (interaction.customId.startsWith('srvmcp_')) {
                const { handleMcpToolInteraction } = require('../handlers/mcpToolPanelHandler');
                return await handleMcpToolInteraction(interaction);
            }
            if (interaction.customId.startsWith('help_')) {
                const { handleHelpInteraction } = require('../handlers/helpPanelHandler');
                return await handleHelpInteraction(interaction);
            }
        }
        if (interaction.isModalSubmit()) {
            if (interaction.customId.startsWith('radio_')) {
                return await handleRadioModal(interaction, client);
            }
            if (interaction.customId.startsWith('cfgmodal_')) {
                if (!config.isOwner(interaction.user.id)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Acesso Negado')
                        .setDescription('Esta ação é restrita ao criador da Hikari.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                return await handleConfigModal(interaction);
            }
        }
        if (interaction.isStringSelectMenu()) {
            if (interaction.customId.startsWith('radio_ambiguous_select_')) {
                return await handleAmbiguousSelect(interaction, client);
            }
            if (interaction.customId.startsWith('radio_select_remove')) {
                return await handleRadioSelectRemove(interaction, client);
            }
            if (interaction.customId.startsWith('music_select_')) {
                const { user, guildId, channelId } = interaction;
                if (checkBan(user.id, guildId, channelId)) {
                    return interaction.reply({ content: 'Acesso aos downloads negado.', flags: MessageFlags.Ephemeral });
                }
                let request;
                try {
                    request = acquireMediaRequest(user.id);
                    await interaction.deferUpdate();
                    const result = await handleMusicSearchAndDownload(null, interaction.values[0], {
                        ...musicOptions(interaction, user.id, request.signal),
                        searchId: interaction.customId.slice('music_select_'.length)
                    });
                    if (result.error && !result.consumed) {
                        return interaction.followUp({ content: result.error, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
                    }
                    return await deliverMusicResult(result, payload => interaction.editReply(payload), request.signal);
                } catch (error) {
                    if (interaction.deferred) {
                        return interaction.editReply({ content: formatMediaError(error), embeds: [], components: [] });
                    }
                    return interaction.reply({ content: formatMediaError(error), flags: MessageFlags.Ephemeral });
                } finally {
                    request?.release();
                }
            }
            if (interaction.customId === 'cfgpanel_goto_select') {
                if (!config.isOwner(interaction.user.id)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Acesso Negado')
                        .setDescription('Esta ação é restrita ao criador da Hikari.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                return await handleConfigSelect(interaction);
            }
            if (interaction.customId.startsWith('banlist_select_')) {
                if (!config.isOwner(interaction.user.id)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Acesso Negado')
                        .setDescription('Esta ação é restrita ao criador da Hikari.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                const parts = interaction.customId.split('_');
                const category = parts[2];
                const targetId = interaction.values[0];
                const payload = await buildBanDetailPayload(client, category, targetId);
                return await interaction.update(payload);
            }

            return;
        }
        if (interaction.isButton()) {
            const cid = interaction.customId;
            if (!cid.startsWith('appeal_ban_') && !cid.startsWith('unban_') && !cid.startsWith('keepban_') && !cid.startsWith('adm_') && !cid.startsWith('banlist_') && !cid.startsWith('crtcfg_') && !cid.startsWith('cfgpanel_') && !cid.startsWith('help_')) {
                const banInfo = checkBan(interaction.user.id, interaction.guildId, interaction.channelId);
                if (banInfo) {
                    return interaction.reply({ content: '🛑 **ACESSO NEGADO:** Você ou este servidor/canal está banido da Hikari.', ephemeral: true });
                }
            }
            if (cid.startsWith('radio_')) {
                if (cid.startsWith('radio_ambiguous_cancel_')) {
                    return await handleAmbiguousSelect(interaction, client);
                }
                return await handleRadioButton(interaction, client);
            }
            if (cid.startsWith('music_cancel_')) {
                if (checkBan(interaction.user.id, interaction.guildId, interaction.channelId)) {
                    return interaction.reply({ content: 'Acesso aos downloads negado.', flags: MessageFlags.Ephemeral });
                }
                const cleared = clearSession(interaction.user.id, {
                    ...mediaScope(interaction, interaction.user.id), searchId: cid.slice('music_cancel_'.length)
                });
                if (!cleared) return interaction.reply({ content: 'Esta seleção expirou ou pertence a outro pedido.', flags: MessageFlags.Ephemeral });
                return interaction.update({ content: 'Pesquisa cancelada.', embeds: [], components: [] });
            }
            if (cid.startsWith('cfgpanel_')) {
                if (!config.isOwner(interaction.user.id)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Acesso Negado')
                        .setDescription('Esta ação é restrita ao criador da Hikari.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                return await handleConfigButton(interaction);
            }
            if (cid.startsWith('adm_') || cid.startsWith('banlist_')) {
                if (!config.isOwner(interaction.user.id)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Acesso Negado')
                        .setDescription('Esta ação é restrita ao criador da Hikari.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
            }
            if (cid.startsWith('adm_manageguild_')) {
                const parts = cid.split('_');
                const action = parts[2];
                const guildId = parts[3];
                if (action === 'leave') {
                    const targetGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
                    if (targetGuild) {
                        await targetGuild.leave().catch(() => {});
                        await interaction.update({ content: `✅ Saí do servidor \`${targetGuild.name}\` com sucesso.`, embeds: [], components: [] });
                    } else {
                        await interaction.reply({ content: '❌ Servidor não encontrado ou já saí.', ephemeral: true });
                    }
                } else if (action === 'confirm') {
                    await interaction.update({ content: '✅ Servidor confirmado e botão ignorado.', components: [] });
                }
                return;
            } else if (cid.startsWith('adm_remoteban_')) {
                const parts = cid.split('_');
                const type = parts[2];
                const targetId = parts[3];
                if (type === 'ignore') {
                    await interaction.update({ content: '✅ Alerta ignorado.', components: [] });
                } else {
                    addBan(type, targetId, "Banido remotamente pelo log de violações do sistema Hikari.");
                    if (type === 'guild') {
                        const targetGuild = client.guilds.cache.get(targetId) || await client.guilds.fetch(targetId).catch(() => null);
                        if (targetGuild) {
                            await targetGuild.leave().catch(() => {});
                        }
                    }
                    await interaction.update({ content: `✅ Alvo \`${targetId}\` (${type}) banido com sucesso.${type === 'guild' ? ' O bot saiu do servidor.' : ''}`, components: [] });
                }
                return;
            } else if (cid === 'banlist_home') {
                const payload = await buildBanListPayload(client, 'home');
                return await interaction.update(payload);
            } else if (cid.startsWith('banlist_view_')) {
                const parts = cid.split('_');
                const category = parts[2];
                const page = parseInt(parts[3] || '0');
                const payload = await buildBanListPayload(client, category, page);
                return await interaction.update(payload);
            } else if (cid.startsWith('banlist_detail_')) {
                const parts = cid.split('_');
                const category = parts[2];
                const targetId = parts[3];
                if (targetId === 'none') {
                    return await interaction.reply({ content: '❌ Sem mais registros.', ephemeral: true });
                }
                const payload = await buildBanDetailPayload(client, category, targetId);
                return await interaction.update(payload);
            } else if (cid.startsWith('banlist_unban_')) {
                const parts = cid.split('_');
                const category = parts[2];
                const targetId = parts[3];
                const apiType = category === 'users' ? 'user' : category === 'guilds' ? 'guild' : 'channel';
                removeBan(apiType, targetId);
                const embed = new EmbedBuilder()
                    .setColor(0x10B981)
                    .setTitle('🔓 Desbanido com Sucesso')
                    .setDescription(`O alvo com ID \`${targetId}\` (${apiType}) foi desbanido do sistema.`);
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`banlist_view_${category}_0`).setLabel('⬅️ Voltar à Lista').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('banlist_home').setLabel('🏠 Início').setStyle(ButtonStyle.Primary)
                );
                return await interaction.update({ embeds: [embed], components: [row] });
            }

            if (cid.startsWith('compress_video_')) {
                let entry;
                let request;
                let compressed;
                const id = cid.slice('compress_video_'.length);
                try {
                    entry = reserveVideoCompression(id, mediaScope(interaction, interaction.user.id));
                    request = acquireMediaRequest(interaction.user.id);
                    const queued = isCompressionActive();
                    await interaction.update({
                        content: queued ? 'O vídeo entrou na fila de compressão.' : 'Comprimindo o vídeo…',
                        embeds: [], components: []
                    });
                    compressed = await compressPendingVideo(entry, getAttachmentLimit(interaction), request.signal);
                    await retryMediaEdit(payload => interaction.editReply(payload), {
                        content: '✅ Vídeo comprimido (' + (compressed.fileSize / 1048576).toFixed(1) + ' MiB).',
                        embeds: [], components: [], files: [playableAttachment(compressed, 'video')]
                    }, request.signal);
                    releasePendingVideo(entry, { discard: true });
                } catch (error) {
                    const discard = ['TOO_LARGE', 'FORMAT_UNAVAILABLE', 'VIDEO_EXPIRED'].includes(error.code);
                    const retry = entry && releasePendingVideo(entry, { discard });
                    const content = formatMediaError(error);
                    if (interaction.replied || interaction.deferred) {
                        await interaction.editReply({ content, embeds: [], components: retry ? [compressionButton(id)] : [] });
                    } else {
                        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
                    }
                } finally {
                    compressed?.cleanup();
                    request?.release();
                }
                return;
            }
            if (cid.startsWith('srvcfg_')) {
                return await handleServerAdminInteraction(interaction);
            }
            if (cid.startsWith('crtcfg_')) {
                return await handleCreatorAdminInteraction(interaction, client);
            }
            const handledTos = await handleTosInteraction(interaction);
            if (handledTos) return;
            await handleBanInteraction(interaction, client);
            return;
        }
        if (!interaction.isCommand() && !interaction.isAutocomplete()) return;
        if (interaction.isCommand()) {
            if (interaction.guildId && interaction.channelId) {
                setServerLastChannel(interaction.guildId, interaction.channelId);
                const { checkAndInitializeUpdateChannel } = require('../handlers/tosHandler');
                await checkAndInitializeUpdateChannel(interaction.guild, interaction.channel);
            }
            const sub = interaction.options.getSubcommand(false);
            logger.command(
                `${interaction.commandName}${sub ? ' ' + sub : ''}`,
                `${interaction.user.tag} (${interaction.user.id})`,
                `${interaction.guild?.name || 'DM'} [${interaction.guildId || 'N/A'}]`
            );
            const banInfo = checkBan(interaction.user.id, interaction.guildId, interaction.channelId);
            if (banInfo && interaction.commandName !== 'ajuda') {
                const banEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('🛑 ACESSO NEGADO — VOCÊ ESTÁ BANIDO!')
                    .setDescription(`Sua tentativa de execução foi abortada. O acesso à **IA Hikari** está permanentemente bloqueado para você.\n\n**DETALHES DO SEU BANIMENTO:**\n- **Tipo:** ${banInfo.typeName || banInfo.type}\n- **Motivo do Banimento:** ${banInfo.reason || "Violação severa dos Termos de Uso da IA Hikari."}\n- **Status Atual:** 🔴 TOTALMENTE RESTRITO / SUSPENSO.\n\nVocê perdeu todos os privilégios de utilização dos nossos serviços. Não adianta insistir.\n\nSe você acredita que isso é um erro ou deseja solicitar um desbanimento, clique no botão de apelação abaixo ou entre em contato com o desenvolvedor: <@${config.ownerId}> [\[Abrir Perfil\](https://discord.com/users/${config.ownerId})] ✨`)
                    .setFooter({ text: 'Hikari Security & Moderation • by yGuilhermy' })
                    .setTimestamp();
                const appealButton = new ButtonBuilder()
                    .setCustomId(`appeal_ban_${banInfo.type}_${banInfo.id || interaction.user.id}`)
                    .setLabel('⚖️ Solicitar Apelação')
                    .setStyle(ButtonStyle.Secondary);
                const projectSiteButton = new ButtonBuilder()
                    .setLabel('Página do Projeto')
                    .setURL('https://projetohikari.com/')
                    .setStyle(ButtonStyle.Link)
                    .setEmoji('🚀');
                const banRow = new ActionRowBuilder().addComponents(appealButton, projectSiteButton);
                return interaction.reply({ embeds: [banEmbed], components: [banRow], ephemeral: true });
            }
        }
        if (interaction.isAutocomplete()) {
            if (interaction.commandName === 'ia_ferramentas' || interaction.commandName === 'config_criador') {
                const focused = interaction.options.getFocused().toLowerCase();
                const guildId = interaction.guildId;
                const disabled = getDisabledTools(guildId);
                const allTools = getAllMcpTools();
                const choices = allTools
                    .filter(t => t.meta.disableable && t.function.name !== 'leave_voice_call')
                    .map(t => {
                        if (t.function.name === 'join_voice_call') {
                            const isDisabled = disabled.includes('join_voice_call');
                            return {
                                name: `${isDisabled ? '❌' : '✅'} 🎙️ Assistente de Voz (Call)`,
                                value: 'join_voice_call'
                            };
                        }
                        const isDisabled = disabled.includes(t.function.name);
                        return {
                            name: `${isDisabled ? '❌' : '✅'} ${t.meta.label}`,
                            value: t.function.name
                        };
                    })
                    .filter(c => c.name.toLowerCase().includes(focused) || c.value.toLowerCase().includes(focused))
                    .slice(0, 25);
                return interaction.respond(choices);
            }
            if (interaction.commandName === 'converter_moeda') {
                const CURRENCIES = [
                    { name: '🇧🇷 BRL — Real Brasileiro',            value: 'BRL' },
                    { name: '🇺🇸 USD — Dólar Americano',           value: 'USD' },
                    { name: '🇪🇺 EUR — Euro',                       value: 'EUR' },
                    { name: '🇬🇧 GBP — Libra Esterlina',            value: 'GBP' },
                    { name: '💹 BTC — Bitcoin',                     value: 'BTC' },
                    { name: '💸 ETH — Ethereum',                    value: 'ETH' },
                    { name: '💵 USDT — Tether',                    value: 'USDT' },
                    { name: '🇯🇵 JPY — Iene Japonês',              value: 'JPY' },
                    { name: '🇨🇦 CAD — Dólar Canadense',           value: 'CAD' },
                    { name: '🇨🇭 CHF — Franco Suíço',              value: 'CHF' },
                    { name: '🇦🇺 AUD — Dólar Australiano',         value: 'AUD' },
                    { name: '🇨🇳 CNY — Yuan Chinês',               value: 'CNY' },
                    { name: '🇰🇷 KRW — Won Sul-Coreano',           value: 'KRW' },
                    { name: '🇲🇽 MXN — Peso Mexicano',             value: 'MXN' },
                    { name: '🇦🇷 ARS — Peso Argentino',             value: 'ARS' },
                    { name: '🇨🇱 CLP — Peso Chileno',               value: 'CLP' },
                    { name: '🇨🇴 COP — Peso Colombiano',            value: 'COP' },
                    { name: '🇺🇾 UAH — Hryvnia Ucraniana',          value: 'UAH' },
                    { name: '🇷🇺 RUB — Rublo Russo',                value: 'RUB' },
                    { name: '🇮🇳 INR — Rupia Indiana',              value: 'INR' },
                    { name: '🇳🇿 NZD — Dólar Neozelandês',         value: 'NZD' },
                    { name: '🇸🇬 SGD — Dólar de Singapura',       value: 'SGD' },
                    { name: '🇸🇦 SAR — Riyal Saudita',              value: 'SAR' },
                    { name: '🧩 SOL — Solana',                      value: 'SOL' },
                    { name: '🧩 BNB — BNB (Binance)',                value: 'BNB' },
                ];
                const focused = interaction.options.getFocused().toUpperCase();
                const filtered = CURRENCIES
                    .filter(c => c.value.includes(focused) || c.name.toUpperCase().includes(focused))
                    .slice(0, 25);
                return interaction.respond(filtered);
            }
            if (interaction.commandName === 'baixar_musica_atual') {
                const focused = (interaction.options.getFocused() || '').toLowerCase();
                let members = [];
                if (interaction.guild) {
                    try {
                        const fetched = await interaction.guild.members.fetch({ query: focused, limit: 20 });
                        members = Array.from(fetched.values());
                    } catch (_) {
                        members = Array.from(interaction.guild.members.cache.values());
                    }
                }
                const choices = members
                    .filter(m => !m.user?.bot)
                    .map(m => {
                        const name = m.displayName || m.user?.globalName || m.user?.username;
                        return {
                            name: `${name} (@${m.user?.username})`.substring(0, 100),
                            value: m.user?.id || m.id
                        };
                    })
                    .filter(c => c.name.toLowerCase().includes(focused) || c.value.includes(focused))
                    .slice(0, 25);
                return interaction.respond(choices).catch(() => {});
            }
            return;
        }
        const { commandName } = interaction;
        if (commandName === 'memoria') {
            const { handleMemoryInteraction } = require('../handlers/memoryPanelHandler');
            return await handleMemoryInteraction(interaction);
        } else if (commandName === 'ia_chat') {
            const prompt = interaction.options.getString('prompt');
            const visibility = interaction.options.getString('visibilidade');
            const voice = interaction.options.getBoolean('voice');
            const isPublic = visibility === 'public';
            await addToQueue(prompt, interaction, 'slash', {
                allowSearch: false,
                public: isPublic,
                memoryRequest: prompt,
                guildId: interaction.guildId,
                voice: typeof voice === 'boolean' ? voice : undefined,
                forceVoice: voice === true
            });
        } else if (commandName === 'config_servidor') {
            return await handleServerAdminCommand(interaction);
        } else if (commandName === 'ia_ferramentas') {
            return await handleIaFerramentasCommand(interaction);
        } else if (commandName === 'config_criador') {
            return await handleCreatorAdminCommand(interaction, client);
        } else if (commandName === 'aceitar_tos') {
            const memberPerms = interaction.memberPermissions || interaction.member?.permissions;
            const hasPermission = !interaction.guild ||
                config.isOwner(interaction.user.id) ||
                (interaction.guild && interaction.user.id === interaction.guild.ownerId) ||
                (memberPerms && (
                    memberPerms.has(PermissionFlagsBits.Administrator) ||
                    memberPerms.has(PermissionFlagsBits.ManageGuild) ||
                    memberPerms.has(PermissionFlagsBits.ManageChannels)
                ));
            if (!hasPermission) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Acesso Negado')
                    .setDescription('Apenas o dono do servidor ou administradores podem aceitar os Termos de Uso.');
                return interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }
            const { isServerAccepted, sendTermsOfService } = require('../handlers/tosHandler');
            if (isServerAccepted(interaction.guildId)) {
                const alreadyAcceptedEmbed = new EmbedBuilder()
                    .setColor(0x10B981)
                    .setTitle('✅ Termos de Uso Já Aceitos')
                    .setDescription('Os Termos de Uso da Hikari já foram previamente aceitos e estão ativos neste servidor.')
                    .setFooter({ text: 'Hikari ToS • by yGuilhermy' })
                    .setTimestamp();
                return interaction.reply({ embeds: [alreadyAcceptedEmbed], ephemeral: true });
            }
            await sendTermsOfService(interaction);
        } else if (commandName === 'ajuda') {
            const { buildHelpHomePayload } = require('../handlers/helpPanelHandler');
            return await interaction.reply({ ...buildHelpHomePayload(), ephemeral: false });
        } else if (commandName === 'ia_imagem') {
            const prompt = interaction.options.getString('prompt');
            const negativePrompt = interaction.options.getString('negative_prompt') || '';
            const width = interaction.options.getInteger('width') || 1024;
            const height = interaction.options.getInteger('height') || 1024;
            const provider = interaction.options.getString('provider') || 'auto';
            const isNsfw = Boolean(interaction.channel?.nsfw);
            await interaction.deferReply({ ephemeral: false });
            try {
                const imageData = await generateImage(prompt, negativePrompt, width, height, { provider, bypassSafety: isNsfw });
                if (imageData) {
                    const drawEmbed = new EmbedBuilder()
                        .setColor(0x7C3AED)
                        .setTitle('🎨 Imagem Gerada')
                        .setDescription('⚠️ **Aviso:** Eu apenas **gero** imagens novas a partir de texto. Eu **não edito** imagens geradas anteriormente nem arquivos de imagem existentes.')
                        .addFields(
                            { name: '🤖 Modelo', value: `\`${imageData.modelName || 'Desconhecido'}\``, inline: false },
                            { name: '🌱 Seed', value: `\`${imageData.actualSeed}\``, inline: true },
                            { name: '📐 Resolução', value: `\`${width}x${height}\``, inline: true }
                        )
                        .setFooter({ text: `Prompt: ${prompt.substring(0, 100)} • by yGuilhermy` })
                        .setTimestamp();
                    const files = [];
                    if (imageData.imageUrl) {
                        drawEmbed.setImage(imageData.imageUrl);
                    } else if (imageData.localFilePath && fs.existsSync(imageData.localFilePath)) {
                        const attachment = new AttachmentBuilder(imageData.localFilePath, { name: 'draw.png' });
                        drawEmbed.setImage('attachment://draw.png');
                        files.push(attachment);
                        setTimeout(() => { try { if (fs.existsSync(imageData.localFilePath)) fs.unlinkSync(imageData.localFilePath); } catch (_) {} }, 10_000);
                    }
                    await interaction.editReply({ embeds: [drawEmbed], files });
                } else {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Falha na Geração')
                        .setDescription('Não consegui gerar a imagem.');
                    await interaction.editReply({ embeds: [errEmbed] });
                }
            } catch (error) {
                console.error('Erro /draw:', error);
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Erro')
                    .setDescription(error.message);
                await interaction.editReply({ embeds: [errEmbed] });
            }
        } else if (['baixar_musica', 'baixar_video', 'baixar_musica_deezer'].includes(commandName)) {
            let request;
            try {
                const userId = interaction.user.id;
                request = acquireMediaRequest(userId);
                await interaction.deferReply();
                const send = payload => interaction.editReply(payload);
                if (commandName === 'baixar_musica_deezer') {
                    const result = await handleMusicSearchAndDownload(interaction.options.getString('nome'), null,
                        musicOptions(interaction, userId, request.signal));
                    await deliverMusicResult(result, send, request.signal);
                } else {
                    const video = commandName === 'baixar_video';
                    await deliverMediaLink(interaction, userId, video ? 'video' : 'audio',
                        interaction.options.getString('url'), video && interaction.options.getBoolean('descricao'),
                        send, request.signal);
                }
            } catch (error) {
                const payload = { content: '❌ ' + formatMediaError(error), embeds: [], components: [] };
                if (interaction.deferred) await interaction.editReply(payload);
                else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
            } finally {
                request?.release();
            }
        } else if (commandName === 'buscar_jogo') {
            await executeGameCommand(interaction);
        } else if (commandName === 'chat_resumo') {
            const amount = interaction.options.getInteger('quantidade') || 20;
            await interaction.deferReply();
            try {
                const { resolveMessageAudioContent } = require('../handlers/audioTranscriptionHandler');
                const { resolveMessageVisualContent } = require('../handlers/imageVisionHandler');
                const messages = await interaction.channel.messages.fetch({ limit: amount });
                const sortedMessages = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
                let conversationLog = "";
                for (const msg of sortedMessages) {
                    let resolved = await resolveMessageAudioContent(msg);
                    resolved = await resolveMessageVisualContent(msg, resolved);
                    if (resolved) {
                        const time = msg.createdAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
                        conversationLog += `[${time}] ${msg.author.username}: ${resolved}\n`;
                    }
                }
                const summaryPrompt = `Faça um resumo: \n${conversationLog}`;
                await addToQueue(summaryPrompt, interaction, 'slash', { allowSearch: false, disableTools: true });
            } catch (error) {
                console.error('summary:', error);
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Erro no Resumo')
                    .setDescription('Não foi possível obter o histórico de mensagens ou gerar o resumo deste canal.');
                await interaction.editReply({ embeds: [errEmbed] });
            }
        } else if (commandName === 'anime_origem') {
            await handleSauceCommand(interaction);
        } else if (commandName === 'ia_config') {
            if (!config.isOwner(interaction.user.id)) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Acesso Negado')
                    .setDescription('Comando restrito ao criador da Hikari.');
                return interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }
            const provider = interaction.options.getString('provider');
            const setting = interaction.options.getString('setting');
            const value = interaction.options.getNumber('value');
            if (provider) {
                if (!setting || value === null) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Dados Insuficientes')
                        .setDescription('Para configurar um provedor de IA, especifique a configuração e o valor.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                updateProviderSetting(provider, setting, value);
            }
            const successEmbed = new EmbedBuilder()
                .setColor(0x10B981)
                .setTitle('⚙️ Configurações • Parâmetros de IA')
                .setDescription('As variáveis operacionais dos modelos de IA foram ajustadas com sucesso.');
            if (provider) {
                successEmbed.addFields(
                    { name: 'Provedor', value: provider, inline: true },
                    { name: 'Configuração', value: setting, inline: true },
                    { name: 'Valor', value: String(value), inline: true }
                );
            }
            await interaction.reply({ embeds: [successEmbed], ephemeral: true });
        } else if (commandName === 'steam_jogo') {
            const query = interaction.options.getString('nome');
            await interaction.deferReply();
            try {
                const steamInfo = await getSteamGameInfo(query);
                if (steamInfo.error) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Erro na Steam')
                        .setDescription(steamInfo.error);
                    return await interaction.editReply({ embeds: [errEmbed] });
                }

                let finalDesc = steamInfo.description || "Sem sinopse válida.";
                if (finalDesc.length > 3900) finalDesc = finalDesc.substring(0, 3900) + '...';

                const steamEmbed = new EmbedBuilder()
                    .setColor(0x7C3AED)
                    .setTitle(steamInfo.name)
                    .setURL(steamInfo.url)
                    .setDescription(finalDesc)
                    .addFields(
                        { name: 'Preço', value: steamInfo.discount > 0 ? `~~${steamInfo.originalPrice}~~ **${steamInfo.price}** (-${steamInfo.discount}%)` : steamInfo.price, inline: true },
                        { name: 'Lançamento', value: steamInfo.releaseDate, inline: true },
                        { name: 'Desenvolvedor', value: steamInfo.developers, inline: true }
                    )
                    .setFooter({ text: 'Fonte: Loja da Steam • Hikari • by yGuilhermy' })
                    .setTimestamp();

                if (steamInfo.headerImage) {
                    steamEmbed.setImage(steamInfo.headerImage);
                }
                if (steamInfo.metacritic) {
                    steamEmbed.addFields({ name: 'Metacritic', value: `${steamInfo.metacritic}/100 🌟`, inline: true });
                }

                let hikariComment = "";
                try {
                    const commentPrompt = `Eu acabei de consultar o jogo "${steamInfo.name}" na Steam via comando manual. O preço atual é ${steamInfo.price}. Faça um comentário simples, natural e bem casual (1 a 2 frases curtas) sobre isso na sua personalidade autêntica (sem emojis normais, kaomojis reduzidos e raros). Apenas o texto, sem JSON, sem ferramentas.`;
                    const rawComment = await generateResponse(commentPrompt, interaction.channelId, { allowSearch: false, disableTools: true, guildId: interaction.guildId, isInternalComment: true });
                    if (rawComment && !rawComment.includes('⚠️ SYSTEM ERROR')) {
                        let cleanData = rawComment.replace(/\n-# .*$/gm, '').trim();
                        const jsonMatch = cleanData.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            try {
                                const parsed = JSON.parse(jsonMatch[0]);
                                cleanData = parsed.response || parsed.content || parsed.text || parsed.reply || cleanData;
                            } catch (e) {}
                        }
                        hikariComment = cleanData;
                    }
                } catch (e) {
                    console.warn('[SteamCommand] Falha ao gerar comentário IA:', e.message);
                }

                await interaction.editReply({ content: hikariComment || null, embeds: [steamEmbed] });
            } catch (error) {
                console.error('Erro no comando steam_jogo:', error);
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Erro de Processamento')
                    .setDescription('Erro ao processar a consulta da Steam.');
                await interaction.editReply({ embeds: [errEmbed] });
            }
        } else if (commandName === 'converter_moeda') {
            const amount = interaction.options.getNumber('valor');
            const from = interaction.options.getString('de');
            const to = interaction.options.getString('para');
            await interaction.deferReply();
            try {
                const convInfo = await convertCurrency(amount, from, to);
                if (convInfo.error) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Erro na Conversão')
                        .setDescription(convInfo.error);
                    return await interaction.editReply({ embeds: [errEmbed] });
                }

                const amountFormatted = formatCurrencyNumber(convInfo.amount);
                const resultFormatted = formatCurrencyNumber(convInfo.result);
                const rateFormatted = formatCurrencyNumber(convInfo.rate);
                
                const convEmbed = new EmbedBuilder()
                    .setColor(0x10B981)
                    .setTitle(`Conversão de Moedas: ${convInfo.name || `${convInfo.from}/${convInfo.to}`}`)
                    .setDescription(`**${amountFormatted} ${convInfo.from}** equivale a **${resultFormatted} ${convInfo.to}**`)
                    .addFields(
                        { name: 'Cotação (' + convInfo.from + ')', value: `1 ${convInfo.from} = ${rateFormatted} ${convInfo.to}`, inline: true },
                        { name: 'Última Atualização', value: convInfo.lastUpdate || 'Desconhecida', inline: true }
                    );

                if (convInfo.pctChange) {
                    convEmbed.addFields({ name: '📊 Variação (24h)', value: `${Number(convInfo.pctChange) >= 0 ? '📈 +' : '📉 '}${convInfo.pctChange}%`, inline: true });
                }
                if (convInfo.high && convInfo.low) {
                    convEmbed.addFields({ name: '📈 Máx / Mín (24h)', value: `${formatCurrencyNumber(convInfo.high)} / ${formatCurrencyNumber(convInfo.low)}`, inline: true });
                }

                convEmbed.setFooter({ text: 'Fonte: Câmbio Oficial (AwesomeAPI / ER-API) • Hikari • by yGuilhermy' })
                    .setTimestamp();
                    
                let hikariComment = "";
                try {
                    const commentPrompt = `Eu acabei de converter ${convInfo.amount} ${convInfo.from} para ${convInfo.to} via comando manual. O resultado foi ${resultFormatted}. Faça um comentário simples, natural e bem casual (1 a 2 frases curtas) sobre isso na sua personalidade autêntica (sem emojis normais, kaomojis reduzidos e raros). Apenas o texto, sem JSON, sem ferramentas.`;
                    const rawComment = await Promise.race([
                        generateResponse(commentPrompt, interaction.channelId, { allowSearch: false, disableTools: true, guildId: interaction.guildId, isInternalComment: true }),
                        new Promise(resolve => setTimeout(() => resolve(null), 3000))
                    ]);
                    if (rawComment && !rawComment.includes('⚠️ SYSTEM ERROR')) {
                        let cleanData = rawComment.replace(/\n-# .*$/gm, '').trim();
                        const jsonMatch = cleanData.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            try {
                                const parsed = JSON.parse(jsonMatch[0]);
                                cleanData = parsed.response || parsed.content || parsed.text || parsed.reply || cleanData;
                            } catch (e) {}
                        }
                        hikariComment = cleanData;
                    }
                } catch (e) {
                    console.warn('[CurrencyCommand] Falha ao gerar comentário IA:', e.message);
                }

                await interaction.editReply({ content: hikariComment || null, embeds: [convEmbed] });
            } catch (error) {
                console.error('Erro no comando converter_moeda:', error);
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Erro de Processamento')
                    .setDescription('Erro ao tentar converter essa moeda.');
                await interaction.editReply({ embeds: [errEmbed] });
            }
        } else if (commandName === 'entrar-call') {
            const modo = interaction.options.getString('modo') || 'conversa';
            await interaction.deferReply({ ephemeral: true });
            if (modo === 'radio') {
                const { startRadioMode } = require('../music/radioManager');
                try {
                    const result = await startRadioMode(interaction.member, interaction.channel, client);
                    if (result.success) {
                        await interaction.editReply({ content: '📻 Entrando no canal de voz em Modo Rádio!' });
                    } else {
                        await interaction.editReply({ content: result.error || '❌ Não foi possível entrar no Modo Rádio.' });
                    }
                } catch (err) {
                    console.error('[EntrarCallRadio]', err);
                    await interaction.editReply({ content: '❌ Erro ao entrar no canal de voz em Modo Rádio.' });
                }
            } else if (modo === 'hibrido') {
                const { startHybridMode } = require('../music/radioManager');
                try {
                    const result = await startHybridMode(interaction.member, interaction.channel, client);
                    if (result.success) {
                        await interaction.editReply({ content: result.message || '🎙️📻 Entrando no canal de voz em Modo Híbrido!' });
                    } else {
                        await interaction.editReply({ content: result.error || '❌ Não foi possível entrar no Modo Híbrido.' });
                    }
                } catch (err) {
                    console.error('[EntrarCallHibrido]', err);
                    await interaction.editReply({ content: '❌ Erro ao entrar no canal de voz em Modo Híbrido.' });
                }
            } else {
                const { joinVoiceCall } = require('../handlers/voiceHandler');
                const result = await joinVoiceCall(interaction.member, interaction.channel);
                if (result) {
                    await interaction.editReply({ content: '✅ Processando entrada no canal de voz em Modo Conversa...' });
                } else {
                    await interaction.editReply({ content: '❌ Não foi possível entrar no canal de voz.' });
                }
            }
        } else if (commandName === 'sair-call') {
            const { leaveVoiceCall } = require('../handlers/voiceHandler');
            await interaction.deferReply({ ephemeral: true });
            const result = await leaveVoiceCall(interaction.guildId, interaction.channel);
            if (result) {
                await interaction.editReply({ content: '✅ Saí do canal de voz.' });
            } else {
                await interaction.editReply({ content: '❌ Não estou em nenhum canal de voz neste servidor.' });
            }
        } else if (commandName === 'modo-radio') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            try {
                const result = await startRadioMode(interaction.member, interaction.channel, client);
                if (result.success) {
                    await interaction.editReply({ content: '📻 Modo Rádio ativado!' });
                } else {
                    await interaction.editReply({ content: result.error || '❌ Não foi possível ativar o Modo Rádio.' });
                }
            } catch (err) {
                console.error('[ModoRadio]', err);
                await interaction.editReply({ content: '❌ Erro ao iniciar o Modo Rádio.' });
            }
        } else if (commandName === 'modo-hibrido') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            try {
                const result = await startHybridMode(interaction.member, interaction.channel, client);
                if (result.success) {
                    await interaction.editReply({ content: result.message || '🎙️📻 Modo Híbrido ativado!' });
                } else {
                    await interaction.editReply({ content: result.error || '❌ Não foi possível ativar o Modo Híbrido.' });
                }
            } catch (err) {
                console.error('[ModoHibrido]', err);
                await interaction.editReply({ content: '❌ Erro ao iniciar o Modo Híbrido.' });
            }
        } else if (commandName === 'baixar_musica_atual') {
            let request;
            try {
                const userId = interaction.user.id;
                request = acquireMediaRequest(userId);
                await interaction.deferReply();
                const activity = await getCurrentMusicFromUser(interaction.options.getString('usuario') || userId,
                    client, interaction.guildId, { requesterId: userId });
                if (!activity.success) return await interaction.editReply({ content: activity.message, allowedMentions: { parse: [] } });
                const infoEmbed = musicActivityEmbed(activity, userId);
                await interaction.editReply({ content: 'Consultando o catálogo Deezer…', allowedMentions: { parse: [] } });
                const result = await handleMusicSearchAndDownload(activity.searchQuery, null, {
                    ...musicOptions(interaction, userId, request.signal), activity, infoEmbed
                });
                await deliverMusicResult(result, payload => interaction.editReply(payload), request.signal, infoEmbed);
            } catch (error) {
                const payload = { content: '❌ ' + formatMediaError(error), embeds: [], components: [] };
                if (interaction.deferred) await interaction.editReply(payload);
                else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
            } finally {
                request?.release();
            }
        }
    },
};