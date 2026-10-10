'use strict';

// Отчёт общего механизма для «Сообщить о проблеме» (этап 5). Считается
// только по запросу попапа — на скорость страницы не влияет.
//
//   * leftovers — что на странице похоже на рекламу, но не спрятано: метки,
//     номера блоков, узлы сетей, маркировка (и в закрытом теневом DOM). Для
//     каждого — короткий фрагмент разметки и почему его слот остался:
//     признаки и сумма или предохранитель. О пропуске сообщает сам отчёт,
//     и из него сразу делается образец для теста.
//   * recon — разведка для решения о перехвате загрузчика рекламы (М5а/б):
//     какие загрузчики есть на странице (только факт), откуда скрипты сетей
//     и картинки у остатков. Ничего не перехватываем.
//
// Адреса в отчёте — без параметров (?…) и якорей: в них бывают токены.

const LEFTOVER_LIMIT = 10;
const SNIPPET_LENGTH = 400;

// Адрес без параметров, путь — не больше трёх частей.
function cleanUrl(raw) {
    try {
        const url = new URL(raw, location.href);
        if (!/^https?:$/.test(url.protocol)) {
            return url.protocol;
        }
        const parts = url.pathname.split('/').filter(Boolean).slice(0, 3).map(part => part.slice(0, 40));
        return url.host + '/' + parts.join('/');
    } catch {
        return '';
    }
}

// Фрагмент разметки без параметров в адресах и без длинных значений.
function snippetOf(el) {
    return el.outerHTML
        .replace(/((?:href|src|srcset|action|data-[\w-]+)=")([^"]*)"/g, (_, attr, value) => attr + value.replace(/[?#][^\s",]*/g, '') + '"')
        .replace(/url\(([^)]*)\)/g, (_, value) => 'url(' + cleanUrl(value.replace(/["']/g, '')) + ')')
        .slice(0, SNIPPET_LENGTH);
}

const sizeOf = el => {
    const r = el.getBoundingClientRect();
    return `${Math.round(r.width)}x${Math.round(r.height)}`;
};

// Откуда картинки узла и его теневого DOM — для разведки (М5б).
function imagesOf(el) {
    const out = new Set();
    const scan = scope => {
        for (const img of scope.querySelectorAll('img[src]')) {
            if (!img.getAttribute('src').startsWith('data:')) {
                out.add(cleanUrl(img.getAttribute('src')));
            }
        }
        for (const node of [scope.host || scope, ...scope.querySelectorAll('*')]) {
            if (node.nodeType !== 1) {
                continue;
            }
            const bg = getComputedStyle(node).backgroundImage;
            const match = bg && bg.match(/url\("?([^")]+)"?\)/);
            if (match && !match[1].startsWith('data:')) {
                out.add(cleanUrl(match[1]));
            }
        }
    };
    scan(el);
    shadowRootsIn(el).forEach(scan);
    out.delete('');
    return [...out].slice(0, 5);
}

// Почему слот не спрятан: предохранитель или признаков мало.
function explain(root) {
    const out = { tag: root.localName, cls: String(root.getAttribute('class') || '').slice(0, 80), size: sizeOf(root) };
    if (insideCollapsed(root)) {
        return { ...out, why: 'уже спрятан' };
    }
    if (!shown(root)) {
        return { ...out, why: 'не виден' };
    }
    if (bait(root)) {
        return { ...out, why: 'похож на приманку детектора (за краем или крошечный)' };
    }
    const empty = !visibleContent(root);
    if (!safeToCollapse(root, empty)) {
        return { ...out, why: 'предохранитель: контент (main/article/form, много текста или выше 2,5 экрана)' };
    }
    const ev = evidence(root, !empty);
    const decision = decide(ev, empty);
    const { total, signals } = score(ev);
    return { ...out, empty, total, threshold: THRESHOLD, signals, decision: decision ? decision.reason : null };
}

// Узлы, похожие на рекламу, которые видны и не спрятаны нами.
function findLeftovers() {
    const found = new Map();
    const add = (el, kind) => {
        if (!el || el === document.body || insideCollapsed(el) || !seen(el)) {
            return;
        }
        if (!found.has(el)) {
            found.set(el, new Set());
        }
        found.get(el).add(kind);
    };
    for (const el of labelsIn(document.body, true)) {
        add(el, 'метка');
    }
    for (const el of document.querySelectorAll(BLOCK_ID_NODES)) {
        if (isBlockId(el) && seen(el, AD_MIN_AREA)) {
            add(el, 'номер блока');
        }
    }
    for (const el of document.querySelectorAll(NETWORK_NODES)) {
        if (seen(el, AD_MIN_AREA)) {
            add(el, 'сеть');
        }
    }
    for (const el of document.querySelectorAll('iframe[src]')) {
        if (NETWORK.test(el.src) && seen(el, AD_MIN_AREA)) {
            add(el, 'сеть');
        }
    }
    // Маркировка: текст с «Рекламодатель» или erid — в своём небольшом блоке.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (/рекламодатель|erid/i.test(node.nodeValue)) {
            const el = node.parentElement;
            if (el && !el.closest('script, style') && MARKING.some(re => re.test(el.innerText || ''))) {
                add(el, 'маркировка');
            }
        }
    }
    // Закрытый теневой DOM: метки и маркировка внутри — на его хосте.
    for (const host of document.body.querySelectorAll('*')) {
        const shadow = shadowOf(host);
        if (!shadow) {
            continue;
        }
        if (labelsIn(shadow, true).length) {
            add(host, 'метка в теневом DOM');
        }
        if (MARKING.some(re => re.test(shadowText(shadow)))) {
            add(host, 'маркировка в теневом DOM');
        }
    }
    // Вложенные — в пользу внешнего.
    const nodes = [...found.keys()];
    for (const el of nodes) {
        const outer = nodes.find(other => other !== el && other.contains(el));
        if (outer) {
            found.get(el).forEach(kind => found.get(outer).add(kind));
            found.delete(el);
        }
    }
    return found;
}

function leftoversReport() {
    beginPass();
    try {
        const found = findLeftovers();
        const items = [];
        for (const [el, kinds] of found) {
            if (items.length >= LEFTOVER_LIMIT) {
                break;
            }
            // Теневой DOM — у самого узла или внутри него.
            const shadows = shadowRootsIn(el);
            const slot = slotsFor(el)[0];
            items.push({
                kinds: [...kinds],
                tag: el.localName,
                id: el.id.slice(0, 80),
                size: sizeOf(el),
                text: [el.innerText || '', ...shadows.map(shadowText)].join(' ').replace(/\s+/g, ' ').trim().slice(0, 120),
                shadow: shadows.length ? (shadows.some(root => root.mode === 'open') ? 'open' : 'closed') : null,
                canvas: Boolean(el.querySelector('canvas') || shadows.some(root => root.querySelector('canvas'))),
                images: imagesOf(el),
                slot: slot ? explain(slot) : null,
                html: snippetOf(el)
            });
        }
        const kindsList = [...found.values()];
        return {
            count: found.size,
            // Не одна лишь метка: одиночная «Реклама» — часто ссылка в подвале.
            likely: kindsList.filter(kinds => [...kinds].some(kind => kind !== 'метка')).length,
            items
        };
    } finally {
        endPass();
    }
}

// Разведка (М5а/б): только факты, ничего не перехватываем.
const LOADER_MARKS = ['Ya.Context', 'AdvManager', 'yaContextCb', 'adfoxAsyncParams', 'adfox', 'adsbygoogle', 'googletag', 'VK.Retargeting'];
const RECON_URL = /an\.yandex\.|yandex\.ru\/ads|yastatic\.net\/(?:partner|pcode|safeframe)|adfox|ads\.vk\.com|ad\.mail\.ru|googlesyndication|doubleclick|get-direct|direct\.yandex/i;

function reconReport() {
    const loaders = new Set();
    const adScripts = new Set();
    for (const script of document.scripts) {
        if (script.src) {
            if (RECON_URL.test(script.src)) {
                adScripts.add(cleanUrl(script.src));
            }
        } else {
            const text = script.textContent;
            for (const mark of LOADER_MARKS) {
                if (text.includes(mark)) {
                    loaders.add(mark);
                }
            }
        }
    }
    // Запросы страницы (Resource Timing): рекламные — по адресу.
    const adResources = new Map();
    for (const entry of performance.getEntriesByType('resource')) {
        if (RECON_URL.test(entry.name)) {
            const key = entry.initiatorType + ' ' + cleanUrl(entry.name);
            adResources.set(key, (adResources.get(key) || 0) + 1);
        }
    }
    let shadowHosts = 0;
    for (const el of document.body.querySelectorAll('*')) {
        if (shadowOf(el)) {
            shadowHosts += 1;
        }
    }
    return {
        loaders: [...loaders],
        adScripts: [...adScripts].slice(0, 20),
        adResources: [...adResources].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([key, count]) => `${key} ×${count}`),
        shadowHosts
    };
}

/* ---------- самопроверка (platform/selfcheck) ---------- */

// Для страницы «Самопроверка»: что мы спрятали и не задели ли нужное — без
// текста страницы (почта, переписка): только имена, размеры и числа.
// Главный текст — блок с наибольшей прозой (абзацы от 80 знаков), как в
// режиме чтения; спрятанное нами считается видимым — иначе спрятанное
// письмо не нашлось бы.
const SELFCHECK_PROSE = 80;
const SELFCHECK_AD_TEXT = /реклам|рекламодател|erid|спонсор|sponsor|партн[её]рск|advertis/i;

function proseOf(root) {
    let total = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (parent && !parent.closest('script, style, noscript, template')) {
            total += node.nodeValue.trim().length;
        }
    }
    return total;
}

function mainTextBlock() {
    const prose = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || node.nodeValue.trim().length < SELFCHECK_PROSE || parent.closest('script, style, noscript, template')) {
            continue;
        }
        if (!parent.checkVisibility() && !insideCollapsed(parent)) {
            continue;
        }
        const box = parent.parentElement || parent;
        prose.set(box, (prose.get(box) || 0) + node.nodeValue.trim().length);
    }
    let main = null;
    for (const [box, total] of prose) {
        if (!main || total > prose.get(main)) {
            main = box;
        }
    }
    return main;
}

function selfCheckReport() {
    const main = mainTextBlock();
    const hidden = [];
    for (const [el, entry] of collapsed) {
        if (!el.isConnected || hidden.length >= 50) {
            continue;
        }
        const r = el.getBoundingClientRect();
        const d = entry.decision || {};
        hidden.push({
            reason: d.reason || null,
            score: typeof d.total === 'number' ? d.total : null,
            signals: d.signals || [],
            afterOther: Boolean(entry.afterOther),
            tag: el.localName,
            name: [el.id ? '#' + el.id : '', typeof el.className === 'string' ? el.className : ''].join(' ').trim().slice(0, 120),
            size: `${Math.round(r.width)}x${Math.round(r.height)}`,
            text: proseOf(el),
            main: Boolean(main && (el === main || el.contains(main))),
            adLike: SELFCHECK_AD_TEXT.test(el.textContent || '') || Boolean(el.querySelector('iframe'))
        });
    }
    const left = leftoversReport();
    return {
        active,
        mainText: main ? proseOf(main) : 0,
        hidden,
        leftovers: {
            count: left.count,
            likely: left.likely,
            items: left.items.map(item => ({ kinds: item.kinds, tag: item.tag, id: item.id, size: item.size, shadow: item.shadow, canvas: item.canvas, images: item.images.map(src => { try { return new URL(src, location.href).hostname; } catch { return ''; } }), slot: item.slot }))
        },
        recon: reconReport()
    };
}

