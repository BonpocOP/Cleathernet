// Профиль общего механизма на снимке страницы: какие наши функции сколько
// стоят (собственное время, мс). Для поиска дорогого в проходах.
//
//   node profile-generic.mjs [--url <адрес> --file <снимок.html>]

import { chromium } from 'playwright';
import { browserOptions } from './browser.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const url = arg('--url', 'https://www.avito.ru/moskva/kvartiry/prodam');
const file = arg('--file', '../test/fixtures/raw/pages/avito.ru_moskva-kvartiry-prodam.html');
const EXT = path.resolve('../build/extension');
const body = await fs.readFile(file, 'utf8');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ygab-prof-'));
const context = await chromium.launchPersistentContext(profile, { ...browserOptions(), headless: true, args: ['--lang=ru', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT] });
try {
    await context.route('**/*', r => (r.request().url() === url ? r.fulfill({ contentType: 'text/html; charset=utf-8', body }) : r.abort()));
    const isOurs = w => w.url().endsWith('/ygab/background.js');
    context.serviceWorkers().find(isOurs) || await context.waitForEvent('serviceworker', { predicate: isOurs });
    await new Promise(r => setTimeout(r, 4000));
    const tab = await context.newPage();
    await tab.setViewportSize({ width: 1600, height: 900 });
    const cdp = await context.newCDPSession(tab);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    await cdp.send('Profiler.start');
    await tab.goto(url, { waitUntil: 'load' });
    await tab.waitForTimeout(6000);
    const { profile: prof } = await cdp.send('Profiler.stop');
    const byId = new Map(prof.nodes.map(n => [n.id, n]));
    const self = new Map();
    const dt = prof.timeDeltas;
    prof.samples.forEach((id, i) => {
        const n = byId.get(id);
        const f = n.callFrame;
        const key = (f.url.includes('generic.js') ? 'НАШ ' : f.url ? 'стр. ' : '     ') + (f.functionName || '(анонимная)') + (f.url.includes('generic.js') ? ':' + f.lineNumber : '');
        self.set(key, (self.get(key) || 0) + (dt[i] || 0) / 1000);
    });
    const ours = [...self].filter(([k]) => k.startsWith('НАШ'));
    console.log('Наше, всего мс:', Math.round(ours.reduce((s, [, v]) => s + v, 0)));
    for (const [k, v] of ours.sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(v.toFixed(1).padStart(7), k);
    console.log('Прочее (верх):');
    for (const [k, v] of [...self].filter(([k]) => !k.startsWith('НАШ')).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(v.toFixed(1).padStart(7), k);
} finally {
    await context.close();
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
