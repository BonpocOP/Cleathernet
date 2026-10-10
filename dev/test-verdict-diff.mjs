// Сравнение решений общего механизма «до» и «после» на настоящей разметке.
//
// В страницу без расширения вставляются две копии механизма: прежняя (из
// git, по умолчанию HEAD — последний коммит) и текущая (рабочие файлы).
// Расхождение — не обязательно ошибка: если решение меняется намеренно
// (новый признак), каждое расхождение разбирается и записывается.
// Кандидаты — объединение кандидатов обеих копий. Для
// каждого кандидата и каждого его слота обе копии выносят решение — они
// должны совпасть. Каждая страница — в двух состояниях: как есть и после
// того, как «сосед» спрятал рекламные узлы (проверяется путь «пустое
// место»).
//
// Страницы: снимки test/fixtures/raw/pages/*.html и gb/*.html (в git не
// хранятся — каких нет, те пропускаются) и все образцы test/fixtures/private/snippets
// (вырезаны из страниц, присланных пользователями, — в git не попадают).
//
//   node test-verdict-diff.mjs [--base <коммит>]

import { chromium } from 'playwright';
import { browserOptions } from './browser.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bi = process.argv.indexOf('--base');
const BASE = bi === -1 ? 'HEAD' : process.argv[bi + 1];

const fromGit = file => execFileSync('git', ['show', `${BASE}:${file}`], { cwd: ROOT, encoding: 'utf8' });
const fromDisk = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

// Кандидаты — как в main.js candidates(), на функциях своей копии.
const HARNESS = `
const NAME_PREFILTER = ['ad', 'rtb', 'sponsor', 'commercial', 'rekl', 'promo']
    .flatMap(w => ['[class*="' + w + '" i]', '[id*="' + w + '" i]']).join(', ');
function candidates(scope) {
    const out = new Set();
    for (const el of scope.querySelectorAll(NAME_PREFILTER)) if (nameStrength(el) > 0) out.add(el);
    for (const el of scope.querySelectorAll(NETWORK_NODES)) out.add(el);
    for (const el of scope.querySelectorAll('iframe[src], script[src]')) if (NETWORK.test(el.src) && el.parentElement) out.add(el.parentElement);
    // Номера блоков — с этапа 4.
    if (typeof BLOCK_ID_NODES !== 'undefined') for (const el of scope.querySelectorAll(BLOCK_ID_NODES)) if (isBlockId(el)) out.add(el);
    for (const el of labelsIn(scope)) out.add(el);
    return out;
}`;

// Файлы механизма по order.json своей версии, без main.js (он запускается
// сам). verdict() до этапа 3 отдавал причину строкой, после — объект:
// сравниваем причину.
function copy(name, read) {
    const order = JSON.parse(read('platform/generic/order.json')).filter(file => file !== 'main.js');
    const body = order.map(file => read('platform/generic/' + file)).join('\n');
    return `window.${name} = (() => {\n'use strict';\n${body}\n${HARNESS}\nreturn { candidates, slotsFor, verdict: root => (d => (d && typeof d === 'object' ? d.reason : d))(verdict(root)), beginPass, endPass, nameStrength, NETWORK_NODES };\n})();`;
}

const OLD = copy('__old', fromGit);
const NEW = copy('__new', fromDisk);

// Страницы.
const pages = [];
for (const dir of ['test/fixtures/raw/pages', 'test/fixtures/raw/pages/gb']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs).filter(n => n.endsWith('.html'))) {
        pages.push({ id: `${dir.endsWith('gb') ? 'gb/' : ''}${name}`, html: fs.readFileSync(path.join(abs, name), 'utf8') });
    }
}
const SNIPPETS = path.join(ROOT, 'test', 'fixtures', 'private', 'snippets');
for (const name of fs.existsSync(SNIPPETS) ? fs.readdirSync(SNIPPETS).filter(n => n.endsWith('.html')) : []) {
    const body = fs.readFileSync(path.join(SNIPPETS, name), 'utf8').replace(/^<!--[\s\S]*?-->\s*/, '');
    const list = /^\s*<li/i.test(body) ? `<ul>${body}<li>обычный пункт списка</li><li>ещё пункт</li></ul>` : body;
    pages.push({ id: 'snippet/' + name, html: `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body><p>Страница с образцом</p>${list}<p>Текст после</p></body></html>` });
}

// В странице: обе копии судят одни и те же слоты.
function compare() {
    const out = { candidates: 0, roots: 0, hidden: { old: 0, new: 0 }, diffs: [] };
    const seen = new Set();
    const cands = new Set([...window.__old.candidates(document.body), ...window.__new.candidates(document.body)]);
    window.__old.beginPass();
    window.__new.beginPass();
    for (const el of cands) {
        out.candidates += 1;
        for (const root of window.__old.slotsFor(el)) {
            if (seen.has(root)) continue;
            seen.add(root);
            out.roots += 1;
            const a = window.__old.verdict(root);
            const b = window.__new.verdict(root);
            if (a) out.hidden.old += 1;
            if (b) out.hidden.new += 1;
            if (a !== b && out.diffs.length < 10) {
                out.diffs.push({ было: a, стало: b, tag: root.localName, cls: String(root.getAttribute('class') || '').slice(0, 60), id: root.id.slice(0, 40) });
            } else if (a !== b) {
                out.diffs.push(null);
            }
        }
    }
    window.__old.endPass();
    window.__new.endPass();
    out.diffCount = out.diffs.length;
    out.diffs = out.diffs.filter(Boolean);
    return out;
}

// «Сосед» спрятал рекламные узлы: всё с рекламным словом и узлы сетей.
function neighborHides() {
    let n = 0;
    for (const el of document.querySelectorAll('*')) {
        if (window.__old.nameStrength(el) === 2 || el.matches(window.__old.NETWORK_NODES)) {
            el.style.setProperty('display', 'none', 'important');
            n += 1;
        }
    }
    return n;
}

const browser = await chromium.launch({ ...browserOptions(), headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: 'ru-RU' });
let current = null;
await context.route('**/*', route => (route.request().url() === 'https://diff.example/page' && current
    ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: current })
    : route.abort()));

let failed = 0;
let totals = { roots: 0, hiddenOld: 0, hiddenNew: 0 };
try {
    for (const p of pages) {
        current = p.html;
        const tab = await context.newPage();
        try {
            await tab.goto('https://diff.example/page', { waitUntil: 'load', timeout: 60000 });
            await tab.waitForTimeout(500);
            await tab.addScriptTag({ content: OLD });
            await tab.addScriptTag({ content: NEW });
            const asIs = await tab.evaluate(compare);
            const hiddenNodes = await tab.evaluate(neighborHides);
            const afterNeighbor = await tab.evaluate(compare);
            for (const [state, r] of [['как есть', asIs], [`сосед спрятал ${hiddenNodes}`, afterNeighbor]]) {
                totals.roots += r.roots;
                totals.hiddenOld += r.hidden.old;
                totals.hiddenNew += r.hidden.new;
                const ok = r.diffCount === 0;
                if (!ok) failed += 1;
                console.log(`${ok ? 'ОК  ' : 'СБОЙ'} ${p.id} (${state}): слотов ${r.roots}, спрятано ${r.hidden.old} → ${r.hidden.new}${ok ? '' : ', расхождений ' + r.diffCount + '  → ' + JSON.stringify(r.diffs)}`);
            }
        } finally {
            await tab.close();
        }
    }
} finally {
    await browser.close();
}
console.log(`\nСтраниц: ${pages.length}, слотов оценено: ${totals.roots}, спрятано: было ${totals.hiddenOld}, стало ${totals.hiddenNew}`);
console.log(failed ? `Итого: расхождения в ${failed} состояниях` : 'Итого: решения совпали везде');
process.exit(failed ? 1 : 0);
