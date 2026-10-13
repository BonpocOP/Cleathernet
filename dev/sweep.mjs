// Обход сайтов с рекламой (test/ad-sites.json): каждый сайт — со сборкой
// Cleathernet и без неё. Ищем то, что человек увидел бы глазами:
//   - осталась метка «Реклама» / «Промо» / «Advertisement»;
//   - виден чужой фрейм (баннер другого сайта);
//   - пустое место размера рекламного блока (рамка без содержимого);
//   - дыра над закреплённым элементом (меню «повисло» — klerk, 12.10:
//     спрятали прилипающую полосу, от высоты которой зависит шапка);
//   - пропал текст (сравнение со страницей без расширения);
//   - наш отчёт: «похожее на рекламу осталось».
// Если нашлось — сохраняем скриншоты (с нами / без нас), отчёт расширения
// и находки; если чисто — одну строку в итоге. Итог — index.html в папке
// обхода: открыть в браузере и листать.
//
// Заодно — скорость на тех же заходах (13.10): запросы, трафик, загрузка и
// время скриптов с нами и без; кэш выключен в обоих браузерах, иначе
// прогревочный заход давал бы нам фору. --ab <набор,набор> — третий
// браузер со сборкой и этими наборами движка сверх наших (например
// rus-1,adguard-spyware-url): что они блокируют сверх нашего и не пропал
// ли текст — решение «включать ли по умолчанию» на сайтах с рекламой.
//
// Папка обхода — test/fixtures/raw/sweep/<дата>: страницы российских
// сайтов не наши — в git не попадают (хук pre-commit).
// Яндекс, Авито и сервисы Яндекса не открываем (решение пользователя).
//
//   node sweep.mjs [--only <часть адреса>] [--limit N] [--no-deep] [--shots] [--headed]
//                  [--resume <папка> | --continue] [--open] [--ab <набор,набор>]
//   --continue — продолжить последний незаконченный обход; --open — открыть
//               итог в браузере (так запускает sweep.bat).
//   --no-deep — только главные страницы (по умолчанию ещё одна статья
//               сайта: рекламы в статьях больше).

import { chromium } from 'playwright';
import { browserOptions } from './browser.mjs';
import fs from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DEV, '..');
const EXT = path.join(ROOT, 'build', 'extension');
const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const ONLY = arg('--only');
const LIMIT = Number(arg('--limit')) || 0;
const DEEP = !args.includes('--no-deep');
const HEADED = args.includes('--headed');
const RESUME = arg('--resume');
// Скриншоты и у чистых сайтов — посмотреть глазами.
const ALL_SHOTS = args.includes('--shots');
const AB = arg('--ab') ? arg('--ab').split(',').filter(Boolean) : [];

const FORBIDDEN = /(^|\.)(yandex\.[a-z]+|ya\.ru|avito\.[a-z]+|kinopoisk\.ru|auto\.ru)$/i;
const NAV_TIMEOUT = 30000;
const SETTLE_MS = 3500;
const STEP_TIMEOUT = 15000;
const VIEWPORT = { width: 1600, height: 900 };
// Потеря текста, о которой стоит сказать: живые ленты меняются между
// заходами — мелкие расхождения шум.
const TEXT_LOSS_SHARE = 0.15;
const TEXT_LOSS_MIN = 400;

const now = new Date();
const pad = n => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
const SWEEPS = path.join(ROOT, 'test', 'fixtures', 'raw', 'sweep');
// --continue — последняя папка обхода, если он не дошёл до конца (батник
// запускают снова после обрыва).
async function unfinished() {
    const names = existsSync(SWEEPS) ? (await fs.readdir(SWEEPS)).sort().reverse() : [];
    const last = names.find(name => existsSync(path.join(SWEEPS, name, 'results.json')));
    return last && !existsSync(path.join(SWEEPS, last, 'done.txt')) ? path.join(SWEEPS, last) : null;
}
const OUT = RESUME ? path.resolve(RESUME) : (args.includes('--continue') && await unfinished()) || path.join(SWEEPS, stamp);
await fs.mkdir(OUT, { recursive: true });

const corpus = JSON.parse(await fs.readFile(path.join(ROOT, 'test', 'ad-sites.json'), 'utf8'));
let sites = corpus.sites.filter(s => !FORBIDDEN.test(new URL(s.url).hostname)).filter(s => !ONLY || s.url.includes(ONLY));
if (LIMIT) sites = sites.slice(0, LIMIT);

const withTimeout = (promise, ms, what) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: дольше ${ms / 1000} с`)), ms))
]);

if (!existsSync(path.join(EXT, 'manifest.json'))) {
    console.log('Нет сборки build/extension — сначала node build.mjs && node build-extension.mjs');
    process.exit(1);
}

/* ---------- что видно на странице (выполняется в странице) ---------- */

function probe() {
    const vw = innerWidth;
    const vh = innerHeight;
    const visible = el => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.left > vw) return null;
        return el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) ? r : null;
    };
    const box = r => ({ x: Math.round(r.left), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) });
    const describe = el => (el.localName + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '')).slice(0, 120);

    // Метки: узел, весь текст которого — слово-метка.
    const LABEL = /^(реклама|промо|спонсор(ский)?( материал)?|партн[её]рский материал|advertisement|sponsored|ad|ads|реклама\s*16\+|реклама\s*0\+)$/i;
    const labels = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && labels.length < 30; node = walker.nextNode()) {
        const text = node.nodeValue.replace(/\s+/g, ' ').trim();
        if (!text || text.length > 30 || !LABEL.test(text)) continue;
        const el = node.parentElement;
        // Пункт меню или подвала «Реклама» (ссылка на свой сайт) — не метка.
        if (!el || el.closest('nav, footer, [role="navigation"], [class*="footer" i], [id*="footer" i]')) continue;
        const link = el.closest('a[href]');
        // Свой сайт — с поддоменами (pikabu: пункт меню «Реклама»).
        const siteOf = host => host.replace(/^www\./, '').split('.').slice(-2).join('.');
        if (link && siteOf(link.hostname) === siteOf(location.hostname) && !/click|_sttc|redirect|away/i.test(link.href)) continue;
        // «Реклама на сайте» — ссылка на страницу для рекламодателей (бывает
        // и на домене владельца: ria → россиясегодня.рф/advertising).
        if (link && /advert|reklam|reclam|media-?kit|for-advertisers/i.test(link.pathname)) continue;
        const r = visible(el);
        if (r && r.top + scrollY < 6000) labels.push({ text, at: box(r), el: describe(el) });
    }

    // Чужие фреймы заметного размера.
    const EMBED = /youtube|rutube|vimeo|player|video_ext|vkvideo\.ru|ok\.ru\/videoembed|google\.com\/maps|recaptcha|captcha|turnstile|challenges\.cloudflare|\/widget_(community|comments|post|like|auth|poll)|comments\.|disqus|t\.me\/|telegram|facebook\.com\/plugins|platform\.twitter|instagram\.com\/p\//i;
    const frames = [];
    for (const f of document.querySelectorAll('iframe')) {
        const r = visible(f);
        if (!r || r.width < 100 || r.height < 50) continue;
        let host = '';
        try { host = f.src ? new URL(f.src, location.href).hostname : ''; } catch { /* битый адрес */ }
        const own = host && (host === location.hostname || host.endsWith('.' + location.hostname.replace(/^www\./, '')));
        // Встроенное, а не реклама: плееры, карты, капчи, виджеты и
        // комментарии соцсетей и порталов.
        if (own || EMBED.test(f.src || '')) continue;
        frames.push({ src: (f.src || '(без адреса)').slice(0, 120), at: box(r) });
    }

    // Пустые места размера рекламного блока: ни текста, ни картинок, ни фрейма.
    const SIZES = [[728, 90], [970, 90], [970, 250], [300, 250], [336, 280], [300, 600], [160, 600], [240, 400], [320, 100], [320, 50], [468, 60], [1000, 120], [1000, 90], [640, 200]];
    const adSize = r => SIZES.some(([w, h]) => Math.abs(r.width - w) <= 8 && Math.abs(r.height - h) <= 8);
    const empty = [];
    for (const el of document.querySelectorAll('div, section, aside, ins, span')) {
        if (empty.length >= 20) break;
        const r = visible(el);
        if (!r || !adSize(r)) continue;
        if ((el.innerText || '').trim().length > 0) continue;
        if ([...el.querySelectorAll('img, video, iframe, canvas, svg, picture, object, embed')].some(m => visible(m))) continue;
        if (getComputedStyle(el).backgroundImage !== 'none') continue;
        if (el.shadowRoot) continue;
        empty.push({ at: box(r), el: describe(el) });
    }

    // Текстовые блоки — заголовки, ссылки и абзацы: по ним видно, какой
    // блок пропал (не только сколько знаков).
    // Куда ведёт блок: на свой сайт или наружу — пропала своя запись
    // (тревожно) или чужая вставка (партнёрские ленты, тизеры — реклама).
    const blocks = new Set();
    const away = {};
    const site = location.hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
    for (const el of document.body.querySelectorAll('h1, h2, h3, h4, a, p, li')) {
        if (blocks.size >= 600) break;
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t.length < 25 || t.length > 200 || blocks.has(t) || !visible(el)) continue;
        blocks.add(t);
        const link = el.closest('a[href]') || el.querySelector('a[href]');
        if (link && link.hostname && !link.hostname.endsWith(site)) away[t] = link.hostname;
    }

    const bodyText = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
    return { labels, frames, empty, text: bodyText.length, bodyText, blocks: [...blocks], away, height: document.documentElement.scrollHeight, title: document.title.slice(0, 100) };
}

// Спрятанные поддеревья с текстом: верхний невидимый узел (родитель
// виден) и кто его спрятал — мы (узел есть в нашем отчёте), движок
// (совпал селектор его косметики для сайта) или сама страница.
function hiddenRoots({ ours, selectors }) {
    const name = el => [el.id ? '#' + el.id : '', typeof el.className === 'string' ? el.className : ''].join(' ').trim().slice(0, 120);
    const describe = el => (el.localName + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '')).slice(0, 120);
    const oursSet = new Set(ours.map(i => i.tag + ' ' + i.name));
    const out = [];
    const walk = el => {
        for (const child of el.children) {
            if (out.length >= 300) return;
            if (child.checkVisibility()) {
                walk(child);
                continue;
            }
            const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
            if (text.length < 40 || /^(script|style|noscript|template)$/.test(child.localName)) continue;
            let by = 'страница';
            let selector = null;
            if (oursSet.has(child.localName + ' ' + name(child))) {
                by = 'мы';
            } else {
                // Процедурное правило (has-text и т. п.) проверяем только по
                // его основе — совпадение там лишь вероятное.
                const hit = selectors.find(x => { try { return child.matches(x.s); } catch { return false; } });
                if (hit) {
                    selector = hit.s;
                    by = hit.proc ? 'движок?' : 'движок';
                }
            }
            out.push({ el: describe(child), by, selector, text: text.slice(0, 6000) });
        }
    };
    walk(document.body);
    return out;
}

// Дыра над закреплённым: страница прокручена, закреплённый элемент стоит
// не у верха, а над ним — ничего закреплённого (полосу, которая держала
// это место, спрятали).
function pinnedGaps() {
    const pinned = [];
    for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 100 || r.height < 20 || !el.checkVisibility()) continue;
        pinned.push({ el, r, top: parseFloat(cs.top) });
    }
    const gaps = [];
    // Всплывающие окна, диалоги, подсказки плавают по замыслу — не полоса.
    const FLOATING = /modal|popup|dialog|tooltip|toast|notif|overlay/i;
    // Отступ под шапкой (10–16 px у колонок) — не дыра от спрятанной полосы.
    const MARGIN = 16;
    for (const p of pinned) {
        // Прилип и стоит ниже верха экрана на заметную высоту.
        if (!(p.top >= 20 && Math.abs(p.r.top - p.top) < 2 && p.r.top < innerHeight / 2)) continue;
        if (p.el.closest('[role="dialog"], [aria-modal="true"], dialog') || FLOATING.test(typeof p.el.className === 'string' ? p.el.className : '')) continue;
        const x = p.r.left + Math.min(p.r.width / 2, 40);
        const covered = pinned.some(q => q !== p && !q.el.contains(p.el) && q.r.top <= 1 && q.r.bottom >= p.r.top - MARGIN && q.r.left <= x && q.r.right >= x);
        if (!covered) gaps.push({ el: (p.el.localName + (typeof p.el.className === 'string' ? '.' + p.el.className.trim().split(/\s+/).slice(0, 3).join('.') : '')).slice(0, 100), top: Math.round(p.r.top) });
    }
    return gaps.slice(0, 5);
}

// Первая статья сайта: ссылка на свой сайт с длинным путём.
function articleLink() {
    const host = location.hostname.replace(/^www\./, '');
    for (const a of document.querySelectorAll('main a[href], article a[href], a[href]')) {
        let u;
        try { u = new URL(a.href); } catch { continue; }
        if (!u.hostname.replace(/^www\./, '').endsWith(host) || u.hash || u.pathname === location.pathname) continue;
        if (u.pathname.length >= 25 && /[0-9]|-.*-/.test(u.pathname) && (a.innerText || '').trim().length >= 25) return u.href;
    }
    return null;
}

/* ---------- браузеры ---------- */

// Копия сборки для обхода — с журналом сработавших сетевых правил
// (declarativeNetRequestFeedback: только распакованному расширению и только
// здесь, у людей этого разрешения нет). По нему видно, какое правило
// какого набора остановило запрос, после которого блок не построился.
let sweepExt = null;
async function sweepBuild() {
    if (sweepExt) return sweepExt;
    sweepExt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'ygab-sweep-ext-')), 'extension');
    await fs.cp(EXT, sweepExt, { recursive: true });
    const manifestPath = path.join(sweepExt, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.permissions = [...new Set([...(manifest.permissions || []), 'declarativeNetRequestFeedback'])];
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 1));
    return sweepExt;
}

async function launch(withExt, addRulesets = []) {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), withExt ? 'ygab-sweep-' : 'ygab-sweep-plain-'));
    const ext = withExt ? await sweepBuild() : null;
    const context = await chromium.launchPersistentContext(profile, {
        ...browserOptions(),
        headless: !HEADED,
        viewport: VIEWPORT,
        locale: 'ru-RU',
        args: ['--lang=ru', ...(withExt ? ['--disable-extensions-except=' + ext, '--load-extension=' + ext] : [])]
    });
    if (withExt) {
        const isWelcome = p => p.url().endsWith('/ygab/platform/welcome/welcome.html');
        const welcome = context.pages().find(isWelcome) || await context.waitForEvent('page', { predicate: isWelcome, timeout: 20000 }).catch(() => null);
        if (welcome) {
            await welcome.waitForFunction(() => document.getElementById('setup').dataset.state, null, { timeout: 30000 }).catch(() => {});
            if (addRulesets.length) {
                await welcome.evaluate(async add => {
                    const enabled = await chrome.runtime.sendMessage({ what: 'getEnabledRulesets' });
                    await chrome.runtime.sendMessage({ what: 'applyRulesets', enabledRulesets: [...new Set(enabled.concat(add))] });
                }, addRulesets);
            }
            await welcome.close();
        }
    }
    return context;
}

async function genericReport(context, page) {
    const worker = engine(context);
    if (!worker) return null;
    const url = page.url();
    return worker.evaluate(async url => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url === url);
        if (!tab) return { error: 'нет вкладки' };
        return chrome.tabs.sendMessage(tab.id, { action: 'getGenericReport' }, { frameId: 0 }).catch(e => ({ error: String(e) }));
    }, url).catch(e => ({ error: String(e) }));
}

const engine = context => context.serviceWorkers().find(w => w.url().endsWith('/ygab/background.js'));

// Журнал сетевых правил: обнулить перед заходом, забрать после. Работник
// мог перезапуститься — тогда подписываемся заново.
async function ruleLog(context, take) {
    const worker = engine(context);
    if (!worker) return [];
    return worker.evaluate(take => {
        if (!self.__sweepRules) {
            self.__sweepRules = [];
            chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener(info => {
                if (self.__sweepRules.length < 5000) self.__sweepRules.push({ url: info.request.url, type: info.request.type, rulesetId: info.rule.rulesetId, ruleId: info.rule.ruleId });
            });
        }
        const out = take ? self.__sweepRules.slice() : [];
        self.__sweepRules.length = 0;
        return out;
    }, take).catch(() => []);
}

// Косметика движка для сайта — его же кэш (css-specific.js): простые
// селекторы и процедурные правила.
async function engineCosmetics(context, url) {
    const worker = engine(context);
    if (!worker) return [];
    const host = new URL(url).hostname;
    const entry = await worker.evaluate(key => chrome.storage.session.get(key).then(bin => bin[key] || null), `cache.css.${host}`).catch(() => null);
    if (!entry) return [];
    return [
        ...(entry.s || []).map(s => ({ s, proc: false })),
        ...(entry.p || []).filter(p => p.selector).map(p => ({ s: p.selector, proc: Boolean(p.tasks) }))
    ];
}

// Правило по номеру — из статического набора сборки (rulesets/main).
// Регулярные правила (rulesets/regex) движок ставит динамическими — у них
// rulesetId «_dynamic» и свои номера: их не раскрываем.
const rulesetCache = new Map();
function ruleOf(rulesetId, ruleId) {
    if (!rulesetCache.has(rulesetId)) {
        const byId = new Map();
        const file = path.join(EXT, 'rulesets', 'main', `${rulesetId}.json`);
        if (existsSync(file)) {
            for (const rule of JSON.parse(readFileSync(file, 'utf8'))) byId.set(rule.id, rule);
        }
        rulesetCache.set(rulesetId, byId);
    }
    return rulesetCache.get(rulesetId).get(ruleId) || null;
}

// Из какого набора селектор косметики (specific/<набор>.json).
let selectorSets = null;
function setsOfSelector(selector) {
    if (!selectorSets) {
        selectorSets = new Map();
        const dir = path.join(EXT, 'rulesets', 'scripting', 'specific');
        for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
            const data = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
            for (const s of data.selectors || []) {
                const key = s.startsWith('{') ? (() => { try { return JSON.parse(s).selector; } catch { return s; } })() : s;
                if (!selectorSets.has(key)) selectorSets.set(key, new Set());
                selectorSets.get(key).add(data.rulesetId);
            }
        }
    }
    return [...(selectorSets.get(selector) || [])];
}

// Сработавшие запрещающие правила захода: адрес, набор, фильтр.
function blockedRules(log) {
    const out = [];
    for (const hit of log) {
        const rule = ruleOf(hit.rulesetId, hit.ruleId);
        const action = rule?.action?.type || (hit.rulesetId.startsWith('_') ? '?' : null);
        if (action === 'allow' || action === 'allowAllRequests' || action === 'modifyHeaders' || action === 'upgradeScheme') continue;
        const c = rule?.condition || {};
        out.push({
            url: hit.url.slice(0, 160),
            type: hit.type,
            ruleset: hit.rulesetId,
            filter: (c.urlFilter || c.regexFilter || (c.requestDomains ? 'requestDomains:' + c.requestDomains.slice(0, 3).join(',') + (c.requestDomains.length > 3 ? ',…' : '') : '') || '#' + hit.ruleId).slice(0, 120),
            action
        });
    }
    return out.slice(0, 300);
}

// Открыть, дать рекламе прийти (прокрутка будит ленивую), снять.
async function visit(context, url, { warm = false, report = false, explain = false } = {}) {
    if (explain) await ruleLog(context, false);
    const page = await context.newPage();
    // Скорость: сеть и время скриптов за весь заход (с прокруткой — она
    // одинакова у всех браузеров).
    const net = { sent: 0, blocked: 0, bytes: 0, blockedHosts: {} };
    const urls = new Map();
    const cdp = warm ? null : await context.newCDPSession(page).catch(() => null);
    if (cdp) {
        await Promise.all([cdp.send('Network.enable'), cdp.send('Network.setCacheDisabled', { cacheDisabled: true }), cdp.send('Performance.enable')]).catch(() => {});
        cdp.on('Network.requestWillBeSent', e => { net.sent += 1; urls.set(e.requestId, e.request.url); });
        cdp.on('Network.loadingFinished', e => { net.bytes += e.encodedDataLength || 0; });
        cdp.on('Network.loadingFailed', e => {
            if (e.blockedReason || /BLOCKED_BY_CLIENT/.test(e.errorText || '')) {
                net.blocked += 1;
                let host = '?';
                try { host = new URL(urls.get(e.requestId)).hostname; } catch { /* нет адреса */ }
                net.blockedHosts[host] = (net.blockedHosts[host] || 0) + 1;
            }
        });
    }
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await page.waitForTimeout(SETTLE_MS);
        if (warm) return { ok: true };
        for (let i = 1; i <= 3; i += 1) {
            await page.evaluate(y => scrollTo(0, y), i * 800).catch(() => {});
            await page.waitForTimeout(700);
        }
        await page.evaluate(() => scrollTo(0, 0)).catch(() => {});
        await page.waitForTimeout(1500);
        const top = await withTimeout(page.evaluate(probe), STEP_TIMEOUT, 'осмотр');
        const shotTop = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);
        await page.evaluate(() => scrollTo(0, 700)).catch(() => {});
        await page.waitForTimeout(900);
        const gaps = await withTimeout(page.evaluate(pinnedGaps), STEP_TIMEOUT, 'закреплённые').catch(() => []);
        const shotScrolled = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);
        const next = DEEP ? await page.evaluate(articleLink).catch(() => null) : null;
        const rep = report || explain ? await genericReport(context, page) : null;
        let hidden = null;
        let blocked = null;
        if (explain) {
            const selectors = await engineCosmetics(context, page.url());
            hidden = await withTimeout(page.evaluate(hiddenRoots, { ours: rep?.items || [], selectors }), STEP_TIMEOUT, 'спрятанное').catch(() => null);
            blocked = blockedRules(await ruleLog(context, true));
        }
        const speed = await pageSpeed(page, cdp, net);
        return { ok: true, finalUrl: page.url(), ...top, gaps, shotTop, shotScrolled, next, report: report ? rep : null, hidden, blocked, speed };
    } catch (e) {
        return { ok: false, error: String(e.message || e).split('\n')[0].slice(0, 200) };
    } finally {
        await page.close().catch(() => {});
    }
}

async function pageSpeed(page, cdp, net) {
    if (!cdp) return null;
    try {
        const metrics = Object.fromEntries((await withTimeout(cdp.send('Performance.getMetrics'), STEP_TIMEOUT, 'показатели')).metrics.map(m => [m.name, m.value]));
        const load = await page.evaluate(() => {
            const nav = performance.getEntriesByType('navigation')[0];
            return nav && nav.loadEventEnd ? Math.round(nav.loadEventEnd) : null;
        });
        return {
            requests: net.sent - net.blocked,
            blocked: net.blocked,
            kb: Math.round(net.bytes / 1024),
            load,
            scriptMs: Math.round(metrics.ScriptDuration * 1000),
            blockedHosts: Object.entries(net.blockedHosts).sort((a, b) => b[1] - a[1]).slice(0, 15)
        };
    } catch {
        return null;
    }
}

/* ---------- находки ---------- */

// Откуда потеря текста: блоки, видимые «до» (без нас или с нами без
// добавочных наборов) и невидимые «после», — по спрятанным поддеревьям
// «после»: спрятали мы, движок (селектор, набор) или сама страница; блока
// нет вовсе — не построился (что заблокировано на этом заходе).
function explainLoss(after, before) {
    if (!after.blocks || !before.blocks || !after.hidden) return null;
    const seen = new Set(after.blocks);
    const missing = before.blocks.filter(t => !seen.has(t) && !(after.bodyText || '').includes(t));
    const groups = new Map();
    const absent = [];
    for (const t of missing) {
        const root = after.hidden.find(h => h.text.includes(t));
        if (!root) {
            absent.push(t);
            continue;
        }
        const key = root.by + ' ' + root.el;
        if (!groups.has(key)) groups.set(key, { by: root.by, el: root.el, selector: root.selector, sets: root.selector ? setsOfSelector(root.selector) : [], blocks: 0, own: 0, away: {}, sample: t.slice(0, 60) });
        const group = groups.get(key);
        group.blocks += 1;
        const host = before.away?.[t];
        if (host) group.away[host] = (group.away[host] || 0) + 1;
        else group.own += 1;
    }
    const absentOwn = absent.filter(t => !before.away?.[t]);
    const absentAway = {};
    for (const t of absent) if (before.away?.[t]) absentAway[before.away[t]] = (absentAway[before.away[t]] || 0) + 1;
    const byHost = new Map();
    for (const b of after.blocked || []) {
        let host = '?';
        try { host = new URL(b.url).hostname; } catch { /* нет адреса */ }
        const key = `${host} [${b.ruleset}: ${b.filter}]`;
        byHost.set(key, (byHost.get(key) || 0) + 1);
    }
    return {
        missing: missing.length,
        hidden: [...groups.values()].sort((a, b) => b.blocks - a.blocks).slice(0, 10),
        absent: { blocks: absent.length, own: absentOwn.length, away: absentAway, sample: absentOwn.slice(0, 5).map(t => t.slice(0, 60)) },
        // Своих (без ссылки наружу) — главное: это может быть нужное.
        own: absentOwn.length + [...groups.values()].reduce((n, g) => n + g.own, 0),
        blocked: [...byHost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([rule, n]) => `${rule} ×${n}`)
    };
}

function lossLine(loss) {
    if (!loss || !loss.missing) return '';
    const parts = [];
    const sum = (by, key = 'blocks') => loss.hidden.filter(g => g.by.startsWith(by)).reduce((n, g) => n + g[key], 0);
    const own = (by) => sum(by, 'own') ? `, своих ${sum(by, 'own')}` : '';
    const hosts = map => Object.entries(map || {}).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([h, n]) => `${h} ×${n}`).join(', ');
    if (sum('мы')) parts.push(`спрятали мы — ${sum('мы')}${own('мы')} (${loss.hidden.filter(g => g.by === 'мы').slice(0, 2).map(g => g.el).join(', ')})`);
    if (sum('движок')) parts.push(`движок — ${sum('движок')}${own('движок')} (${loss.hidden.filter(g => g.by.startsWith('движок')).slice(0, 2).map(g => `${g.selector} из ${g.sets.join('/') || '?'}`).join('; ')})`);
    if (sum('страница')) parts.push(`скрыла страница — ${sum('страница')}`);
    if (loss.absent.blocks) parts.push(`не построено — ${loss.absent.blocks}, своих ${loss.absent.own}${hosts(loss.absent.away) ? ', наружу: ' + hosts(loss.absent.away) : ''}${loss.absent.own && loss.blocked.length ? ' (заблокировано: ' + loss.blocked.slice(0, 3).join(', ') + ')' : ''}`);
    return ` — блоков: ${loss.missing} (своих ${loss.own}); ${parts.join('; ')}`;
}

function findings(ours, plain) {
    const out = [];
    if (ours.labels.length) out.push(`осталась метка: ${ours.labels.slice(0, 3).map(l => `«${l.text}» (${l.el})`).join(', ')}`);
    if (ours.frames.length) out.push(`чужой фрейм: ${ours.frames.slice(0, 3).map(f => `${f.src} ${f.at.w}×${f.at.h}`).join(', ')}`);
    if (ours.empty.length) {
        // Пустое место, которого без нас не было (или было с рекламой).
        const plainKeys = new Set((plain?.empty || []).map(e => e.el + e.at.w + e.at.h));
        const ourOnly = ours.empty.filter(e => !plainKeys.has(e.el + e.at.w + e.at.h));
        if (ourOnly.length) out.push(`пустое место размера рекламы: ${ourOnly.slice(0, 3).map(e => `${e.el} ${e.at.w}×${e.at.h}`).join(', ')}`);
    }
    if (ours.gaps.length) {
        const plainGaps = new Set((plain?.gaps || []).map(g => g.el));
        const ourOnly = ours.gaps.filter(g => !plainGaps.has(g.el));
        if (ourOnly.length) out.push(`дыра над закреплённым (меню «повисло»?): ${ourOnly.map(g => `${g.el} на ${g.top}px`).join(', ')}`);
    }
    if (plain && plain.text > 0) {
        const loss = plain.text - ours.text;
        if (loss >= TEXT_LOSS_MIN && loss / plain.text >= TEXT_LOSS_SHARE) {
            ours.loss = explainLoss(ours, plain);
            out.push(`пропало текста: ${loss} знаков из ${plain.text} (${Math.round(loss / plain.text * 100)}%)${lossLine(ours.loss) || ' — проверить, не спрятано ли нужное'}`);
        }
    }
    const left = ours.report?.leftovers;
    if (left && left.likely > 0) out.push(`наш отчёт: похожего на рекламу осталось ${left.likely}`);
    return out;
}

const slug = url => url.replace(/^https?:\/\//, '').replace(/[^a-z0-9а-яё.-]+/gi, '_').slice(0, 80);

async function save(url, ours, plain, found) {
    const dir = path.join(OUT, slug(url));
    await fs.mkdir(dir, { recursive: true });
    const files = {};
    for (const [name, buf] of [['ours-top.jpg', ours.shotTop], ['ours-scrolled.jpg', ours.shotScrolled], ['plain-top.jpg', plain?.shotTop], ['plain-scrolled.jpg', plain?.shotScrolled]]) {
        if (buf) {
            await fs.writeFile(path.join(dir, name), buf);
            files[name] = path.relative(OUT, path.join(dir, name)).replace(/\\/g, '/');
        }
    }
    // Снимки — отдельными файлами; сырой текст и спрятанные поддеревья
    // нужны только для разбора потери (итог разбора — в loss).
    const strip = r => r && Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('shot') && !['bodyText', 'blocks', 'away', 'hidden'].includes(k)));
    await fs.writeFile(path.join(dir, 'details.json'), JSON.stringify({ url, found, ours: strip(ours), plain: strip(plain) }, null, 1));
    return files;
}

/* ---------- итог ---------- */

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const median = list => {
    const sorted = list.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Скорость: медианы по сайтам, где открылись оба браузера.
function speedTable(results) {
    const pairs = results.filter(r => r.speed?.ours && r.speed?.plain);
    if (!pairs.length) return '<p>—</p>';
    const row = (name, key, unit) => {
        const ours = median(pairs.map(r => r.speed.ours[key]));
        const plain = median(pairs.map(r => r.speed.plain[key]));
        const share = median(pairs.filter(r => r.speed.plain[key] && typeof r.speed.ours[key] === 'number').map(r => (r.speed.ours[key] - r.speed.plain[key]) / r.speed.plain[key] * 100));
        return `<tr><td>${name}</td><td>${ours ?? '—'} ${unit}</td><td>${plain ?? '—'} ${unit}</td><td>${share === null ? '—' : (share > 0 ? '+' : '') + Math.round(share) + ' %'}</td></tr>`;
    };
    return `<table><tr><th></th><th>с Cleathernet</th><th>без расширения</th><th>разница (медиана по сайтам)</th></tr>
${row('запросы', 'requests', '')}${row('трафик', 'kb', 'КБ')}${row('загрузка', 'load', 'мс')}${row('скрипты страницы', 'scriptMs', 'мс')}</table>
<p><small>Сайтов с замером: ${pairs.length}. Живая реклама меняется между заходами — смотреть на медиану, не на отдельный сайт.</small></p>`;
}

function abSection(results) {
    if (!AB.length) return '';
    const rows = results.filter(r => r.ab).map(r => `<tr><td>${esc(r.url)}</td><td>${r.ab.extraBlocked}</td><td>${r.ab.kbDiff ?? '—'}</td><td>${r.ab.textLoss === null ? '—' : r.ab.textLoss + ' %'}</td><td>${esc((r.ab.rules?.length ? r.ab.rules : r.ab.hosts || []).join(', '))}${r.ab.loss ? '<br><small>' + esc(lossLine(r.ab.loss)) + '</small>' : ''}</td></tr>`).join('');
    return `<h2>Сравнение: + ${esc(AB.join(', '))}</h2>
<p><small>Третий браузер — та же сборка и эти наборы сверх наших. «Текст» — насколько текста меньше, чем с нами (живые ленты дают шум ±10–15 %).</small></p>
<table><tr><th>сайт</th><th>заблокировано сверх</th><th>трафик, КБ</th><th>текст</th><th>что блокирует сверх</th></tr>${rows}</table>`;
}

async function writeIndex(results) {
    const flagged = results.filter(r => r.found?.length);
    const rows = flagged.map(r => `<section><h2>${esc(r.url)} <small>${esc(r.category || '')}</small></h2>
<ul>${r.found.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
<div class="pair">${['ours-top.jpg', 'plain-top.jpg', 'ours-scrolled.jpg', 'plain-scrolled.jpg'].filter(n => r.files?.[n]).map(n => `<figure><a href="${r.files[n]}"><img loading="lazy" src="${r.files[n]}"></a><figcaption>${n.startsWith('ours') ? 'с Cleathernet' : 'без расширения'}, ${n.includes('top') ? 'верх' : 'после прокрутки'}</figcaption></figure>`).join('')}</div></section>`).join('\n');
    const isClean = r => r.ok && !r.found?.length && !r.plainError;
    const clean = results.filter(isClean).map(r => esc(r.url)).join(', ');
    const unpaired = results.filter(r => r.ok && r.plainError).map(r => `<li>${esc(r.url)} — ${esc(r.plainError)}</li>`).join('');
    const failed = results.filter(r => !r.ok).map(r => `<li>${esc(r.url)} — ${esc(r.error)}</li>`).join('');
    const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Обход сайтов</title>
<style>body{font:15px system-ui,sans-serif;margin:16px;max-width:1700px}h2{font-size:17px;margin:28px 0 4px}small{color:#777;font-weight:normal}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px;font-size:13px;text-align:left}figure{margin:0}img{width:100%;border:1px solid #ccc}figcaption{font-size:12px;color:#555}</style></head><body>
<h1>Обход сайтов ${esc(stamp)}</h1>
<p>Сайтов: ${results.length}; с находками: ${flagged.length}; чисто: ${results.filter(isClean).length}; не сравнить (без расширения не открылся): ${results.filter(r => r.ok && r.plainError).length}; не открылись: ${results.filter(r => !r.ok).length}.
Слева — с Cleathernet, справа — без расширения. Находки — подсказки, где посмотреть, а не приговор.</p>
${rows}
<h2>Скорость</h2>
${speedTable(results)}
${abSection(results)}
<h2>Чисто</h2><p>${clean || '—'}</p>
<h2>Не сравнить — без расширения не открылся</h2><ul>${unpaired || '<li>—</li>'}</ul>
<h2>Не открылись</h2><ul>${failed || '<li>—</li>'}</ul></body></html>`;
    await fs.writeFile(path.join(OUT, 'index.html'), html);
}

const resultsPath = path.join(OUT, 'results.json');
const results = existsSync(resultsPath) ? JSON.parse(await fs.readFile(resultsPath, 'utf8')) : [];
const done = new Set(results.map(r => r.url));

console.log(`Обход: ${sites.length} сайтов${DEEP ? ' (+ по статье)' : ''}. Папка: ${path.relative(ROOT, OUT)}`);
const ours = await launch(true);
const plain = await launch(false);
const extra = AB.length ? await launch(true, AB) : null;
if (extra) console.log(`Сравнение: третий браузер с наборами ${AB.join(', ')}`);
const started = Date.now();
try {
    let n = 0;
    for (const site of sites) {
        n += 1;
        const queue = [site.url];
        for (let k = 0; k < queue.length; k += 1) {
            const url = queue[k];
            if (done.has(url) || FORBIDDEN.test(new URL(url).hostname)) continue;
            // Движок применяет правила сайта со второго захода — сначала прогрев.
            await visit(ours, url, { warm: true });
            const a = await visit(ours, url, { report: true, explain: true });
            const b = a.ok ? await visit(plain, url) : null;
            const entry = { url, category: site.category, ok: a.ok, error: a.error };
            if (a.ok) {
                entry.speed = { ours: a.speed, plain: b?.ok ? b.speed : null };
                if (extra) {
                    await visit(extra, url, { warm: true });
                    const c = await visit(extra, url, { explain: true });
                    if (c.ok && a.speed && c.speed) {
                        const oursHosts = new Set(a.speed.blockedHosts.map(([h]) => h));
                        const textLoss = a.text ? Math.round((a.text - c.text) / a.text * 100) : null;
                        // Что добавочные наборы блокируют сверх наших: правило и набор.
                        const oursRules = new Set((a.blocked || []).map(b => b.ruleset + b.filter));
                        entry.ab = {
                            extraBlocked: c.speed.blocked - a.speed.blocked,
                            kbDiff: c.speed.kb - a.speed.kb,
                            textLoss,
                            hosts: c.speed.blockedHosts.map(([h]) => h).filter(h => !oursHosts.has(h)).slice(0, 8),
                            rules: [...new Set((c.blocked || []).filter(b => !oursRules.has(b.ruleset + b.filter)).map(b => `${b.ruleset}: ${b.filter}`))].slice(0, 12),
                            loss: textLoss >= 10 ? explainLoss(c, a) : null
                        };
                    }
                }
                entry.found = findings(a, b?.ok ? b : null);
                // Без расширения не открылся — сравнивать не с чем: не «чисто».
                if (!b?.ok) entry.plainError = b?.error || 'не открылся';
                entry.collapsed = a.report?.collapsed ?? null;
                if (a.loss) entry.loss = a.loss;
                if (entry.found.length || ALL_SHOTS) entry.files = await save(url, a, b?.ok ? b : null, entry.found);
                if (k === 0 && a.next) queue.push(a.next);
            }
            results.push(entry);
            done.add(url);
            await fs.writeFile(resultsPath, JSON.stringify(results, null, 1));
            const mins = Math.round((Date.now() - started) / 60000);
            console.log(`[${n}/${sites.length}, ${mins} мин] ${url}: ${!a.ok ? 'не открылся — ' + a.error : entry.found.length ? 'НАЙДЕНО: ' + entry.found.join('; ') : entry.plainError ? 'не сравнить — без расширения: ' + entry.plainError : 'чисто'}`);
        }
        await writeIndex(results);
    }
} finally {
    await writeIndex(results);
    await ours.close().catch(() => {});
    await plain.close().catch(() => {});
    if (extra) await extra.close().catch(() => {});
}
await fs.writeFile(path.join(OUT, 'done.txt'), new Date().toISOString());
console.log(`Готово. Итог: ${path.join(OUT, 'index.html')}`);
if (args.includes('--open') && process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', path.join(OUT, 'index.html')], { detached: true, stdio: 'ignore' }).unref();
}
