// Замер (R12, п.4 плана): что дали бы имена из выверенных общих селекторов
// списков (EasyList, uBlock filters, RU AdList — rulesets/scripting/generic
// в сборке, с исключениями сайтов) против нашего словаря имён.
//
// Движок в режиме «Оптимальный» (у нас по умолчанию) общие селекторы не
// применяет вовсе. Вопрос — брать ли их признаком. На каждой странице
// (снимки, набор обычных страниц, образцы — как в test-verdict-diff):
//   * сколько узлов совпало с селекторами списков (видимых, заметных);
//   * из них — уже кандидаты нашего механизма или нет;
//   * спрятал бы их слот механизм сейчас;
//   * что в них: текст, есть ли другие признаки рекламы.
// Плюс цена: время сопоставления (как у движка: хэши class/id → селекторы).
//
//   node survey-list-names.mjs [--page <файл.html> --url <адрес>] [--json <выход>]

import { chromium } from 'playwright';
import { browserOptions } from './browser.mjs';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildLists, LISTS_PLACEHOLDER } from './list-signs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'build', 'extension');
const GENERIC = path.join(EXT, 'rulesets', 'scripting', 'generic');
// Рекламные наборы, включённые по умолчанию (ruleset-details + setup.js).
const RULESETS = ['ublock-filters', 'easylist', 'rus-0'];

function loadGeneric(id) {
    const sandbox = { self: {} };
    vm.runInNewContext(fs.readFileSync(path.join(GENERIC, id + '.js'), 'utf8'), sandbox);
    const map = sandbox.self.genericSelectorMaps[0];
    const details = sandbox.self.genericDetails[0];
    return {
        id,
        lowly: [...map.values()].flatMap(s => s.split(',\n')),
        highly: details.highlyGeneric ? details.highlyGeneric.split(',\n') : [],
        hostnames: details.hostnames,
        exceptions: details.exceptions
    };
}
const sets = RULESETS.map(loadGeneric);
// Сайты, где авторы списков отключили общие правила целиком (generic-details).
const unhide = new Map(JSON.parse(fs.readFileSync(path.join(EXT, 'rulesets', 'generic-details.json'), 'utf8')));

function selectorsFor(url) {
    const host = new URL(url).hostname;
    const suffixes = host.split('.').map((_, i, parts) => parts.slice(i).join('.'));
    const out = [];
    for (const set of sets) {
        const details = unhide.get(set.id);
        if (details && details.unhide && suffixes.some(h => details.unhide.includes(h))) {
            continue;
        }
        const except = new Set();
        set.hostnames.forEach((h, i) => {
            if (suffixes.includes(h)) {
                set.exceptions[i].split('\n').forEach(s => except.add(s));
            }
        });
        for (const s of [...set.lowly, ...set.highly]) {
            if (!except.has(s)) {
                out.push({ s, set: set.id, highly: set.highly.includes(s) });
            }
        }
    }
    return out;
}

// Наш механизм — текущая копия (как в test-verdict-diff).
let lists = null;
function mechanism() {
    lists = lists || buildLists(EXT).lists;
    const order = JSON.parse(fs.readFileSync(path.join(ROOT, 'platform/generic/order.json'), 'utf8')).filter(f => f !== 'main.js');
    const body = order.map(f => fs.readFileSync(path.join(ROOT, 'platform/generic', f), 'utf8')).join('\n')
        .replace(LISTS_PLACEHOLDER, () => `const LISTS = ${JSON.stringify(lists)};`);
    return `window.__m = (() => {\n'use strict';\nconst active = true;\n${body}
const NAME_PREFILTER = ['ad', 'rtb', 'sponsor', 'commercial', 'rekl', 'promo'].flatMap(w => ['[class*="' + w + '" i]', '[id*="' + w + '" i]']).join(', ');
function candidates(scope) {
    const out = new Set();
    for (const el of scope.querySelectorAll(NAME_PREFILTER)) if (nameStrength(el) > 0) out.add(el);
    for (const el of scope.querySelectorAll(NETWORK_NODES)) out.add(el);
    for (const el of scope.querySelectorAll(BLOCK_ID_NODES)) if (isBlockId(el)) out.add(el);
    for (const el of scope.querySelectorAll('iframe[src], script[src]')) if ((NETWORK.test(el.src) || blockedFrame(el)) && el.parentElement) out.add(el.parentElement);
    const marking = [];
    for (const el of labelsIn(scope, false, marking)) out.add(el);
    for (const el of marking) out.add(el);
    for (const el of findListAddress(scope)) out.add(el);
    return out;
}
return { candidates, slotsFor, verdict, beginPass, endPass, evidence, nameStrength, labelsDeep, networkIn, trackingIn, markingIn };
})();`;
}

// В странице: совпадения с селекторами списков и что о них думает механизм.
function survey(selectors) {
    const m = window.__m;
    const t0 = performance.now();
    const hits = new Map();
    let bad = 0;
    // Пачками, как это сделал бы движок одной таблицей.
    for (let i = 0; i < selectors.length; i += 300) {
        const chunk = selectors.slice(i, i + 300);
        let found;
        try {
            found = document.querySelectorAll(chunk.map(x => x.s).join(','));
        } catch {
            found = [];
            for (const x of chunk) {
                try {
                    document.querySelectorAll(x.s).forEach(el => hits.has(el) || hits.set(el, x));
                } catch {
                    bad += 1;
                }
            }
        }
        for (const el of found) {
            if (!hits.has(el)) {
                hits.set(el, chunk.find(x => { try { return el.matches(x.s); } catch { return false; } }));
            }
        }
    }
    const matchMs = performance.now() - t0;
    const cands = m.candidates(document.body);
    const candidateNear = el => [...cands].some(c => c === el || el.contains(c) || c.contains(el));
    m.beginPass();
    const items = [];
    for (const [el, rule] of hits) {
        // Только внешние: вложенные совпадения — та же реклама.
        let outer = true;
        for (let up = el.parentElement; up; up = up.parentElement) {
            if (hits.has(up)) { outer = false; break; }
        }
        if (!outer) continue;
        const r = el.getBoundingClientRect();
        const visible = el.checkVisibility() && r.width * r.height >= 100 * 50;
        let hidden = false;
        let reason = null;
        for (const root of m.slotsFor(el)) {
            const d = m.verdict(root);
            if (d) { hidden = true; reason = d.reason + ' [' + d.signals + ']'; break; }
        }
        const ev = m.evidence(el, false);
        const other = ['network', 'label', 'tracking'].filter(k => ev[k]);
        items.push({
            sel: rule ? rule.s.slice(0, 80) : '?', set: rule && rule.set, highly: Boolean(rule && rule.highly),
            tag: el.localName, cls: String(el.getAttribute('class') || '').slice(0, 60), id: el.id.slice(0, 40),
            visible, size: `${Math.round(r.width)}x${Math.round(r.height)}`,
            text: (el.innerText || '').replace(/\s+/g, ' ').trim().length,
            links: el.querySelectorAll('a[href]').length,
            ourName: m.nameStrength(el, true), candidate: candidateNear(el), hidden, reason, other
        });
    }
    m.endPass();
    return { selectors: selectors.length, bad, matchMs: Math.round(matchMs * 10) / 10, nodes: document.querySelectorAll('*').length, items };
}

// Страницы — как в test-verdict-diff.
const pages = [];
const pi = process.argv.indexOf('--page');
const ui = process.argv.indexOf('--url');
const DEFAULT_URL = 'https://diff.example/page';
if (pi !== -1) {
    pages.push({ id: path.basename(process.argv[pi + 1]), html: fs.readFileSync(process.argv[pi + 1], 'utf8'), url: ui === -1 ? DEFAULT_URL : process.argv[ui + 1] });
}
for (const dir of pi !== -1 ? [] : ['test/fixtures/raw/pages', 'test/fixtures/raw/pages/gb']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs).filter(n => n.endsWith('.html'))) {
        const url = name.startsWith('avito') ? 'https://www.avito.ru/' : DEFAULT_URL;
        pages.push({ id: `${dir.endsWith('gb') ? 'gb/' : ''}${name}`, html: fs.readFileSync(path.join(abs, name), 'utf8'), url });
    }
}
const FP = path.join(ROOT, 'test', 'fixtures', 'raw', 'fp');
const fpIndex = pi === -1 && fs.existsSync(path.join(FP, 'index.json')) ? JSON.parse(fs.readFileSync(path.join(FP, 'index.json'), 'utf8')) : {};
for (const [id, { url }] of Object.entries(fpIndex)) {
    const file = path.join(FP, id + '.html');
    if (fs.existsSync(file)) pages.push({ id: 'fp/' + id, html: fs.readFileSync(file, 'utf8'), url });
}
const SNIPPETS = path.join(ROOT, 'test', 'fixtures', 'private', 'snippets');
for (const name of pi === -1 && fs.existsSync(SNIPPETS) ? fs.readdirSync(SNIPPETS).filter(n => n.endsWith('.html')) : []) {
    const body = fs.readFileSync(path.join(SNIPPETS, name), 'utf8').replace(/^<!--[\s\S]*?-->\s*/, '');
    const list = /^\s*<li/i.test(body) ? `<ul>${body}<li>обычный пункт списка</li><li>ещё пункт</li></ul>` : body;
    pages.push({ id: 'snippet/' + name, url: DEFAULT_URL, html: `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body><p>Страница с образцом</p>${list}<p>Текст после</p></body></html>` });
}

const browser = await chromium.launch({ ...browserOptions(), headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: 'ru-RU' });
let current = null;
await context.route('**/*', route => (current && route.request().url() === current.url
    ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: current.html })
    : route.abort()));
const M = mechanism();
const results = [];
try {
    for (const p of pages) {
        current = p;
        const tab = await context.newPage();
        try {
            await tab.goto(p.url, { waitUntil: 'load', timeout: 60000 });
            await tab.waitForTimeout(300);
            await tab.addScriptTag({ content: M });
            const r = await tab.evaluate(survey, selectorsFor(p.url));
            results.push({ page: p.id, url: p.url, ...r });
            const vis = r.items.filter(i => i.visible);
            console.log(`${p.id}: узлов ${r.nodes}, совпало ${r.items.length} (видимых ${vis.length}; из них новых для нас ${vis.filter(i => !i.candidate).length}, прячем ${vis.filter(i => i.hidden).length}), сопоставление ${r.matchMs} мс`);
        } catch (error) {
            console.log(`${p.id}: ошибка ${error.message.split('\n')[0]}`);
        } finally {
            await tab.close();
        }
    }
} finally {
    await browser.close();
}
const ji = process.argv.indexOf('--json');
const out = ji === -1 ? path.join(ROOT, 'test', 'fixtures', 'raw', 'list-names-survey.json') : process.argv[ji + 1];
fs.writeFileSync(out, JSON.stringify(results, null, 1));
console.log(`\nИтог — ${path.relative(ROOT, out)} (чужие страницы: только локально)`);
