// Фон сборки-обёртки: то, чего нет у расширения для игр.
//
// После установки открываем страницу первого запуска. Она же применяет
// наши настройки движка (platform/setup.js): из фона это сделать нельзя,
// движок принимает такие сообщения только от страниц расширения.

import { worksOn, icon } from './pages.js';

chrome.runtime.onInstalled.addListener(details => {
    if (details.reason === 'install') {
        chrome.tabs.create({ url: chrome.runtime.getURL('ygab/platform/welcome/welcome.html') })
            .catch(() => { /* не открылась — настройку сделает попап */ });
    }
});

// Серая «C» там, где расширение не работает: на служебных страницах и в
// магазине Chrome. Движок красит значок только по сигналу своего скрипта
// со страницы, а сюда его скрипт не попадает. Адрес служебной страницы без
// разрешения tabs нам не виден (url пустой) — это тоже «не работает».
// Значок для вкладки браузер сбрасывает при переходе, поэтому ставим его
// после каждой загрузки.
function markTab(tab) {
    let url = null;
    try {
        url = tab.url ? new URL(tab.url) : null;
    } catch { /* не адрес — считаем служебной */ }
    if (!worksOn(url)) {
        chrome.action.setIcon({ tabId: tab.id, path: icon(false) }).catch(() => {});
    }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status === 'complete') {
        markTab(tab);
    }
});

// Вкладки, открытые до запуска фона (установка, обновление, перезапуск).
chrome.tabs.query({}).then(tabs => tabs.forEach(markTab)).catch(() => {});

// Незаметное скрытие для общего механизма (generic/apply.js): таблица
// стилей пользователя для документа, из которого пришло сообщение. Ни в
// разметке, ни в document.styleSheets её не видно. Сначала вставляем
// новую, потом убираем старую — реклама не мигает.
//
// Что вставлено в какую вкладку, записываем в storage.local: таблица
// переживает перезагрузку и обновление расширения, а скрипт на открытой
// вкладке после них уже не слышит расширение — ни выключение на сайте,
// ни сдвиги ленты (пути по номерам начали бы указывать на контент). Новый
// фон снимает такие таблицы сам (ниже, onInstalled). Ключ — на вкладку:
// сообщения разных вкладок не затирают друг друга.
const CSS_KEY = 'ygab.css.';

chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || message.what !== 'ygab:css' || !sender.tab) {
        return false;
    }
    const target = sender.documentId
        ? { tabId: sender.tab.id, documentIds: [sender.documentId] }
        : { tabId: sender.tab.id, frameIds: [sender.frameId || 0] };
    const key = CSS_KEY + sender.tab.id;
    (async () => {
        if (message.add) {
            await chrome.scripting.insertCSS({ target, css: message.add, origin: 'USER' });
        }
        if (message.remove && message.remove !== message.add) {
            await chrome.scripting.removeCSS({ target, css: message.remove, origin: 'USER' });
        }
        if (message.add) {
            await chrome.storage.local.set({ [key]: { target, css: message.add } });
        } else {
            await chrome.storage.local.remove(key);
        }
    })().then(() => respond(true), () => respond(false));
    return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
    chrome.storage.local.remove(CSS_KEY + tabId).catch(() => {});
});

// Снять таблицы, оставшиеся от прежнего экземпляра расширения. После
// перезапуска браузера документов тех вкладок уже нет — записи просто
// стираем.
async function dropLeftoverCss({ remove }) {
    const stored = await chrome.storage.local.get(null);
    const keys = Object.keys(stored).filter(key => key.startsWith(CSS_KEY));
    if (remove) {
        await Promise.all(keys.map(key => {
            const { target, css } = stored[key] || {};
            return target && css
                ? chrome.scripting.removeCSS({ target, css, origin: 'USER' }).catch(() => { /* документа уже нет */ })
                : null;
        }));
    }
    await chrome.storage.local.remove(keys);
}

chrome.runtime.onInstalled.addListener(() => {
    dropLeftoverCss({ remove: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
    dropLeftoverCss({ remove: false }).catch(() => {});
});
