const { ActivityType } = require('discord.js');

const PREMID_YTMUSIC_APP_ID = '463151177836658699';

const PLATFORM_PRIORITY = [
    {
        id: 'spotify',
        label: 'Spotify',
        emoji: '🟢',
        match: (a) => a.name === 'Spotify' && a.type === ActivityType.Listening,
        extract: (a) => ({
            title: a.details,
            artist: a.state?.replace(/^by\s+/i, '') || null,
            album: a.assets?.largeText || null,
            coverUrl: a.assets?.largeImage?.startsWith('spotify:')
                ? `https://i.scdn.co/image/${a.assets.largeImage.replace('spotify:', '')}`
                : null,
        }),
    },
    {
        id: 'ytmusic',
        label: 'YouTube Music',
        emoji: '▶️',
        match: (a) =>
            (a.applicationId === PREMID_YTMUSIC_APP_ID ||
                a.name?.toLowerCase() === 'youtube music') &&
            a.details,
        extract: (a) => ({
            title: a.details,
            artist: a.state || null,
            album: a.assets?.largeText || null,
            coverUrl: typeof a.assets?.largeImage === 'string' && a.assets.largeImage.startsWith('http')
                ? a.assets.largeImage
                : null,
        }),
    },
    {
        id: 'other',
        label: 'Outros',
        emoji: '🎵',
        match: (a) => a.type === ActivityType.Listening && a.details,
        extract: (a) => ({
            title: a.details,
            artist: a.state || null,
            album: a.assets?.largeText || null,
            coverUrl: typeof a.assets?.largeImage === 'string' && a.assets.largeImage.startsWith('http')
                ? a.assets.largeImage
                : null,
        }),
    },
];


function memberId(member) {
    return member?.id || member?.user?.id;
}

function readNameMatches(members, name) {
    const username = [];
    const displayName = [];
    for (const member of members.values ? members.values() : members) {
        if (member.user?.username?.toLowerCase() === name) username.push(member);
        else if (member.displayName?.toLowerCase() === name || member.user?.globalName?.toLowerCase() === name) {
            displayName.push(member);
        }
    }
    return username.length ? username : displayName;
}

async function resolveMember(rawInput, client, guildId, requesterId) {
    const target = String(rawInput || '').trim();
    const id = target.match(/^(?:<@!?(\d{17,20})>|(\d{17,20}))$/)?.slice(1).find(Boolean);
    const guilds = client?.guilds?.cache;
    if (!guilds || !target) return {};
    if (!guildId) {
        if (!id || id !== requesterId) return {};
        let fallback;
        for (const guild of guilds.values()) {
            const members = guild.members.cache;
            const member = members.get?.(id) || members.find?.(candidate => memberId(candidate) === id);
            if (!member) continue;
            if (member.presence?.status && member.presence.status !== 'offline') return { member };
            fallback ||= member;
        }
        return { member: fallback };
    }

    const guild = guilds.get(guildId);
    if (!guild) return {};
    if (id) {
        const cached = guild.members.cache.get?.(id);
        const fetched = cached?.presence ? null : await guild.members.fetch({ user: id, withPresences: true }).catch(() => null);
        const member = fetched || cached;
        return id === memberId(member) ? { member } : {};
    }

    const name = target.replace(/^@/, '').toLowerCase().trim();
    if (!name) return {};
    const local = readNameMatches(guild.members.cache, name);
    const candidates = new Map(local.map(member => [memberId(member), member]));
    if (!local.some(member => member.user?.username?.toLowerCase() === name)) {
        const searched = await guild.members.search({ query: name, limit: 20 }).catch(() => null);
        if (searched) {
            for (const member of readNameMatches(searched, name)) candidates.set(memberId(member), member);
        }
    }

    const exact = readNameMatches(candidates, name);
    if (exact.length !== 1) return { ambiguous: exact.length > 1 };
    const member = exact[0];
    if (member.presence || !memberId(member)) return { member };
    const refreshed = await guild.members.fetch({ user: memberId(member), withPresences: true }).catch(() => null);
    return { member: memberId(refreshed) === memberId(member) ? refreshed : member };
}

function cleanText(value, maximum) {
    return typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, maximum) : '';
}

function safeCover(url) {
    try {
        const cover = new URL(url);
        return cover.protocol === 'https:' && !cover.username && !cover.password && cover.href.length <= 2000
            ? cover.href : null;
    } catch (_) {
        return null;
    }
}

async function getCurrentMusicFromUser(userId, client, guildId = null, { requesterId } = {}) {
    const { member, ambiguous } = await resolveMember(userId, client, guildId, requesterId);
    if (ambiguous) {
        return { success: false, reason: 'ambiguous_member', message: 'Encontrei mais de uma pessoa com esse nome. Mencione quem você quer consultar.' };
    }
    if (!member) {
        const message = guildId
            ? 'Não encontrei essa pessoa neste servidor. Use uma menção ou o nome de usuário exato.'
            : 'No privado, a consulta usa sua própria atividade visível em um servidor compartilhado com a Hikari.';
        return { success: false, reason: 'no_guild', message };
    }

    const userName = member.user?.globalName || member.displayName || member.user?.username || 'Usuário';
    if (!member.presence || member.presence.status === 'offline') {
        return {
            success: false,
            reason: 'no_presence',
            userName,
            isOffline: member.presence?.status === 'offline',
            message: 'A atividade musical de ' + userName + ' não está visível para mim neste momento.',
            helpInstructions: true
        };
    }

    const activities = member.presence.activities || [];
    for (const platform of PLATFORM_PRIORITY) {
        const activity = activities.find(a => platform.match(a));
        if (!activity) continue;

        const data = platform.extract(activity);
        const title = cleanText(data.title, 150);
        if (!title) continue;
        const artist = cleanText(data.artist, 130);
        return {
            success: true,
            platform: platform.id,
            platformLabel: platform.label,
            platformEmoji: platform.emoji,
            title,
            artist: artist || 'Artista desconhecido',
            album: cleanText(data.album, 150) || null,
            coverUrl: safeCover(data.coverUrl),
            targetUser: { id: memberId(member), username: member.user?.username || userName, displayName: userName },
            searchQuery: [title, artist].filter(Boolean).join(' ')
        };
    }

    return {
        success: false,
        reason: 'no_music',
        userName,
        message: 'Não encontrei uma atividade musical visível agora.',
        helpInstructions: true
    };
}

module.exports = { getCurrentMusicFromUser };
