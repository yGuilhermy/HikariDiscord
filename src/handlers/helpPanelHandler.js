const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');

const { commands } = require('../commands/slashCommands');

const COMMAND_GROUPS = [
    ["Conversa e ajuda", [
        ["ia_chat", "Faça uma pergunta ou um pedido. A resposta é privada por padrão e pode ser enviada em voz."],
        ["chat_resumo", "Resume as mensagens recentes do canal. A quantidade aceita vai de 10 a 100."],
        ["ajuda", "Abre este painel com a lista de comandos."],
    ]],
    ["Imagem e mídia", [
        ["ia_imagem", "Gera uma imagem a partir de uma descrição e aceita a escolha de provedor."],
        ["anime_origem", "Identifica uma cena de anime por imagem anexada ou URL. Envie pelo menos uma das duas."],
        ["baixar_musica", "Extrai o áudio em MP3 de um link de vídeo compatível."],
        ["baixar_musica_deezer", "Busca e baixa uma faixa no Deezer pelo nome da música ou do artista."],
        ["baixar_musica_atual", "Identifica a música pela atividade do Discord, como Spotify ou YouTube Music, e procura a faixa para baixar."],
        ["baixar_video", "Baixa um vídeo em MP4 e ajusta a compressão para o limite de envio. A opção descricao liga a exibição da descrição."],
    ]],
    ["Jogos e câmbio", [
        ["buscar_jogo", "Busca jogos pelo nome nos catálogos locais DODI e FitGirl."],
        ["steam_jogo", "Consulta preço e detalhes de um jogo na Steam."],
        ["converter_moeda", "Converte um valor entre moedas tradicionais ou criptomoedas."],
    ]],
    ["Chamadas e rádio", [
        ["entrar-call", "Entra no seu canal de voz em modo Conversa, Rádio ou Híbrido."],
        ["sair-call", "Desconecta a Hikari do canal de voz."],
        ["modo-radio", "Ativa o modo de reprodução de música no canal de voz."],
        ["modo-hibrido", "Ativa música e conversa por voz no mesmo canal."],
    ]],
    ["Administração do servidor", [
        ["config_servidor", "Abre o painel do servidor ou aplica as opções informadas."],
        ["ia_ferramentas", "Consulta, altera ou restaura as ferramentas do servidor. Também alterna os embeds de múltiplas ferramentas."],
        ["aceitar_tos", "Abre os Termos de Uso para o servidor revisar e aceitar."],
    ]],
    ["Configuração do criador", [
        ["ia_config", "Ajusta parâmetros de IA. Ao informar um provedor, informe também o parâmetro e o valor."],
        ["config_criador", "Gerencia a instância por subcomandos, incluindo painel, modelos e moderação global."],
    ]],
];

const REGISTERED_COMMANDS = new Map(commands.map(command => [command.name, command]));
const COMMAND_DETAILS = new Map(COMMAND_GROUPS.flatMap(([category, entries]) =>
    entries.map(([name, description]) => [name, { category, description }])
));

function describeOption(option) {
    const choices = option.choices?.map(choice => choice.value).join(', ');
    const range = option.min_value !== undefined && option.max_value !== undefined
        ? ' (' + option.min_value + '–' + option.max_value + ')'
        : '';
    const type = option.type === 5 ? ' · booleano' : '';
    const details = choices ? ' · ' + choices : '';
    return '• '+'`'+option.name+'`'+' ('+(option.required ? 'obrigatório' : 'opcional')+'): '+option.description+range+type+details;
}

function getMainCategorySelectMenu(currentActive = 'home') {
    const menuOptions = [
        { label: '🏠 Visão Geral & Início', description: 'Apresentação principal da Hikari e novidades', value: 'home', default: currentActive === 'home' },
        { label: '🤖 Lista Geral de Comandos', description: 'Todos os comandos com menu de inspeção detalhado', value: 'commands_list', default: currentActive === 'commands_list' },
        { label: '⚖️ Regras, Segurança & AutoMod', description: 'Diretrizes de uso e moderação automática por IA', value: 'regras', default: currentActive === 'regras' },
        { label: '✨ Criador & Apoie o Projeto', description: 'Redes sociais de yGuilhermy e apoio via LivePix', value: 'sobre', default: currentActive === 'sobre' }
    ];

    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('help_category_select')
            .setPlaceholder('💡 Escolha uma seção do menu de ajuda')
            .addOptions(menuOptions)
    );
}

function buildHelpHomePayload() {
    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle('✨ Central de Ajuda — Hikari AI')
        .setDescription('Bem-vindo(a) ao hub de ajuda oficial da **Hikari**!\n\nEu sou uma Agente Autônoma multifuncional para o Discord, equipada com inteligência artificial generativa, assistente de voz em chamadas, download de multimídia, busca de jogos torrent, cotações em tempo real e moderação de segurança.\n\n📖 **[Guia de comandos](https://projetohikari.com/docs/discord/comandos/)**')
        .addFields(
            { name: '🤖 Comandos & Inspeção', value: 'Explore a lista completa de comandos e selecione qualquer um no menu para ver sua sintaxe e exemplos.', inline: true },
            { name: '⚙️ Configuração do Servidor', value: 'Administradores podem usar `/config_servidor` ou `/ia_ferramentas` para ajustar os recursos.', inline: true },
            { name: '💖 Apoie o Projeto', value: 'Conheça as redes do criador e ajude a manter o bot no ar via **LivePix**!', inline: false }
        )
        .setFooter({ text: 'Use o menu suspenso abaixo para navegar pelas seções • by yGuilhermy' })
        .setTimestamp();

    const linkButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('🚀 GitHub').setURL('https://github.com/yGuilhermy/HikariDiscord').setStyle(ButtonStyle.Link),
        new ButtonBuilder().setLabel('🌐 Redes Sociais').setURL('https://bio.site/yGuilhermy').setStyle(ButtonStyle.Link),
        new ButtonBuilder().setLabel('💖 Apoiar no LivePix').setURL('https://livepix.gg/yguilhermy').setStyle(ButtonStyle.Link)
    );

    return { embeds: [embed], components: [getMainCategorySelectMenu('home'), linkButtons] };
}

function buildHelpCommandListPayload() {
    const fields = COMMAND_GROUPS.map(([name, entries]) => ({
        name,
        value: entries.map(([command, description]) => '• '+'`'+'/'+command+'`'+' — '+description).join('\n')
    }));
    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle('Comandos da Hikari')
        .setDescription('Selecione um comando para ver os detalhes. [Referência no site](https://projetohikari.com/docs/discord/comandos/)')
        .addFields(fields);

    const commandOptions = COMMAND_GROUPS.flatMap(([, entries]) => entries.map(([name, description]) => ({
        label: '/' + name,
        description: description.slice(0, 95),
        value: name
    })));

    const cmdSelectMenu = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('help_command_select')
            .setPlaceholder('Selecione um comando')
            .addOptions(commandOptions)
    );

    return { embeds: [embed], components: [getMainCategorySelectMenu('commands_list'), cmdSelectMenu] };
}

function buildHelpCommandDetailPayload(commandId) {
    const command = REGISTERED_COMMANDS.get(commandId);
    const details = COMMAND_DETAILS.get(commandId);
    if (!command || !details) return buildHelpCommandListPayload();

    const creator = commandId === 'ia_config' || commandId === 'config_criador';
    const permissions = creator ? 'Criador do bot'
        : command.default_member_permissions === '32' ? 'Gerenciar Servidor'
        : command.default_member_permissions === '16' ? 'Gerenciar Canais'
        : 'Disponível aos usuários';
    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle('/' + command.name)
        .setDescription(details.description + '\n\n' + details.category + ' · ' + permissions);

    const options = command.options || [];
    const subcommands = options.filter(option => option.type === 1);
    if (subcommands.length) {
        for (const subcommand of subcommands) {
            const description = subcommand.description.replace(/^\[Creator\] /, '');
            embed.addFields({
                name: '/' + command.name + ' ' + subcommand.name,
                value: [description, ...(subcommand.options || []).map(describeOption)].join('\n')
            });
        }
    } else {
        if (!options.length) embed.addFields({ name: 'Parâmetros', value: 'Sem parâmetros.' });
        for (let i = 0; i < options.length; i += 5) {
            embed.addFields({ name: i === 0 ? 'Parâmetros' : 'Mais parâmetros', value: options.slice(i, i + 5).map(describeOption).join('\n') });
        }
    }

    const btnRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('help_btn_cmd_list').setLabel('⬅️ Voltar à Lista de Comandos').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('help_btn_home').setLabel('🏠 Início').setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [getMainCategorySelectMenu('commands_list'), btnRow] };
}

function buildHelpRulesPayload(pageIndex = 0) {
    const { getTosPages } = require('./tosHandler');
    const pages = getTosPages();
    const safeIndex = Math.max(0, Math.min(pageIndex, pages.length - 1));
    const currentPage = pages[safeIndex];

    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle(currentPage.title)
        .setDescription(currentPage.content)
        .setFooter({ text: `Página ${safeIndex + 1} de ${pages.length} • Diretrizes & TOS Hikari • by yGuilhermy` })
        .setTimestamp();

    const btnRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`help_rules_page_${safeIndex - 1}`)
            .setLabel('⬅️ Anterior')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safeIndex === 0),
        new ButtonBuilder()
            .setCustomId('help_btn_home')
            .setLabel('🏠 Início')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`help_rules_page_${safeIndex + 1}`)
            .setLabel('➡️ Próximo')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safeIndex === pages.length - 1)
    );

    return { embeds: [embed], components: [getMainCategorySelectMenu('regras'), btnRow] };
}

function buildHelpCreatorPayload() {
    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle('✨ Criador, Redes Sociais & Apoio ao Projeto')
        .setDescription('Conheça mais sobre o desenvolvedor da **Hikari**, acompanhe as redes sociais oficiais ou apoie o projeto para manter o bot no ar!')
        .addFields(
            {
                name: '👨‍💻 Desenvolvedor & Autor',
                value: 'Criado com dedicação por **yGuilhermy** (<@593372065730396160>).\nO projeto é **100% Código Aberto (Open Source)**!'
            },
            {
                name: '🌐 Redes Sociais do Criador & Hub Central',
                value: 'Acesse o agregador oficial de redes sociais para conferir conteúdos, vídeos, atualizações e projetos:\n👉 **[Redes Sociais do Criador](https://bio.site/yGuilhermy)**'
            },
            {
                name: '💖 Apoie a Hikari pelo LivePix!',
                value: 'Manter a infraestrutura de IA, servidores de voz e modelos generativos rodando 24/7 exige custos consideráveis. Se você gosta do projeto e quer ajudar na manutenção, envie um apoio via Pix!\n\n🎁 **[Apoiar no LivePix](https://livepix.gg/yguilhermy)**\n*Qualquer contribuição ajuda imensamente a manter a Hikari sempre online e rápida!*'
            }
        )
        .setFooter({ text: 'Hikari Project • Desenvolvido por yGuilhermy' })
        .setTimestamp();

    const linkButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('🌐 Redes Sociais do Criador').setURL('https://bio.site/yGuilhermy').setStyle(ButtonStyle.Link).setEmoji('🔗'),
        new ButtonBuilder().setLabel('💖 Apoiar no LivePix').setURL('https://livepix.gg/yguilhermy').setStyle(ButtonStyle.Link).setEmoji('🎁'),
        new ButtonBuilder().setLabel('🚀 GitHub Open Source').setURL('https://github.com/yGuilhermy/HikariDiscord').setStyle(ButtonStyle.Link).setEmoji('⭐')
    );

    return { embeds: [embed], components: [getMainCategorySelectMenu('sobre'), linkButtons] };
}

async function handleHelpInteraction(interaction) {
    const { customId } = interaction;

    if (customId === 'help_category_select') {
        const selected = interaction.values[0];
        let payload;
        if (selected === 'home') payload = buildHelpHomePayload();
        else if (selected === 'commands_list') payload = buildHelpCommandListPayload();
        else if (selected === 'regras') payload = buildHelpRulesPayload();
        else if (selected === 'sobre') payload = buildHelpCreatorPayload();
        else payload = buildHelpHomePayload();

        return await interaction.update(payload);
    }

    if (customId === 'help_command_select') {
        const commandId = interaction.values[0];
        const payload = buildHelpCommandDetailPayload(commandId);
        return await interaction.update(payload);
    }

    if (customId.startsWith('help_rules_page_')) {
        const pageIndex = parseInt(customId.replace('help_rules_page_', ''));
        const payload = buildHelpRulesPayload(pageIndex);
        return await interaction.update(payload);
    }

    if (customId === 'help_btn_cmd_list') {
        const payload = buildHelpCommandListPayload();
        return await interaction.update(payload);
    }

    if (customId === 'help_btn_home' || customId === 'help_back') {
        const payload = buildHelpHomePayload();
        return await interaction.update(payload);
    }
}

module.exports = {
    buildHelpHomePayload,
    buildHelpCommandListPayload,
    buildHelpCommandDetailPayload,
    buildHelpRulesPayload,
    buildHelpCreatorPayload,
    handleHelpInteraction
};
