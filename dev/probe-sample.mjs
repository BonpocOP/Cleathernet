// Прогон присланного фрагмента разметки через сборку: что спрятано, что
// осталось и почему. Для разбора отчётов (навык triage-report): фрагмент
// (outerHTML блока) отдаётся по настоящему адресу сайта без сети, как в
// test-generic, — так срабатывают и правила движка для этого сайта.
// Скрипты из фрагмента вырезаются; без стилей сайта размеры не настоящие.
//
//   node probe-sample.mjs --url <адрес> --file <фрагмент.html> [--check <селектор>]... [--headed]

import { chromium } from 'playwright';
import { browserOptions } from './browser.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(DEV, '..', 'build', 'extension');
const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const checks = args.flatMap((a, i) => (a === '--check' ? [args[i + 1]] : []));
const url = arg('--url');
const file = arg('--file');
if (!url || !file) {
    console.log('node probe-sample.mjs --url <адрес> --file <фрагмент.html> [--check <селектор>]...');
    process.exit(1);
}

const fragment = (await fs.readFile(file, 'utf8')).replace(/<script\b[\s\S]*?<\/script>/gi, '');
const body = /<html[\s>]/i.test(fragment) ? fragment
    : `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Образец</title></head><body>${fragment}</body></html>`;

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ygab-probe-'));
const context = await chromium.launchPersistentContext(profile, {
    ...browserOptions(),
    headless: !args.includes('--headed'),
    viewport: { width: 1600, height: 900 },
    args: ['--lang=ru', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
});
try {
    const isWelcome = p => p.url().endsWith('/ygab/platform/welcome/welcome.html');
    const welcome = context.pages().find(isWelcome) || await context.waitForEvent('page', { predicate: isWelcome, timeout: 15000 }).catch(() => null);
    if (welcome) await welcome.waitForFunction(() => document.getElementById('setup').dataset.state, null, { timeout: 20000 }).catch(() => {});
    await context.route('**/*', route => {
        const u = route.request().url();
        if (u.startsWith('chrome-extension://')) return route.continue();
        return u === url ? route.fulfill({ contentType: 'text/html; charset=utf-8', body }) : route.abort();
    });
    // Движок применяет правила сайта со второго захода — открываем дважды.
    for (let i = 0; i < 2; i += 1) {
        const tab = await context.newPage();
        await tab.goto(url, { waitUntil: 'load' });
        await tab.waitForTimeout(2500);
        if (i === 0) { await tab.close(); continue; }
        const worker = context.serviceWorkers().find(w => w.url().endsWith('/ygab/background.js'));
        const report = await worker.evaluate(async u => {
            const tabs = await chrome.tabs.query({});
            const t = tabs.find(x => x.url === u);
            return chrome.tabs.sendMessage(t.id, { action: 'getGenericReport' }, { frameId: 0 }).catch(e => ({ error: String(e) }));
        }, url);
        console.log('Спрятано нами:', JSON.stringify(report.items, null, 1));
        console.log('Осталось похожего на рекламу:', JSON.stringify(report.leftovers && report.leftovers.items.map(x => ({ kinds: x.kinds, text: x.text, slot: x.slot })), null, 1));
        for (const sel of checks) {
            const seen = await tab.evaluate(s => [...document.querySelectorAll(s)].map(el => el.checkVisibility() && el.getBoundingClientRect().height > 0), sel);
            console.log(`${sel}: ${seen.length ? seen.map(v => (v ? 'виден' : 'спрятан')).join(', ') : 'нет на странице'}`);
        }
        await tab.close();
    }
} finally {
    await context.close();
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
