const actionWords = {
    write: /^(?:anot(?:a|e|ar)|salv(?:a|e|ar)|guard(?:a|e|ar)|registr(?:a|e|ar)|memoriza|memorize|memorizar|lembre-se\s+de|lembre|lembrar)\s+/iu,
    edit: /^(?:edit(?:a|e|ar)|alter(?:a|e|ar)|atualiz(?:a|e|ar)|corrig(?:e|ir)|corrija|acrescent(?:a|e|ar)|adicion(?:a|e|ar))\s+/iu,
    delete: /^(?:apag(?:a|ue|ar)|exclu(?:a|i|ir)|remov(?:a|e|er)|delet(?:a|e|ar)|esquec(?:e|er)|esqueça)\s+/iu
};
const memoryReference = /\b(?:anota(?:ção|ções|cao|coes)|memória|memoria|banco\s+de\s+dados|registro|chave)\b/iu;
const politePrefix = /^(?:hikari[\s,:]+)?(?:por\s+favor[,\s]+)?(?:(?:pode|poderia|consegue|quero\s+que\s+(?:você|voce|vc))\s+)?/iu;

function parseMemoryIntent(raw) {
    if (typeof raw !== 'string') return null;
    const text = raw.trim().replace(politePrefix, '');
    if (!text || /^(?:>|["“`])/.test(text) || /(?:^|\n)\s*(?:>|\`\`\`)/.test(text)) return null;
    for (const [operation, pattern] of Object.entries(actionWords)) {
        const verb = text.match(pattern);
        if (!verb) continue;
        const remainder = text.slice(verb[0].length).trim();
        if (!remainder || (operation !== 'write' && !memoryReference.test(remainder))) return null;
        const content = remainder.replace(/^(?:(?:isso\s+)?(?:no\s+banco(?:\s+de\s+dados)?|na\s+mem[oó]ria)[:\s]+)?(?:que\s+|isto:\s*|isso:\s*)?/iu, '')
            .replace(/\s+(?:no\s+banco(?:\s+de\s+dados)?|na\s+mem[oó]ria)[.!]?$/iu, '').trim();
        return { operation, content };
    }
    return null;
}

module.exports = { parseMemoryIntent };
