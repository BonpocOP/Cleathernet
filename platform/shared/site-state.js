// «Где мы работаем» — одно место на всю сборку Cleathernet: общий
// выключатель, сайты, где расширение выключено, и подписка на их
// изменения. Пользуются попап, настройки и скрипты страниц (модули).
//
// Слой Яндекс.Игр (src/) — исключение: у него своя копия той же логики
// (src/content/config.js, state.js, main.js, src/frame.js), её не трогаем.
// Ключи у всех одни и те же — это сверяет dev/test-build.mjs.
//
// ES-модуль без импортов: страницы расширения импортируют его, а в бандлы
// скриптов страниц dev/build.mjs вклеивает его текст, сняв export.

// Сайты, где расширение выключено, — в local, как у движка: через sync
// слои расходились на другом устройстве.
export const OFF_SITES_KEY = 'ygab.offSites';
// Общий выключатель (попап расширения для игр) — в sync.
export const ENABLED_KEY = 'enabled';

// Запись накрывает сайт и все его поддомены.
export const covers = (site, host) => host === site || host.endsWith('.' + site);
export const isOff = (offSites, host) => offSites.some(site => covers(site, host));

const asList = value => (Array.isArray(value) ? value : []);

export async function readOffSites() {
    const stored = await chrome.storage.local.get({ [OFF_SITES_KEY]: [] });
    return asList(stored[OFF_SITES_KEY]);
}

// Когда сайт выключили: { сайт: время }. Отдельным ключом — список сайтов
// читает и слой Игр, его формат не меняем. Выключенный и забытый сайт
// выглядит как «блокировщик не работает» (10.10: VK и mail.ru), поэтому
// попап и настройки показывают, с какого дня сайт выключен.
export const OFF_SINCE_KEY = 'ygab.offSince';

export async function readOffSince() {
    const stored = await chrome.storage.local.get({ [OFF_SINCE_KEY]: {} });
    const since = stored[OFF_SINCE_KEY];
    return since && typeof since === 'object' ? since : {};
}

export async function writeOffSites(list) {
    const before = await readOffSince();
    const since = {};
    for (const site of list) {
        since[site] = before[site] || Date.now();
    }
    await chrome.storage.local.set({ [OFF_SITES_KEY]: list, [OFF_SINCE_KEY]: since });
}

// «с 08.10» — для подписи; у выключенных до 10.10 даты нет.
export const sinceText = time => (time ? 'с ' + new Date(time).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '');

// Для скриптов страницы: onChange(active) — при старте и при каждом
// изменении; active — расширение включено и сайт host не выключен.
// После перезагрузки расширения chrome.* в старой копии скрипта бросает
// исключения — вызывать внутри try.
export function watchActive(host, onChange) {
    let offSites = [];
    let enabled = true;
    const emit = () => onChange(enabled !== false && !isOff(offSites, host));
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && OFF_SITES_KEY in changes) {
            offSites = asList(changes[OFF_SITES_KEY].newValue);
            emit();
        } else if (area === 'sync' && ENABLED_KEY in changes) {
            enabled = changes[ENABLED_KEY].newValue;
            emit();
        }
    });
    chrome.storage.local.get({ [OFF_SITES_KEY]: [] }, local => {
        offSites = asList(local[OFF_SITES_KEY]);
        chrome.storage.sync.get({ [ENABLED_KEY]: true }, sync => {
            enabled = sync[ENABLED_KEY];
            emit();
        });
    });
}
