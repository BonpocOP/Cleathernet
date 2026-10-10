// Самопроверка: расширение само открывает сайты из списка по одному и
// собирает, что общий механизм спрятал (и не задел ли главный текст) и что
// осталось похожим на рекламу. Итог — один файл для разработчика: живые
// данные с настоящей рекламой и настоящими входами в почту и соцсети,
// которых нет у автоматических проверок.
//
// Приватность: текста страниц в файле нет (только имена блоков, размеры,
// числа); адрес — сайт и первая часть пути.
//
// ?urls=<адрес>,<адрес>&settle=<мс> — для тестов (dev/test-build.mjs).

import { readOffSites, covers } from '../shared/site-state.js';

const DEFAULT_URLS = [
    'https://www.avito.ru/',
    'https://www.avito.ru/moskva/kvartiry/prodam',
    'https://www.avito.ru/moskva/kvartiry/catalog/novostroyki',
    'https://www.avito.ru/moskva/avtomobili',
    'https://yandex.ru/search/?text=купить холодильник',
    'https://yandex.ru/video/search?text=сериалы',
    'https://yandex.ru/maps/213/moscow/',
    'https://vk.com/feed',
    'https://vk.com/video',
    'https://e.mail.ru/inbox/',
    'https://news.mail.ru/',
    'https://dzen.ru/',
    'https://ria.ru/',
    'https://www.rbc.ru/',
    'https://www.kp.ru/',
    'https://www.mk.ru/',
    'https://aif.ru/',
    'https://pikabu.ru/',
    'https://habr.com/ru/',
    'https://www.drom.ru/',
    'https://www.youtube.com/'
];

const params = new URLSearchParams(location.search);
// Ждать после загрузки: ленивая реклама приходит с прокруткой и позже.
const SETTLE_MS = Number(params.get('settle')) || 4000;
const LOAD_TIMEOUT_MS = 45000;
const LOST_TEXT = 200;

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = message => chrome.runtime.sendMessage(message);

$('urls').value = (params.get('urls') ? params.get('urls').split(',') : DEFAULT_URLS).join('\n');

// Адрес без подробностей: сайт и первая часть пути (без писем, id, запросов).
function shortUrl(raw) {
    try {
        const url = new URL(raw);
        const first = url.pathname.split('/').filter(Boolean)[0];
        return url.origin + (first ? '/' + first + '/…' : '/');
    } catch {
        return '';
    }
}

function waitComplete(tabId) {
    return new Promise(resolve => {
        const done = () => {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timer);
            resolve();
        };
        const listener = (id, info) => {
            if (id === tabId && info.status === 'complete') {
                done();
            }
        };
        const timer = setTimeout(done, LOAD_TIMEOUT_MS);
        chrome.tabs.onUpdated.addListener(listener);
    });
}

const inPage = (tabId, func) => chrome.scripting.executeScript({ target: { tabId }, func })
    .then(([result]) => result && result.result, () => null);

// Прокрутка на три экрана и обратно — догружается ленивое.
async function scrollPage() {
    for (let i = 0; i < 3; i += 1) {
        scrollBy(0, innerHeight);
        await new Promise(resolve => setTimeout(resolve, 700));
    }
    scrollTo(0, 0);
}

function timing() {
    const nav = performance.getEntriesByType('navigation')[0];
    return nav ? {
        domReady: Math.round(nav.domContentLoadedEventEnd),
        load: Math.round(nav.loadEventEnd),
        requests: performance.getEntriesByType('resource').length
    } : null;
}

async function checkOne(tabId, url, offSites) {
    await chrome.tabs.update(tabId, { url });
    await waitComplete(tabId);
    await sleep(SETTLE_MS / 2);
    await inPage(tabId, scrollPage);
    await sleep(SETTLE_MS / 2);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const finalUrl = tab && tab.url ? tab.url : url;
    const host = (() => { try { return new URL(finalUrl).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    const result = await chrome.tabs.sendMessage(tabId, { action: 'getSelfCheck' }, { frameId: 0 })
        .catch(error => ({ error: String(error && error.message || error).slice(0, 200) }));
    const hidden = (result && result.hidden) || [];
    return {
        url: shortUrl(finalUrl),
        siteOff: offSites.some(site => covers(site, host)),
        perf: await inPage(tabId, timing),
        // Вопросы — спрятан главный текст или много текста без признаков рекламы.
        problems: hidden.filter(item => item.main || (item.text >= LOST_TEXT && !item.adLike)).length,
        ...result
    };
}

let report = null;

$('start').addEventListener('click', async () => {
    const urls = $('urls').value.split('\n').map(line => line.trim()).filter(line => /^https?:\/\//.test(line));
    if (!urls.length) {
        $('status').textContent = 'Список пуст';
        return;
    }
    $('start').disabled = true;
    $('save').disabled = true;
    $('progress').textContent = '';
    const manifest = chrome.runtime.getManifest();
    report = {
        product: manifest.name,
        version: manifest.version,
        build: manifest.version_name || null,
        browser: navigator.userAgent,
        language: navigator.language,
        startedAt: new Date().toISOString(),
        rulesets: await send({ what: 'getEnabledRulesets' }).catch(() => null),
        sites: []
    };
    const offSites = await readOffSites();
    const win = await chrome.windows.create({ url: 'about:blank', focused: true, width: 1400, height: 900 });
    const tabId = win.tabs[0].id;
    try {
        for (const [i, url] of urls.entries()) {
            $('status').textContent = `Проверяю ${i + 1} из ${urls.length}…`;
            const site = await checkOne(tabId, url, offSites).catch(error => ({ url: shortUrl(url), error: String(error) }));
            report.sites.push(site);
            const line = document.createElement('li');
            const hidden = site.hidden ? site.hidden.length : 0;
            const left = site.leftovers ? site.leftovers.likely : 0;
            line.textContent = site.error
                ? `${site.url} — не удалось: ${site.error}`
                : `${site.url} — спрятано ${hidden}, осталось похожего на рекламу ${left}${site.problems ? `, ВОПРОСОВ ${site.problems}` : ''}${site.siteOff ? ' (выключено на сайте)' : ''}`;
            if (site.problems || site.error) {
                line.className = 'bad';
            }
            $('progress').append(line);
        }
    } finally {
        await chrome.windows.remove(win.id).catch(() => {});
        report.finishedAt = new Date().toISOString();
        $('status').textContent = 'Готово. Нажмите «Сохранить файл» и перешлите его разработчику.';
        $('start').disabled = false;
        $('save').disabled = false;
        document.body.dataset.done = '1';
    }
});

$('save').addEventListener('click', () => {
    if (!report) {
        return;
    }
    const blob = new Blob([JSON.stringify(report, null, 1)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `cleathernet-selfcheck-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
});

// Для тестов: итог — в странице.
window.__selfcheck = () => report;
