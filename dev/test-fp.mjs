// Ложные срабатывания общего механизма на обычных страницах (R12).
//
// Набор — test/fp-corpus.json: статьи, обсуждения, справка, карточки.
// Главное на них — содержимое; реклама рядом бывает, её прятать можно.
// Поэтому меряем не «спрятано ли что-то», а **какой видимый текст пропал
// из-за нас**: страница открывается со сборкой, механизм работает, потом
// выключается на сайте на лету (только наш слой — движок остаётся) — всё,
// что после этого стало видно, прятали мы. Ошибка — спрятанный блок с
// главным текстом страницы или с текстом от LOST_TEXT знаков без признаков
// рекламы; остальное (Р — с меткой/маркировкой/фреймом) — список для
// просмотра.
//
// Снимки — test/fixtures/raw/fp/ (чужие страницы, в git не попадают):
//   node test-fp.mjs --capture [--only id]   снять (сеть; Яндекс и Авито
//                                            в наборе нет)
//   node test-fp.mjs [--only id]             проверить снимки (без сети)

import { chromium } from 'playwright';
import { browserOptions } from './browser.mjs';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DEV, '..');
// FP_EXT — другая папка сборки (когда build/extension пересобирают тесты).
const EXT = process.env.FP_EXT || path.join(ROOT, 'build', 'extension');
const DIR = path.join(ROOT, 'test', 'fixtures', 'raw', 'fp');
const corpus = JSON.parse(await fs.readFile(path.join(ROOT, 'test', 'fp-corpus.json'), 'utf8')).pages;
const oi = process.argv.indexOf('--only');
const only = oi === -1 ? null : process.argv[oi + 1];
const pages = corpus.filter(p => !only || p.id === only);
const LOST_TEXT = 200;
const SETTLE_MS = 3000;
const VIEWPORT = { width: 1600, height: 900 };

/* ---------- съёмка ---------- */

// Первая ссылка на статью: тот же сайт, длинный текст ссылки, путь из
// нескольких частей или с числом.
function pickArticle() {
    const host = location.hostname.replace(/^www\./, '');
    const links = [...document.querySelectorAll('a[href]')].filter(a => {
        const r = a.getBoundingClientRect();
        if (r.width < 40 || r.height < 10 || !a.checkVisibility()) return false;
        let u;
        try { u = new URL(a.href); } catch { return false; }
        const text = (a.innerText || '').replace(/\s+/g, ' ').trim();
        const parts = u.pathname.split('/').filter(Boolean);
        return u.hostname.replace(/^www\./, '').endsWith(host) && text.length >= 30 && (parts.length >= 2 || /\d{3,}/.test(u.pathname));
    });
    return links.length ? links[0].href : null;
}

async function capture() {
    await fs.mkdir(DIR, { recursive: true });
    const browser = await chromium.launch({ ...browserOptions(), headless: true, args: ['--lang=ru'] });
    const index = existsSync(path.join(DIR, 'index.json')) ? JSON.parse(await fs.readFile(path.join(DIR, 'index.json'), 'utf8')) : {};
    for (const p of pages) {
        const context = await browser.newContext({ viewport: VIEWPORT, locale: 'ru-RU' });
        const page = await context.newPage();
        try {
            await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForTimeout(4000);
            if (p.pick === 'article') {
                const href = await page.evaluate(pickArticle);
                if (!href) throw new Error('нет ссылки на статью');
                await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 });
                await page.waitForTimeout(4000);
            }
            // Прокрутка — чтобы догрузилось ленивое содержимое.
            await page.evaluate(async () => { for (let y = 0; y < 3; y += 1) { scrollBy(0, innerHeight); await new Promise(r => setTimeout(r, 600)); } scrollTo(0, 0); });
            await page.waitForTimeout(1000);
            const text = await page.evaluate(() => (document.body.innerText || '').length);
            if (text < 500) throw new Error(`мало текста (${text}) — капча или заглушка`);
            const session = await context.newCDPSession(page);
            const { data } = await session.send('Page.captureSnapshot', { format: 'mhtml' });
            const mhtml = path.join(DIR, p.id + '.mhtml');
            await fs.writeFile(mhtml, data);
            execFileSync(process.execPath, [path.join(DEV, 'snapshot-to-html.mjs'), mhtml, path.join(DIR, p.id + '.html')], { stdio: 'ignore' });
            await fs.rm(mhtml);
            index[p.id] = { url: page.url(), captured: new Date().toISOString(), text };
            console.log(`СНЯТО ${p.id}: ${page.url()}`);
        } catch (error) {
            console.log(`НЕ СНЯТО ${p.id}: ${String(error.message || error).split('\n')[0]}`);
        } finally {
            await context.close();
        }
        await fs.writeFile(path.join(DIR, 'index.json'), JSON.stringify(index, null, 1));
    }
    await browser.close();
}

/* ---------- проверка ---------- */

// В странице: запомнить невидимые сейчас узлы с текстом (механизм работает).
function rememberHidden() {
    window.__fpHidden = [...document.body.querySelectorAll('*')].filter(el => !el.checkVisibility() && (el.textContent || '').trim().length > 0);
}

// После выключения механизма: что из запомненного стало видно — прятали мы.
// Только верхние узлы, текст — как его видно сейчас. Для каждого:
// содержит ли главный текст страницы (блок с наибольшей прозой — абзацы от
// 80 знаков, как режим чтения) и есть ли в нём признаки рекламы, которые
// сайт пишет для человека (метка, маркировка, «спонсор», фрейм).
function lostByUs() {
    const back = window.__fpHidden.filter(el => el.isConnected && el.checkVisibility());
    const top = back.filter(el => !back.some(other => other !== el && other.contains(el)));
    const prose = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (parent && !parent.closest('script, style') && node.nodeValue.trim().length >= 80 && parent.checkVisibility()) {
            const box = parent.parentElement || parent;
            prose.set(box, (prose.get(box) || 0) + node.nodeValue.trim().length);
        }
    }
    let main = null;
    for (const [box, total] of prose) if (!main || total > prose.get(main)) main = box;
    const AD_TEXT = /реклам|рекламодател|erid|спонсор|sponsor|партн[её]рск|advertis/i;
    return top.map(el => {
        const r = el.getBoundingClientRect();
        return {
            containsMain: Boolean(main && el.contains(main)),
            adLike: AD_TEXT.test(el.innerText || '') || Boolean(el.querySelector('iframe')),
            tag: el.localName,
            name: [el.id ? '#' + el.id : '', typeof el.className === 'string' ? el.className : ''].join(' ').trim().slice(0, 100),
            size: `${Math.round(r.width)}x${Math.round(r.height)}`,
            text: (el.innerText || '').replace(/\s+/g, ' ').trim().length,
            sample: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80)
        };
    });
}

async function check() {
    const index = existsSync(path.join(DIR, 'index.json')) ? JSON.parse(await fs.readFile(path.join(DIR, 'index.json'), 'utf8')) : {};
    const list = pages.filter(p => index[p.id] && existsSync(path.join(DIR, p.id + '.html')));
    if (!list.length) {
        console.log('Снимков нет: node test-fp.mjs --capture');
        return 0;
    }
    const bodies = new Map();
    for (const p of list) bodies.set(index[p.id].url, await fs.readFile(path.join(DIR, p.id + '.html'), 'utf8'));

    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ygab-fp-'));
    const context = await chromium.launchPersistentContext(profile, {
        ...browserOptions(), headless: true,
        args: ['--lang=ru', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
    });
    let failures = 0;
    const results = {};
    try {
        const isWelcome = p => p.url().endsWith('/ygab/platform/welcome/welcome.html');
        const welcome = context.pages().find(isWelcome) || await context.waitForEvent('page', { predicate: isWelcome, timeout: 15000 }).catch(() => null);
        if (welcome) await welcome.waitForFunction(() => document.getElementById('setup').dataset.state, null, { timeout: 20000 }).catch(() => {});
        const isOurs = w => w.url().endsWith('/ygab/background.js');
        const worker = context.serviceWorkers().find(isOurs) || await context.waitForEvent('serviceworker', { predicate: isOurs, timeout: 10000 });
        await context.route('**/*', route => {
            const url = route.request().url();
            if (url.startsWith('chrome-extension://')) return route.continue();
            return bodies.has(url) ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: bodies.get(url) }) : route.abort();
        });
        for (const p of list) {
            const url = index[p.id].url;
            const host = new URL(url).hostname.replace(/^www\./, '');
            await worker.evaluate(() => chrome.storage.local.set({ 'ygab.offSites': [] }));
            const tab = await context.newPage();
            await tab.setViewportSize(VIEWPORT);
            try {
                await tab.goto(url, { waitUntil: 'load', timeout: 60000 });
                await tab.waitForTimeout(SETTLE_MS);
                const report = await worker.evaluate(async u => {
                    const t = (await chrome.tabs.query({})).find(x => x.url === u);
                    return t ? chrome.tabs.sendMessage(t.id, { action: 'getGenericReport' }, { frameId: 0 }).catch(() => null) : null;
                }, url);
                await tab.evaluate(rememberHidden);
                // Только наш слой: запись в списке выключенных сайтов без
                // смены режима движка — механизм откатывается на лету.
                await worker.evaluate(h => chrome.storage.local.set({ 'ygab.offSites': [h] }), host);
                await tab.waitForTimeout(1500);
                const lost = await tab.evaluate(lostByUs);
                const bad = lost.filter(b => b.containsMain || (b.text >= LOST_TEXT && !b.adLike));
                failures += bad.length ? 1 : 0;
                const items = ((report && report.items) || []).map(i => `${i.reason} ${i.score} [${i.signals}] ${i.tag}.${i.name || ''} ${i.size}`);
                results[p.id] = { url, lost, items };
                console.log(`${bad.length ? 'СБОЙ' : 'ОК  '} ${p.id}: спрятано нами ${items.length}, пропало текста ${lost.reduce((s, b) => s + b.text, 0)} знаков`);
                for (const b of lost) console.log(`       ${bad.includes(b) ? '!!' : b.adLike ? 'Р ' : '  '} ${b.tag}.${b.name} ${b.size} текст ${b.text}${b.containsMain ? ' ГЛАВНЫЙ ТЕКСТ' : ''} «${b.sample}»`);
            } catch (error) {
                console.log(`ПРОПУСК ${p.id}: ${String(error.message || error).split('\n')[0]}`);
            } finally {
                await tab.close();
            }
        }
    } finally {
        await context.close();
    }
    await fs.writeFile(path.join(DIR, 'results.json'), JSON.stringify(results, null, 1));
    console.log(`\nСтраниц: ${Object.keys(results).length}, с потерей содержимого: ${failures}`);
    return failures;
}

if (process.argv.includes('--capture')) {
    await capture();
} else {
    process.exit(await check() ? 1 : 0);
}
