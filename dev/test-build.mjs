// Проверка сборки-обёртки build/extension (Э2): движок uBO Lite и наш код
// живут в одном расширении и не мешают друг другу.
//
// Сначала собрать: node build-extension.mjs. Сетевой запрос один — к
// рекламному скрипту Google, который движок должен перехватить; сама
// страница подставляется локально.
//
//   node test-build.mjs [--headed]

import { chromium } from 'playwright';
import { browserOptions } from './browser.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(DEV, '..', 'build', 'extension');
const headed = process.argv.includes('--headed');

const AD_SCRIPT = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
const PAGE_URL = 'https://test.example/';
const PAGE_HTML = `<!doctype html><html><body><p>страница</p><script src="${AD_SCRIPT}"></script></body></html>`;

const results = [];
// Печатаем сразу: если тест зависнет, видно, на какой проверке.
const check = (name, ok, detail) => {
    results.push({ ok: Boolean(ok), name, detail });
    console.log(`${ok ? 'ОК  ' : 'СБОЙ'} ${name}${ok ? '' : '  → ' + JSON.stringify(detail)}`);
};

// «Где мы работаем»: у сборки одно место (platform/shared/site-state.js),
// у слоя Игр — своя копия, которую мы не трогаем. Ключи хранилища должны
// совпадать, иначе выключение на сайте не дойдёт до одного из слоёв.
// Файлы Игр только читаем.
{
    const ROOT = path.resolve(DEV, '..');
    const read = file => fs.readFile(path.join(ROOT, file), 'utf8');
    const keyIn = (text, name) => (text.match(new RegExp(`${name} = '([^']+)'`)) || [])[1];
    const shared = await read('platform/shared/site-state.js');
    const offKey = keyIn(shared, 'export const OFF_SITES_KEY');
    const games = {
        'src/content/config.js': keyIn(await read('src/content/config.js'), 'const OFF_SITES_KEY'),
        'src/frame.js': keyIn(await read('src/frame.js'), 'const OFF_SITES_KEY')
    };
    const enabledKey = keyIn(shared, 'export const ENABLED_KEY');
    const gamesEnabled = /\benabled: true\b/.test(await read('src/content/config.js')) && /\benabled: true\b/.test(await read('src/frame.js'));
    check('выключенные сайты: один ключ у сборки и у слоя Игр, общий выключатель — «enabled» у обоих',
        offKey && Object.values(games).every(key => key === offKey) && enabledKey === 'enabled' && gamesEnabled, { сборка: offKey, игры: games, enabledKey, gamesEnabled });
    const bundled = await fs.readFile(path.join(EXT, 'ygab', 'platform', 'bundle', 'generic.js'), 'utf8');
    check('общий механизм в сборке берёт «где работать» из site-state.js', bundled.includes('function watchActive(') && !/^export /m.test(bundled), null);
}

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ygab-build-'));
const context = await chromium.launchPersistentContext(profile, {
    ...browserOptions(),
    headless: !headed,
    // Не русский язык браузера: при русском uBO Lite сам включает RU AdList,
    // и не видно, сработала ли наша настройка. Заодно это случай
    // пользователя за границей.
    args: ['--lang=en-GB', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
});

try {
    const manifest = JSON.parse(await fs.readFile(path.join(EXT, 'manifest.json'), 'utf8'));
    check('манифест: наше имя, наш попап, фон — наша точка входа',
        manifest.name === 'Cleathernet' && manifest.action.default_popup === 'ygab/platform/popup/popup.html' &&
        manifest.background.service_worker === 'ygab/background.js', { name: manifest.name, popup: manifest.action.default_popup });

    // Значок движок ставит сам из img/icon_*.png (серый _off — сайт
    // выключен): там должны лежать наши картинки, а не щит uBO.
    const same = async (a, b) => Buffer.compare(await fs.readFile(path.join(EXT, a)), await fs.readFile(path.join(DEV, '..', b))) === 0;
    check('значок на панели — наш и во включённом, и в выключенном виде',
        await same('img/icon_16.png', 'platform/icons/icon16.png') && await same('img/icon_16_off.png', 'platform/icons/icon16-off.png') &&
        await same('img/icon_128_off.png', 'platform/icons/icon128-off.png'), null);

    const isOurs = w => w.url().endsWith('/ygab/background.js');
    let worker = context.serviceWorkers().find(isOurs);
    if (!worker) worker = await context.waitForEvent('serviceworker', { predicate: isOurs, timeout: 15000 });
    check('фон запустился', worker);
    const id = new URL(worker.url()).host;
    const identity = JSON.parse(await fs.readFile(path.join(DEV, '..', 'platform', 'identity.json'), 'utf8'));
    check('номер расширения постоянный (key в манифесте), команд движка нет', id === identity.id && manifest.key === identity.key && Object.keys(manifest.commands || {}).length === 0, { id, expected: identity.id, commands: manifest.commands });

    // --- первый запуск: страница открылась сама и настроила движок
    const isWelcome = p => p.url().endsWith('/ygab/platform/welcome/welcome.html');
    let welcome = context.pages().find(isWelcome);
    if (!welcome) welcome = await context.waitForEvent('page', { predicate: isWelcome, timeout: 10000 }).catch(() => null);
    check('после установки открылась страница первого запуска', welcome, context.pages().map(p => p.url()));
    if (welcome) {
        await welcome.waitForFunction(() => document.getElementById('setup').dataset.state, null, { timeout: 15000 }).catch(() => {});
        const state = await welcome.evaluate(() => ({ state: document.getElementById('setup').dataset.state, text: document.getElementById('setup').textContent }));
        check('страница первого запуска: фильтры настроены', state.state === 'ok', state);
        const setup = await welcome.evaluate(async () => ({
            rulesets: await chrome.runtime.sendMessage({ what: 'getEnabledRulesets' }),
            autoReload: (await chrome.runtime.sendMessage({ what: 'getOptionsPageData' })).autoReload,
            stored: (await chrome.storage.local.get('ygab.setup'))['ygab.setup']
        }));
        check('RU AdList (rus-0) включён при английском браузере', setup.rulesets.includes('rus-0'), setup.rulesets);
        check('автоперезагрузка движка выключена', setup.autoReload === false, setup.autoReload);
        check('«Раздражители»: включены cookie, всплывашки, уведомления и ИИ-помощники — чаты, соцсети и «прочее» нет',
            ['annoyances-cookies', 'annoyances-overlays', 'annoyances-notifications', 'annoyances-ai'].every(id => setup.rulesets.includes(id)) &&
            !setup.rulesets.some(id => /^annoyances-(social|widgets|others)$/.test(id)) && !setup.rulesets.includes('rus-1'), setup.rulesets);
        check('шаги настройки записаны', setup.stored && setup.stored.step === 3, setup.stored);

        // Сделанный шаг не повторяется: выбор пользователя не перезаписываем.
        const again = await welcome.evaluate(async () => {
            const enabled = await chrome.runtime.sendMessage({ what: 'getEnabledRulesets' });
            await chrome.runtime.sendMessage({ what: 'applyRulesets', enabledRulesets: enabled.filter(id => id !== 'rus-0') });
            return true;
        });
        await welcome.reload();
        await welcome.waitForFunction(() => document.getElementById('setup').dataset.state, null, { timeout: 15000 }).catch(() => {});
        const after = await welcome.evaluate(() => chrome.runtime.sendMessage({ what: 'getEnabledRulesets' }));
        check('повторное открытие не включает обратно то, что пользователь выключил', again && !after.includes('rus-0'), after);
        await welcome.evaluate(async () => {
            const enabled = await chrome.runtime.sendMessage({ what: 'getEnabledRulesets' });
            await chrome.runtime.sendMessage({ what: 'applyRulesets', enabledRulesets: enabled.concat('rus-0') });
        });
    }

    // Страница расширения — отсюда сообщения проходят проверку доверия uBO Lite.
    const popup = await context.newPage();
    const popupErrors = [];
    popup.on('pageerror', error => popupErrors.push(String(error.message || error)));
    await popup.goto(`chrome-extension://${id}/ygab/platform/popup/popup.html`);
    await popup.waitForTimeout(1000);
    check('наш попап открылся без ошибок', popupErrors.length === 0 && await popup.locator('body').count() === 1, popupErrors);

    const engine = await popup.evaluate(async () => ({
        mode: await chrome.runtime.sendMessage({ what: 'getDefaultFilteringMode' }),
        rulesets: await chrome.runtime.sendMessage({ what: 'getEnabledRulesets' }),
        dnr: await chrome.declarativeNetRequest.getEnabledRulesets()
    }));
    check('движок uBO Lite отвечает на сообщения', typeof engine.mode === 'number', engine.mode);
    check('наборы правил по умолчанию включены (easylist, ublock-filters)',
        Array.isArray(engine.dnr) && engine.dnr.includes('easylist') && engine.dnr.includes('ublock-filters'), engine.dnr);

    const ours = await popup.evaluate(async () => ({
        alarm: await chrome.alarms.get('ygab:update-check'),
        settings: await chrome.storage.sync.get(null)
    }));
    check('наш фон отработал установку: будильник проверки обновлений есть', ours.alarm && ours.alarm.periodInMinutes === 24 * 60, ours.alarm);

    // Наши сообщения uBO Lite не перехватывает: ответа от него нет.
    const passthrough = await popup.evaluate(async () => {
        const reply = await chrome.runtime.sendMessage({ what: 'ygab:ping' }).catch(e => 'error: ' + e.message);
        return reply === undefined ? 'no-reply' : reply;
    });
    check("сообщение 'ygab:…' uBO Lite не перехватывает", passthrough === 'no-reply' || /Receiving end|port closed/.test(String(passthrough)), passthrough);

    // Сеть: рекламный скрипт не доходит до сервера Google. Движок его либо
    // блокирует, либо (как uBO для adsbygoogle.js) подменяет безвредной
    // заглушкой из своих web_accessible_resources.
    await context.route(PAGE_URL, route => route.fulfill({ contentType: 'text/html', body: PAGE_HTML }));
    const page = await context.newPage();
    const seen = { reachedGoogle: false, surrogate: false, blocked: false };
    page.on('response', response => {
        if (response.url().startsWith(AD_SCRIPT)) seen.reachedGoogle = true;
        if (response.url().startsWith(`chrome-extension://${id}/web_accessible_resources/`)) seen.surrogate = true;
    });
    page.on('requestfailed', request => {
        if (request.url().startsWith(AD_SCRIPT) && /BLOCKED_BY_CLIENT/.test((request.failure() || {}).errorText || '')) seen.blocked = true;
    });
    await page.goto(PAGE_URL, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    check('рекламный скрипт Google не дошёл до сервера (заблокирован или подменён заглушкой)',
        !seen.reachedGoogle && (seen.surrogate || seen.blocked), seen);

    // --- серая «C» там, где расширение не работает (служебные страницы).
    // Картинку значка не прочитать — записываем вызовы setIcon в фоне.
    await worker.evaluate(() => {
        self.iconCalls = [];
        const original = chrome.action.setIcon.bind(chrome.action);
        chrome.action.setIcon = details => {
            self.iconCalls.push({ tabId: details.tabId, off: String(details.path[16]).includes('_off') });
            return original(details);
        };
    });
    const service = await context.newPage();
    await service.goto('chrome://version');
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(500);
    const pageTab = await popup.evaluate(async url => (await chrome.tabs.query({ url: url + '*' }))[0].id, PAGE_URL);
    const iconCalls = await worker.evaluate(() => self.iconCalls);
    check('значок: на служебной странице серый, на обычном сайте — нет',
        iconCalls.some(call => call.off && call.tabId !== pageTab) && !iconCalls.some(call => call.off && call.tabId === pageTab), iconCalls);
    await service.close();

    // --- попап: «работает на этом сайте»
    const tabId = await popup.evaluate(async url => (await chrome.tabs.query({ url: url + '*' }))[0].id, PAGE_URL);
    const panel = await context.newPage();
    const panelErrors = [];
    panel.on('pageerror', error => panelErrors.push(String(error.message || error)));
    await panel.goto(`chrome-extension://${id}/ygab/platform/popup/popup.html?tab=${tabId}`);
    await panel.waitForFunction(() => !document.getElementById('siteOn').disabled, null, { timeout: 5000 }).catch(() => {});
    const before = await panel.evaluate(() => ({
        host: document.getElementById('host').textContent,
        on: document.getElementById('siteOn').checked,
        state: document.getElementById('siteState').textContent,
        games: !document.getElementById('games').hidden
    }));
    check('попап: сайт вкладки, расширение на нём работает, блока игр нет', before.host === 'test.example' && before.on && !before.games, before);

    await panel.click('label.switch');
    await panel.waitForFunction(() => !document.getElementById('siteNote').hidden, null, { timeout: 5000 }).catch(() => {});
    const off = await panel.evaluate(async () => ({
        on: document.getElementById('siteOn').checked,
        note: document.getElementById('siteNote').hidden ? null : document.getElementById('siteNoteText').textContent,
        level: await chrome.runtime.sendMessage({ what: 'getFilteringMode', hostname: 'test.example' }),
        offSites: (await chrome.storage.local.get('ygab.offSites'))['ygab.offSites'],
        since: (await chrome.storage.local.get('ygab.offSince'))['ygab.offSince'],
        state: document.getElementById('siteState').textContent
    }));
    check('выключить на сайте: движок в режиме «без фильтрации», сайт в нашем списке, есть строка про обновление',
        !off.on && off.level === 0 && Array.isArray(off.offSites) && off.offSites.includes('test.example') && off.note, off);
    // Забытое выключение видно: в попапе — с какого дня.
    check('выключить на сайте: дата выключения запомнена и видна в попапе',
        off.since && typeof off.since['test.example'] === 'number' && /^Выключено на этом сайте с \d{2}\.\d{2}$/.test(off.state), off);

    const seenOff = { surrogate: false, googleResponse: false };
    const onResponse = response => {
        if (response.url().startsWith(`chrome-extension://${id}/web_accessible_resources/`)) seenOff.surrogate = true;
        if (response.url().startsWith(AD_SCRIPT)) seenOff.googleResponse = true;
    };
    page.on('response', onResponse);
    // Не ждём load: скрипт теперь идёт в настоящую сеть и может грузиться
    // долго. Достаточно увидеть сам запрос и дать движку время на подмену.
    const adRequest = page.waitForEvent('request', { predicate: r => r.url().startsWith(AD_SCRIPT), timeout: 15000 }).catch(() => null);
    // Скрипт Google в заголовке без движка грузится из сети и держит
    // DOMContentLoaded — ждём только начала навигации.
    await page.reload({ waitUntil: 'commit' });
    await adRequest;
    await page.waitForTimeout(2000);
    page.off('response', onResponse);
    check('после обновления выключенного сайта рекламный скрипт движок не трогает', !seenOff.surrogate, seenOff);

    await panel.click('label.switch');
    await panel.waitForTimeout(800);
    const on = await panel.evaluate(async () => ({
        on: document.getElementById('siteOn').checked,
        level: await chrome.runtime.sendMessage({ what: 'getFilteringMode', hostname: 'test.example' }),
        defaultLevel: await chrome.runtime.sendMessage({ what: 'getDefaultFilteringMode' }),
        offSites: (await chrome.storage.local.get('ygab.offSites'))['ygab.offSites']
    }));
    check('включить обратно: режим движка по умолчанию, сайта нет в нашем списке',
        on.on && on.level === on.defaultLevel && !(on.offSites || []).includes('test.example'), on);

    // --- выключен родительский домен: включение сайта снимает и его,
    // иначе движок оставил бы поддомен выключенным, а наш слой включил бы
    await panel.evaluate(async () => {
        await chrome.runtime.sendMessage({ what: 'setFilteringMode', hostname: 'example', level: 0 });
        await chrome.storage.local.set({ 'ygab.offSites': ['example'] });
    });
    await panel.reload();
    await panel.waitForFunction(() => !document.getElementById('siteOn').disabled, null, { timeout: 5000 }).catch(() => {});
    const parentOff = await panel.evaluate(() => ({ on: document.getElementById('siteOn').checked, counters: Boolean(document.getElementById('stats')) }));
    await panel.click('label.switch');
    await panel.waitForFunction(() => !document.getElementById('siteNote').hidden, null, { timeout: 5000 }).catch(() => {});
    const parentOn = await panel.evaluate(async () => ({
        on: document.getElementById('siteOn').checked,
        note: document.getElementById('siteNoteText').textContent,
        parentLevel: await chrome.runtime.sendMessage({ what: 'getFilteringMode', hostname: 'example' }),
        level: await chrome.runtime.sendMessage({ what: 'getFilteringMode', hostname: 'test.example' }),
        offSites: (await chrome.storage.local.get('ygab.offSites'))['ygab.offSites']
    }));
    check('выключен родительский домен: попап показывает «выключено»; счётчиков в попапе нет', !parentOff.on && !parentOff.counters, parentOff);
    check('включение сайта снимает выключение и с родительского домена — у движка и у нас', parentOn.on && parentOn.parentLevel !== 0 && parentOn.level !== 0 &&
        !(parentOn.offSites || []).length && /всём example/.test(parentOn.note), parentOn);

    // --- «Сообщить о проблеме» есть и на обычном сайте
    // Читать буфер обмена в тестовом браузере нельзя — перехватываем запись.
    await panel.evaluate(() => {
        document.getElementById('reportBox').open = true;
        navigator.clipboard.writeText = text => { window.copiedText = text; return Promise.resolve(); };
    });
    await panel.click('#report');
    await panel.waitForTimeout(800);
    const reportState = await panel.evaluate(async () => {
        const box = document.getElementById('reportBox');
        let copied = null;
        try { copied = JSON.parse(window.copiedText); } catch (e) { copied = String(e.message || e); }
        return { visible: !box.hidden && box.offsetParent !== null, insideGames: Boolean(box.closest('#games')), button: document.getElementById('report').textContent, copied };
    });
    check('«Сообщить о проблеме» на обычном сайте: раздел виден, отчёт с движком и сайтом',
        reportState.visible && !reportState.insideGames && reportState.copied && reportState.copied.product === 'Cleathernet' &&
        reportState.copied.site && reportState.copied.site.host === 'test.example' && Array.isArray(reportState.copied.engine.rulesets), reportState);
    check('попап без ошибок в консоли', panelErrors.length === 0, panelErrors);

    // --- свои настройки вместо панели uBO Lite
    check('настройки — наша страница, не панель uBO Lite', manifest.options_page === 'ygab/platform/settings/settings.html', manifest.options_page);
    await panel.click('label.switch');
    await panel.waitForTimeout(800);
    const settings = await context.newPage();
    const settingsErrors = [];
    settings.on('pageerror', error => settingsErrors.push(String(error.message || error)));
    await settings.goto(`chrome-extension://${id}/ygab/platform/settings/settings.html`);
    await settings.waitForSelector('[data-ruleset="annoyances-cookies"]', { timeout: 5000 }).catch(() => {});
    await settings.waitForTimeout(500);
    const page1 = await settings.evaluate(() => ({
        text: document.body.innerText,
        cookies: document.querySelector('[data-ruleset="annoyances-cookies"]')?.checked,
        notifications: document.querySelector('[data-ruleset="annoyances-notifications"]')?.checked,
        social: document.querySelector('[data-ruleset="annoyances-social"]')?.checked,
        ru: document.querySelector('[data-ruleset="rus-0"]')?.checked,
        sites: Array.from(document.querySelectorAll('#offSites li span')).map(el => el.textContent),
        since: Array.from(document.querySelectorAll('#offSites li .site-row__since')).map(el => el.textContent),
        engine: document.getElementById('engineVersion').textContent
    }));
    check('настройки: без режимов фильтрации, списки отмечены как в движке',
        !/Полный|Оптимальный|Базовый|разработчик/i.test(page1.text) && page1.cookies === true && page1.notifications === true && page1.social === false && page1.ru === true && /^\d{4}\./.test(page1.engine), { ...page1, text: undefined });
    check('настройки: выключенный сайт в списке, с датой', page1.sites.includes('test.example') && page1.since.some(t => /^с \d{2}\.\d{2}$/.test(t)), { sites: page1.sites, since: page1.since });

    await settings.click('[data-ruleset="annoyances-social"]');
    await settings.waitForTimeout(1000);
    const afterToggle = await settings.evaluate(() => chrome.runtime.sendMessage({ what: 'getEnabledRulesets' }));
    check('настройки: переключатель списка меняет наборы движка', afterToggle.includes('annoyances-social'), afterToggle);

    await settings.click('#offSites .site-row__button');
    await settings.waitForTimeout(1000);
    const reEnabled = await settings.evaluate(async () => ({
        level: await chrome.runtime.sendMessage({ what: 'getFilteringMode', hostname: 'test.example' }),
        defaultLevel: await chrome.runtime.sendMessage({ what: 'getDefaultFilteringMode' }),
        offSites: (await chrome.storage.local.get('ygab.offSites'))['ygab.offSites'],
        empty: !document.getElementById('offEmpty').hidden
    }));
    check('настройки: «Включить» возвращает сайт', reEnabled.level === reEnabled.defaultLevel && !(reEnabled.offSites || []).includes('test.example') && reEnabled.empty, reEnabled);
    check('настройки без ошибок в консоли', settingsErrors.length === 0, settingsErrors);

    // Самопроверка: сама открывает сайт, собирает, что спрятано, — без
    // текста страницы и с укороченным адресом.
    const SELF_URL = 'https://selfcheck.example/news/2026/secret-letter-id';
    await context.route(SELF_URL, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body>
        <h1>Новости</h1><p>СЕКРЕТНЫЙТЕКСТ письма, который не должен попасть в файл самопроверки, даже если его много и он длинный.</p>
        <div class="ad-banner" style="width:300px;height:250px"><a href="https://ads.example/click"><img alt="" width="300" height="250" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="></a><span>Реклама</span></div>
        <p>Текст после рекламы.</p></body></html>` }));
    const selfcheck = await context.newPage();
    const selfErrors = [];
    selfcheck.on('pageerror', error => selfErrors.push(String(error.message || error)));
    await selfcheck.goto(`chrome-extension://${id}/ygab/platform/selfcheck/selfcheck.html?urls=${encodeURIComponent(SELF_URL)}&settle=1500`);
    await selfcheck.click('#start');
    await selfcheck.waitForFunction(() => document.body.dataset.done === '1', null, { timeout: 90000 }).catch(() => {});
    const selfReport = await selfcheck.evaluate(() => window.__selfcheck());
    const site = selfReport && selfReport.sites[0];
    check('самопроверка: открыла сайт и собрала спрятанное, вопросов нет',
        site && !site.error && site.hidden.length >= 1 && site.problems === 0 && site.hidden.every(h => typeof h.text === 'number' && typeof h.main === 'boolean'), site);
    check('самопроверка: в файле нет текста страницы, адрес укорочен',
        selfReport && !JSON.stringify(selfReport).includes('СЕКРЕТНЫЙТЕКСТ') && !JSON.stringify(selfReport).includes('secret-letter-id') && site && site.url === 'https://selfcheck.example/news/…', site && site.url);
    check('самопроверка без ошибок в консоли', selfErrors.length === 0, selfErrors);
} catch (error) {
    check('тест не упал', false, String(error.message || error).slice(0, 300));
} finally {
    await context.close();
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}

const passed = results.filter(r => r.ok).length;
console.log(`\nИтого: ${passed} из ${results.length}`);
process.exit(passed === results.length ? 0 : 1);
