// Замер: сколько стоит общий механизм на больших страницах (снимки Авито
// из test/fixtures/raw/pages). Каждая страница открывается со сборкой
// Cleathernet дважды: общий механизм выключен на сайте и включён —
// разница во времени скриптов и есть наша цена. Движок работает в обоих.
//
//   node perf-generic.mjs
import { chromium } from 'playwright';
import { browserOptions } from './browser.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const EXT = path.resolve('../build/extension');
const pages = [
    ['https://www.avito.ru/moskva/kvartiry/prodam', '../test/fixtures/raw/pages/avito.ru_moskva-kvartiry-prodam.html'],
    ['https://www.avito.ru/', '../test/fixtures/raw/pages/avito.ru.html']
];
const bodies = Object.fromEntries(await Promise.all(pages.map(async ([u, f]) => [u, await fs.readFile(f, 'utf8')])));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ygab-perf-'));
const context = await chromium.launchPersistentContext(profile, { ...browserOptions(), headless: true, args: ['--lang=ru', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT] });
await context.route('**/*', r => bodies[r.request().url()] ? r.fulfill({ contentType: 'text/html; charset=utf-8', body: bodies[r.request().url()] }) : r.abort());
await context.addInitScript(() => {
    window.__long = [];
    new PerformanceObserver(list => list.getEntries().forEach(e => window.__long.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: true });
});
const isOurs = w => w.url().endsWith('/ygab/background.js');
const worker = context.serviceWorkers().find(isOurs) || await context.waitForEvent('serviceworker', { predicate: isOurs });
await new Promise(r => setTimeout(r, 4000));
for (const [url] of pages) {
    for (const off of [true, false, true, false]) {
        await worker.evaluate(list => chrome.storage.local.set({ 'ygab.offSites': list }), off ? ['avito.ru'] : []);
        const tab = await context.newPage();
        await tab.setViewportSize({ width: 1600, height: 900 });
        const cdp = await context.newCDPSession(tab);
        await cdp.send('Performance.enable');
        await tab.goto(url, { waitUntil: 'load' });
        await tab.waitForTimeout(6000);
        const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
        const long = await tab.evaluate(() => window.__long);
        console.log(url.slice(8, 50).padEnd(42), off ? 'мы выкл' : 'мы вкл ', 'скрипты', Math.round(m.ScriptDuration * 1000), 'мс; вёрстка', Math.round(m.LayoutDuration * 1000), 'мс; стили', Math.round(m.RecalcStyleDuration * 1000), 'мс; долгие задачи', JSON.stringify(long));
        await tab.close();
    }
}
await context.close();
