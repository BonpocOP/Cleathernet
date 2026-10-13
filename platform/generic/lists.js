'use strict';

// Признаки из списков движка (dev/list-signs.mjs): правила скрытия по
// адресу из рекламных наборов (ссылка, фрейм или картинка ведут на
// рекламный сервер) и адреса, которые сетевые правила блокируют целиком
// (ссылка учёта). Свой словарь сетей отстаёт: 10.10 баннер на klerk.ru
// вёл на bs.serving-sys.ru — в RU AdList он был, у нас нет. Данные
// вклеиваются при сборке; в git их нет — тогда признаки молчат.
//
// Не копируем ошибки списков: они прячут сам узел и оставляют пустую
// рамку (мы схлопываем место), и прячут ссылку внутри текста статьи —
// предложение рвётся (мы такую не трогаем, inlineInText).
const LISTS = null;

/* ---------- фильтр адресов (Блум) ---------- */

// Тот же хэш, что при сборке (dev/list-signs.mjs, fnv).
function fnvHash(s, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
}

// Биты раскрываются при первом вопросе: на большинстве страниц его нет.
let bloomBits = null;

function bloomHas(bloom, item) {
    if (!bloomBits) {
        const raw = atob(bloom.bits);
        bloomBits = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) {
            bloomBits[i] = raw.charCodeAt(i);
        }
    }
    const h1 = fnvHash(item, 2166136261);
    const h2 = fnvHash(item, 16777619) | 1;
    for (let i = 0; i < bloom.k; i += 1) {
        const bit = (h1 + Math.imul(i, h2) >>> 0) % bloom.m;
        if (!(bloomBits[bit >> 3] & (1 << (bit & 7)))) {
            return false;
        }
    }
    return true;
}

// Адрес и все его родительские домены: правило на ad.example.com
// действует и на x.ad.example.com.
function hostSuffixes(host) {
    const out = [];
    for (let h = host.toLowerCase(); h.includes('.'); h = h.slice(h.indexOf('.') + 1)) {
        out.push(h);
    }
    return out;
}

/* ---------- правила по адресу ---------- */

const RULE = /^(a|iframe|img)((?:\[[^\]]+\])+)(\s*>\s*img)?$/;
const CONDITION = /\[([a-z-]+)([*^$]?)="([^"]+)"(\s+i)?\]/g;
// Адрес в значении условия: «://bs.serving-sys.ru/», «https://ad.x.com/»,
// «.smartadserver.com», «clickbytes.ru/». Остальное («&maxads=») —
// подстрока без адреса.
const HOST_IN_VALUE = /^(?:https?)?:?(?:\/\/)?\.?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=[/?#:]|$)/i;
const URL_HOST = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#:]+)/i;

// Разбор правила — при сборке: dev/list-signs.mjs берёт эту функцию и
// кладёт итог в LISTS.rules. На странице разбор тысячи правил регулярками
// стоил 2,6–3,6 мс на каждой странице (Авито, 11.10). Итог: [селектор,
// тег, «> img», адрес сервера или '', условия [[атрибут, оператор, без
// учёта регистра, значение], …]].
function parseListRule(selector) {
    const m = RULE.exec(selector);
    if (!m) {
        return null;
    }
    const conds = [...m[2].matchAll(CONDITION)].map(c => [c[1], c[2], Boolean(c[4]), c[4] ? c[3].toLowerCase() : c[3]]);
    const keyed = m[1] === 'a' && conds.find(c => c[0] === 'href' && HOST_IN_VALUE.test(c[3]));
    return [selector, m[1], Boolean(m[3]), keyed ? HOST_IN_VALUE.exec(keyed[3])[1].toLowerCase() : '', conds];
}

const mainAttr = tag => (tag === 'a' ? 'href' : 'src');

// Отсев по тегу — тоже при сборке: одно выражение из строк всех правил
// тега по адресу — может ли хоть одно подойти (в 15 раз быстрее перебора:
// Авито, 1263 ссылки — 0,6 мс против 9). Исключения сайта в нём не
// вычитаются: отсев лишь пропускает лишнее, решают сами правила.
function listPrefilters(rules) {
    const out = {};
    for (const tag of ['a', 'iframe', 'img']) {
        out[tag] = rules.filter(r => r[1] === tag && !r[3])
            .flatMap(r => r[4].filter(c => c[0] === mainAttr(tag)).slice(0, 1))
            .map(c => c[3].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    }
    return out;
}

let listRules = undefined;

// Правила для этой страницы: без исключений сайта; на сайтах, где авторы
// списков отключили общие правила (generichide), — никаких. Ссылки с
// адресом сервера (их большинство) сверяем по указателю «адрес →
// правила»: на странице тысячи ссылок, и перебирать все правила для
// каждой дорого. Остальное (фреймы, картинки, подстроки) — по тегу:
// узел проверяется только правилами своего тега. Одним селектором на
// всю страницу нельзя: браузер проверяет каждое из сотен правил на
// каждом узле (Авито, 11.10: +30 мс).
function rulesHere() {
    if (listRules !== undefined) {
        return listRules;
    }
    listRules = null;
    if (!LISTS) {
        return null;
    }
    const here = hostSuffixes(location.hostname);
    if (here.some(h => LISTS.nohide.includes(h))) {
        return null;
    }
    const skip = new Set(here.flatMap(h => LISTS.exceptions[h] || []));
    const byHost = new Map();
    const loose = { a: [], iframe: [], img: [] };
    const always = { a: [], iframe: [], img: [] };
    const selectors = [];
    for (const [selector, tag, img, host, conds] of LISTS.rules) {
        if (skip.has(selector)) {
            continue;
        }
        selectors.push(selector);
        const rule = { conds, img };
        if (host) {
            if (!byHost.has(host)) {
                byHost.set(host, []);
            }
            byHost.get(host).push(rule);
            continue;
        }
        loose[tag].push(rule);
        // Правила без условия на адрес (onclick, data-href) проверяются
        // у каждого узла тега — но только если у него есть их атрибут.
        if (!conds.some(c => c[0] === mainAttr(tag))) {
            always[tag].push(rule);
        }
    }
    const alwaysAttrs = {};
    const prefilter = {};
    for (const tag of Object.keys(loose)) {
        alwaysAttrs[tag] = [...new Set(always[tag].flatMap(rule => rule.conds.map(c => c[0])))];
        prefilter[tag] = LISTS.prefilter[tag] ? new RegExp(LISTS.prefilter[tag], 'i') : null;
    }
    const find = [];
    if (byHost.size || loose.a.length) {
        find.push('a[href]');
    }
    if (loose.a.some(rule => rule.conds.some(c => c[0] !== 'href'))) {
        find.push('a[onclick]', 'a[data-href]');
    }
    for (const tag of ['iframe', 'img']) {
        if (loose[tag].length) {
            find.push(tag + '[src]');
        }
    }
    listRules = { byHost, loose, prefilter, always, alwaysAttrs, selectors, find: find.join(', ') };
    return listRules;
}

function conditionHolds(attrs, [attr, op, ci, expected]) {
    let value = attrs(attr);
    if (value === null) {
        return false;
    }
    if (ci) {
        value = value.toLowerCase();
    }
    return op === '*' ? value.includes(expected)
        : op === '^' ? value.startsWith(expected)
            : op === '$' ? value.endsWith(expected)
                : value === expected;
}

// Атрибуты узла читаем по разу, сколько бы правил их ни спрашивали.
function attrReader(el) {
    const cache = {};
    return name => (name in cache ? cache[name] : (cache[name] = el.getAttribute(name)));
}

const ruleHolds = (el, rule, attrs) => rule.conds.every(c => conditionHolds(attrs, c)) && (!rule.img || Boolean(el.querySelector(':scope > img')));

// Правила адреса ссылки (с родительскими доменами) — на адрес, а не на
// ссылку: на странице сотни ссылок на один адрес.
const hostRuleCache = new Map();

function rulesForHost(rules, host) {
    let list = hostRuleCache.get(host);
    if (list === undefined) {
        list = hostSuffixes(host).flatMap(h => rules.byHost.get(h) || []);
        hostRuleCache.set(host, list);
    }
    return list;
}

function listAddressMatch(el) {
    const rules = rulesHere();
    const tag = el.localName;
    if (!rules || !(tag in rules.loose)) {
        return false;
    }
    const attrs = attrReader(el);
    if (tag === 'a') {
        const m = URL_HOST.exec(attrs('href') || '');
        if (m && rulesForHost(rules, m[1]).some(rule => ruleHolds(el, rule, attrs))) {
            return true;
        }
    }
    const pre = rules.prefilter[tag];
    if (pre && pre.test(attrs(mainAttr(tag)) || '') && rules.loose[tag].some(rule => ruleHolds(el, rule, attrs))) {
        return true;
    }
    return rules.alwaysAttrs[tag].some(a => el.hasAttribute(a)) && rules.always[tag].some(rule => ruleHolds(el, rule, attrs));
}

// Найденное по спискам — на всё время страницы: признак «сеть» у слота
// сверяется с ним, а не ищется в каждом слоте заново.
const listHits = new Set();

// Поиск в scope (проход общего механизма, main.js candidates).
function findListAddress(scope) {
    const rules = rulesHere();
    if (!rules) {
        return [];
    }
    const out = [];
    if (!rules.find) {
        return out;
    }
    if (scope.matches && scope.matches(rules.find) && listAddressMatch(scope)) {
        out.push(scope);
    }
    for (const el of scope.querySelectorAll(rules.find)) {
        if (listAddressMatch(el)) {
            out.push(el);
        }
    }
    out.forEach(el => listHits.add(el));
    return out;
}

// Ссылка внутри текста: вокруг неё в том же абзаце есть свои слова
// (партнёрская ссылка в статье). Списки прячут и её — предложение
// рвётся; мы такую не трогаем: она часть текста, а не рекламное место.
const INLINE_TEXT_AROUND = 20;

function inlineInText(el) {
    const parent = el.parentElement;
    if (el.localName !== 'a' || !parent || !el.checkVisibility() || !getComputedStyle(el).display.startsWith('inline')) {
        return false;
    }
    return (parent.textContent || '').trim().length - (el.textContent || '').trim().length > INLINE_TEXT_AROUND;
}

// След рекламы по списку. Ссылку с картинкой и фрейм наша таблица
// (listAddressCss) прячет ещё до отрисовки — спрятанные, они и есть
// видимая реклама. Видимый узел — реклама, если он заметного размера
// или это ссылка-кнопка не внутри текста. Спрятанная картинка — нет:
// это может быть пиксель учёта внутри обычной карточки.
const CREATIVE_MEDIA = 'img, picture, video, iframe, canvas, object, embed';

function listCreative(el) {
    if (el.checkVisibility()) {
        if (inlineInText(el)) {
            return false;
        }
        // Строчная ссылка с баннером: её рамка — высотой со строку, а не
        // с картинку; размер — у самого креатива.
        return seen(el, AD_MIN_AREA) || (el.localName === 'a' && ((el.textContent || '').trim().length > 2 ||
            [...el.querySelectorAll(CREATIVE_MEDIA)].some(m => seen(m, AD_MIN_AREA))));
    }
    if (el.localName === 'iframe') {
        return true;
    }
    return el.localName === 'a' && Boolean(el.querySelector(CREATIVE_MEDIA));
}

function listAddressIn(root, visibleOnly = false) {
    for (const el of listHits) {
        if (!el.isConnected) {
            listHits.delete(el);
            continue;
        }
        if ((el === root || root.contains(el)) && (visibleOnly ? listCreative(el) : !inlineInText(el))) {
            return true;
        }
    }
    return false;
}

// Таблица для ранней вставки: реклама по спискам не появляется вовсе.
// Только сама реклама — ссылка с картинкой, фрейм, картинка; текстовую
// ссылку решает проход (inlineInText), а не таблица.
function listAddressCss() {
    const rules = rulesHere();
    if (!rules || !rules.selectors.length) {
        return '';
    }
    const visual = rules.selectors.map(s => (/^a\[/.test(s) && !/>\s*img$/.test(s) ? s + ':has(img, picture, video, iframe, canvas)' : s));
    return visual.join(',\n') + ' { display: none !important; }';
}

/* ---------- ссылка учёта по сетевым правилам ---------- */

// Ссылка ведёт на чужой адрес, который сетевые правила блокируют
// целиком: переход через рекламную систему или счётчик (eye.targetads.io
// на klerk.ru, 11.10). Свой сайт — не учёт. Ответ — на адрес: ссылок на
// один адрес много.
const blockedHostCache = new Map();

function blockedHost(host) {
    if (!LISTS || !host) {
        return false;
    }
    let answer = blockedHostCache.get(host);
    if (answer === undefined) {
        answer = !sameSite(host, location.hostname) && hostSuffixes(host).some(h => bloomHas(LISTS.hosts, h));
        blockedHostCache.set(host, answer);
    }
    return answer;
}

const blockedLinkHost = a => blockedHost(a.hostname);

// Фрейм с чужого адреса, который сетевые правила блокируют целиком, —
// место рекламной биржи (13.10: otm-r.com, betweendigital, buzzoola,
// adx.com.ru — в списках движка есть, в нашем словаре сетей и в правилах
// «по адресу» нет). Пиксель учёта во фрейме — не реклама: фрейм должен
// быть размером с рекламу — на экране, а спрятанный (движком, соседом) —
// по объявленным width и height.
function frameHost(frame) {
    try {
        return new URL(frame.src).hostname;
    } catch {
        return '';
    }
}

const declaredArea = frame => (parseInt(frame.getAttribute('width'), 10) || 0) * (parseInt(frame.getAttribute('height'), 10) || 0);

function blockedFrame(frame, visibleOnly = false) {
    if (frame.localName !== 'iframe' || !LISTS) {
        return false;
    }
    const sized = seen(frame, AD_MIN_AREA) || (!visibleOnly && declaredArea(frame) >= AD_MIN_AREA);
    return sized && blockedHost(frameHost(frame));
}

function blockedLinkIn(root) {
    if (!LISTS) {
        return false;
    }
    if (root.localName === 'a' && blockedLinkHost(root)) {
        return true;
    }
    for (const a of root.querySelectorAll('a[href]')) {
        if (blockedLinkHost(a)) {
            return true;
        }
    }
    return false;
}
