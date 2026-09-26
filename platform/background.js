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
