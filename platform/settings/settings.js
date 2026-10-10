// Своя страница настроек вместо панели uBO Lite.
//
// Здесь только то, что безопасно менять: дополнительные списки и сайты,
// где расширение выключено. Режимов фильтрации нет намеренно: «Полный»
// прячет приманки детекторов, и нас начинают замечать. Панель uBO Lite
// остаётся в архиве (GPLv3), но мы на неё не ссылаемся.

import { OFF_SITES_KEY, readOffSites, writeOffSites, readOffSince, sinceText } from '../shared/site-state.js';

const $ = id => document.getElementById(id);
const send = message => chrome.runtime.sendMessage(message);

let statusTimer = 0;
function status(text) {
    $('status').textContent = text;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { $('status').textContent = ''; }, 2500);
}

/* ---------- списки ---------- */

async function setRuleset(id, on) {
    const enabled = await send({ what: 'getEnabledRulesets' });
    const next = on
        ? [...new Set(enabled.concat(id))]
        : enabled.filter(item => item !== id);
    await send({ what: 'applyRulesets', enabledRulesets: next });
}

// Флажки — из каталога функций (platform/features.json): разделы и
// функции. Пока все функции — наборы движка (type: ruleset).
function renderSections(catalog, container, enabled) {
    container.textContent = '';
    for (const section of catalog.sections) {
        const card = document.createElement('section');
        card.className = 'card';
        card.dataset.section = section.id;
        const heading = document.createElement('h2');
        heading.textContent = section.title;
        const list = document.createElement('ul');
        list.className = 'toggles';
        card.append(heading, list);
        renderToggles(section.features.filter(feature => feature.type === 'ruleset'), list, enabled);
        container.append(card);
    }
}

function renderToggles(features, container, enabled) {
    container.textContent = '';
    for (const { ruleset: id, title: name, hint } of features) {
        const item = document.createElement('li');
        item.className = 'toggle';
        const label = document.createElement('label');
        label.className = 'toggle__label';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.ruleset = id;
        box.checked = enabled.includes(id);
        box.addEventListener('change', async () => {
            box.disabled = true;
            try {
                await setRuleset(id, box.checked);
                status(box.checked ? `«${name}» включено` : `«${name}» выключено`);
            } catch (e) {
                box.checked = !box.checked;
                status('Не удалось сохранить');
            } finally {
                box.disabled = false;
            }
        });
        const text = document.createElement('span');
        text.className = 'toggle__text';
        const title = document.createElement('span');
        title.className = 'toggle__name';
        title.textContent = name;
        const small = document.createElement('span');
        small.className = 'toggle__hint';
        small.textContent = hint;
        text.append(title, small);
        label.append(box, text);
        item.append(label);
        container.append(item);
    }
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

const [enabled, catalog] = await Promise.all([
    send({ what: 'getEnabledRulesets' }),
    fetch('../features.json').then(response => response.json())
]);
renderSections(catalog, $('features'), enabled);
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
