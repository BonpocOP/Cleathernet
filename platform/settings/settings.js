// Своя страница настроек вместо панели uBO Lite.
//
// Здесь только то, что безопасно менять: функции из каталога (списки
// движка, рекламные функции браузера) и сайты, где расширение выключено.
// Режимов фильтрации нет намеренно: «Полный» прячет приманки детекторов,
// и нас начинают замечать. Панель uBO Lite
// остаётся в архиве (GPLv3), но мы на неё не ссылаемся.

import { OFF_SITES_KEY, readOffSites, writeOffSites, readOffSince, sinceText } from '../shared/site-state.js';
import { loadCatalog, renderSections } from '../shared/features-ui.js';

const $ = id => document.getElementById(id);
const send = message => chrome.runtime.sendMessage(message);

let statusTimer = 0;
function status(text) {
    $('status').textContent = text;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { $('status').textContent = ''; }, 2500);
}

/* ---------- где выключено ---------- */

// Выключенные сайты — из двух мест: наш список и сайты без фильтрации у
// движка. Обычно совпадают; расходятся, если сайт выключали в его панели.
async function offSites() {
    const [ours, modes] = await Promise.all([
        readOffSites(),
        send({ what: 'getFilteringModeDetails' })
    ]);
    const engine = (modes && Array.isArray(modes.none) ? modes.none : []).filter(host => host !== 'all-urls');
    return [...new Set(ours.concat(engine))].sort();
}

async function enableSite(host) {
    const level = await send({ what: 'getDefaultFilteringMode' });
    await send({ what: 'setFilteringMode', hostname: host, level });
    await writeOffSites((await readOffSites()).filter(site => site !== host));
}

async function renderOffSites() {
    const [hosts, offSince] = await Promise.all([offSites(), readOffSince()]);
    const container = $('offSites');
    container.textContent = '';
    $('offEmpty').hidden = hosts.length !== 0;
    for (const host of hosts) {
        const item = document.createElement('li');
        item.className = 'site-row';
        const name = document.createElement('span');
        name.textContent = host;
        const since = document.createElement('small');
        since.className = 'site-row__since';
        since.textContent = sinceText(offSince[host]);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'site-row__button';
        button.textContent = 'Включить';
        button.addEventListener('click', async () => {
            button.disabled = true;
            try {
                await enableSite(host);
                status(`На ${host} снова работает`);
            } catch {
                status('Не удалось включить');
            }
            renderOffSites();
        });
        item.append(name, since, button);
        container.append(item);
    }
}

/* ---------- старт ---------- */

// Флажки — из каталога функций (platform/features.json, shared/features-ui.js).
renderSections(await loadCatalog(), $('features'), status);
renderOffSites();
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && OFF_SITES_KEY in changes) {
        renderOffSites();
    }
});

fetch('../engine.json')
    .then(response => response.json())
    .then(engine => { $('engineVersion').textContent = engine.version; })
    .catch(() => {});
