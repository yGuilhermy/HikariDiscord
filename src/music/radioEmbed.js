const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } = require('discord.js');

const { peekNextTrack, canGoPrevious, playedIndices } = require('./radioDatabase');

function safeText(value, maxLength, fallback = '—') {
    const clip = text => text.slice(0, maxLength - 1).replace(/[\uD800-\uDBFF]$/, '');
    const raw = String(value || fallback).slice(0, maxLength + 1).replace(/[\r\n\t]+/g, ' ').trim() || fallback;
    const text = escapeMarkdown(raw.length > maxLength ? clip(raw) + '…' : raw);
    return text.length <= maxLength ? text : clip(text).replace(/\\$/, '') + '…';
}

function thumbnail(embed, url) {
    try {
        if (['http:', 'https:'].includes(new URL(url).protocol)) embed.setThumbnail(url);
    } catch (_) {}
}

function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '?:??';
    const m = Math.floor(seconds / 60);
    const s = String(Math.floor(seconds % 60)).padStart(2, '0');
    return `${m}:${s}`;
}

function loopLabel(mode) {
    if (mode === 'TRACK') return '🔂 1×';
    if (mode === 'QUEUE') return '🔁 Playlist';
    return '🔁 Off';
}

function loopButtonStyle(mode) {
    if (mode === 'OFF') return ButtonStyle.Secondary;
    return ButtonStyle.Success;
}

function voiceModeLabel(mode, isHybrid = false) {
    if (isHybrid) {
        if (mode === 'HYBRID') return '🎙️ Híbrido (Ambos)';
        if (mode === 'CHAT_ONLY') return '💬 Apenas Chat';
        if (mode === 'MUSIC_DIRECT') return '⚡ Música: Direto';
        if (mode === 'MUSIC_IA') return '🧠 Música: IA';
        return '🔇 Desligado (Painel)';
    }
    if (mode === 'DIRECT') return '⚡ Voz: Direct';
    if (mode === 'IA') return '🧠 Voz: IA';
    return '🔇 Voz: Off';
}

function voiceButtonStyle(mode, isHybrid = false) {
    if (isHybrid) {
        if (mode === 'HYBRID') return ButtonStyle.Success;
        if (mode === 'CHAT_ONLY') return ButtonStyle.Primary;
        if (mode === 'MUSIC_DIRECT') return ButtonStyle.Secondary;
        if (mode === 'MUSIC_IA') return ButtonStyle.Secondary;
        return ButtonStyle.Danger;
    }
    if (mode === 'DIRECT') return ButtonStyle.Success;
    if (mode === 'IA') return ButtonStyle.Primary;
    return ButtonStyle.Danger;
}

function buildRadioEmbed(session) {
    const track = session.currentTrack;
    const status = session.status;
    const playlist = session.playlist || [];
    const currentPos = session.currentIndex >= 0 ? session.currentIndex + 1 : 0;

    const statusLabel = status === 'PLAYING' ? '▶️ Tocando' : status === 'BUFFERING' ? '⏳ Carregando...' : status === 'PAUSED' ? '⏸️ Pausado' : '⏹️ Parado';
    const color = status === 'PLAYING' ? 0x1DB954 : status === 'BUFFERING' ? 0x3B82F6 : status === 'PAUSED' ? 0xF59E0B : 0x6B7280;

    const isHybrid = !!session.isHybrid;
    const currentVoiceMode = session.voiceMode;
    const voiceLabel = voiceModeLabel(currentVoiceMode, isHybrid);
    const effectiveVoiceLabel = session.voiceDisabled ? '🔒 Escuta desativada no servidor' :
        session.voiceCooldownUntil > Date.now() && currentVoiceMode !== 'OFF' ? voiceLabel + ' · escuta em espera' : voiceLabel;

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(isHybrid ? '🎙️📻 Modo Híbrido — Hikari' : '📻 Modo Rádio — Hikari')
        .setFooter({ text: isHybrid ? 'Hikari Modo Híbrido • Use os botões abaixo para controlar' : 'Hikari Radio • Use os botões abaixo para controlar' });

    const isFast = session.streamMode === 'FAST';
    const streamModeText = isFast ? '⚡ Rápido (Converte YT ➔ Deezer)' : '⚖️ Híbrido (Padrão)';

    if (track) {
        embed.setDescription(`**${statusLabel}** (Faixa #${currentPos} de ${playlist.length})`)
            .addFields(
                { name: '🎵 Faixa Atual', value: `**#${currentPos}. ${safeText(track.title, 475)}** — ${safeText(track.artist, 475)}`, inline: false },
                { name: '⏱️ Duração', value: formatDuration(track.duration), inline: true },
                { name: '📂 Álbum', value: safeText(track.album, 256), inline: true },
                { name: '📋 Playlist Total', value: `${playlist.length} faixa(s)`, inline: true },
                { name: '🎲 Shuffle', value: session.shuffle ? '✅ Ativo' : '❌ Off', inline: true },
                { name: '🔁 Loop', value: loopLabel(session.loopMode), inline: true },
                { name: '🚀 Busca', value: streamModeText, inline: true },
                { name: '🎙️ Voz', value: effectiveVoiceLabel, inline: true }
            );
        thumbnail(embed, track.cover);
        if (/^\d+$/.test(track.addedBy || '')) embed.addFields({ name: '➕ Adicionada por', value: `<@${track.addedBy}>`, inline: true });
    } else {
        embed.setDescription(`**${statusLabel}**\n\nNenhuma faixa tocando. Playlist com ${playlist.length} música(s). Use ➕ para adicionar!\n🚀 **Modo de Busca:** ${streamModeText}\n🎙️ **Modo de Voz:** ${effectiveVoiceLabel}`);
    }

    if (session.playbackError) embed.addFields({ name: 'Falha na reprodução', value: session.playbackError });

    const prevDisabled = !canGoPrevious(session);
    const nextDisabled = !peekNextTrack(session.guildId, { reason: 'manual' });
    const stopDisabled = status === 'STOPPED';
    const shuffleDisabled = playlist.length <= 1;
    const removeDisabled = playlist.length === 0;
    const queueDisabled = playlist.length === 0;

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('radio_prev').setLabel('⏮️').setStyle(ButtonStyle.Secondary).setDisabled(prevDisabled),
        new ButtonBuilder().setCustomId('radio_playpause').setEmoji(status === 'PLAYING' ? '⏸️' : '▶️').setLabel(status === 'BUFFERING' ? 'Carregando' : status === 'PLAYING' ? 'Pausar' : 'Play')
            .setStyle(ButtonStyle.Primary).setDisabled(!playlist.length || status === 'BUFFERING'),
        new ButtonBuilder().setCustomId('radio_stop').setLabel('⏹️').setStyle(ButtonStyle.Danger).setDisabled(stopDisabled),
        new ButtonBuilder().setCustomId('radio_next').setLabel('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(nextDisabled),
        new ButtonBuilder().setCustomId('radio_shuffle').setLabel('🔀 Shuffle').setStyle(session.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(shuffleDisabled)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('radio_add').setLabel('➕ Adicionar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('radio_remove').setLabel('🗑️ Remover').setStyle(ButtonStyle.Danger).setDisabled(removeDisabled),
        new ButtonBuilder().setCustomId('radio_queue').setLabel('📜 Ver Lista').setStyle(ButtonStyle.Secondary).setDisabled(queueDisabled),
        new ButtonBuilder().setCustomId('radio_loop').setLabel(loopLabel(session.loopMode)).setStyle(loopButtonStyle(session.loopMode)),
        new ButtonBuilder().setCustomId('radio_leave').setLabel('🚪 Sair').setStyle(ButtonStyle.Secondary)
    );

    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('radio_voice_toggle').setLabel(voiceModeLabel(currentVoiceMode, isHybrid)).setStyle(voiceButtonStyle(currentVoiceMode, isHybrid)),
        new ButtonBuilder().setCustomId('radio_stream_mode').setLabel(isFast ? '⚡ Rápido' : '⚖️ Híbrido').setStyle(isFast ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setLabel('Apoie o projeto').setURL('https://bio.site/yGuilhermy').setStyle(ButtonStyle.Link).setEmoji('💖')
    );

    return { embeds: [embed], components: [row1, row2, row3] };
}

function buildQueueEmbed(session, page = 1) {
    const playlist = session.playlist || [];
    const currentIdx = typeof session.currentIndex === 'number' ? session.currentIndex : -1;
    const totalPages = Math.max(1, Math.ceil(playlist.length / 10));
    const safePage = Math.min(Math.max(1, page), totalPages);

    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle('📋 Fila do Rádio')
        .setFooter({ text: `Página ${safePage}/${totalPages} • ${playlist.length} faixa(s) cadastradas` });

    if (playlist.length === 0) {
        embed.setDescription('Fila vazia.');
        return { embed, components: [] };
    }

    const startIndex = (safePage - 1) * 10;
    const pageTracks = playlist.slice(startIndex, startIndex + 10);

    const played = playedIndices(session);
    let desc = '';
    pageTracks.forEach((t, relativeIndex) => {
        const absoluteIndex = startIndex + relativeIndex;
        const pos = absoluteIndex + 1;
        const dur = formatDuration(t.duration);
        if (absoluteIndex === currentIdx && session.status === 'PLAYING') {
            desc += `**▶️ #${pos}. ${safeText(t.title, 190)} — ${safeText(t.artist, 130)}** (tocando agora)\n`;
        } else if (absoluteIndex === currentIdx && session.status === 'PAUSED') {
            desc += `**⏸️ #${pos}. ${safeText(t.title, 190)} — ${safeText(t.artist, 130)}** (pausada)\n`;
        } else if (absoluteIndex === currentIdx && session.status === 'BUFFERING') {
            desc += `**⏳ #${pos}. ${safeText(t.title, 190)} — ${safeText(t.artist, 130)}** (carregando)\n`;
        } else if (played.has(absoluteIndex)) {
            desc += `~~#${pos}. ${safeText(t.title, 190)} — ${safeText(t.artist, 130)}~~\n`;
        } else {
            desc += `**#${pos}.** ${safeText(t.title, 190)} — ${safeText(t.artist, 130)} (${dur})\n`;
        }
    });

    embed.setDescription(desc || 'Fila vazia.');

    const components = [];
    if (totalPages > 1) {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`radio_qpage_${session.id}_${safePage - 1}`).setLabel('⬅️ Anterior').setStyle(ButtonStyle.Secondary).setDisabled(safePage <= 1),
            new ButtonBuilder().setCustomId(`radio_qpage_${session.id}_${safePage + 1}`).setLabel('Próxima ➡️').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= totalPages)
        );
        components.push(row);
    }

    return { embed, components };
}

function buildAmbiguousEmbed(results) {
    const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle('🎵 Qual música você quer?')
        .setDescription('Não achei a correta com certeza. Escolha uma das opções abaixo:')
        .setFooter({ text: 'Powered by Deezer' });

    thumbnail(embed, results[0]?.cover);

    results.slice(0, 10).forEach((t, i) => {
        embed.addFields({
            name: `${i + 1}. ${safeText(t.title, 210)}`,
            value: `👤 ${safeText(t.artist, 180)} | ⏱️ ${formatDuration(t.duration)}`,
            inline: false
        });
    });

    return embed;
}

function buildNotFoundEmbed(query) {
    return new EmbedBuilder()
        .setColor(0xE11D48)
        .setTitle('❌ Música não encontrada')
        .setDescription(`Não consegui encontrar **"${safeText(query, 350)}"** nos serviços de música.`)
        .setFooter({ text: 'Hikari Radio' });
}

module.exports = {
    buildRadioEmbed,
    buildQueueEmbed,
    buildAmbiguousEmbed,
    buildNotFoundEmbed,
    formatDuration,
    voiceModeLabel,
    voiceButtonStyle,
    safeText
};
