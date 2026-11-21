# Hikari Discord slash commands

Use /ajuda in Discord to open the interactive help. Square brackets mark optional parameters unless the description states a condition. Discord controls which commands are shown to each user.

## Chat and help

For `/ia_chat`, only `prompt` is required. Set `visibilidade=public` to make the reply visible to other channel members. `/entrar-call` defaults to conversation mode. Select `radio` for a music session or `hibrido` for music and voice chat.

| Command | Parameters | Behavior |
| :--- | :--- | :--- |
| `/ia_chat` | `prompt`, `[visibilidade=public/private]`, `[voice=true/false]` | Ask a question. Replies are private by default and can be sent as voice messages. |
| `/chat_resumo` | `[quantidade=10–100]` | Summarizes recent messages in the channel. |
| `/ajuda` | — | Opens the interactive help menu. |

## Images and media

| Command | Parameters | Behavior |
| :--- | :--- | :--- |
| `/ia_imagem` | `prompt`, `[negative_prompt]`, `[width=512–1280]`, `[height=512–1280]`, `[provider=auto/flux/pollinations/stablehorde]` | Generates an image from a prompt with an optional provider selection. |
| `/anime_origem` | `[imagem]`, `[url]` | Identifies anime from an attachment or direct image URL. Provide at least one. |
| `/baixar_musica` | `url` | Extracts MP3 audio from a supported video link. |
| `/baixar_musica_deezer` | `nome` | Searches Deezer by track or artist name and downloads the match. |
| `/baixar_musica_atual` | `[usuario]` | Identifies the music shown in Discord activity, such as Spotify or YouTube Music, and searches for a downloadable match. |
| `/baixar_video` | `url`, `[descricao=true/false]` | Downloads MP4 video and adapts compression to the upload limit. |

## Games and currency

| Command | Parameters | Behavior |
| :--- | :--- | :--- |
| `/buscar_jogo` | `nome`, `[fonte=any/dodi/fitgirl]` | Searches the local FitGirl and DODI game catalogs. |
| `/steam_jogo` | `nome` | Looks up prices and game details on Steam. |
| `/converter_moeda` | `valor`, `de`, `para` | Converts a value between currencies or cryptocurrencies. |

## Voice calls and radio

| Command | Parameters | Behavior |
| :--- | :--- | :--- |
| `/entrar-call` | `[modo=conversa/radio/hibrido]` | Joins your voice channel in conversation, radio or hybrid mode. |
| `/sair-call` | — | Disconnects Hikari from the voice channel. |
| `/modo-radio` | — | Starts music mode in your voice channel. |
| `/modo-hibrido` | — | Enables music and voice chat in the same channel. |

## Server administration

| Command | Parameters | Behavior |
| :--- | :--- | :--- |
| `/config_servidor` · Manage Server | `[instrucao]`, `[mood]`, `[reset_humor=true/false]`, `[espontaneo_estado=on/off]`, `[espontaneo_frequencia=low/medium/high]`, `[espontaneo_porcentagem=0–100]`, `[canal_updates]`, `[mencoes_ativo=true/false]`, `[canal_alvo]`, `[canal_status=enable/disable]`, `[multi_mcp_embeds=true/false]` | Opens server settings or applies the supplied options. |
| `/ia_ferramentas` · Manage Server | `acao=list/toggle/toggle_embeds/reset`, `[ferramenta]`, `[estado=on/off]` | Lists, changes or resets server tools and toggles multi-tool embeds. |
| `/aceitar_tos` · Manage Channels | — | Opens the server Terms of Use panel. |

## Creator settings

| Command | Parameters | Behavior |
| :--- | :--- | :--- |
| `/ia_config` · Creator | `[provider=local/gemini/pollinations/hf/horde]`, `[setting=timeout/temperature/max_tokens]`, `[value]` | Adjusts provider settings. When specifying a provider, also provide the setting and value. |
| `/config_criador` · Creator | `modelo`, `banir`, `desbanir`, `bans_lista`, `automod`, `ferramenta`, `bot_config`, `painel`, `dashboard` | Manages instance settings through subcommands. |

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

[Command reference on the site](https://projetohikari.com/docs/discord/comandos/)
