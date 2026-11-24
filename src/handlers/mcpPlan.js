const readTools = new Set(['search_web', 'check_steam', 'convert_currency', 'db_read', 'db_read_personal', 'get_creator_info']);
const firstTools = new Set([...readTools, 'db_write', 'db_edit', 'db_delete', 'generate_image', 'send_voice_note']);
const aliases = { web_search: 'search_web', steam_jogo: 'check_steam', converter_moeda: 'convert_currency' };

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return typeof value === 'string' ? value.trim() : value;
}

function buildBatch(items, allowed, attempted, limit, sanitizeArgs) {
    const batch = [];
    const planned = new Set();
    for (const item of Array.isArray(items) ? items : []) {
        if (!item || typeof item !== 'object') continue;
        const name = String(item.tool || item.name || item.action || '').trim().toLowerCase();
        const tool = Object.hasOwn(aliases, name) ? aliases[name] : name;
        if (!allowed.has(tool)) continue;
        const args = canonical(sanitizeArgs(item.args || item.arguments || item.action_input || {}));
        const signature = tool + ':' + JSON.stringify(args);
        if (attempted.has(signature) || planned.has(signature)) continue;
        planned.add(signature);
        batch.push({ tool, args, signature });
        if (batch.length >= limit) break;
    }
    return batch;
}

function steamPriceDependency(batch, request, normalizeCurrency) {
    if (!batch.some(item => item.tool === 'check_steam') || typeof request !== 'string') return null;
    const asksConversion = /convert|convers[aã]o|(?:pre[çc]o|valor|custa).{0,70}\bem\b/iu.test(request);
    const independent = /(?:\bconvert\w*\s+|\bconvers[aã]o\s+de\s+)\d[\d.,]*\s*(?:[a-zà-ÿ$€£¥]{2,}|[$€£¥])/iu.test(request);
    const proposed = batch.some(item => item.tool === 'convert_currency');
    if (independent || (!asksConversion && !proposed)) return null;
    const currencies = new Set([...Intl.supportedValuesOf('currency'), 'BTC', 'ETH', 'SOL', 'DOGE', 'LTC', 'XRP']);
    const terms = [...request.matchAll(/(?:^|\s)(?:para|pra|em)\s+([a-zà-ÿ]+|[$€£¥])(?:\s+([a-zà-ÿ]+))?/giu)];
    const to = terms.flatMap(([, first, second]) => [second ? normalizeCurrency(first + ' ' + second) : null, normalizeCurrency(first)])
        .find(value => currencies.has(value));
    return { to };
}

function readPlan(response) {
    const clean = String(response || '').replace(/^\s*-# .*$/gm, '').trim();
    const fenced = clean.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/i);
    try {
        const parsed = JSON.parse(fenced?.[1] || clean);
        if (Array.isArray(parsed)) return { tools: parsed };
        if (Array.isArray(parsed?.multi_tools)) return { tools: parsed.multi_tools };
        if (Array.isArray(parsed?.tools)) return { tools: parsed.tools };
        if (parsed?.tool && !['generate_reply', 'none', 'null'].includes(String(parsed.tool).toLowerCase())) return { tools: [parsed] };
        return { text: typeof parsed === 'string' ? parsed : parsed?.args?.content || parsed?.content || parsed?.text || parsed?.reply || '' };
    } catch {
        return { text: clean };
    }
}

function resultContext(results) {
    return JSON.stringify(results.map(result => String(result).slice(0, 2600)));
}

module.exports = { readTools, firstTools, buildBatch, readPlan, resultContext, steamPriceDependency };
