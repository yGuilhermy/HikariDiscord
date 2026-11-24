const commands = [
    ['PAUSE', /(?:pausa[rs]?|pause|espera|sil[eê]ncio|para um pouco|d[aá] um tempo|hold|cala (?:a )?boca)/i],
    ['STOP', /(?:para|pare|parar|stop|cancela|para tudo|fechar|encerrar|(?:para|pare|parar|desliga) (?:(?:a |o )?(?:m[uú]sica|r[aá]dio|som)|de tocar))/i],
    ['RESUME', /(?:toca[rs]?|play|retom[ae]r?|volt[ae]r? a tocar|despaus[ae]r?|solta (?:o som|a m[uú]sica)|continua|resume)/i],
    ['LEAVE', /(?:sai[ar]?|vaza[r]?|desconecta[r]?)(?: (?:da call|da cal|do canal|daqui))?|tchau|at[eé] logo/i],
    ['NEXT', /(?:pr[oó]xima(?: (?:m[uú]sica|faixa))?|passa|pula|skip|pular|avan[çc]a[r]?|troca|muda[r]? m[uú]sica)(?: (?:essa|esta|a m[uú]sica|a faixa))?/i],
    ['PREVIOUS', /(?:anterior|volta[r]?|volte|back|a de antes|(?:toca[r]? |volta[r]? )?(?:a |para a )?(?:m[uú]sica |faixa )?anterior|toca a de antes)/i],
    ['SHUFFLE', /(?:embaralha[r]?|shuffle|mistura[r]?|(?:ativa[r]? )?(?:(?:o )?modo )?aleat[oó]rio|ordem aleat[oó]ria|ativar shuffle)/i],
    ['LOOP', /(?:repete|repita|repetir)(?: (?:a )?(?:m[uú]sica|faixa))?|loop|modo de repeti[çc][aã]o/i],
    ['INFO', /(?:que m[uú]sica [eé] essa|qual (?:[eé] )?o nome (?:dessa|da) m[uú]sica|qual m[uú]sica t[aá] tocando|quem t[aá] cantando|nome da m[uú]sica)/i],
    ['QUEUE', /(?:(?:mostra|ver) (?:a )?(?:fila|lista)|lista de m[uú]sicas|quais m[uú]sicas tem|fila|queue)/i]
].map(([type, pattern]) => [type, new RegExp('^(?:' + pattern.source + ')$', pattern.flags)]);

const addPattern = /^(?:toca[r]?|toque|bota[r]?|bote|coloca[r]?|coloque|p[oõ]e|adicion[ae]r?|pesquisa[r]?|reproduzi[r]?|solta[r]?)\s+(?:(?:a m[uú]sica|a faixa|o som de)\s+)?(.+)$/i;
const removePattern = /^(?:remov[ae]r?|tir[ae]r?|apaga[r]?|deleta[r]?)\s+(?:(?:a )?(?:m[uú]sica|faixa|n[uú]mero)\s+)?#?(\d+)$/i;

function parseRadioIntent(text) {
    if (typeof text !== 'string') return null;
    const request = text.trim()
        .replace(/^(?:hikari|hicari|ikari)[,\s]+/i, '')
        .replace(/^(?:(?:por favor|agora)[,\s]+)+/i, '')
        .replace(/(?:[,\s]+(?:por favor|a[íi]))?[.!?]+$/i, '')
        .replace(/[,\s]+(?:por favor|a[íi])$/i, '')
        .trim();
    if (!request) return null;

    const command = commands.find(([, pattern]) => pattern.test(request));
    if (command) return { type: command[0] };

    const remove = request.match(removePattern);
    if (remove) return { type: 'REMOVE', position: Number(remove[1]) };

    const add = request.match(addPattern);
    if (add && add[1].trim().length >= 2) return { type: 'ADD', query: add[1].trim() };
    return null;
}

module.exports = { parseRadioIntent };
