# Comandos Slash da Hikari Discord

Use /ajuda no Discord para abrir o menu. Os parâmetros entre colchetes são opcionais, salvo condições explicadas na descrição. O Discord controla quais comandos aparecem para cada usuário.

## Conversa e ajuda

Em `/ia_chat`, só `prompt` é obrigatório. Escolha `visibilidade=public` se quiser que outras pessoas do canal vejam a resposta. Em uma chamada, `/entrar-call` usa o modo Conversa por padrão. selecione `radio` para abrir uma sessão musical ou `hibrido` para combinar música e conversa.

| Comando | Parâmetros | O que faz |
| :--- | :--- | :--- |
| `/ia_chat` | `prompt`, `[visibilidade=public/private]`, `[voice=true/false]` | Faça uma pergunta ou um pedido. A resposta é privada por padrão e pode ser enviada em voz. |
| `/chat_resumo` | `[quantidade=10–100]` | Resume as mensagens recentes do canal. A quantidade aceita vai de 10 a 100. |
| `/ajuda` | — | Abre este painel com a lista de comandos. |

## Imagem e mídia

| Comando | Parâmetros | O que faz |
| :--- | :--- | :--- |
| `/ia_imagem` | `prompt`, `[negative_prompt]`, `[width=512–1280]`, `[height=512–1280]`, `[provider=auto/flux/pollinations/stablehorde]` | Gera uma imagem a partir de uma descrição e aceita a escolha de provedor. |
| `/anime_origem` | `[imagem]`, `[url]` | Identifica uma cena de anime por imagem anexada ou URL. Envie pelo menos uma das duas. |
| `/baixar_musica` | `url` | Extrai o áudio em MP3 de um link de vídeo compatível. |
| `/baixar_musica_deezer` | `nome` | Busca e baixa uma faixa no Deezer pelo nome da música ou do artista. |
| `/baixar_musica_atual` | `[usuario]` | Identifica a música pela atividade do Discord, como Spotify ou YouTube Music, e procura a faixa para baixar. |
| `/baixar_video` | `url`, `[descricao=true/false]` | Baixa um vídeo em MP4 e ajusta a compressão para o limite de envio. A opção descricao liga a exibição da descrição. |

## Jogos e câmbio

| Comando | Parâmetros | O que faz |
| :--- | :--- | :--- |
| `/buscar_jogo` | `nome`, `[fonte=any/dodi/fitgirl]` | Busca jogos pelo nome nos catálogos locais DODI e FitGirl. |
| `/steam_jogo` | `nome` | Consulta preço e detalhes de um jogo na Steam. |
| `/converter_moeda` | `valor`, `de`, `para` | Converte um valor entre moedas tradicionais ou criptomoedas. |

## Chamadas e rádio

| Comando | Parâmetros | O que faz |
| :--- | :--- | :--- |
| `/entrar-call` | `[modo=conversa/radio/hibrido]` | Entra no seu canal de voz em modo Conversa, Rádio ou Híbrido. |
| `/sair-call` | — | Desconecta a Hikari do canal de voz. |
| `/modo-radio` | — | Ativa o modo de reprodução de música no canal de voz. |
| `/modo-hibrido` | — | Ativa música e conversa por voz no mesmo canal. |

## Administração do servidor

| Comando | Parâmetros | O que faz |
| :--- | :--- | :--- |
| `/config_servidor` · Gerenciar Servidor | `[instrucao]`, `[mood]`, `[reset_humor=true/false]`, `[espontaneo_estado=on/off]`, `[espontaneo_frequencia=low/medium/high]`, `[espontaneo_porcentagem=0–100]`, `[canal_updates]`, `[mencoes_ativo=true/false]`, `[canal_alvo]`, `[canal_status=enable/disable]`, `[multi_mcp_embeds=true/false]` | Abre o painel do servidor ou aplica as opções informadas. |
| `/ia_ferramentas` · Gerenciar Servidor | `acao=list/toggle/toggle_embeds/reset`, `[ferramenta]`, `[estado=on/off]` | Consulta, altera ou restaura as ferramentas do servidor. Também alterna os embeds de múltiplas ferramentas. |
| `/aceitar_tos` · Gerenciar Canais | — | Abre os Termos de Uso para o servidor revisar e aceitar. |

## Configuração do criador

| Comando | Parâmetros | O que faz |
| :--- | :--- | :--- |
| `/ia_config` · Criador | `[provider=local/gemini/pollinations/hf/horde]`, `[setting=timeout/temperature/max_tokens]`, `[value]` | Ajusta parâmetros de IA. Ao informar um provedor, informe também o parâmetro e o valor. |
| `/config_criador` · Criador | `modelo`, `banir`, `desbanir`, `bans_lista`, `automod`, `ferramenta`, `bot_config`, `painel`, `dashboard` | Gerencia a instância por subcomandos, incluindo painel, modelos e moderação global. |

### /config_criador

- `/config_criador modelo` `[mostrar_nome=true/false]`, `[mostrar_pensamento=true/false]`, `[multi_mcp_embeds=true/false]`, `[retentativas=0–10]`
- `/config_criador banir` `tipo=user/guild/channel`, `id`, `[motivo]`
- `/config_criador desbanir` `tipo=user/guild/channel`, `id`
- `/config_criador bans_lista`
- `/config_criador automod` `servidor_id`, `modo=off/trigger/mcp/both`
- `/config_criador ferramenta` `acao=toggle/list/reset`, `[ferramenta]`, `[estado=on/off]`, `[servidor_id]`
- `/config_criador bot_config`
- `/config_criador painel`
- `/config_criador dashboard`

[Comandos no site](https://projetohikari.com/docs/discord/comandos/)
