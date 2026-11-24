const { EmbedBuilder } = require('discord.js');

const labels = Object.freeze({
    search_web: 'Pesquisa na web',
    check_steam: 'Steam',
    convert_currency: 'Conversão de moedas',
    db_read: 'Consulta à memória',
    db_read_personal: 'Consulta à memória',
    get_creator_info: 'Dados dos criadores',
    db_write: 'Salvar anotação',
    db_edit: 'Editar anotação',
    db_delete: 'Excluir anotação',
    generate_image: 'Geração de imagem',
    send_voice_note: 'Nota de voz',
    download_audio: 'Download de áudio',
    download_video: 'Download de vídeo',
    search_and_download_music: 'Busca de música',
    get_current_music: 'Música atual',
    search_game: 'Busca de jogo',
    join_voice_call: 'Entrar na chamada',
    leave_voice_call: 'Sair da chamada'
});

const progressText = {
    search_web: 'Consultando fontes para responder ao pedido.',
    check_steam: 'Consultando a ficha do jogo na Steam.',
    convert_currency: 'Buscando a cotação para calcular a conversão.',
    db_read: 'Buscando anotações relacionadas ao pedido.',
    db_read_personal: 'Buscando anotações relacionadas ao pedido.',
    get_creator_info: 'Consultando os dados oficiais.',
    db_write: 'Verificando a anotação e as permissões de gravação.',
    db_edit: 'Verificando a anotação antes da edição.',
    db_delete: 'Verificando a anotação antes da exclusão.',
    generate_image: 'Preparando a imagem solicitada.',
    send_voice_note: 'Preparando a resposta falada.',
    download_audio: 'Preparando o áudio para envio.',
    download_video: 'Preparando o vídeo para envio.',
    search_and_download_music: 'Buscando a faixa no catálogo.',
    get_current_music: 'Consultando a atividade musical.',
    search_game: 'Consultando os catálogos de jogos.'
};

function names(tools) {
    return [...new Set(tools.map(tool => Object.hasOwn(labels, tool) ? labels[tool] : 'Ferramenta'))];
}

function toolFooter(tools) {
    return tools.length ? '⚙️ ' + names(tools).join(' · ') : '';
}

function progressEmbed(active, previous = [], step = 1) {
    const running = names(active);
    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle(running.length === 1 ? running[0] : 'Ferramentas em execução')
        .setDescription(running.length === 1
            ? (Object.hasOwn(progressText, active[0]) ? progressText[active[0]] : 'Em execução.')
            : running.map(label => '• ' + label).join('\n'))
        .setFooter({ text: 'Hikari · Etapa ' + step });
    if (previous.length) embed.addFields({ name: 'Já executadas', value: names(previous).join(' · ').slice(0, 1024) });
    return embed;
}

module.exports = { toolFooter, progressEmbed };
