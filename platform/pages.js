// Где расширение вообще может работать — общее для попапа и фона.
//
// Только обычные сайты (http/https). Служебные страницы браузера
// (chrome://, новая вкладка, страницы расширений) закрыты для расширений,
// магазин Chrome — тоже, хотя адрес у него обычный.

const isStore = url => url.hostname === 'chromewebstore.google.com'
    || (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'));

export function worksOn(url) {
    return Boolean(url && /^https?:$/.test(url.protocol) && !isStore(url));
}

// Картинки — наши, на месте img/ движка (сборка подменяет их).
export const icon = on => Object.fromEntries([16, 32, 64, 128].map(size => [size, `/img/icon_${size}${on ? '' : '_off'}.png`]));
