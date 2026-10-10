// Замер: ускоряют ли страницы дополнительные наборы движка (шаг 2 плана
// рефакторинга, 09.10). Решаем по нему, что включать по умолчанию.
//
// Несколько браузеров со сборкой Cleathernet (build/extension): первый —
// наши настройки как есть, в каждом следующем включён ещё один набор.
// Каждый сайт открывается во всех браузерах одновременно (колебания сети
// для всех одни и те же), кэш выключен, несколько проходов, медиана.
//
// Окно замера — до load плюс SETTLE_MS (реклама и счётчики догружаются
// после load), но не меньше MIN_WINDOW_MS и не больше MAX_WINDOW_MS от
// начала навигации. Из Великобритании русские сайты грузятся по 30–45 с:
// пробный прогон 09.10 с окном 15 с ловил недогруженные страницы, и
// разница между браузерами была от сети, а не от наборов. Меряем:
//   * запросы: сколько ушло в сеть, сколько заблокировано, килобайты;
//   * время скриптов страницы (Performance.getMetrics: ScriptDuration) и
//     всех задач главного потока (TaskDuration) — это и есть «тормозит»;
//   * время до load и TBT (длинные задачи сверх 50 мс);
//   * признаки поломки: ошибки страницы и сколько видимого текста.
// Проход, где страница так и не показала текст (меньше MIN_TEXT
// символов), не считается — как и проход с капчей.
//
// Яндекс и Авито автоматическим браузером не открываем; сайты с geo: ru —
// только с российского IP (--geo-ru), иначе их реклама и счётчики другие.
//
//   node perf-rulesets.mjs [--runs 3] [--limit N] [--only <часть адреса>] [--geo-ru]

import { chromium } from 'playwright';
import { browserOptions } from './browser.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DEV, '..');
const EXT = path.join(ROOT, 'build', 'extension');
const OUT_DIR = path.join(ROOT, 'docs', 'research');

const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? fallback : process.argv[i + 1];
};
const RUNS = Number(arg('--runs', 3));
const LIMIT = Number(arg('--limit', 0));
const ONLY = arg('--only', null);
const GEO_RU = process.argv.includes('--geo-ru');
const MIN_WINDOW_MS = 15000;
const MAX_WINDOW_MS = 45000;
const SETTLE_MS = 3000;
const NAV_TIMEOUT = 30000;
const MIN_TEXT = 200;
// Проверка «вы робот?» вместо сайта — такой проход не считаем.
const CAPTCHA = /проверк|captcha|robot|робот|access denied|доступ ограничен/i;

// Конфигурации: что включено сверх наших настроек по умолчанию.
const CONFIGS = [
    { id: 'base', name: 'как сейчас', add: [] },
    { id: 'rus-1', name: 'RU AdList: Counters (счётчики)', add: ['rus-1'] },
    { id: 'adguard-spyware-url', name: 'URL Tracking Protection (чистые ссылки)', add: ['adguard-spyware-url'] },
    { id: 'annoyances-widgets', name: 'Chat Widgets (чаты)', add: ['annoyances-widgets'] },
    { id: 'annoyances-notifications', name: 'Notifications (запросы уведомлений)', add: ['annoyances-notifications'] }
];

const corpus = JSON.parse(await fs.readFile(path.join(ROOT, 'test', 'corpus.json'), 'utf8'));
let sites = corpus.sites
    .filter(s => !/(^|\.)(yandex\.ru|ya\.ru|avito\.ru)$/.test(new URL(s.url).hostname))
    .filter(s => GEO_RU || s.geo !== 'ru')
    .filter(s => !ONLY || s.url.includes(ONLY));
if (LIMIT) sites = sites.slice(0, LIMIT);

const median = list => {
    const sorted = list.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Длинные задачи — с самого начала загрузки.
const longTaskProbe = () => {
    window.__longTasks = [];
    try {
        new PerformanceObserver(list => {
            for (const entry of list.getEntries()) window.__longTasks.push(entry.duration);
        }).observe({ type: 'longtask', buffered: true });
    } catch { /* нет поддержки — TBT не посчитаем */ }
};

async function launch(config) {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ygab-perfrs-'));
    const context = await chromium.launchPersistentContext(profile, {
        ...browserOptions(),
        headless: true,
        viewport: { width: 1600, height: 900 },
        locale: 'ru-RU',
        args: ['--lang=ru', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
    });
    // Первый запуск: страница приветствия настраивает движок.
    const isWelcome = p => p.url().endsWith('/ygab/platform/welcome/welcome.html');
    const welcome = context.pages().find(isWelcome) || await context.waitForEvent('page', { predicate: isWelcome, timeout: 20000 });
    await welcome.waitForFunction(() => document.getElementById('setup').dataset.state, null, { timeout: 30000 });
    const setupState = await welcome.evaluate(() => document.getElementById('setup').dataset.state);
    if (setupState !== 'ok') throw new Error(`${config.id}: первый запуск не настроил движок (${setupState})`);
    // Наборы меняем так же, как страница настроек: сообщением движку.
    const rulesets = await welcome.evaluate(async add => {
        const enabled = await chrome.runtime.sendMessage({ what: 'getEnabledRulesets' });
        const wanted = [...new Set(enabled.concat(add))];
        if (wanted.length !== enabled.length) {
            await chrome.runtime.sendMessage({ what: 'applyRulesets', enabledRulesets: wanted });
        }
        return chrome.runtime.sendMessage({ what: 'getEnabledRulesets' });
    }, config.add);
    for (const id of config.add) {
        if (!rulesets.includes(id)) throw new Error(`${config.id}: набор ${id} не включился`);
    }
    await welcome.close();
    return { ...config, context, profile, rulesets };
}

async function measure(browser, url) {
    const page = await browser.context.newPage();
    const cdp = await browser.context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Performance.enable');
    await page.addInitScript(longTaskProbe);
    const net = { sent: 0, blocked: 0, failed: 0, bytes: 0 };
    cdp.on('Network.requestWillBeSent', () => { net.sent += 1; });
    cdp.on('Network.loadingFinished', e => { net.bytes += e.encodedDataLength || 0; });
    cdp.on('Network.loadingFailed', e => {
        if (e.blockedReason || /BLOCKED_BY_CLIENT/.test(e.errorText || '')) net.blocked += 1;
        else net.failed += 1;
    });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message || e).slice(0, 120)));
    const out = { ok: true };
    const t0 = Date.now();
    try {
        await page.goto(url, { waitUntil: 'commit', timeout: NAV_TIMEOUT });
    } catch (e) {
        out.ok = false;
        out.error = String(e.message || e).split('\n')[0].slice(0, 120);
    }
    const left = () => Math.max(0, MAX_WINDOW_MS - (Date.now() - t0));
    if (out.ok) {
        await page.waitForLoadState('load', { timeout: left() }).catch(() => { /* load не наступил — меряем по потолку */ });
    }
    await page.waitForTimeout(Math.min(left(), Math.max(SETTLE_MS, MIN_WINDOW_MS - (Date.now() - t0))));
    out.windowMs = Date.now() - t0;
    try {
        const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
        const page_ = await page.evaluate(() => {
            const nav = performance.getEntriesByType('navigation')[0];
            const tasks = window.__longTasks || [];
            return {
                load: nav && nav.loadEventEnd ? Math.round(nav.loadEventEnd) : null,
                dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
                tbt: Math.round(tasks.reduce((sum, d) => sum + Math.max(0, d - 50), 0)),
                text: (document.body && document.body.innerText || '').length,
                title: document.title.slice(0, 60)
            };
        });
        Object.assign(out, page_, {
            requests: net.sent - net.blocked,
            blocked: net.blocked,
            failed: net.failed,
            kb: Math.round(net.bytes / 1024),
            scriptMs: Math.round(metrics.ScriptDuration * 1000),
            taskMs: Math.round(metrics.TaskDuration * 1000),
            errors: errors.length,
            errorSamples: errors.slice(0, 3)
        });
        if (CAPTCHA.test(out.title) && out.text < 2000) {
            out.ok = false;
            out.error = 'капча: ' + out.title;
        } else if (out.text < MIN_TEXT) {
            out.ok = false;
            out.error = `страница не показала текст (${out.text} симв.)`;
        }
    } catch (e) {
        out.ok = false;
        out.error = out.error || String(e.message || e).split('\n')[0].slice(0, 120);
    }
    await page.close().catch(() => {});
    return out;
}

const started = Date.now();
console.log(`Сайтов: ${sites.length}, проходов: ${RUNS}, конфигураций: ${CONFIGS.length}`);
const browsers = [];
for (const config of CONFIGS) {
    browsers.push(await launch(config));
    console.log(`  запущен: ${config.name}`);
}
console.log(`  наборы «как сейчас»: ${browsers[0].rulesets.join(', ')}`);

const raw = {};
try {
    for (const [index, site] of sites.entries()) {
        raw[site.url] = Object.fromEntries(CONFIGS.map(c => [c.id, []]));
        for (let run = 0; run < RUNS; run += 1) {
            const results = await Promise.all(browsers.map(browser => measure(browser, site.url)));
            browsers.forEach((browser, i) => raw[site.url][browser.id].push(results[i]));
        }
        const base = median(raw[site.url].base.map(r => r.scriptMs));
        const minutes = Math.round((Date.now() - started) / 60000);
        console.log(`[${index + 1}/${sites.length}, ${minutes} мин] ${site.url}: скрипты ${base} мс, ` +
            CONFIGS.slice(1).map(c => `${c.id} ${median(raw[site.url][c.id].map(r => r.scriptMs))}`).join(', '));
        // Промежуточный результат — на случай обрыва.
        await fs.writeFile(path.join(OUT_DIR, 'perf-rulesets.raw.json'), JSON.stringify({ date: new Date().toISOString(), runs: RUNS, window: { minMs: MIN_WINDOW_MS, maxMs: MAX_WINDOW_MS, settleMs: SETTLE_MS }, configs: CONFIGS, baseRulesets: browsers[0].rulesets, raw }, null, 2));
    }
} finally {
    for (const browser of browsers) {
        await browser.context.close().catch(() => {});
        await fs.rm(browser.profile, { recursive: true, force: true }).catch(() => {});
    }
}

// ---------- сводка ----------
// По каждому сайту — медианы проходов; разница с «как сейчас» в процентах.
// По набору — медиана и среднее разниц по сайтам, где обе стороны
// открылись, плюс на скольких сайтах набор вообще что-то заблокировал.
const METRICS = ['requests', 'kb', 'scriptMs', 'taskMs', 'tbt', 'load', 'windowMs'];
const perSite = {};
for (const [url, byConfig] of Object.entries(raw)) {
    perSite[url] = {};
    for (const [id, runs] of Object.entries(byConfig)) {
        const good = runs.filter(r => r.ok);
        perSite[url][id] = {
            opened: good.length,
            ...Object.fromEntries([...METRICS, 'blocked', 'text', 'errors'].map(m => [m, median(good.map(r => r[m]))]))
        };
    }
}

const pct = (value, base) => (base ? (value - base) / base * 100 : null);
const summary = {};
for (const config of CONFIGS.slice(1)) {
    const rows = [];
    for (const [url, byConfig] of Object.entries(perSite)) {
        const b = byConfig.base;
        const c = byConfig[config.id];
        if (!b.opened || !c.opened) continue;
        rows.push({
            url,
            extraBlocked: (c.blocked || 0) - (b.blocked || 0),
            ...Object.fromEntries(METRICS.map(m => [m, pct(c[m], b[m])])),
            textLoss: b.text ? (b.text - c.text) / b.text * 100 : 0,
            extraErrors: (c.errors || 0) - (b.errors || 0)
        });
    }
    const avg = list => {
        const ok = list.filter(v => typeof v === 'number' && Number.isFinite(v));
        return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
    };
    summary[config.id] = {
        name: config.name,
        sites: rows.length,
        sitesWithEffect: rows.filter(r => r.extraBlocked > 0).length,
        ...Object.fromEntries(METRICS.map(m => [m, { median: median(rows.map(r => r[m])), mean: avg(rows.map(r => r[m])) }])),
        // Подозрения на поломку: текста стало заметно меньше или новые ошибки.
        suspicious: rows.filter(r => r.textLoss > 15 || r.extraErrors > 0).map(r => ({ url: r.url, textLoss: Math.round(r.textLoss), extraErrors: r.extraErrors })),
        topEffect: rows.filter(r => r.extraBlocked > 0).sort((a, b) => b.extraBlocked - a.extraBlocked).slice(0, 8)
            .map(r => ({ url: r.url, extraBlocked: r.extraBlocked, scriptMs: r.scriptMs === null ? null : Math.round(r.scriptMs), kb: r.kb === null ? null : Math.round(r.kb) }))
    };
}

await fs.writeFile(path.join(OUT_DIR, 'perf-rulesets.json'), JSON.stringify({ date: new Date().toISOString(), runs: RUNS, window: { minMs: MIN_WINDOW_MS, maxMs: MAX_WINDOW_MS, settleMs: SETTLE_MS }, baseRulesets: browsers[0].rulesets, summary, perSite }, null, 2));

const f = v => (v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + v.toFixed(1) + '%');
console.log('\nИзменение относительно «как сейчас» (медиана по сайтам / среднее):');
for (const [id, s] of Object.entries(summary)) {
    console.log(`\n${s.name}: сайтов ${s.sites}, набор что-то заблокировал на ${s.sitesWithEffect}`);
    for (const m of METRICS) console.log(`  ${m.padEnd(9)} ${f(s[m].median).padStart(8)} / ${f(s[m].mean).padStart(8)}`);
    if (s.suspicious.length) console.log('  подозрения на поломку:', JSON.stringify(s.suspicious));
    if (s.topEffect.length) console.log('  где сильнее всего:', JSON.stringify(s.topEffect.slice(0, 5)));
}
console.log(`\nГотово за ${Math.round((Date.now() - started) / 60000)} мин. Сохранено: docs/research/perf-rulesets.json`);
