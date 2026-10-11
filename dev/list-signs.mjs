// Признаки из списков движка — для общего механизма (platform/generic/lists.js).
//
// Свой словарь рекламных сетей отстаёт от жизни: 10.10 баннер на klerk.ru
// вёл на bs.serving-sys.ru, которого в словаре не было, а в RU AdList —
// был (и правилом скрытия, и сетевым). Списки ведут их авторы и
// обновляются вместе с движком, поэтому признаки берём из них:
//
//   * address — общие правила скрытия по адресу: ссылка, фрейм или
//     картинка ведут на рекламный сервер (a[href*="://bs.serving-sys.ru/"]).
//     Только из рекламных наборов (основные, региональные, AdGuard Mobile)
//     и только правила по адресу: правила по именам классов («.ad_banner»)
//     ловят приманки детекторов и обычные блоки — их не берём (R12).
//     Плюс исключения: сайты, где авторы отключили общие правила
//     (generichide), и исключения #@# для сайта.
//   * hosts — адреса, которые сетевые правила рекламных и трекерных
//     наборов блокируют целиком и без условий (без «только скрипты»,
//     «только на таких-то сайтах»): ~100 тыс. Это «ссылка учёта» —
//     переход через рекламную систему или счётчик. В скрипт страницы они
//     идут фильтром Блума (вероятностное множество: «нет» — точно нет,
//     «да» — с ошибкой 1 на 100 тыс.) — ~400 КБ вместо 1,6 МБ списком.
//     Популярные места перехода (popular-hosts.txt) — не учёт: их
//     убираем, и на них фильтр не ошибается.
//
// Вызывается из dev/build-extension.mjs; данные вклеиваются в собранный
// бандл вместо `const LISTS = null;` (в git — без данных).

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LISTS_PLACEHOLDER = 'const LISTS = null;';
// 1 на 100 тыс.: при 1 на 1000 фильтр ошибся на dzen.ru (11.10) — на
// длинном хвосте сайтов ошибки неизбежны, их доля и есть цена.
const BLOOM_FPR = 0.00001;

// Наборы, чьи правила по адресу — реклама.
const AD_GROUPS = new Set(['default', 'ads', 'regions']);
// Сетевые правила: реклама и счётчики. Вредоносные сайты — не «учёт».
const HOST_GROUPS = new Set(['default', 'ads', 'regions']);

// Правило по адресу: тег, условия на атрибуты, необязательно «> img».
const ADDRESS = /^(a|iframe|img)((?:\[(?:href|src|data-href|onclick)[*^$]?="[^"]+"(?:\s+i)?\])+)(\s*>\s*img)?$/;

function genericSelectors(file) {
    const ctx = { self: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), ctx);
    const details = (ctx.self.genericDetails || [])[0] || {};
    const highly = details.highlyGeneric;
    const text = typeof highly === 'string' ? highly : Object.values(highly || {}).join('');
    return {
        selectors: text.split(/,\n/).map(s => s.trim()).filter(Boolean),
        exceptions: (details.hostnames || []).map((host, i) => [host, String((details.exceptions || [])[i] || '').split('\n')])
    };
}

function blockedHosts(file) {
    const out = [];
    for (const rule of JSON.parse(fs.readFileSync(file, 'utf8'))) {
        const c = rule.condition || {};
        if (rule.action.type !== 'block' || !c.requestDomains || c.urlFilter || c.regexFilter ||
            c.resourceTypes || c.initiatorDomains || c.excludedRequestDomains || c.excludedInitiatorDomains) {
            continue;
        }
        out.push(...c.requestDomains);
    }
    return out;
}

// Хэш строки — тот же, что в platform/generic/lists.js (bloomHas);
// совпадение проверяется ниже на собранных данных.
function fnv(s, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
}

// extra — сдвиг размера: другие m — другие ложные ответы (см. buildLists).
function bloom(items, extra = 0) {
    const m = Math.ceil(-items.length * Math.log(BLOOM_FPR) / (Math.LN2 * Math.LN2)) + extra;
    const k = Math.round(m / items.length * Math.LN2);
    const bits = new Uint8Array(Math.ceil(m / 8));
    for (const item of items) {
        const h1 = fnv(item, 2166136261);
        const h2 = fnv(item, 16777619) | 1;
        for (let i = 0; i < k; i += 1) {
            const bit = (h1 + Math.imul(i, h2) >>> 0) % m;
            bits[bit >> 3] |= 1 << (bit & 7);
        }
    }
    return { m, k, bits };
}

function bloomTest({ m, k, bits }, item) {
    const h1 = fnv(item, 2166136261);
    const h2 = fnv(item, 16777619) | 1;
    for (let i = 0; i < k; i += 1) {
        const bit = (h1 + Math.imul(i, h2) >>> 0) % m;
        if (!(bits[bit >> 3] & (1 << (bit & 7)))) {
            return false;
        }
    }
    return true;
}

const suffixes = host => host.split('.').map((_, i, parts) => parts.slice(i).join('.')).filter(h => h.includes('.'));

// Популярные места перехода (popular-hosts.txt): ссылка на них — не учёт.
// Списки блокируют часть из них как ресурс (виджеты партнёрских программ),
// а фильтр может ошибиться на любом адресе — проверяем оба случая.
function popularHosts() {
    return fs.readFileSync(path.join(ROOT, 'dev', 'popular-hosts.txt'), 'utf8')
        .split('\n').filter(line => !line.startsWith('#')).join(' ').split(/\s+/).filter(Boolean);
}

function hostFilter(hosts) {
    const popular = popularHosts();
    const destinations = popular.flatMap(suffixes).filter(h => hosts.has(h));
    destinations.forEach(h => hosts.delete(h));
    const items = [...hosts];
    // Фильтр, который ни на одном популярном адресе не ошибается: при
    // ошибке чуть меняем размер — ложные ответы ложатся на другие адреса.
    for (let extra = 0; extra < 64; extra += 1) {
        const filter = bloom(items, extra);
        if (!popular.some(p => suffixes(p).some(h => bloomTest(filter, h)))) {
            return { filter: { ...filter, bits: Buffer.from(filter.bits).toString('base64') }, items, destinations: [...new Set(destinations)] };
        }
    }
    throw new Error('Фильтр адресов ошибается на популярных адресах при любом размере — проверить popular-hosts.txt');
}

export function buildLists(out) {
    const details = JSON.parse(fs.readFileSync(path.join(out, 'rulesets', 'ruleset-details.json'), 'utf8'));
    const generic = new Map(JSON.parse(fs.readFileSync(path.join(out, 'rulesets', 'generic-details.json'), 'utf8')));
    const address = new Set();
    const exceptions = {};
    const nohide = new Set();
    const hosts = new Set();
    for (const set of details) {
        if (AD_GROUPS.has(set.group)) {
            const file = path.join(out, 'rulesets', 'scripting', 'generic', set.id + '.js');
            if (fs.existsSync(file)) {
                const { selectors, exceptions: exc } = genericSelectors(file);
                const mine = selectors.filter(s => ADDRESS.test(s));
                mine.forEach(s => address.add(s));
                const own = new Set(mine);
                for (const [host, list] of exc) {
                    const hit = list.filter(s => own.has(s));
                    if (hit.length) {
                        exceptions[host] = [...new Set((exceptions[host] || []).concat(hit))];
                    }
                }
            }
            for (const host of (generic.get(set.id) || {}).unhide || []) {
                nohide.add(host);
            }
        }
        if (HOST_GROUPS.has(set.group)) {
            const file = path.join(out, 'rulesets', 'main', set.id + '.json');
            if (fs.existsSync(file)) {
                blockedHosts(file).forEach(h => hosts.add(h));
            }
        }
    }
    if (address.size < 300 || hosts.size < 50000) {
        throw new Error(`Признаки из списков: подозрительно мало (по адресу ${address.size}, адресов ${hosts.size}) — изменился формат движка?`);
    }
    // Правила разбирает код страницы (lists.js) — здесь, один раз.
    const page = pageCode(null);
    const rules = [...address].sort().map(selector => page.parseListRule(selector)).filter(Boolean);
    const lists = {
        rules,
        prefilter: page.listPrefilters(rules),
        exceptions,
        nohide: [...nohide].sort(),
        hosts: null
    };
    const { filter, items, destinations } = hostFilter(hosts);
    lists.hosts = filter;
    checkRuntime(lists, items);
    return { lists, counts: { address: rules.length, exceptions: Object.keys(exceptions).length, nohide: nohide.size, hosts: items.length, destinations } };
}

// Фильтр, собранный здесь, читается кодом страницы так же: берём
// bloomHas из platform/generic/lists.js и спрашиваем выборку адресов, а
// популярные — на «нет».
function pageCode(lists) {
    const source = fs.readFileSync(path.join(ROOT, 'platform', 'generic', 'lists.js'), 'utf8');
    const ctx = { atob: s => Buffer.from(s, 'base64').toString('binary') };
    vm.runInNewContext(source.replace(LISTS_PLACEHOLDER, 'const LISTS = __lists;') +
        '\nthis.bloomHas = bloomHas; this.parseListRule = parseListRule; this.listPrefilters = listPrefilters;', Object.assign(ctx, { __lists: lists }));
    return ctx;
}

function checkRuntime(lists, hosts) {
    const ctx = pageCode(lists);
    const sample = hosts.filter((_, i) => i % 997 === 0);
    const miss = sample.filter(h => !ctx.bloomHas(lists.hosts, h));
    if (miss.length) {
        throw new Error('Фильтр адресов читается страницей не так, как собран: ' + miss.slice(0, 3).join(', '));
    }
    const lie = popularHosts().filter(p => suffixes(p).some(h => ctx.bloomHas(lists.hosts, h)));
    if (lie.length) {
        throw new Error('Фильтр адресов в странице отвечает «учёт» на популярные адреса: ' + lie.slice(0, 3).join(', '));
    }
}

// Вклеить данные в собранный бандл.
export function injectLists(bundleFile, lists) {
    const text = fs.readFileSync(bundleFile, 'utf8');
    const at = text.indexOf(LISTS_PLACEHOLDER);
    if (at === -1 || text.indexOf(LISTS_PLACEHOLDER, at + 1) !== -1) {
        throw new Error(`В ${bundleFile} должно быть ровно одно «${LISTS_PLACEHOLDER}»`);
    }
    fs.writeFileSync(bundleFile, text.slice(0, at) + `const LISTS = ${JSON.stringify(lists)};` + text.slice(at + LISTS_PLACEHOLDER.length));
}
