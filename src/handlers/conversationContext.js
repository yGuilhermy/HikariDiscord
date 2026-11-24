const cleanTopic = value => String(value || '').replace(/^\s*(?:<@!?\d+>|hikari\b)[,:\s]*/iu, '').trim();
const noTopic = /^(?:isso|isto|aquilo|a[ií]|sobre|pesquise|pesquisa|pesquisar|por favor|na web|na internet|no google|query|consulta|termo|search)[.!?\s]*$/iu;
const clipped = value => cleanTopic(value).slice(0, 400);

function searchRequest(text, context = {}) {
    const request = cleanTopic(text);
    const directive = request.match(/^(?:(?:por favor|pode|poderia)[,\s]+)?(?:(?:fa[çc]a|faz|fazer)\s+(?:uma\s+)?(?:pesquisa|busca)|pesquis(?:a+|e|ar)|busc(?:a|ar)|busque|procure|procura|google|mcp\s+(?:de\s+)?(?:pesquisa|search_web|web))(?=$|[\s,:.!?])[,\s:!.?]*(.*)$/iu);
    const marketplacePrice = /\b(?:quanto (?:custa|t[aá]|est[aá])|pre[çc]o|valor)\b.*\b(?:nintendo(?:\s+eshop)?|eshop|playstation\s+store|xbox\s+store|epic\s+games)\b/iu.test(request);
    if (!directive && !marketplacePrice) return null;
    if (marketplacePrice && !directive) return { query: clipped(request) };
    const subject = clipped(directive[1].replace(/^(?:(?:na web|na internet|no google)\b[\s,:]*)?(?:(?:sobre|por|pra|para|de)\b[\s,:]*)?/iu, ''));
    const reference = clipped(context.referenceTopic);
    const previous = clipped(context.previousTopic);
    const related = !subject || noTopic.test(subject) || /^(?:e\b|sobre\b|isso\b|isto\b)/iu.test(subject);
    const antecedent = [reference, previous].find(topic => topic && !noTopic.test(topic));
    if (related && antecedent) {
        return { query: clipped(antecedent + (subject && !noTopic.test(subject) ? ' ' + subject.replace(/^e\s+/iu, '') : '')) };
    }
    return { query: subject && !noTopic.test(subject) && !related ? subject : null };
}

function profileRequest(value) {
    const text = cleanTopic(value).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    if (/^(?:doq|do que|de que|o que)\s+eu gosto\b|\b(?:meus?|minhas?)\s+(?:gostos?|preferencias?|[^.!?]{0,26}favorit[oa]s?)\b|\bo que (?:voce )?sabe sobre mim\b/u.test(text)) return 'personal';
    if (/\b(?:quem (?:e|foi) (?:o )?(?:seu )?criador|quem te criou|(?:sobre|gosta) (?:o |do |seu |dos )?(?:seu )?criadore?s?|(?:gostos?|preferencias?) (?:do|dos) criadore?s?)\b/u.test(text)) return 'creator';
    if (/^(?:quem e voce|como voce (?:e|se parece)|quem e a hikari)\b|\b(?:sua aparencia|sua personalidade|do que voce gosta|me fale sobre voce)\b/u.test(text)) return 'hikari';
    return null;
}

function usableToolReply(value) {
    let cleaned = String(value || '').replace(/^\s*-# .*$/gm, '').trim();
    if (/^\{/.test(cleaned)) {
        try {
            const parsed = JSON.parse(cleaned);
            if (!parsed.tool || parsed.tool === 'generate_reply') {
                const text = parsed.args?.content ?? parsed.content ?? parsed.text ?? parsed.reply ?? parsed.resposta;
                cleaned = typeof text === 'string' ? text.trim() : '';
            }
        } catch { return ''; }
    }
    if (!cleaned || /⚠️ SYSTEM ERROR|limites de processamento atingidos|default_api\.|tool_code|^\s*\{|^\s*```/iu.test(cleaned)) return '';
    if (/^\s*(?:(?:blz|ok|certo|beleza)[,.!\s]*)?(?:(?:t[oô]|estou)\s+pesquisando|vou\s+(?:pesquisar|buscar|verificar))\b[^.!?]*[.!?]*$/iu.test(cleaned)) return '';
    return (cleaned.match(/[\p{L}\p{N}]+/gu) || []).length >= 2 ? cleaned : '';
}

function limitMentions(content, allowedIds) {
    if (typeof content !== 'string') return content;
    const allowed = new Set(allowedIds.filter(Boolean));
    return content.replace(/<@!?(\d+)>/g, (mention, id) => allowed.has(id) ? mention : '@usuário')
        .replace(/<@&(\d+)>/g, '@cargo');
}

module.exports = { searchRequest, usableToolReply, limitMentions, profileRequest };
