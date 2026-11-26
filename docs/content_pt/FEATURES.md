# ✨ Funcionalidades, IA e Processamento de Mídia

A Hikari não é apenas um wrapper de chat. Ela é um ecossistema de processamento as síncrono que combina LLMs, difusão de imagens e extração de metadados.

---

## 📂 Sumário

1. [🧠 1. Inteligência Artificial: O Ciclo de Vida do Prompt](#-1-inteligência-artificial-o-ciclo-de-vida-do-prompt)
2. [🎨 2. Geração de Imagens (Hierarquia de Provedores)](#-2-geração-de-imagens-hierarquia-de-provedores)
3. [🎵 3. Processamento de Mídia (Áudio, Vídeo e Compressão)](#-3-processamento-de-mídia-áudio-vídeo-e-compressão)
4. [🎙️ 4. Assistente de Voz & Protocolo DAVE (Calls do Discord)](#-4-assistente-de-voz--protocolo-dave-calls-do-discord)
5. [🎙️ 5. Transcrição de Áudio no Histórico (Whisper Sob Demanda)](#-5-transcrição-de-áudio-no-histórico-whisper-sob-demanda)
6. [💾 6. Banco de Dados Permanente & Memória Sob Demanda](#-6-banco-de-dados-permanente--memória-sob-demanda-zero-token-overhead)
7. [🎙️ 7. Mensagens de Voz Nativas (XTTS v2)](./VOICE.md)
8. [💡 Dicas de Uso Avançado](#-dicas-de-uso-avançado)

---

## 🧠 1. Inteligência Artificial: O Ciclo de Vida do Prompt

A Hikari processa todas as mensagens de IA através de uma **Fila Global (`processingQueue`)**.

### Fluxo de Resposta:

1.  **Captura de Contexto:** A Hikari lê as últimas 5 a 10 mensagens do canal (Short-term memory) para garantir coerência.
2.  **Identificação de Gatilhos:** O bot responde se:
    - For mencionado (`@Hikari`).
    - O texto conter a palavra "Hikari".
    - Houver uma resposta direta (reply) à mensagem dela.
3.  **Processamento Multimodal:** Se houver uma imagem anexa, ela é enviada junto ao prompt para análise Vision (sujeito à capacidade do modelo configurado). (Ainda não implementado)
4.  **Parsing de Ferramentas:** A saída da IA é passada por um parser JSON que detecta se ela "decidiu" usar uma ferramenta (Busca Web, Imagem, Música).

---

## 🎨 2. Geração de Imagens (Hierarquia de Provedores)

A Hikari possui um motor de fallback agressivo para garantir que o usuário receba sua arte, mesmo que as APIs principais falhem.

**Ordem de Execução:**

2.  **Stable Horde:** Rede distribuída de GPUs.
3.  **Hugging Face Space (FLUX.1):** Última alternativa para gerar a imagem.
5.  **Pollinations:** O fallback definitivo para 100% de disponibilidade.

---

## 🎵 3. Processamento de Mídia (Áudio, Vídeo e Compressão)

Implementamos um sistema completo de download e manipulação de mídia via `youtubeAudioHandler.js`.

- **Suporte Multplataforma:** O bot suporta download de áudio e vídeo de plataformas populares, como YouTube (geral para áudio, apenas Shorts para vídeo), Instagram Reels e TikTok (incluindo subdomínios como `vt.tiktok.com`).
- **Download Inteligente de Áudio:** Extração apenas do melhor stream de áudio (`bestaudio`) via `yt-dlp` e conversão dinâmica com `ffmpeg` para MP3.
- **Música do Deezer:** busca título e artista e abre um seletor quando há versões parecidas. O formato e o bitrate dependem da faixa disponível.
- **Download de Vídeo com Metadados:** Ao baixar vídeos, a Hikari pode extrair o uploader original e a descrição para exibição rica no chat, configurável via parâmetro.
- **Compressão de vídeo:** o bot lê o limite de anexo da interação. Quando o arquivo não cabe, o botão permite tentar compressão para esse limite.
- **Fila de compressão:** um vídeo por vez, com prazo de processamento e opção de tentar novamente em caso de falha temporária.
- **Limitação de Uso:** Há uma limitação estrita de 1 download/processo ativo por usuário ao mesmo tempo para evitar sobrecarga.
- **Cleanup Automático:** Todos os arquivos temporários são deletados após o envio. Vídeos grandes que aguardam compressão expiram após 6 horas.

---

## 🎙️ 4. Assistente de Voz & Protocolo DAVE (Calls do Discord)

O ecossistema de voz da Hikari permite que ela participe de chamadas de voz e atenda comandos dos usuários em tempo real.

- **Conexão Nativa com Protocolo DAVE (E2EE)**: Utiliza a versão mais recente do `@discordjs/voice` com suporte nativo ao protocolo de criptografia ponta a ponta do Discord (DAVE protocol version 1).
- **Filtro de Energia Corporal de Áudio (PCM RMS)**: Analisa a energia do sinal PCM do fluxo de áudio recebido. Áudios com RMS < 250 ou de membros mutados são descartados automaticamente para evitar uso desnecessário de cotas das APIs de STT.
- **Dicionário STT & Matcher Fonético de 75+ Variações**: Incorpora injeção de prompt no Whisper ("Hikari") aliado a um sistema de expressões regulares que identifica 75+ grafias e fonemas derivados de sotaques ou ruídos (ex: "Ricardo", "Hicari", "Icari", "Ficari", "Vicari", "Ih cari").
- **Ferramenta Unificada MCP (Assistente de Voz)**: O controle de chamada (`join_voice_call` e `leave_voice_call`) é integrado e gerenciado como um único item unificado no comando `/ia_ferramentas`.
- **Desconexão por Inatividade**: Quando todos os usuários humanos deixam o canal de voz, a Hikari se desconecta automaticamente preservando conexões do servidor.

---

## 🎙️ 5. Transcrição de Áudio no Histórico (Whisper Sob Demanda)

A Hikari não ignora áudios enviados nos canais! Quando acionada em um chat cujo histórico recente contém mensagens de voz:

- **Transcrição Sob Demanda:** A Hikari envia o arquivo de voz para o motor Whisper apenas quando o usuário a menciona ou pergunta algo relacionado àquela conversa.
- **Hierarquia de Provedores:** Utiliza primariamente **Wit.ai** para transcrição ultrarrápida e gratuita em português/outros idiomas, com fallback automático para a API do **Groq** (`whisper-large-v3-turbo`).
- **Cache Persistente por Mensagem:** Uma vez que o áudio de uma mensagem foi transcrito, o texto resultante fica vinculado em memória àquela mensagem do histórico. Nas próximas interações, a Hikari reutiliza o texto transcrito sem acionar novamente as APIs.
- **Filtro Inteligente de Tipo de Áudio:** Áudios de voz (notas de voz do Discord) são rotulados como `[Áudio transcrito: "..."]`, enquanto músicas ou arquivos de áudio normais são identificados apenas pelo nome original (ex: `musica.mp3`), evitando transcrições desnecessárias de faixas musicais.

---

## 💾 6. Banco de Dados Permanente & Memória Sob Demanda (Zero Token Overhead)

Abra `/memoria` para buscar pela chave ou pelo texto, consultar a autoria e criar, editar ou excluir uma anotação. O painel é privado. As anotações do servidor ficam naquele servidor, e as de DM ficam vinculadas ao usuário. Os registros oficiais da Hikari continuam acessíveis.

A Hikari só grava por chat quando o pedido de alteração está na mensagem atual. Use a chave exata para editar ou excluir. Edições, sobrescritas e exclusões pedem revisão e confirmação em até cinco minutos. O autor, a moderação do mesmo servidor e o dono da instância podem alterar anotações conforme as permissões das ferramentas.

A lixeira e até cinco versões anteriores por anotação ficam disponíveis por sete dias. No painel, é possível restaurar ou eliminar cópias antes do prazo. O dono da instância também pode, em DM, revisar anotações legadas e mover cada uma para um servidor escolhido.

A persistência usa `src/data/ai_database.json`. A leitura é feita sob demanda, e a confirmação de alteração só é enviada após a gravação em disco.


## 🎙️ 7. Mensagens de Voz Nativas (XTTS v2 Neural Voice)

A Hikari suporta envio de mensagens de voz oficiais no chat com player de microfone nativo do Discord (`flags: 8192`), waveform interativa e síntese de voz neural via XTTS v2.

- **Documentação Completa & Tutorial de Treinamento/Deploy**: Consulte o guia dedicado em [🎙️ Sistema Vocal Neural da Hikari](./VOICE.md).

---

## 💡 Dicas de Uso Avançado

- 💡 **Resumo de Chat (`/chat_resumo`):** A IA lê as últimas N mensagens e cria um mapeamento semântico de quem falou o que e sobre quais tópicos. Excelente para gerenciar canais movimentados.
- 💡 **Trace.moe Integration:** A função `/anime_origem` permite que você encontre animes apenas enviando um frame. Ela retorna o título, episódio e o timestamp aproximado.
- 💡 **Busca de Jogos e Preços da Steam:** A Hikari não apenas busca links Magnéticos em bases de dados, mas também pode consultar nativamente a **Steam**! Basta perguntar naturalmente como "O Elden Ring está em promoção na Steam?" e ela retornará dados atualizados, preços e sinopse, além de fazer um comentário divertido.
- 💡 **Conversor de Moedas e Cripto:** Converta qualquer valor entre moedas reais (BRL, USD, EUR) ou cripto (BTC, ETH) apenas perguntando "quanto tá o bitcoin hoje?". Ela usa APIs financeiras com cache local de expiração diária e fallback automático.
- 💡 **Visão Computacional e Edição:** A Hikari possui regras claras avisando que ela não realiza edições de imagens existentes e analisa imagens enviadas ou citadas quando há um provedor de visão disponível.

---

> [!TIP]
> Para ver a lista completa de comandos e explicações detalhadas, veja o [Guia de Comandos](./COMMANDS.md).

---

[🏠 Voltar ao Menu Principal](../../README.md)
