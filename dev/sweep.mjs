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
//                  [--night] [--until ЧЧ:ММ] [--shuffle]
//   --continue — продолжить последний незаконченный обход; --open — открыть
//               итог в браузере (так запускает sweep.bat).
//   --no-deep — только главные страницы (по умолчанию ещё одна статья
//               сайта: рекламы в статьях больше).
//   --night — ночной прогон без человека (night.bat): без окон, но браузер
//             представляется обычным Chrome (без «HeadlessChrome» и метки
//             автоматизации — такой сайты чаще принимают за робота); закрылся
//             браузер — запускаем заново; паузы между сайтами, статьи — в конце прохода
//             (тот же сайт — не раньше чем через час). Капча или защита от
//             роботов — сайт пропускаем до конца прохода, капчу не решаем
//             никогда; две подряд — пауза 10 мин; пять за последние 15
//             адресов — останавливаемся (похоже, адрес IP помечен).
//   --until ЧЧ:ММ — не начинать новый адрес после этого времени (утро).
//   --shuffle — сайты в случайном порядке.
//   --recheck <папка> | last — только адреса, где в том обходе пропал текст.

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
const DEEP = !args.includes('--no-deep') && !args.includes('--recheck');
const HEADED = args.includes('--headed');
const RESUME = arg('--resume');
// Скриншоты и у чистых сайтов — посмотреть глазами.
const ALL_SHOTS = args.includes('--shots');
const AB = arg('--ab') ? arg('--ab').split(',').filter(Boolean) : [];
const NIGHT = args.includes('--night');
const SHUFFLE = args.includes('--shuffle');
// Время остановки: ЧЧ:ММ сегодня, а если уже прошло — завтра.
const UNTIL = (() => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(arg('--until') || '');
    if (!m) return null;
    const t = new Date();
    t.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (t <= new Date()) t.setDate(t.getDate() + 1);
    return t.getTime();
})();

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
// --recheck <папка> | last — второй проход ночи (14.10): только адреса, где в
// прошлом обходе пропал текст (с нами или с добавочными наборами), — живая
// лента или стойкая потеря. Остальное повторять незачем: скорость через VPN —
// шум, а лишние заходы на сайт — риск капчи.
const RECHECK = arg('--recheck');
const recheckDir = RECHECK === 'last' ? (existsSync(SWEEPS) ? readdirSync(SWEEPS).sort().reverse().map(name => path.join(SWEEPS, name)).find(dir => existsSync(path.join(dir, 'results.json'))) : null) : RECHECK && path.resolve(RECHECK);
const OUT = RESUME ? path.resolve(RESUME) : (args.includes('--continue') && await unfinished()) || path.join(SWEEPS, stamp);
await fs.mkdir(OUT, { recursive: true });

const corpus = JSON.parse(await fs.readFile(path.join(ROOT, 'test', 'ad-sites.json'), 'utf8'));
let sites = corpus.sites;
if (RECHECK) {
    const lost = recheckDir ? JSON.parse(readFileSync(path.join(recheckDir, 'results.json'), 'utf8'))
        .filter(e => (e.found || []).some(f => f.startsWith('пропало текста')) || e.ab?.textLoss >= 10) : [];
    console.log(`Перепроверка потери текста: ${lost.length} адресов из ${recheckDir || 'нет прошлого обхода'}`);
    sites = lost.map(e => ({ url: e.url, category: e.category }));
}
sites = sites.filter(s => !FORBIDDEN.test(new URL(s.url).hostname)).filter(s => !ONLY || s.url.includes(ONLY));
if (LIMIT) sites = sites.slice(0, LIMIT);

const withTimeout = (promise, ms, what) => {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: дольше ${ms / 1000} с`)), ms); })
    ]).finally(() => clearTimeout(timer));
};
// Весь адрес (три браузера, прогрев, разбор) — около 47 с (замер 14.10). Дольше 6 мин —
// зависла вкладка (evaluate и close без срока ждут вечно, 14.10 обход
// простоял так 12 часов): бросаем адрес и перезапускаем браузеры.
const SITE_TIMEOUT = Number(process.env.SWEEP_SITE_TIMEOUT) || 6 * 60000;

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
    const narrow = {};
    const site = location.hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
    for (const el of document.body.querySelectorAll('h1, h2, h3, h4, a, p, li')) {
        if (blocks.size >= 600) break;
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t.length < 25 || t.length > 200 || blocks.has(t) || !visible(el)) continue;
        blocks.add(t);
        // Узкая колонка сбоку (< 30 % экрана: Гисметео — 320 px из 1600) или
        // основная область — по ширине ближайшего блочного предка.
        let box = el;
        while (box.parentElement && getComputedStyle(box).display.startsWith('inline')) box = box.parentElement;
        if (box.getBoundingClientRect().width < 0.3 * vw) narrow[t] = 1;
        const link = el.closest('a[href]') || el.querySelector('a[href]');
        if (link && link.hostname && !link.hostname.endsWith(site)) away[t] = link.hostname;
    }

    const bodyText = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
    // Шапка (13.10, Гисметео: правило списка сузило обёртку страницы, а с
    // ней — меню; пункты ушли за стрелки): ссылки в верхних 260 px, которые
    // видно (не обрезаны и не перекрыты), и ширина, которую они занимают.
    const navLinks = [];
    // Пункты, ушедшие за край полосы с прокруткой (стрелки «<» «>»).
    let clipped = 0;
    const clipOf = el => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const cs = getComputedStyle(p);
            if (cs.overflowX !== 'visible') return p.getBoundingClientRect();
        }
        return null;
    };
    // Только ссылки на свой сайт: рекламный баннер над шапкой без нас — тоже
    // ссылки (championat: «пропало» 10 — это баннер).
    const ownSite = location.hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
    for (const a of document.querySelectorAll('a[href]')) {
        const r = a.getBoundingClientRect();
        if (r.top < 0 || r.bottom > 260 || r.width < 4 || r.height < 4) continue;
        if (!a.hostname.endsWith(ownSite) || /click|redirect|away|erid=/i.test(a.href)) continue;
        const clip = clipOf(a);
        if (clip && clip.width > 200 && (r.left < clip.left - 1 || r.right > clip.right + 1)) clipped += 1;
        if (r.left < 0 || r.right > vw) continue;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (hit && (hit === a || a.contains(hit) || hit.contains(a))) navLinks.push(r);
    }
    // Помехи поверх страницы (13.10: плашки cookie видны на многих сайтах,
    // хотя annoyances-cookies включён; mail.ru — «сменить регион»): что
    // осталось закреплённым поверх страницы — по виду, с разметкой как
    // образцом для будущего механизма (образцы — в папке обхода, не в git).
    const PESTS = [
        ['cookie', /cookie|куки/i],
        ['приложение', /(скачайте|установите|откройте в|открыть в|перейти в) (наше |мобильное )?приложени|app store|google play|rustore|appgallery/i],
        ['регион', /ваш (город|регион)|выберите (свой |ваш )?(город|регион)|определить (ваше )?местоположени|сменить регион|это ваш город|верно определили/i],
        ['стартовая', /сделать (стартовой|яндекс)|установите (яндекс[.\s]?)?браузер|сделайте .{0,20}стартовой/i],
        ['уведомления', /(разрешите|включите|получать|подпишитесь на) .{0,20}уведомлени/i],
        ['блокировщик', /(отключите|выключите|обнаружен|используете) .{0,25}(блокировщик|adblock)/i]
    ];
    const pests = [];
    const pinnedOf = el => {
        for (; el && el !== document.body; el = el.parentElement) {
            const pos = getComputedStyle(el).position;
            if (pos === 'fixed' || pos === 'sticky') return el;
        }
        return null;
    };
    const seenPest = new Set();
    const addPest = (kind, el, text) => {
        if (seenPest.has(el) || pests.length >= 8) return;
        const r = visible(el);
        if (!r || r.width < 120 || r.height < 30) return;
        seenPest.add(el);
        pests.push({ kind, el: describe(el), text: text.replace(/\s+/g, ' ').trim().slice(0, 100), w: Math.round(r.width), h: Math.round(r.height), html: el.outerHTML.slice(0, 15000) });
    };
    const pw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = pw.nextNode(); node && pests.length < 8; node = pw.nextNode()) {
        const v = node.nodeValue;
        if (v.length < 4) continue;
        const kind = PESTS.find(([, re]) => re.test(v));
        if (!kind) continue;
        const pinned = pinnedOf(node.parentElement);
        if (pinned) addPest(kind[0], pinned, v);
    }
    // Плавающее видео в углу: закреплённый плеер меньше половины экрана.
    for (const media of document.querySelectorAll('video, iframe[src*="player" i], iframe[src*="video" i], iframe[src*="rutube" i], iframe[src*="youtube" i]')) {
        const pinned = pinnedOf(media);
        if (pinned && pinned.getBoundingClientRect().width < vw / 2) addPest('видео', pinned, media.getAttribute('src') || 'video');
    }
    const cookie = pests.find(p => p.kind === 'cookie') || null;
    const nav = navLinks.length ? { links: navLinks.length, clipped, span: Math.round(Math.max(...navLinks.map(r => r.right)) - Math.min(...navLinks.map(r => r.left))) } : null;
    return { labels, frames, empty, nav, text: bodyText.length, bodyText, blocks: [...blocks], away, narrow, cookie, pests, height: document.documentElement.scrollHeight, title: document.title.slice(0, 100) };
}

// Спрятанные поддеревья с текстом: верхний невидимый узел (родитель
// виден) и кто его спрятал — мы (узел есть в нашем отчёте), движок
// (совпал селектор его косметики для сайта) или сама страница.
// Страница проверки «вы не робот» или отказ в доступе (по коду ответа,
// заголовку, тексту и фреймам капч). Обычная страница с капчей в форме
// комментария под это не подходит: текста у неё много.
function gateOf(status) {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const title = document.title || '';
    const short = text.length < 1500;
    if ([403, 429, 503].includes(status) && short) return 'код ' + status;
    const words = /(вы не робот|я не робот|подтвердите, что вы|проверка браузера|проверяем ваш браузер|доступ ограничен|доступ запрещ[её]н|слишком много запросов|just a moment|checking your browser|verify you are human|are you a robot|access denied|attention required|ddos-guard|too many requests)/i;
    const hit = words.exec(title) || (short && words.exec(text));
    if (hit) return hit[1].toLowerCase();
    const frame = document.querySelector('iframe[src*="captcha" i], iframe[src*="challenges.cloudflare" i], iframe[src*="smartcaptcha" i], #challenge-form, .cf-turnstile');
    if (frame && short) return 'капча на странице';
    return null;
}

function hiddenRoots({ ours, selectors }) {
    const name = el => [el.id ? '#' + el.id : '', typeof el.className === 'string' ? el.className : ''].join(' ').trim().slice(0, 120);
    const describe = el => (el.localName + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '')).slice(0, 120);
    const oursSet = new Set(ours.map(i => i.tag + ' ' + i.name));
    // Лента ссылок без полей ввода (R15): довесок или потеря решает место
    // на странице без нас — explainLoss.
    const feedOf = (el, text) => {
        let links = 0;
        for (const a of el.querySelectorAll('a[href]')) if (!a.parentElement.closest('a[href]')) links += (a.textContent || '').replace(/\s+/g, ' ').trim().length;
        return links >= 0.6 * text.length && !el.querySelector('input:not([type="hidden"]), textarea, select');
    };
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
            out.push({ el: describe(child), by, selector, feed: feedOf(child, text), text: text.slice(0, 6000) });
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

// Строка браузера как у обычного Chrome той же версии.
let userAgent = null;
async function plainUserAgent() {
    if (userAgent) return userAgent;
    const probeContext = await chromium.launchPersistentContext(await fs.mkdtemp(path.join(os.tmpdir(), 'ygab-ua-')), { ...browserOptions(), ...SAFE, headless: true });
    const page = probeContext.pages()[0] || await probeContext.newPage();
    userAgent = (await page.evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
    await probeContext.close();
    return userAgent;
}

// Безопасность (обход крутит чужую рекламу часами без присмотра):
// песочница Chrome включена (Playwright по умолчанию её выключает),
// скачивания запрещены. Профиль — временный: ни входов, ни данных
// человека; ссылки — только из списка и статьи того же сайта; ничего не
// нажимаем и не заполняем.
const SAFE = { chromiumSandbox: true, acceptDownloads: false };

async function launch(withExt, addRulesets = []) {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), withExt ? 'ygab-sweep-' : 'ygab-sweep-plain-'));
    const ext = withExt ? await sweepBuild() : null;
    const context = await chromium.launchPersistentContext(profile, {
        ...browserOptions(),
        ...SAFE,
        headless: !HEADED,
        ...(NIGHT ? { userAgent: await plainUserAgent() } : {}),
        viewport: VIEWPORT,
        locale: 'ru-RU',
        args: ['--lang=ru', ...(NIGHT ? ['--disable-blink-features=AutomationControlled'] : []), ...(withExt ? ['--disable-extensions-except=' + ext, '--load-extension=' + ext] : [])]
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
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await page.waitForTimeout(SETTLE_MS);
        // Капча или защита от роботов: дальше не идём и ничего не нажимаем.
        const gate = await page.evaluate(gateOf, response ? response.status() : 0).catch(() => null);
        if (gate) return { ok: false, gate, error: 'капча / защита: ' + gate };
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
        if (!groups.has(key)) groups.set(key, { by: root.by, el: root.el, selector: root.selector, feed: root.feed, narrow: 0, sets: root.selector ? setsOfSelector(root.selector) : [], blocks: 0, own: 0, away: {}, sample: t.slice(0, 60) });
        const group = groups.get(key);
        group.blocks += 1;
        if (before.narrow?.[t]) group.narrow += 1;
        const host = before.away?.[t];
        if (host) group.away[host] = (group.away[host] || 0) + 1;
        else group.own += 1;
    }
    // Довесок (R15, 13.10): лента ссылок в узкой колонке сбоку — без нас она
    // стояла не в основной области. Основная лента (pikabu, главная Дзена,
    // агрегатор) и блок со своим текстом или формой — потеря. Признак «раздел
    // есть в меню» (мысль пользователя: функцию не украли) проверили и не
    // взяли решающим: рекомендации ведут на отдельные статьи, не на разделы
    // меню, — он ошибается в обе стороны.
    for (const g of groups.values()) g.kind = g.feed && g.narrow >= 0.6 * g.blocks ? 'довесок' : 'потеря';
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
    if (sum('движок')) {
        // Потери движка — первыми: довесок (лента ссылок сбоку) он прячет верно.
        const engine = loss.hidden.filter(g => g.by.startsWith('движок')).sort((a, b) => (a.kind === 'потеря' ? 0 : 1) - (b.kind === 'потеря' ? 0 : 1));
        // Партнёрская лента (ссылки наружу) — не свой контент: считаем только свои блоки.
        const lost = engine.filter(g => g.kind === 'потеря').reduce((n, g) => n + g.own, 0);
        parts.push(`движок — ${sum('движок')}${own('движок')}${lost ? `, ПОТЕРЯ ${lost}` : ', довесок'} (${engine.slice(0, 2).map(g => `${g.kind || '?'}: ${g.selector} из ${g.sets.join('/') || '?'}`).join('; ')})`);
    }
    if (sum('страница')) parts.push(`скрыла страница — ${sum('страница')}`);
    if (loss.absent.blocks) parts.push(`не построено — ${loss.absent.blocks}, своих ${loss.absent.own}${hosts(loss.absent.away) ? ', наружу: ' + hosts(loss.absent.away) : ''}${loss.absent.own && loss.blocked.length ? ' (заблокировано: ' + loss.blocked.slice(0, 3).join(', ') + ')' : ''}`);
    return ` — блоков: ${loss.missing} (своих ${loss.own}); ${parts.join('; ')}`;
}

function findings(ours, plain) {
    const out = [];
    // Помехи, которых без нас не меньше: с нами осталось — подсказка, что
    // убирать (cookie, приложение, регион, стартовая, уведомления, видео).
    for (const p of ours.pests || []) out.push(`помеха осталась (${p.kind}): «${p.text.slice(0, 60)}» ${p.w}×${p.h}`);
    // Шапка сжалась или пункты меню ушли за край (без нас было видно больше).
    if (ours.nav && plain?.nav) {
        const fewer = ours.nav.links < plain.nav.links * 0.85 && plain.nav.links - ours.nav.links >= 3;
        const narrower = ours.nav.span < plain.nav.span * 0.9;
        const cut = (ours.nav.clipped || 0) - (plain.nav.clipped || 0) >= 3;
        if (fewer || narrower || cut) out.push(`шапка сжалась: ссылок видно ${ours.nav.links} из ${plain.nav.links}, за краем ${ours.nav.clipped} (без нас ${plain.nav.clipped}), ширина ${ours.nav.span} из ${plain.nav.span} px`);
    }
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
    const strip = r => r && Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('shot') && !['bodyText', 'blocks', 'away', 'narrow', 'hidden'].includes(k)));
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
// Браузер закрылся (окно закрыли, упал) — запускаем заново, а не падаем.
const watch = context => { context.on('close', () => { context.gone = true; }); return context; };
let ours = watch(await launch(true));
let plain = watch(await launch(false));
let extra = AB.length ? watch(await launch(true, AB)) : null;
async function revive() {
    if (ours.gone) { console.log('Браузер «с нами» закрылся — запускаю заново.'); ours = watch(await launch(true)); }
    if (plain.gone) { console.log('Браузер «без нас» закрылся — запускаю заново.'); plain = watch(await launch(false)); }
    if (extra?.gone) { console.log('Третий браузер закрылся — запускаю заново.'); extra = watch(await launch(true, AB)); }
}
// Зависший браузер закрыть может не выйти — тогда просто бросаем его
// (умрёт вместе с процессом) и при следующем адресе запускаем новые.
async function closeAll() {
    for (const context of [ours, plain, extra]) {
        if (!context) continue;
        await withTimeout(context.close(), STEP_TIMEOUT, 'закрыть браузер').catch(() => {});
        context.gone = true;
    }
}
// Последняя страховка срока: что бы ни повисло, через 15 минут после
// --until процесс выходит сам.
if (UNTIL) {
    setTimeout(() => {
        console.log('Срок --until прошёл 15 минут назад, а обход не закончился — выхожу принудительно.');
        process.exit(3);
    }, Math.max(0, UNTIL - Date.now()) + 15 * 60000).unref();
}
if (extra) console.log(`Сравнение: третий браузер с наборами ${AB.join(', ')}`);
const started = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Ночью: сайт, показавший капчу, до конца прохода не трогаем; две капчи
// подряд — пауза; пять за последние 15 адресов — стоп (адрес IP, похоже,
// помечен: дальше только хуже).
const gated = new Set();
const recent = [];
let stopReason = null;
if (SHUFFLE) sites.sort(() => Math.random() - 0.5);
// Очередь: главные страницы, статья — сразу за своей главной; ночью —
// в конце прохода (тот же сайт не открываем дважды подряд).
const queue = sites.map(site => ({ site, url: site.url, main: true }));
// Один адрес во всех браузерах: запись для results.json.
async function check(site, url, main, q) {
    // Движок применяет правила сайта со второго захода — сначала прогрев.
    const w = await visit(ours, url, { warm: true });
    const a = w.gate ? w : await visit(ours, url, { report: true, explain: true });
    const b = a.ok ? await visit(plain, url) : null;
    const gate = a.gate || b?.gate || null;
    const entry = { url, category: site.category, ok: a.ok, error: a.error };
    if (gate) entry.gate = gate;
    if (a.ok) {
        entry.speed = { ours: a.speed, plain: b?.ok ? b.speed : null };
        if (extra && !gate) {
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
        if (main && a.next && !gate) {
            const article = { site, url: a.next, main: false };
            if (NIGHT) queue.push(article);
            else queue.splice(q + 1, 0, article);
        }
    }
    return entry;
}
try {
    let n = 0;
    for (let q = 0; q < queue.length; q += 1) {
        const { site, url, main } = queue[q];
        if (main) n += 1;
        const host = new URL(url).hostname;
        if (done.has(url) || FORBIDDEN.test(host) || gated.has(host)) continue;
        if (UNTIL && Date.now() > UNTIL) { stopReason = 'время вышло (--until)'; break; }
        await revive();
        // Человек не открывает сайты без передышки.
        if (NIGHT && q) await sleep(4000 + Math.random() * 8000);
        let entry;
        try {
            entry = await withTimeout(check(site, url, main, q), SITE_TIMEOUT, 'адрес целиком');
        } catch (e) {
            entry = { url, category: site.category, ok: false, error: 'завис — ' + e.message };
            console.log(`${url}: завис больше ${Math.round(SITE_TIMEOUT / 1000)} с — бросаю адрес, перезапускаю браузеры.`);
            await closeAll();
        }
        const gate = entry.gate || null;
        results.push(entry);
        done.add(url);
        await fs.writeFile(resultsPath, JSON.stringify(results, null, 1));
        const mins = Math.round((Date.now() - started) / 60000);
        console.log(`[${n}/${sites.length}, ${mins} мин] ${url}: ${gate ? 'КАПЧА / ЗАЩИТА — ' + gate + ' (сайт пропускаем)' : !entry.ok ? 'не открылся — ' + entry.error : entry.found.length ? 'НАЙДЕНО: ' + entry.found.join('; ') : entry.plainError ? 'не сравнить — без расширения: ' + entry.plainError : 'чисто'}`);
        if (main) await writeIndex(results);
        recent.push(Boolean(gate));
        if (recent.length > 15) recent.shift();
        if (gate) {
            gated.add(host);
            if (recent.filter(Boolean).length >= 5) {
                stopReason = 'капча на 5 из последних 15 адресов — похоже, адрес IP помечен; остановился, чтобы не стало хуже';
                break;
            }
            if (NIGHT && recent.length >= 2 && recent[recent.length - 2]) {
                console.log('Две капчи подряд — пауза 10 минут.');
                await sleep(10 * 60000);
            }
        }
    }
} finally {
    await writeIndex(results);
    await closeAll();
}
if (stopReason) {
    // Не дописан — --continue продолжит.
    await fs.writeFile(path.join(OUT, 'stopped.txt'), `${new Date().toISOString()} ${stopReason}\n`);
    console.log(`Остановлен: ${stopReason}. Итог: ${path.join(OUT, 'index.html')}`);
    // night.ps1: после остановки из-за капч второй проход не запускаем.
    if (stopReason.startsWith('капча')) process.exitCode = 2;
} else {
    await fs.writeFile(path.join(OUT, 'done.txt'), new Date().toISOString());
    console.log(`Готово. Итог: ${path.join(OUT, 'index.html')}`);
}
if (args.includes('--open') && process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', path.join(OUT, 'index.html')], { detached: true, stdio: 'ignore' }).unref();
}
