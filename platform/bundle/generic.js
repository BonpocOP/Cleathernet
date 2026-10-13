// Собрано dev/build.mjs из platform/generic/*.js — не править руками.
// Правки — в исходниках, затем `node dev/build.mjs`.
(() => {
'use strict';

// ===== platform/shared/site-state.js =====
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
const OFF_SITES_KEY = 'ygab.offSites';
// Общий выключатель (попап расширения для игр) — в sync.
const ENABLED_KEY = 'enabled';

// Запись накрывает сайт и все его поддомены.
const covers = (site, host) => host === site || host.endsWith('.' + site);
const isOff = (offSites, host) => offSites.some(site => covers(site, host));

const asList = value => (Array.isArray(value) ? value : []);

async function readOffSites() {
    const stored = await chrome.storage.local.get({ [OFF_SITES_KEY]: [] });
    return asList(stored[OFF_SITES_KEY]);
}

// Когда сайт выключили: { сайт: время }. Отдельным ключом — список сайтов
// читает и слой Игр, его формат не меняем. Выключенный и забытый сайт
// выглядит как «блокировщик не работает» (10.10: VK и mail.ru), поэтому
// попап и настройки показывают, с какого дня сайт выключен.
const OFF_SINCE_KEY = 'ygab.offSince';

async function readOffSince() {
    const stored = await chrome.storage.local.get({ [OFF_SINCE_KEY]: {} });
    const since = stored[OFF_SINCE_KEY];
    return since && typeof since === 'object' ? since : {};
}

async function writeOffSites(list) {
    const before = await readOffSince();
    const since = {};
    for (const site of list) {
        since[site] = before[site] || Date.now();
    }
    await chrome.storage.local.set({ [OFF_SITES_KEY]: list, [OFF_SINCE_KEY]: since });
}

// «с 08.10» — для подписи; у выключенных до 10.10 даты нет.
const sinceText = time => (time ? 'с ' + new Date(time).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '');

// Для скриптов страницы: onChange(active) — при старте и при каждом
// изменении; active — расширение включено и сайт host не выключен.
// После перезагрузки расширения chrome.* в старой копии скрипта бросает
// исключения — вызывать внутри try.
function watchActive(host, onChange) {
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

// ===== platform/generic/signs.js =====

// Признаки рекламы, общие для всех сайтов. Знаний о конкретных сайтах
// здесь нет (docs/rules-schema.md, «общий механизм»).

/* ---------- видимость следа ---------- */

// Видимый блок с содержимым — реклама, только если реклама в нём видна.
// След, которого не видно (пустой фрейм, спрятанная строка, скрипт), —
// признак лишь пустого места: иначе от пустой строки рекламы в списке
// писем мы поднялись бы до всего списка и спрятали его (mail.ru, 08.10).
// Поэтому функции ниже принимают visibleOnly — для непустых блоков.
const seen = (el, minArea = 1) => {
    if (!el.checkVisibility()) {
        return false;
    }
    const r = el.getBoundingClientRect();
    return r.width * r.height >= minArea;
};
// Рекламный узел сети меньше этого — пиксель учёта, а не реклама
// (тот же порог, что у приманок, slots.js bait).
const AD_MIN_AREA = 100 * 50;

/* ---------- слова в именах ---------- */

// Рекламные слова в class, id и data-*. Имя режется на слова по дефисам,
// подчёркиваниям и смене регистра: подстрокой искать нельзя — «ad» сидит в
// padding, header, gradient. Хеши в именах (ads-_45fbda8b…) не мешают.
const AD_WORDS = new Set([
    'ad', 'ads', 'adv', 'advert', 'adverts', 'advertising', 'advertisement',
    'adfox', 'rtb', 'adsbygoogle', 'sponsored', 'sponsor', 'commercial',
    'rekl', 'reklama'
]);
// «promo» двусмысленно (промо-страницы, промокоды): само по себе не
// признак, считается только дважды в одном блоке или рядом с другим.
const WEAK_WORDS = new Set(['promo']);
// Дешёвый отсев до разбора на слова: у большинства узлов разбирать нечего.
const NAME_HINT = /ad|rtb|sponsor|commercial|rekl|promo/i;

const words = value => value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);

// Сила имени узла: 2 — рекламное слово, 1 — слабое, 0 — ничего.
// Модификатор блока (БЭМ: «блок_модификатор», «блок--модификатор», где
// «блок» — тоже класс этого узла) описывает состояние блока, а не что он
// такое. Реклама помечается модификатором-«рекламой» (serp-item_type_ad,
// post--ad, card_is_sponsored); составной модификатор, где рекламное слово —
// одно из нескольких, — это контекст: у области письма mail.ru
// scrollable_top-line-adv-2pane — «вариант раскладки с полосой рекламы
// сверху» (10.10: пряталась вся область с письмом).
const MODIFIER_IDENTITY = new Set(['type', 'is', 'kind', 'view', 'mode', 'variant', 'format']);

function modifierOf(token, tokens) {
    let base = '';
    for (const other of tokens) {
        if (other !== token && other.length > base.length && (token.startsWith(other + '_') || token.startsWith(other + '--'))) {
            base = other;
        }
    }
    return base ? token.slice(base.length).replace(/^_|^--/, '') : null;
}

function classStrength(className) {
    const tokens = className.split(/\s+/).filter(Boolean);
    let best = 0;
    for (const token of tokens) {
        if (!NAME_HINT.test(token)) {
            continue;
        }
        const modifier = modifierOf(token, tokens);
        const list = words(modifier === null ? token : modifier);
        if (list.some(word => AD_WORDS.has(word))) {
            if (modifier === null || list.every(word => AD_WORDS.has(word) || MODIFIER_IDENTITY.has(word))) {
                return 2;
            }
            continue;
        }
        if (list.some(word => WEAK_WORDS.has(word))) {
            best = 1;
        }
    }
    return best;
}

function nameStrength(el, withData = false) {
    const className = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
    let best = className && NAME_HINT.test(className) ? classStrength(className) : 0;
    if (best === 2) {
        return 2;
    }
    const values = [el.id || ''];
    if (withData) {
        for (const attr of el.attributes) {
            if (attr.name.startsWith('data-') && attr.value.length < 80) {
                values.push(attr.value);
            }
        }
    }
    for (const value of values) {
        if (!value || !NAME_HINT.test(value)) {
            continue;
        }
        for (const word of words(value)) {
            if (AD_WORDS.has(word)) {
                return 2;
            }
            if (WEAK_WORDS.has(word)) {
                best = 1;
            }
        }
    }
    return best;
}

// Рекламные имена внутри блока: сколько сильных и слабых, и какой из
// сильных узлов самый внешний.
function namesIn(root, visibleOnly = false) {
    const out = { strong: 0, weak: 0, outer: null };
    const visit = el => {
        const s = nameStrength(el, true);
        if (s && visibleOnly && !seen(el)) {
            return;
        }
        if (s === 2) {
            out.strong += 1;
            if (!out.outer) {
                out.outer = el;
            }
        } else if (s === 1) {
            out.weak += 1;
        }
    };
    visit(root);
    for (const el of root.querySelectorAll('*')) {
        visit(el);
    }
    // Слабое слово в адресах ссылок (ref=…promo…) — тоже след.
    for (const a of root.querySelectorAll('a[href*="promo" i]')) {
        if (words(a.getAttribute('href')).some(w => WEAK_WORDS.has(w))) {
            out.weak += 1;
        }
    }
    return out;
}

// Контейнер, названный по рекламе, которую он содержит, — не реклама:
// mail.ru, 10.10 — прокручиваемая область письма с модификатором
// scrollable_top-line-adv-2pane («сверху полоса рекламы») держит письмо, а
// сама реклама — узел letter-list-item-adv внутри, в десятки раз меньше.
// У настоящей рекламной обёртки рекламный узел внутри с неё размером.
// Спрятанный (движком, соседом, нами) рекламный узел тоже в счёт: область
// письма проверяется раньше заготовки рекламы внутри неё, а заготовку к
// тому времени уже прячет движок.
const AD_NAME_NODES = ['ad', 'rtb', 'sponsor', 'commercial', 'rekl']
    .flatMap(w => [`[class*="${w}" i]`, `[id*="${w}" i]`]).join(', ');
const SMALLER_AD_SHARE = 0.5;

function holdsSmallerAd(outer) {
    const box = outer.getBoundingClientRect();
    const area = box.width * box.height;
    for (const el of outer.querySelectorAll(AD_NAME_NODES)) {
        if (nameStrength(el) !== 2) {
            continue;
        }
        const r = el.getBoundingClientRect();
        if (r.width * r.height < area * SMALLER_AD_SHARE || insideCollapsed(el)) {
            return true;
        }
    }
    return false;
}

/* ---------- закрытый теневой DOM ---------- */

// Страница может спрятать содержимое в закрытый shadow root — скрипты
// страницы его не видят (так рисует рекламу Яндекс: снаружи блок пустой).
// Расширению он доступен через chrome.dom. Без него (тесты в странице) —
// только открытые.
function shadowOf(el) {
    try {
        return chrome.dom.openOrClosedShadowRoot(el) || null;
    } catch {
        return el.shadowRoot || null;
    }
}

// Теневые корни внутри узла (и у него самого), без вложенных.
function shadowRootsIn(root) {
    const out = [];
    for (const el of [root, ...root.querySelectorAll('*')]) {
        const shadow = shadowOf(el);
        if (shadow) {
            out.push(shadow);
        }
    }
    return out;
}

// Текст теневого корня, который видно на экране (без style и script).
function shadowText(shadow) {
    let text = '';
    const walker = document.createTreeWalker(shadow, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const el = node.parentElement;
        if (el && !el.closest('style, script') && seen(el)) {
            text += node.nodeValue + ' ';
        }
    }
    return text.replace(/\s+/g, ' ').trim();
}

/* ---------- рекламные сети ---------- */

// Сайт может переименовать классы, но встроить рекламу сети, не оставив её
// следов, ему сложнее.
const NETWORK = /an\.yandex\.|yandex\.ru\/ads|adfox|doubleclick|googlesyndication|ad\.mail\.ru|ads\.vk\.com|criteo|taboola|yandexadexchange/i;
const NETWORK_NODES = [
    '[id*="_R-A-"]', '[id^="yandex_rtb"]', '[id^="adfox_"]', 'ins.adsbygoogle',
    // Слот рекламной сети с привязкой к домену (kinogo, 26.09).
    'ins[data-cp-host]',
    // Фавиконка Директа у объявлений в выдаче.
    '[style*="direct.yandex."]'
].join(', ');

// Номер рекламного блока Яндекса в id: R-A-… (РСЯ на сайтах), R-I-…
// (площадки самого Яндекса) — c любым разделителем и без него
// (search-list-4-R-I-48058-751, …9022689fR-I-142300-726). Это след
// рекламной системы, как узел сети. Отсев — селектором, точно — regex.
const BLOCK_ID = /R-[AI]-\d{3,}-\d+/;
const BLOCK_ID_NODES = '[id*="R-A-"], [id*="R-I-"]';
const isBlockId = el => BLOCK_ID.test(el.id);
const isNetworkNode = el => el.matches(NETWORK_NODES) || (el.matches(BLOCK_ID_NODES) && isBlockId(el));

// visibleOnly: только видимые узлы сети заметного размера; скрипт сам по
// себе не виден и тогда не считается.
function networkIn(root, visibleOnly = false) {
    const counts = el => !visibleOnly || seen(el, AD_MIN_AREA);
    if (root.matches(NETWORK_NODES) && counts(root)) {
        return true;
    }
    for (const node of root.querySelectorAll(NETWORK_NODES)) {
        if (counts(node)) {
            return true;
        }
    }
    if (root.matches(BLOCK_ID_NODES) && isBlockId(root) && counts(root)) {
        return true;
    }
    for (const node of root.querySelectorAll(BLOCK_ID_NODES)) {
        if (isBlockId(node) && counts(node)) {
            return true;
        }
    }
    for (const node of root.querySelectorAll(visibleOnly ? 'iframe[src]' : 'iframe[src], script[src]')) {
        if ((NETWORK.test(node.src) && counts(node)) || blockedFrame(node, visibleOnly)) {
            return true;
        }
    }
    // Рекламные серверы из списков движка (lists.js).
    return listAddressIn(root, visibleOnly);
}

/* ---------- ссылки учёта кликов ---------- */

// Переход через счётчик рекламной системы. erid — метка по закону о
// рекламе; её часто не ставят, поэтому она лишь один из признаков.
const TRACKING_LINKS = [
    'a[href*="/_sttc/"]', 'a[href*="yabs.yandex."]', 'a[href*="an.yandex."]',
    'a[href*="erid="]', 'a[href*="googleadservices."]', 'a[href*="/aclk?"]',
    'a[href*="doubleclick.net"]', 'a[href*="ads.vk.com"]', 'a[href*="ad.mail.ru"]'
].join(', ');

// Переход через адрес, который сетевые правила движка блокируют целиком,
// — тоже ссылка учёта (lists.js, blockedLinkIn); его спрашивает decide(),
// только когда он может решить.
const trackingIn = root => root.matches(TRACKING_LINKS) || Boolean(root.querySelector(TRACKING_LINKS));

/* ---------- метка «Реклама» ---------- */

// Отдельная короткая надпись, а не слово в тексте. Сама по себе ничего не
// решает (статья о рекламе, рубрика, ссылка «Реклама» на сайте): нужен
// второй признак.
// «На правах рекламы», «Партнёрский контент» — так помечают нативную
// рекламу российские издания (13.10, аудит: метка была, мы её не знали).
const LABELS = new Set(['реклама', 'соцреклама', 'промо', 'sponsored', 'advertisement', 'advertising', 'ad', 'ads', 'спонсор',
    'партнёрский материал', 'партнерский материал', 'на правах рекламы', 'партнёрский контент', 'партнерский контент',
    'спонсорский контент', 'sponsored content', 'promoted']);
// Украшения после метки: возрастная отметка и кнопка меню — «реклама ·
// 0+», «РЕКЛАМА •••», «Соцреклама ⋮» (Яндекс, 08–09.10).
const LABEL_TAIL = /(?:\s*(?:\d{1,2}\+|[·•⋮…|.]))+$/u;
// Латиница, похожая на кириллицу: «Pеклaмa» с подменой букв.
const HOMOGLYPHS = { a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', h: 'н', b: 'в' };
const INVISIBLE = /[​-‍⁠﻿­]/g;

function isLabelText(raw) {
    const text = raw.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (text.length < 2 || text.length > 22) {
        return false;
    }
    const bare = text.replace(LABEL_TAIL, '').trim();
    return [text, bare].some(t => LABELS.has(t) || LABELS.has(t.replace(/[aeopcxykmthb]/g, ch => HOMOGLYPHS[ch])));
}

// Подпись места: кнопка «Отключить рекламу» рядом с баннером — сайт сам
// говорит, что здесь реклама (klerk, 11.10: полоса над шапкой с картинкой
// и кнопкой, без метки «Реклама»). Метка — только кнопкой или ссылкой
// (заголовок статьи «Как отключить рекламу» — нет) и только рядом с
// креативом (placeCreative): страница подписки «Без рекламы» с той же
// кнопкой баннера не держит.
const PLACE_LABELS = new Set(['отключить рекламу', 'убрать рекламу']);

const isPlaceLabel = raw => PLACE_LABELS.has(raw.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().toLowerCase());

// Место — креатив (фрейм или заметная картинка, видео, холст внутри
// ссылки) и кнопки сайта; своего текста вне ссылок и кнопок почти нет.
// Статья «Как отключить рекламу» со ссылкой-скриншотом и той же кнопкой —
// абзацы текста, не место.
const PLACE_TEXT = 30;
const PLACE_CONTROLS = 'a, button, [role="button"], script, style, noscript, template';

function placeCreative(root, visibleOnly) {
    const counts = el => !visibleOnly || seen(el, AD_MIN_AREA);
    const creative = [...root.querySelectorAll('iframe')].some(counts) ||
        [...root.querySelectorAll('a[href] img, a[href] picture, a[href] video, a[href] canvas')].some(counts);
    if (!creative) {
        return false;
    }
    let text = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || parent.closest(PLACE_CONTROLS) || (visibleOnly && !parent.checkVisibility())) {
            continue;
        }
        text += node.nodeValue.trim().length;
        if (text > PLACE_TEXT) {
            return false;
        }
    }
    return true;
}

// Маркировка одной строкой — тоже метка: «Реклама. Рекламодатель ПАО …
// ИНН … erid …» (Авито, 10.10). Метка и данные рекламодателя двумя
// элементами уже были «меткой + маркировкой»; здесь то же, записанное в
// строку. Только если строка начинается с «Реклама» и сама — маркировка:
// цитата в тексте («Пример пометки: «Реклама. …»») не подходит.
const MARKING_LABEL_START = /^реклама[.,:]\s/i;

function isMarkingLabel(raw) {
    // Дешёвый отсев: проход по всей странице встречает тысячи текстов.
    if (raw.indexOf('еклам') === -1) {
        return false;
    }
    const text = raw.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    return text.length <= 200 && MARKING_LABEL_START.test(text) && MARKING.some(re => re.test(text));
}

// Маркировка строкой — метка, только если стоит на краю блока: первый или
// последний видимый текст. У рекламы подпись сверху или снизу (Авито —
// последняя строка карусели, Карты — значок в конце заголовка); пример
// маркировки в заметке стоит посередине текста (ловушка в test-generic).
const EDGE_SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

function atTextEdge(root, el) {
    const owners = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!node.nodeValue.trim() || !parent || EDGE_SKIP.has(parent.tagName) || !parent.checkVisibility()) {
            continue;
        }
        if (owners[owners.length - 1] !== parent) {
            owners.push(parent);
        }
    }
    const index = owners.findIndex(owner => owner === el || el.contains(owner) || owner.contains(el));
    return index === 0 || (index !== -1 && owners.slice(index).every(owner => owner === el || el.contains(owner)));
}

// Один и тот же сайт: kp.ru и www.kp.ru, news.site.ru и site.ru.
const sameSite = (a, b) => {
    a = a.replace(/^www\./, '');
    b = b.replace(/^www\./, '');
    return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
};

// Ссылка «Реклама» на свою же страницу («Реклама на сайте», «Рекламодателям»
// в подвале или меню) — навигация, а не метка рекламы (10.10, набор обычных
// страниц: так прятались подвал gazeta.ru и колонка vc.ru, а пункт меню,
// который сайт прячет сам, делал «сиротой» всё меню kp.ru). Навигация —
// короткая ссылка, пункт меню («Реклама», «Реклама на сайте»). Метка внутри
// ссылки-карточки (заголовок, адрес сайта, «Реклама») — часть рекламы, даже
// если ссылка ведёт на свой сайт: поисковики, агрегаторы и соцсети пускают
// переходы по рекламе через свой счётчик (Поиск Яндекса, 10.10: подсказки
// под строкой поиска, yandex.ru/search/_sttc/…).
const NAV_LINK_TEXT = 40;

const ownPageLink = el => {
    const link = el.closest('a[href]');
    if (!link || link.matches(TRACKING_LINKS) || (link.textContent || '').replace(/\s+/g, ' ').trim().length > NAV_LINK_TEXT) {
        return false;
    }
    try {
        return sameSite(new URL(link.href, location.href).hostname, location.hostname);
    } catch {
        return false;
    }
};

// Элементы-метки внутри узла: текст элемента целиком — метка (или
// маркировка одной строкой, начинающаяся с метки).
const SKIP_MARKING = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

// marking — куда сложить узлы с маркировкой без метки (поиск кандидатов,
// main.js): тот же обход текста, без второго.
function labelsIn(root, visibleOnly = false, marking = null) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.nodeValue;
        const el = node.parentElement;
        if (!el || value.length > 240) {
            continue;
        }
        if (marking && value.length > 20 && (value.indexOf('екламодат') !== -1 || value.indexOf('erid') !== -1) &&
            !SKIP_MARKING.has(el.tagName) && MARKING.some(re => re.test(value))) {
            marking.push(el);
        }
        const label = value.length <= 40
            ? (isLabelText(value) && isLabelText(el.textContent)) ||
                (isPlaceLabel(value) && isPlaceLabel(el.textContent) && Boolean(el.closest('button, a[href], [role="button"]')))
            : isMarkingLabel(value);
        if (label && !ownPageLink(el) && (!visibleOnly || seen(el))) {
            out.push(el);
        }
    }
    return out;
}

/* ---------- осиротевшая реклама ---------- */

// Движок или сосед спрятал только метку «Реклама», а сама реклама осталась
// видна — уже без пометки (Карты, 10.10: при втором заходе RU AdList
// прячет значок у плашки «Кешбэк»). Блок рекламы — ближайший видимый
// предок метки, где есть содержимое. Спрятанным должен быть только значок:
// без картинок и фреймов и почти без текста. Спрятанная целиком строка
// рекламы (mail.ru, 08.10: строка с фреймом в списке писем) — не сирота:
// реклама уже спрятана, а список вокруг — контент.
const ORPHAN_LEVELS = 10;
const ORPHAN_HIDDEN_MEDIA = 'img, video, canvas, iframe, picture, object, embed';

// Спрятанное — только значок: метка и украшения («· 0+», «•••»).
const ORPHAN_EXTRA = 8;
const ORPHAN_MAX_LINKS = 3;
// Короткий текст без картинок — полоска у подписи, а не сама реклама
// (тот же порог, что у labelOnly в slots.js).
const ORPHAN_STRIP_TEXT = 30;

function orphanUnit(label) {
    const text = label.textContent || '';
    if (label.checkVisibility() || !(isLabelText(text) || isMarkingLabel(text)) || ownPageLink(label)) {
        return null;
    }
    let hidden = label;
    for (let i = 0, node = label.parentElement; i < ORPHAN_LEVELS && node && node !== document.body; i += 1, node = node.parentElement) {
        if (!node.checkVisibility()) {
            hidden = node;
            continue;
        }
        const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
        // Пусто или полоска рядом с подписью («Больше квартир» у Авито —
        // сосед спрятал маркировку под ней) — сама реклама выше.
        if (text.length <= ORPHAN_STRIP_TEXT && ![...node.querySelectorAll(ORPHAN_HIDDEN_MEDIA)].some(sizable)) {
            continue;
        }
        // Реклама — одно действие (ссылка-две или кнопка); меню, подвал,
        // список ссылок — не сирота, даже если в нём спрятан пункт «Реклама».
        if (node.closest('nav, header, footer, [role="navigation"], [role="menu"]') || node.querySelectorAll('a[href]').length > ORPHAN_MAX_LINKS) {
            return null;
        }
        // node — блок с содержимым; спрятанная часть — только значок.
        const extra = (hidden.textContent || '').replace(/\s+/g, ' ').trim().length - (label.textContent || '').replace(/\s+/g, ' ').trim().length;
        return extra <= ORPHAN_EXTRA && !hidden.querySelector(ORPHAN_HIDDEN_MEDIA) ? node : null;
    }
    return null;
}

function orphanLabelIn(root) {
    for (const label of labelsIn(root)) {
        const unit = orphanUnit(label);
        if (unit && root.contains(unit)) {
            return true;
        }
    }
    return false;
}

// Метки и в закрытом теневом DOM внутри узла — только при оценке слота
// (verdict): на поиске кандидатов по всей странице это было бы дорого.
function labelsDeep(root, visibleOnly = false) {
    const out = labelsIn(root, visibleOnly);
    for (const shadow of shadowRootsIn(root)) {
        out.push(...labelsIn(shadow, visibleOnly));
    }
    return out;
}

/* ---------- маркировка по закону о рекламе ---------- */

// С 01.09.2022 интернет-реклама в России помечается: «Реклама.
// Рекламодатель ООО …», ИНН или ОГРН, токен erid. Признак слабый: не вся
// реклама маркируется, а в новости о законе тот же текст (решение 09.10:
// один из признаков, не основа). Шаблоны строгие: подвал сайта «ООО …,
// ОГРН … · Реклама» под них не подходит.
const MARKING = [
    /реклама[.,:]?\s+рекламодатель/i,
    /рекламодатель\s*[:—–-]?\s*(?:ооо|ао|пао|зао|ип|«)/i,
    /реклама[.,:]\s+(?:ооо|ао|пао|зао|ип)\s/i,
    /(?:^|[^a-z0-9])erid[\s:=]+[a-z0-9]{8,}/i
];

// Маркировка в видимом тексте узла и его закрытого теневого DOM.
function markingIn(root) {
    const texts = [root.innerText || ''];
    for (const shadow of shadowRootsIn(root)) {
        texts.push(shadowText(shadow));
    }
    return texts.some(text => MARKING.some(re => re.test(text)));
}

// ===== platform/generic/lists.js =====

// Признаки из списков движка (dev/list-signs.mjs): правила скрытия по
// адресу из рекламных наборов (ссылка, фрейм или картинка ведут на
// рекламный сервер) и адреса, которые сетевые правила блокируют целиком
// (ссылка учёта). Свой словарь сетей отстаёт: 10.10 баннер на klerk.ru
// вёл на bs.serving-sys.ru — в RU AdList он был, у нас нет. Данные
// вклеиваются при сборке; в git их нет — тогда признаки молчат.
//
// Не копируем ошибки списков: они прячут сам узел и оставляют пустую
// рамку (мы схлопываем место), и прячут ссылку внутри текста статьи —
// предложение рвётся (мы такую не трогаем, inlineInText).
const LISTS = null;

/* ---------- фильтр адресов (Блум) ---------- */

// Тот же хэш, что при сборке (dev/list-signs.mjs, fnv).
function fnvHash(s, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
}

// Биты раскрываются при первом вопросе: на большинстве страниц его нет.
let bloomBits = null;

function bloomHas(bloom, item) {
    if (!bloomBits) {
        const raw = atob(bloom.bits);
        bloomBits = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) {
            bloomBits[i] = raw.charCodeAt(i);
        }
    }
    const h1 = fnvHash(item, 2166136261);
    const h2 = fnvHash(item, 16777619) | 1;
    for (let i = 0; i < bloom.k; i += 1) {
        const bit = (h1 + Math.imul(i, h2) >>> 0) % bloom.m;
        if (!(bloomBits[bit >> 3] & (1 << (bit & 7)))) {
            return false;
        }
    }
    return true;
}

// Адрес и все его родительские домены: правило на ad.example.com
// действует и на x.ad.example.com.
function hostSuffixes(host) {
    const out = [];
    for (let h = host.toLowerCase(); h.includes('.'); h = h.slice(h.indexOf('.') + 1)) {
        out.push(h);
    }
    return out;
}

/* ---------- правила по адресу ---------- */

const RULE = /^(a|iframe|img)((?:\[[^\]]+\])+)(\s*>\s*img)?$/;
const CONDITION = /\[([a-z-]+)([*^$]?)="([^"]+)"(\s+i)?\]/g;
// Адрес в значении условия: «://bs.serving-sys.ru/», «https://ad.x.com/»,
// «.smartadserver.com», «clickbytes.ru/». Остальное («&maxads=») —
// подстрока без адреса.
const HOST_IN_VALUE = /^(?:https?)?:?(?:\/\/)?\.?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=[/?#:]|$)/i;
const URL_HOST = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#:]+)/i;

// Разбор правила — при сборке: dev/list-signs.mjs берёт эту функцию и
// кладёт итог в LISTS.rules. На странице разбор тысячи правил регулярками
// стоил 2,6–3,6 мс на каждой странице (Авито, 11.10). Итог: [селектор,
// тег, «> img», адрес сервера или '', условия [[атрибут, оператор, без
// учёта регистра, значение], …]].
function parseListRule(selector) {
    const m = RULE.exec(selector);
    if (!m) {
        return null;
    }
    const conds = [...m[2].matchAll(CONDITION)].map(c => [c[1], c[2], Boolean(c[4]), c[4] ? c[3].toLowerCase() : c[3]]);
    const keyed = m[1] === 'a' && conds.find(c => c[0] === 'href' && HOST_IN_VALUE.test(c[3]));
    return [selector, m[1], Boolean(m[3]), keyed ? HOST_IN_VALUE.exec(keyed[3])[1].toLowerCase() : '', conds];
}

const mainAttr = tag => (tag === 'a' ? 'href' : 'src');

// Отсев по тегу — тоже при сборке: одно выражение из строк всех правил
// тега по адресу — может ли хоть одно подойти (в 15 раз быстрее перебора:
// Авито, 1263 ссылки — 0,6 мс против 9). Исключения сайта в нём не
// вычитаются: отсев лишь пропускает лишнее, решают сами правила.
function listPrefilters(rules) {
    const out = {};
    for (const tag of ['a', 'iframe', 'img']) {
        out[tag] = rules.filter(r => r[1] === tag && !r[3])
            .flatMap(r => r[4].filter(c => c[0] === mainAttr(tag)).slice(0, 1))
            .map(c => c[3].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    }
    return out;
}

let listRules = undefined;

// Правила для этой страницы: без исключений сайта; на сайтах, где авторы
// списков отключили общие правила (generichide), — никаких. Ссылки с
// адресом сервера (их большинство) сверяем по указателю «адрес →
// правила»: на странице тысячи ссылок, и перебирать все правила для
// каждой дорого. Остальное (фреймы, картинки, подстроки) — по тегу:
// узел проверяется только правилами своего тега. Одним селектором на
// всю страницу нельзя: браузер проверяет каждое из сотен правил на
// каждом узле (Авито, 11.10: +30 мс).
function rulesHere() {
    if (listRules !== undefined) {
        return listRules;
    }
    listRules = null;
    if (!LISTS) {
        return null;
    }
    const here = hostSuffixes(location.hostname);
    if (here.some(h => LISTS.nohide.includes(h))) {
        return null;
    }
    const skip = new Set(here.flatMap(h => LISTS.exceptions[h] || []));
    const byHost = new Map();
    const loose = { a: [], iframe: [], img: [] };
    const always = { a: [], iframe: [], img: [] };
    const selectors = [];
    for (const [selector, tag, img, host, conds] of LISTS.rules) {
        if (skip.has(selector)) {
            continue;
        }
        selectors.push(selector);
        const rule = { conds, img };
        if (host) {
            if (!byHost.has(host)) {
                byHost.set(host, []);
            }
            byHost.get(host).push(rule);
            continue;
        }
        loose[tag].push(rule);
        // Правила без условия на адрес (onclick, data-href) проверяются
        // у каждого узла тега — но только если у него есть их атрибут.
        if (!conds.some(c => c[0] === mainAttr(tag))) {
            always[tag].push(rule);
        }
    }
    const alwaysAttrs = {};
    const prefilter = {};
    for (const tag of Object.keys(loose)) {
        alwaysAttrs[tag] = [...new Set(always[tag].flatMap(rule => rule.conds.map(c => c[0])))];
        prefilter[tag] = LISTS.prefilter[tag] ? new RegExp(LISTS.prefilter[tag], 'i') : null;
    }
    const find = [];
    if (byHost.size || loose.a.length) {
        find.push('a[href]');
    }
    if (loose.a.some(rule => rule.conds.some(c => c[0] !== 'href'))) {
        find.push('a[onclick]', 'a[data-href]');
    }
    for (const tag of ['iframe', 'img']) {
        if (loose[tag].length) {
            find.push(tag + '[src]');
        }
    }
    listRules = { byHost, loose, prefilter, always, alwaysAttrs, selectors, find: find.join(', ') };
    return listRules;
}

function conditionHolds(attrs, [attr, op, ci, expected]) {
    let value = attrs(attr);
    if (value === null) {
        return false;
    }
    if (ci) {
        value = value.toLowerCase();
    }
    return op === '*' ? value.includes(expected)
        : op === '^' ? value.startsWith(expected)
            : op === '$' ? value.endsWith(expected)
                : value === expected;
}

// Атрибуты узла читаем по разу, сколько бы правил их ни спрашивали.
function attrReader(el) {
    const cache = {};
    return name => (name in cache ? cache[name] : (cache[name] = el.getAttribute(name)));
}

const ruleHolds = (el, rule, attrs) => rule.conds.every(c => conditionHolds(attrs, c)) && (!rule.img || Boolean(el.querySelector(':scope > img')));

// Правила адреса ссылки (с родительскими доменами) — на адрес, а не на
// ссылку: на странице сотни ссылок на один адрес.
const hostRuleCache = new Map();

function rulesForHost(rules, host) {
    let list = hostRuleCache.get(host);
    if (list === undefined) {
        list = hostSuffixes(host).flatMap(h => rules.byHost.get(h) || []);
        hostRuleCache.set(host, list);
    }
    return list;
}

function listAddressMatch(el) {
    const rules = rulesHere();
    const tag = el.localName;
    if (!rules || !(tag in rules.loose)) {
        return false;
    }
    const attrs = attrReader(el);
    if (tag === 'a') {
        const m = URL_HOST.exec(attrs('href') || '');
        if (m && rulesForHost(rules, m[1]).some(rule => ruleHolds(el, rule, attrs))) {
            return true;
        }
    }
    const pre = rules.prefilter[tag];
    if (pre && pre.test(attrs(mainAttr(tag)) || '') && rules.loose[tag].some(rule => ruleHolds(el, rule, attrs))) {
        return true;
    }
    return rules.alwaysAttrs[tag].some(a => el.hasAttribute(a)) && rules.always[tag].some(rule => ruleHolds(el, rule, attrs));
}

// Найденное по спискам — на всё время страницы: признак «сеть» у слота
// сверяется с ним, а не ищется в каждом слоте заново.
const listHits = new Set();

// Поиск в scope (проход общего механизма, main.js candidates).
function findListAddress(scope) {
    const rules = rulesHere();
    if (!rules) {
        return [];
    }
    const out = [];
    if (!rules.find) {
        return out;
    }
    if (scope.matches && scope.matches(rules.find) && listAddressMatch(scope)) {
        out.push(scope);
    }
    for (const el of scope.querySelectorAll(rules.find)) {
        if (listAddressMatch(el)) {
            out.push(el);
        }
    }
    out.forEach(el => listHits.add(el));
    return out;
}

// Ссылка внутри текста: вокруг неё в том же абзаце есть свои слова
// (партнёрская ссылка в статье). Списки прячут и её — предложение
// рвётся; мы такую не трогаем: она часть текста, а не рекламное место.
const INLINE_TEXT_AROUND = 20;

function inlineInText(el) {
    const parent = el.parentElement;
    if (el.localName !== 'a' || !parent || !el.checkVisibility() || !getComputedStyle(el).display.startsWith('inline')) {
        return false;
    }
    return (parent.textContent || '').trim().length - (el.textContent || '').trim().length > INLINE_TEXT_AROUND;
}

// След рекламы по списку. Ссылку с картинкой и фрейм наша таблица
// (listAddressCss) прячет ещё до отрисовки — спрятанные, они и есть
// видимая реклама. Видимый узел — реклама, если он заметного размера
// или это ссылка-кнопка не внутри текста. Спрятанная картинка — нет:
// это может быть пиксель учёта внутри обычной карточки.
const CREATIVE_MEDIA = 'img, picture, video, iframe, canvas, object, embed';

function listCreative(el) {
    if (el.checkVisibility()) {
        if (inlineInText(el)) {
            return false;
        }
        // Строчная ссылка с баннером: её рамка — высотой со строку, а не
        // с картинку; размер — у самого креатива.
        return seen(el, AD_MIN_AREA) || (el.localName === 'a' && ((el.textContent || '').trim().length > 2 ||
            [...el.querySelectorAll(CREATIVE_MEDIA)].some(m => seen(m, AD_MIN_AREA))));
    }
    if (el.localName === 'iframe') {
        return true;
    }
    return el.localName === 'a' && Boolean(el.querySelector(CREATIVE_MEDIA));
}

function listAddressIn(root, visibleOnly = false) {
    for (const el of listHits) {
        if (!el.isConnected) {
            listHits.delete(el);
            continue;
        }
        if ((el === root || root.contains(el)) && (visibleOnly ? listCreative(el) : !inlineInText(el))) {
            return true;
        }
    }
    return false;
}

// Таблица для ранней вставки: реклама по спискам не появляется вовсе.
// Только сама реклама — ссылка с картинкой, фрейм, картинка; текстовую
// ссылку решает проход (inlineInText), а не таблица.
function listAddressCss() {
    const rules = rulesHere();
    if (!rules || !rules.selectors.length) {
        return '';
    }
    const visual = rules.selectors.map(s => (/^a\[/.test(s) && !/>\s*img$/.test(s) ? s + ':has(img, picture, video, iframe, canvas)' : s));
    return visual.join(',\n') + ' { display: none !important; }';
}

/* ---------- ссылка учёта по сетевым правилам ---------- */

// Ссылка ведёт на чужой адрес, который сетевые правила блокируют
// целиком: переход через рекламную систему или счётчик (eye.targetads.io
// на klerk.ru, 11.10). Свой сайт — не учёт. Ответ — на адрес: ссылок на
// один адрес много.
const blockedHostCache = new Map();

function blockedHost(host) {
    if (!LISTS || !host) {
        return false;
    }
    let answer = blockedHostCache.get(host);
    if (answer === undefined) {
        answer = !sameSite(host, location.hostname) && hostSuffixes(host).some(h => bloomHas(LISTS.hosts, h));
        blockedHostCache.set(host, answer);
    }
    return answer;
}

const blockedLinkHost = a => blockedHost(a.hostname);

// Фрейм с чужого адреса, который сетевые правила блокируют целиком, —
// место рекламной биржи (13.10: otm-r.com, betweendigital, buzzoola,
// adx.com.ru — в списках движка есть, в нашем словаре сетей и в правилах
// «по адресу» нет). Пиксель учёта во фрейме — не реклама: фрейм должен
// быть размером с рекламу — на экране, а спрятанный (движком, соседом) —
// по объявленным width и height.
function frameHost(frame) {
    try {
        return new URL(frame.src).hostname;
    } catch {
        return '';
    }
}

const declaredArea = frame => (parseInt(frame.getAttribute('width'), 10) || 0) * (parseInt(frame.getAttribute('height'), 10) || 0);

function blockedFrame(frame, visibleOnly = false) {
    if (frame.localName !== 'iframe' || !LISTS) {
        return false;
    }
    const sized = seen(frame, AD_MIN_AREA) || (!visibleOnly && declaredArea(frame) >= AD_MIN_AREA);
    return sized && blockedHost(frameHost(frame));
}

function blockedLinkIn(root) {
    if (!LISTS) {
        return false;
    }
    if (root.localName === 'a' && blockedLinkHost(root)) {
        return true;
    }
    for (const a of root.querySelectorAll('a[href]')) {
        if (blockedLinkHost(a)) {
            return true;
        }
    }
    return false;
}

// ===== platform/generic/score.js =====

// Решение по слоту — сумма сил признаков (R10, §3). Признаки делятся на
// классы; каждый класс входит в сумму один раз, своей самой сильной формой:
// десять рекламных слов в одном блоке весят не больше одного. Слот —
// реклама, если сумма достигла порога.
//
// Силы подобраны так, что решения совпадают с прежней цепочкой «если» во
// всех сочетаниях признаков (перебор — dev/test-score.mjs):
//   * сеть — решает сама (рекламный фрейм или узел сети, номер блока
//     Яндекса R-A-/R-I- в id — видимые);
//   * метка «Реклама» (и «реклама · 0+», «Соцреклама ⋮») — сама не решает
//     (статья о рекламе), но с любым вторым признаком — да;
//   * маркировка по закону («Реклама. Рекламодатель …», erid в тексте) —
//     сама не решает (не вся реклама маркируется, а новость о законе
//     цитирует тот же текст); с меткой или ссылкой учёта — да. Добавлена
//     на этапе 4: в сочетаниях без неё решения прежние (test-score.mjs);
//   * ссылка учёта кликов — только вместе с меткой или парой слабых слов;
//   * имена: рекламное слово на весь блок — решает само; «promo» дважды —
//     решает, если так назван сам блок, иначе нужен второй признак.
// Новый признак — новая строка в STRENGTH и в evidence(), без переписывания
// логики решения.

const THRESHOLD = 4;
const STRENGTH = {
    network: 4,
    // Осиротевшая реклама: метку «Реклама» спрятал не владелец блока, а
    // чьё-то правило (движок, сосед), блок остался виден — правило уже
    // опознало здесь рекламу, но спрятало не то (signs.js, orphanLabelIn).
    orphan: 4,
    label: 3,
    marking: 2,
    tracking: 2,
    // Класс «имя» — самая сильная из форм.
    name: {
        cover: 4,       // рекламное слово у узла, который почти весь слот
        promoRoot: 4,   // «promo» у самого слота и ещё раз внутри
        promoPair: 2,   // «promo» дважды
        strong: 1,      // рекламное слово где-то внутри
        promo: 1        // «promo» один раз
    }
};

// Форма класса «имя» по счёту имён в слоте: strong — есть рекламное слово,
// cover — узел с ним почти весь слот, weak — сколько раз «promo», rootWeak
// — «promo» у самого слота (без рекламного слова).
function nameLevel({ strong, cover, weak, rootWeak }) {
    if (strong && cover) {
        return 'cover';
    }
    if (weak >= 2) {
        return rootWeak ? 'promoRoot' : 'promoPair';
    }
    if (strong) {
        return 'strong';
    }
    return weak ? 'promo' : null;
}

// Признаки слота. visibleOnly — для блока с видимым содержимым считаются
// только видимые следы (signs.js, «видимость следа»).
function evidence(root, visibleOnly) {
    const names = namesIn(root, visibleOnly);
    const covering = el => {
        const a = el.getBoundingClientRect();
        const b = root.getBoundingClientRect();
        return a.width * a.height >= b.width * b.height * 0.8;
    };
    return {
        network: networkIn(root, visibleOnly),
        orphan: visibleOnly && orphanLabelIn(root),
        label: labelsDeep(root, visibleOnly).some(label => isPlaceLabel(label.textContent)
            ? placeCreative(root, visibleOnly)
            : !isMarkingLabel(label.textContent) || atTextEdge(root, label)),
        // Маркировка — текст: у пустого места его нет.
        marking: visibleOnly && markingIn(root),
        tracking: trackingIn(root),
        // Ссылка учёта по сетевым правилам движка — дороже, спрашивается
        // в decide(), только когда может решить.
        trackedLink: () => blockedLinkIn(root),
        name: nameLevel({
            strong: names.strong > 0,
            cover: Boolean(names.strong && names.outer && covering(names.outer) && !holdsSmallerAd(names.outer)),
            weak: names.weak,
            rootWeak: names.weak >= 2 && nameStrength(root, true) === 1
        })
    };
}

// Сумма и список сработавших признаков — для решения и для отчёта.
function score(ev) {
    const signals = [];
    let total = 0;
    for (const key of ['network', 'orphan', 'label', 'marking', 'tracking']) {
        if (ev[key]) {
            total += STRENGTH[key];
            signals.push(key);
        }
    }
    if (ev.name) {
        total += STRENGTH.name[ev.name];
        signals.push('name:' + ev.name);
    }
    return { total, signals };
}

// Решение. empty — у слота нет видимого содержимого: тогда хватает любого
// рекламного следа, кроме ссылки учёта (пустое место со ссылкой — не
// реклама, а, например, недогруженная карточка).
// Причина (reason) — для отчёта: empty, network, label, marking, name.
function decide(ev, empty) {
    if (!empty && !ev.tracking && ev.trackedLink) {
        const before = score(ev).total;
        if (before < THRESHOLD && before + STRENGTH.tracking >= THRESHOLD && ev.trackedLink()) {
            ev.tracking = true;
        }
    }
    const { total, signals } = score(ev);
    if (empty) {
        return ev.network || ev.label || ev.name ? { reason: 'empty', total, signals } : null;
    }
    if (total < THRESHOLD) {
        return null;
    }
    // marking — только если без маркировки слот бы остался.
    const withoutMarking = total - (ev.marking ? STRENGTH.marking : 0);
    const reason = ev.network ? 'network' : ev.orphan ? 'orphan' : ev.label ? 'label' : withoutMarking >= THRESHOLD ? 'name' : 'marking';
    return { reason, total, signals };
}

// ===== platform/generic/slots.js =====

// Слот — внешний контейнер, который держит место под рекламу: элемент
// сетки, пункт выдачи, блок колонки. Ищем его от найденного признака и
// решаем, схлопывать ли. Работаем по фактическому состоянию страницы: не
// важно, кто спрятал рекламу внутри слота — мы, движок или сосед.

const MAX_LEVELS = 10;
const EMPTY_MIN_SIDE = 20;
const BIG_BLOCK_SHARE = 0.5;

// Есть ли у блока видимое содержимое: текст, картинки, видео, фреймы — в
// том числе в закрытом теневом DOM (снаружи такой блок пустой, но на
// экране в нём реклама: Яндекс, 08–09.10).
const MEDIA = 'img, video, canvas, iframe, svg, picture, object, embed';
const sizable = el => {
    const r = el.getBoundingClientRect();
    return r.width > 20 && r.height > 20;
};

// Кнопка «закрыть» у рекламного места — часть места, а не содержимое:
// движок или сосед прячет креатив, а обёртка с крестиком остаётся висеть
// поверх страницы (klerk, обход 12.10: баннер Ozon спрятан, «×» на
// месте). Кнопка — маленькая, и весь её текст — крестик или «закрыть»;
// значок без текста — с такой подписью для экранного диктора или с
// «close» в имени. Ошибиться дёшево: обёртку без содержимого прячем, только
// если в ней есть рекламный след.
const CLOSE_TEXT = /^(?:[×✕✖✗xх]|закрыть|скрыть|close)$/i;
const CLOSE_NAME = /close|закр/i;
const CLOSE_SIDE = 48;
const CLOSE_WIDE = 120;
const CLOSE_WORD = 7;
const CLOSE_CONTROLS = 'button, [role="button"], [aria-label], [title], [class*="close" i]';

function closeControl(el) {
    const r = el.getBoundingClientRect();
    const text = (el.innerText || '').trim();
    if (r.height > CLOSE_SIDE || r.width > (text.length > 1 ? CLOSE_WIDE : CLOSE_SIDE)) {
        return false;
    }
    if (text) {
        return CLOSE_TEXT.test(text);
    }
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    return CLOSE_TEXT.test(label) || CLOSE_NAME.test(typeof el.className === 'string' ? el.className : '');
}

const closeControlsIn = el => [el, ...el.querySelectorAll(CLOSE_CONTROLS)].filter(node => node.matches(CLOSE_CONTROLS) && closeControl(node));

// Весь видимый текст узла — в кнопках закрытия.
function closeTextOnly(el, inClose) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (node.nodeValue.trim() && parent && parent.checkVisibility() && !inClose(parent)) {
            return false;
        }
    }
    return true;
}

// Кроме узла, у родителя виден только текст кнопок закрытия.
function onlyCloseBesides(parent, node) {
    if ([...parent.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim())) {
        return false;
    }
    return [...parent.children].every(kid => {
        if (kid === node) {
            return true;
        }
        const closes = closeControlsIn(kid);
        return closeTextOnly(kid, n => closes.some(c => c === n || c.contains(n)));
    });
}

function visibleContent(el) {
    const text = (el.innerText || '').trim().length;
    if (text > CLOSE_WORD) {
        return true;
    }
    // Кнопки закрытия ищем, только если без них узел почти пуст.
    let closes = null;
    const inClose = node => (closes || (closes = closeControlsIn(el))).some(c => c === node || c.contains(node));
    if (text > 2 && !closeTextOnly(el, inClose)) {
        return true;
    }
    for (const media of el.querySelectorAll(MEDIA)) {
        if (sizable(media) && !inClose(media)) {
            return true;
        }
    }
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== 'none') {
        return true;
    }
    for (const shadow of shadowRootsIn(el)) {
        if (shadowText(shadow).length > 2 || [...shadow.querySelectorAll(MEDIA)].some(sizable)) {
            return true;
        }
    }
    return skippedContent(el);
}

// Содержимое есть, но браузер его не рисует: content-visibility (auto —
// ниже экрана, hidden — до показа). innerText такого блока пуст, размеров
// у записей нет — «пустым» он только кажется (hh, 13.10: секция «Похожие
// вакансии» 770×600 ниже экрана). Узел с текстом в разметке под таким
// свойством — содержимое. Только когда всё прочее сказало «пусто»; узлов
// смотрим немного — пустое место мало.
const SKIPPED_SCAN = 200;

function skippedContent(el) {
    // Текста нет и в разметке — пусто по-настоящему (почти всегда так):
    // стили не спрашиваем.
    if ((el.textContent || '').trim().length <= 2) {
        return false;
    }
    const nodes = [el, ...el.querySelectorAll('*')];
    for (let i = 0; i < nodes.length && i < SKIPPED_SCAN; i += 1) {
        const node = nodes[i];
        if (getComputedStyle(node).contentVisibility !== 'visible' && (node.textContent || '').trim().length > 2) {
            return true;
        }
    }
    return false;
}

// Спрятанное нами считается скрытым сразу: таблица стилей из фона
// доходит до страницы не мгновенно.
const shown = el => !collapsed.has(el) && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';

// Родитель — список, а узел — его элемент: сетка, лента с переносом или
// в столбик, либо три и больше однотипных соседа (li выдачи, блоки
// колонки с одним первым классом).
// Кандидаты одного прохода делят предков, а getComputedStyle не бесплатен —
// ответ для узла запоминаем до конца прохода.
let listCache = null;
const beginPass = () => { listCache = new Map(); };
const endPass = () => { listCache = null; };

function listItem(node) {
    if (listCache && listCache.has(node)) {
        return listCache.get(node);
    }
    const answer = isListItem(node);
    if (listCache) {
        listCache.set(node, answer);
    }
    return answer;
}

function isListItem(node) {
    const parent = node.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement || parent.children.length < 3) {
        return false;
    }
    const cs = getComputedStyle(parent);
    if (cs.display.includes('grid')) {
        return true;
    }
    if (cs.display.includes('flex') && (cs.flexWrap === 'wrap' || cs.flexDirection.startsWith('column'))) {
        return true;
    }
    const key = el => el.tagName + '.' + (el.classList[0] || '');
    const mine = key(node);
    let same = 0;
    for (const kid of parent.children) {
        if (key(kid) === mine) {
            same += 1;
        }
    }
    return same >= 3;
}

// Самый внешний предок, в котором нет ничего, кроме этого узла: место
// держит обёртка, а не сама реклама.
function outermostAlone(el) {
    let node = el;
    for (let i = 0; i < MAX_LEVELS; i += 1) {
        const parent = node.parentElement;
        if (!parent || parent === document.body || parent === document.documentElement) {
            break;
        }
        const others = [...parent.children].some(kid => kid !== node && shown(kid) && visibleContent(kid));
        if (others) {
            break;
        }
        // Лишний текст у родителя — свой, а не надпись кнопки закрытия.
        const extra = (parent.innerText || '').trim().length - (node.innerText || '').trim().length;
        if (extra > 2 && (extra > CLOSE_WORD + 2 || !onlyCloseBesides(parent, node))) {
            break;
        }
        node = parent;
    }
    return node;
}

// Подпись без рекламы: в узле есть метка «Реклама» (или маркировка
// строкой), а кроме неё — только мелочь вроде кнопки «Больше квартир»:
// ни картинок, ни заметного текста. Такой узел — подпись к рекламе, а не
// реклама: спрятав его, мы оставили бы рекламу без пометки (R11: Авито —
// строка «Реклама. Рекламодатель …», Карты — значок «Реклама»).
const LABEL_ONLY_REST = 30;
// Место под одну кнопку рядом с подписью («Больше квартир»).
const LABEL_ONLY_BUTTON = 64;
const CONTENT_MEDIA_SLOT = 'img, video, canvas, iframe, picture, object, embed';

function labelOnly(node) {
    if ((node.textContent || '').length > 2000) {
        return false;
    }
    const labels = labelsDeep(node, true);
    if (!labels.length) {
        return false;
    }
    // Подпись — полоса: не выше трёх строк самой высокой метки и одной
    // кнопки. Блок выше — уже сама реклама, даже если весь её текст —
    // метка и маркировка, а картинка нарисована фоном (Видео, баннер
    // справа: 640×266, текст — «Tenet Plus», «РЕКЛАМА •••» и маркировка).
    const labelHeight = Math.max(...labels.map(label => label.getBoundingClientRect().height));
    if (node.getBoundingClientRect().height > labelHeight * 3 + LABEL_ONLY_BUTTON) {
        return false;
    }
    // Содержимое — и в закрытом теневом DOM: у Яндекса снаружи блока одна
    // метка, а реклама внутри (без этого поднялись бы до всего списка).
    const shadows = shadowRootsIn(node);
    const labelText = labels.reduce((sum, label) => sum + (label.innerText || label.textContent || '').replace(/\s+/g, ' ').trim().length, 0);
    const text = (node.innerText || '').replace(/\s+/g, ' ').trim().length + shadows.reduce((sum, shadow) => sum + shadowText(shadow).length, 0);
    if (text - labelText > LABEL_ONLY_REST) {
        return false;
    }
    for (const scope of [node, ...shadows]) {
        for (const media of scope.querySelectorAll(CONTENT_MEDIA_SLOT)) {
            if (sizable(media)) {
                return false;
            }
        }
    }
    return true;
}

// Части одного объявления ведут через счётчик рекламной системы: заголовок,
// строка адреса с меткой, быстрые ссылки — у каждой своя ссылка учёта.
// Блок рекламы, найденный от метки, бывает лишь строкой карточки (Поиск
// Яндекса, 12.10: «verbosity.ru › … Промо» — адрес длиннее подписи);
// спрятав строку, мы сняли бы с рекламы пометку, а сама реклама осталась
// бы — хуже пропуска. Поэтому блок растёт, пока рядом есть ещё ссылка учёта
// и все видимые переходы предка — ссылки учёта: содержимое сайта (карточка
// остановки на Картах, обычный результат) ведёт не через счётчик. Не
// дальше элемента списка — слот ищет slotsFrom; и не через второе
// объявление (вторая метка).
const navigates = a => {
    const href = a.getAttribute('href') || '';
    return href !== '' && !href.startsWith('#') && !/^javascript:/i.test(href) && a.checkVisibility();
};

function adExtent(unit) {
    let node = unit;
    for (let i = 0; i < MAX_LEVELS && !listItem(node); i += 1) {
        const parent = node.parentElement;
        if (!parent || parent === document.body || parent === document.documentElement || parent.matches(NEVER)) {
            break;
        }
        // Сначала дешёвое: есть ли рядом ссылка учёта вообще (на большинстве
        // страниц — нет); видимость — только у ссылок такого предка.
        if (![...parent.querySelectorAll(TRACKING_LINKS)].some(a => !node.contains(a) && navigates(a))) {
            break;
        }
        if (![...parent.querySelectorAll('a[href]')].every(a => a.matches(TRACKING_LINKS) || !navigates(a))) {
            break;
        }
        if (labelsDeep(parent, true).length > Math.max(1, labelsDeep(node, true).length)) {
            break;
        }
        node = parent;
    }
    return node;
}

// Откуда искать слот: от подписи — вверх до ближайшего узла, где кроме
// подписи есть сама реклама, и дальше — на всё объявление (adExtent).
function adUnitFrom(el) {
    // Метку спрятал кто-то другой — блок рекламы её видимый предок.
    const orphan = orphanUnit(el);
    if (orphan) {
        return adExtent(orphan);
    }
    let node = el;
    let fromLabel = false;
    for (let i = 0; i < MAX_LEVELS && labelOnly(node); i += 1) {
        fromLabel = true;
        const parent = node.parentElement;
        if (!parent || parent === document.body || parent === document.documentElement) {
            break;
        }
        node = parent;
    }
    return fromLabel ? adExtent(node) : node;
}

// Кандидаты в слоты от блока рекламы, от ближнего к дальнему: элементы
// списков по пути вверх, а если списка нет — самая внешняя обёртка.
function slotsFrom(unit) {
    const out = [];
    let node = unit;
    for (let i = 0; i <= MAX_LEVELS && node && node !== document.body; i += 1) {
        if (listItem(node)) {
            out.push(node);
        }
        node = node.parentElement;
    }
    if (!out.length) {
        out.push(outermostAlone(unit));
    }
    return out;
}

const slotsFor = el => slotsFrom(adUnitFrom(el));

// Слот состоит из рекламы: кроме неё в нём только мелочь — подпись,
// отступ, кнопка «скрыть». Однотипные соседи бывают и у контейнеров —
// вкладок, колонок, разделов, где реклама лишь малая часть (Карты, 10.10:
// три вкладки карточки остановки, в одной — плашка «Кешбэк» среди
// расписания и адреса; пряталась вся карточка). Такой кандидат — не слот:
// прячем собственную обёртку рекламы. Текст считаем видимый: спрятанная
// реклама в слот не входит, а innerText спрятанного узла — весь его
// исходный текст. Проверяем только решённый слот: innerText не бесплатен,
// а кандидаты — каждая карточка выдачи.
const SLOT_OUTSIDE_MIN = 30;
const renderedText = el => (el.innerText || '').replace(/\s+/g, ' ').trim().length;

function adText(unit) {
    return unit.checkVisibility()
        ? renderedText(unit) + shadowRootsIn(unit).reduce((sum, shadow) => sum + shadowText(shadow).length, 0)
        : 0;
}

function mostlyAd(root, unit) {
    if (root === unit) {
        return true;
    }
    const inside = adText(unit);
    return renderedText(root) - inside <= Math.max(SLOT_OUTSIDE_MIN, inside);
}

// Предохранители: то, что точно не рекламный слот.
const NEVER = 'html, body, main, nav, header, footer, form, [role="main"], [contenteditable]';
const HAS_NEVER = 'main, nav, form, input, textarea, select, [role="main"], [contenteditable]';

// Запись (article) — статья или пост, но рекламная запись тоже article:
// карточки партнёров в правой панели klerk (11.10), рекламные посты в
// ленте. Слот с записью прячем только по сильному доказательству (R12):
// сеть или два независимых класса признаков (имена — словарь сайта — не
// в счёт), и каждая запись в слоте ведёт к рекламодателю — ссылок мало, и
// чужих не меньше половины (leadsAway). Статья о рекламе с рубрикой
// «Реклама» и ссылкой на рекламную систему в тексте ведёт на свой сайт.
const holdsArticle = root => root.matches('article') || Boolean(root.querySelector('article'));

function articleProof(root, decision) {
    const strong = new Set(decision.signals.filter(signal => !signal.startsWith('name:')));
    // Ссылку учёта decide() спрашивает, только когда без неё не хватает
    // до порога; здесь она — второй независимый признак.
    if (!strong.has('network') && strong.size === 1 && !strong.has('tracking') && (trackingIn(root) || blockedLinkIn(root))) {
        strong.add('tracking');
    }
    if (!strong.has('network') && strong.size < 2) {
        return false;
    }
    const records = root.matches('article') ? [root] : [...root.querySelectorAll('article')];
    return records.every(leadsAway);
}

function safeToCollapse(root, empty) {
    if (root.matches(NEVER) || root.querySelector(HAS_NEVER)) {
        return false;
    }
    if (empty) {
        return true;
    }
    // Реклама — это немного текста; большой блок текста — контент.
    if ((root.innerText || '').length > 1500) {
        return false;
    }
    return root.getBoundingClientRect().height <= innerHeight * 2.5;
}

// Приманка детектора блокировщиков: блок с рекламными классами за краем
// страницы или в пиксель. Места он не занимает, а спрятав его, мы бы себя
// выдали. Настоящая реклама стоит в потоке страницы.
function bait(root) {
    const r = root.getBoundingClientRect();
    if (r.width * r.height < 100 * 50) {
        return true;
    }
    return r.right + scrollX <= 0 || r.bottom + scrollY <= 0 || r.left + scrollX >= document.documentElement.scrollWidth;
}

// Реклама в слоте спрятана не нами (движком или соседом): внутри есть
// невидимый узел с рекламным именем или следом сети. Для отчёта — это то
// место, которое без нас осталось бы пустым (цель №5).
function hiddenAdTrace(root) {
    for (const el of root.querySelectorAll('*')) {
        if ((isNetworkNode(el) || nameStrength(el) > 0 || (el.matches('a, iframe') && listAddressMatch(el)) || blockedFrame(el)) && !insideCollapsed(el) && getComputedStyle(el).display === 'none') {
            return true;
        }
    }
    return false;
}

// Остался ли в спрятанном нами слоте рекламный след (main.js, «слот
// отдан под другое»). Только по разметке — размеров у спрятанного нет:
// сеть, номер блока, адрес из списков или с заблокированного сервера,
// ссылка учёта, метка, маркировка, рекламное имя у самого слота или
// внутри. Любой след — блок остаётся спрятанным: крутящийся баннер с
// новым объявлением не мигает. Сначала дешёвое.
function adTraceLeft(root) {
    if (isNetworkNode(root) || root.querySelector(NETWORK_NODES) || [...root.querySelectorAll(BLOCK_ID_NODES)].some(isBlockId)) {
        return true;
    }
    if (trackingIn(root) || nameStrength(root, true) > 0) {
        return true;
    }
    for (const node of root.querySelectorAll('iframe[src], script[src]')) {
        if (NETWORK.test(node.src) || blockedFrame(node)) {
            return true;
        }
    }
    const names = namesIn(root);
    if (names.strong > 0 || names.weak >= 2) {
        return true;
    }
    return findListAddress(root).length > 0 || blockedLinkIn(root) || labelsDeep(root).length > 0 || markingIn(root);
}

// Подтверждения имени, не зависящие от словаря сайта (R12).
// Формат: размер стандартного рекламного места (IAB и российские) — у самого
// блока или у его картинки, фрейма, видео. Допуск — на рамку и отступы.
const AD_SIZES = [
    [300, 250], [336, 280], [728, 90], [970, 90], [970, 250], [160, 600], [120, 600],
    [300, 600], [240, 400], [320, 50], [320, 100], [468, 60], [250, 250], [200, 200],
    [300, 50], [1000, 120], [1000, 90], [240, 350], [300, 300], [580, 400]
];
const AD_SIZE_TOLERANCE = 6;

const isAdSize = r => AD_SIZES.some(([w, h]) => Math.abs(r.width - w) <= AD_SIZE_TOLERANCE && Math.abs(r.height - h) <= AD_SIZE_TOLERANCE);

function adFormat(root) {
    if (isAdSize(root.getBoundingClientRect())) {
        return true;
    }
    for (const media of root.querySelectorAll('img, iframe, video, canvas, ins')) {
        if (isAdSize(media.getBoundingClientRect())) {
            return true;
        }
    }
    return false;
}

// Ссылка наружу: реклама ведёт к рекламодателю — на другой сайт; меню,
// подвал, карточки сайта ведут на свой. Ссылок немного (одно действие), и
// чужих — не меньше половины.
const LEADS_AWAY_MAX_LINKS = 6;

function leadsAway(root) {
    const links = [...root.querySelectorAll('a[href]')].filter(a => /^https?:/i.test(a.href));
    if (!links.length || links.length > LEADS_AWAY_MAX_LINKS) {
        return false;
    }
    const away = links.filter(a => {
        try {
            return !sameSite(new URL(a.href).hostname, location.hostname);
        } catch {
            return false;
        }
    });
    return away.length * 2 >= links.length;
}

// Решение по слоту: сначала предохранители, потом оценка признаков
// (score.js). Возвращает { reason, total, signals } или null. Причины:
//   empty   — пустое место с рекламным следом (реклама не пришла или её
//             спрятал движок либо сосед);
//   network — внутри рекламная сеть;
//   label   — метка «Реклама» плюс второй признак;
//   name    — по рекламным именам.
function verdict(root) {
    if (!shown(root) || bait(root)) {
        return null;
    }
    const empty = !visibleContent(root);
    if (!safeToCollapse(root, empty)) {
        return null;
    }
    // Пустая полоса тоньше 20 px — ручка, разделитель, отступ, не место
    // под рекламу (mail.ru, 10.10: ручка ширины колонки 7×886 с
    // js-promo-id_… в имени).
    if (empty) {
        const r = root.getBoundingClientRect();
        if (Math.min(r.width, r.height) < EMPTY_MIN_SIDE) {
            return null;
        }
    }
    // Одну подпись без рекламы не прячем никогда (R11).
    if (!empty && labelOnly(root)) {
        return null;
    }
    // Пустое место — по любому следу, видимый блок — только по видимым
    // (signs.js, «видимость следа»).
    const decision = decide(evidence(root, !empty), empty);
    if (decision && holdsArticle(root) && !articleProof(root, decision)) {
        return null;
    }
    // Видимый блок по одному имени — только с подтверждением (R12): имя —
    // словарь сайта, «ad» в нём значит и рекламу, и раскладку вокруг неё
    // (gazeta.ru ad_branding_footer — подвал, mail.ru …top-line-adv… — письмо).
    if (decision && !empty && decision.signals.every(signal => signal.startsWith('name:')) && !adFormat(root) && !leadsAway(root)) {
        return null;
    }
    // Страховка: блок больше половины экрана по одному имени не прячем —
    // нужен второй признак. Главную область страницы рекламой по одному
    // слову не объявляем (mail.ru, 10.10: область письма 1640×834).
    if (decision && !empty && decision.reason === 'name' && decision.signals.length === 1) {
        const r = root.getBoundingClientRect();
        if (r.width * r.height > innerWidth * innerHeight * BIG_BLOCK_SHARE) {
            return null;
        }
    }
    return decision;
}

// ===== platform/generic/apply.js =====

// Скрытие с журналом: выключение на сайте возвращает всё как было, без
// перезагрузки. Меток на узлах не ставим — журнал живёт в замыкании.
//
// Незаметно для страницы (Э3, шаг 5): прячем не инлайн-стилем, а
// пользовательской таблицей стилей, которую вставляет фон
// (chrome.scripting.insertCSS, origin USER). Её нет ни в разметке, ни в
// document.styleSheets, узлы не меняются — наблюдатель атрибутов страницы
// ничего не видит, а !important пользователя сильнее !important сайта.
// Узел в таблице задаётся путём от ближайшего предка с уникальным id по
// номерам среди соседей. Путь сверяется при каждом изменении дерева рядом
// со спрятанным: указывает не на тот узел — пересобираем. Не вышло
// (нет фона, путь не строится) — прежний инлайн display: none.

// узел → { selector, inline }; inline — исходное значение и приоритет
// display, если узел спрятан инлайн-стилем (запасной путь)
const collapsed = new Map();
// Причины и «после соседа» — для отчёта (Э3, шаг 4).
const collapseLog = [];

let appliedCss = '';
let cssBroken = false;
let queue = Promise.resolve();

function matchesOnly(selector, el) {
    try {
        const found = document.querySelectorAll(selector);
        return found.length === 1 && found[0] === el;
    } catch {
        return false;
    }
}

function uniqueId(node) {
    if (!node.id) {
        return false;
    }
    try {
        return document.querySelectorAll('#' + CSS.escape(node.id)).length === 1;
    } catch {
        return false;
    }
}

function selectorFor(el) {
    const parts = [];
    for (let node = el; node; node = node.parentElement) {
        if (uniqueId(node)) {
            parts.unshift('#' + CSS.escape(node.id));
            break;
        }
        if (node === document.body) {
            parts.unshift('body');
            break;
        }
        const parent = node.parentElement;
        if (!parent) {
            return null;
        }
        parts.unshift(`${CSS.escape(node.localName)}:nth-child(${Array.prototype.indexOf.call(parent.children, node) + 1})`);
    }
    const selector = parts.join(' > ');
    return matchesOnly(selector, el) ? selector : null;
}

function hideInline(el, entry) {
    if (!entry.inline) {
        entry.inline = {
            value: el.style.getPropertyValue('display'),
            priority: el.style.getPropertyPriority('display')
        };
    }
    if (el.style.getPropertyValue('display') !== 'none' || el.style.getPropertyPriority('display') !== 'important') {
        el.style.setProperty('display', 'none', 'important');
    }
}

function unhideInline(el, entry) {
    if (!entry.inline) {
        return;
    }
    if (entry.inline.value) {
        el.style.setProperty('display', entry.inline.value, entry.inline.priority);
    } else {
        el.style.removeProperty('display');
    }
    entry.inline = null;
}

// Таблица в странице = пути всех узлов, спрятанных через неё. Новую
// вставляем раньше, чем убираем старую, — реклама не мигает. Сообщения
// строго по очереди: иначе старая могла бы убраться раньше, чем вставилась.
function pushCss() {
    const selectors = [];
    const shifts = [];
    for (const entry of collapsed.values()) {
        if (entry.selector && !entry.inline) {
            selectors.push(entry.selector);
            for (const shift of entry.shifts) {
                if (shift.selector) {
                    shifts.push(`${shift.selector} { top: ${shift.top}px !important;${shift.toBottom ? ` height: calc(100vh - ${shift.top}px) !important; max-height: none !important;` : ''} }`);
                }
            }
        }
    }
    const css = (selectors.length ? selectors.join(',\n') + ' { display: none !important; }' : '') + (shifts.length ? '\n' + shifts.join('\n') : '');
    if (css === appliedCss) {
        return;
    }
    const message = { what: 'ygab:css', add: css, remove: appliedCss };
    appliedCss = css;
    queue = queue.then(() => chrome.runtime.sendMessage(message)).then(ok => {
        if (ok !== true && !cssBroken) {
            cssBroken = true;
            appliedCss = '';
            syncStyles();
        }
    }, () => { /* контекст расширения потерян — не работаем */ });
}

// Привести страницу к журналу: пути указывают ровно на свои узлы,
// ушедшие со страницы узлы забыты (их путь мог бы теперь попасть в
// контент), страница не стёрла инлайн-скрытие.
function syncStyles() {
    for (const [el, entry] of collapsed) {
        if (!el.isConnected) {
            if (!entry.inline) {
                collapsed.delete(el);
            }
            continue;
        }
        if (!cssBroken && !(entry.selector && matchesOnly(entry.selector, el))) {
            entry.selector = selectorFor(el);
        }
        if (cssBroken || !entry.selector) {
            hideInline(el, entry);
        } else {
            unhideInline(el, entry);
        }
        // Поднятые закреплённые (stackedBelow): ушедший узел — забыть,
        // путь не туда — пересобрать.
        entry.shifts = entry.shifts.filter(shift => shift.el.isConnected);
        for (const shift of entry.shifts) {
            if (!cssBroken && !(shift.selector && matchesOnly(shift.selector, shift.el))) {
                shift.selector = selectorFor(shift.el);
            }
        }
    }
    pushCss();
}

// Прилипающая полоса у верха (реклама над шапкой) держит место не только
// собой: шапка и колонки ниже прилипают со сдвигом на её высоту (klerk,
// 12.10: у шапки top — высота полосы, у колонки — полоса плюс шапка).
// Спрятав полосу, мы оставили бы над ними дыру — меню «повисает», текст
// уходит под него. Как будто полосы не было: такие закреплённые поднимаем
// на её высоту той же таблицей стилей; выключение на сайте снимает и это.
// Только для полосы, прилипшей к самому верху, и только тех, чей сдвиг не
// меньше её высоты, — иначе их место от полосы не зависит. Обход всех
// узлов — один раз на такую полосу (на странице она одна).
const STACK_EDGE = 2;
const STACK_REACH = 400;

function stackedBelow(el) {
    const own = getComputedStyle(el);
    if ((own.position !== 'sticky' && own.position !== 'fixed') || !(parseFloat(own.top) <= STACK_EDGE)) {
        return [];
    }
    const height = el.getBoundingClientRect().height;
    if (height < 10) {
        return [];
    }
    const shifts = [];
    for (const node of document.body.querySelectorAll('*')) {
        if (el.contains(node) || node.contains(el)) {
            continue;
        }
        const cs = getComputedStyle(node);
        if (cs.position !== 'sticky' && cs.position !== 'fixed') {
            continue;
        }
        const top = parseFloat(cs.top);
        if (top >= height - STACK_EDGE && top <= height + STACK_REACH) {
            // Колонка до низа экрана (высота «экран минус сдвиг») — и после
            // подъёма до низа.
            const toBottom = Math.abs(node.getBoundingClientRect().bottom - innerHeight) <= STACK_EDGE;
            shifts.push({ el: node, top: Math.max(0, Math.round(top - height)), toBottom, selector: null });
        }
    }
    return shifts;
}

// decision — из verdict(): причина, сумма сил и признаки (для отчёта:
// почему спрятано).
function collapse(el, decision = null, afterOther = false) {
    if (collapsed.has(el)) {
        return false;
    }
    // empty — спрятано как пустое место: решение условное, его снимает
    // содержимое, пришедшее позже (main.js, refilled).
    collapsed.set(el, { selector: null, inline: null, empty: Boolean(decision && decision.reason === 'empty'), decision, afterOther, shifts: stackedBelow(el) });
    if (collapseLog.length < 50) {
        const r = el.getBoundingClientRect();
        collapseLog.push({
            reason: decision && decision.reason,
            score: decision && decision.total,
            signals: decision ? decision.signals : [],
            afterOther,
            tag: el.localName,
            // Какой именно блок: классы и id (без текста и адресов) — по
            // одному размеру спрятанное не найти (mail.ru, 10.10).
            name: [el.id ? '#' + el.id : '', typeof el.className === 'string' ? el.className : ''].join(' ').trim().slice(0, 120),
            size: `${Math.round(r.width)}x${Math.round(r.height)}`
        });
    }
    return true;
}

// Изменения дерева, после которых путь мог указать не туда: узел ушёл
// со страницы или поменялись дети его предка.
function touchesCollapsed(records) {
    for (const el of collapsed.keys()) {
        if (!el.isConnected) {
            return true;
        }
    }
    for (const record of records) {
        const target = record.target;
        if (target.nodeType !== 1) {
            continue;
        }
        for (const el of collapsed.keys()) {
            if (target.contains(el)) {
                return true;
            }
        }
    }
    return false;
}

const keepCollapsed = syncStyles;

// Вернуть один узел (пустое место, в котором появилось содержимое).
function uncollapse(el) {
    const entry = collapsed.get(el);
    if (!entry) {
        return;
    }
    unhideInline(el, entry);
    collapsed.delete(el);
    pushCss();
}

// Спрятанный нами предок узла (или сам узел), если есть.
function collapsedAbove(node) {
    for (let up = node; up; up = up.parentElement) {
        if (collapsed.has(up)) {
            return up;
        }
    }
    return null;
}

// Ранняя таблица по правилам списков (lists.js): вставляется, как только
// известно, что на сайте мы работаем, — до отрисовки рекламы. Отдельной
// частью: она не меняется, пересылать её с каждым скрытием незачем.
let appliedListsCss = '';

function pushListsCss(on) {
    const css = on ? listAddressCss() : '';
    if (css === appliedListsCss) {
        return;
    }
    const message = { what: 'ygab:css', part: 'lists', add: css, remove: appliedListsCss };
    appliedListsCss = css;
    queue = queue.then(() => chrome.runtime.sendMessage(message)).then(() => {}, () => { /* контекст расширения потерян */ });
}

function restoreAll() {
    for (const [el, entry] of collapsed) {
        unhideInline(el, entry);
    }
    collapsed.clear();
    collapseLog.length = 0;
    pushCss();
    pushListsCss(false);
}

const insideCollapsed = el => {
    for (let node = el; node; node = node.parentElement) {
        if (collapsed.has(node)) {
            return true;
        }
    }
    return false;
};

// ===== platform/generic/report.js =====

// Отчёт общего механизма для «Сообщить о проблеме» (этап 5). Считается
// только по запросу попапа — на скорость страницы не влияет.
//
//   * leftovers — что на странице похоже на рекламу, но не спрятано: метки,
//     номера блоков, узлы сетей, маркировка (и в закрытом теневом DOM). Для
//     каждого — короткий фрагмент разметки и почему его слот остался:
//     признаки и сумма или предохранитель. О пропуске сообщает сам отчёт,
//     и из него сразу делается образец для теста.
//   * recon — разведка для решения о перехвате загрузчика рекламы (М5а/б):
//     какие загрузчики есть на странице (только факт), откуда скрипты сетей
//     и картинки у остатков. Ничего не перехватываем.
//
// Адреса в отчёте — без параметров (?…) и якорей: в них бывают токены.

const LEFTOVER_LIMIT = 10;
const SNIPPET_LENGTH = 400;

// Адрес без параметров, путь — не больше трёх частей.
function cleanUrl(raw) {
    try {
        const url = new URL(raw, location.href);
        if (!/^https?:$/.test(url.protocol)) {
            return url.protocol;
        }
        const parts = url.pathname.split('/').filter(Boolean).slice(0, 3).map(part => part.slice(0, 40));
        return url.host + '/' + parts.join('/');
    } catch {
        return '';
    }
}

// Фрагмент разметки без параметров в адресах и без длинных значений.
function snippetOf(el) {
    return el.outerHTML
        .replace(/((?:href|src|srcset|action|data-[\w-]+)=")([^"]*)"/g, (_, attr, value) => attr + value.replace(/[?#][^\s",]*/g, '') + '"')
        .replace(/url\(([^)]*)\)/g, (_, value) => 'url(' + cleanUrl(value.replace(/["']/g, '')) + ')')
        .slice(0, SNIPPET_LENGTH);
}

const sizeOf = el => {
    const r = el.getBoundingClientRect();
    return `${Math.round(r.width)}x${Math.round(r.height)}`;
};

// Откуда картинки узла и его теневого DOM — для разведки (М5б).
function imagesOf(el) {
    const out = new Set();
    const scan = scope => {
        for (const img of scope.querySelectorAll('img[src]')) {
            if (!img.getAttribute('src').startsWith('data:')) {
                out.add(cleanUrl(img.getAttribute('src')));
            }
        }
        for (const node of [scope.host || scope, ...scope.querySelectorAll('*')]) {
            if (node.nodeType !== 1) {
                continue;
            }
            const bg = getComputedStyle(node).backgroundImage;
            const match = bg && bg.match(/url\("?([^")]+)"?\)/);
            if (match && !match[1].startsWith('data:')) {
                out.add(cleanUrl(match[1]));
            }
        }
    };
    scan(el);
    shadowRootsIn(el).forEach(scan);
    out.delete('');
    return [...out].slice(0, 5);
}

// Почему слот не спрятан: предохранитель или признаков мало.
function explain(root) {
    const out = { tag: root.localName, cls: String(root.getAttribute('class') || '').slice(0, 80), size: sizeOf(root) };
    if (insideCollapsed(root)) {
        return { ...out, why: 'уже спрятан' };
    }
    if (!shown(root)) {
        return { ...out, why: 'не виден' };
    }
    if (bait(root)) {
        return { ...out, why: 'похож на приманку детектора (за краем или крошечный)' };
    }
    const empty = !visibleContent(root);
    if (!safeToCollapse(root, empty)) {
        return { ...out, why: 'предохранитель: контент (main/nav/form, много текста или выше 2,5 экрана)' };
    }
    const ev = evidence(root, !empty);
    const decision = decide(ev, empty);
    const { total, signals } = score(ev);
    if (decision && holdsArticle(root) && !articleProof(root, decision)) {
        return { ...out, empty, total, threshold: THRESHOLD, signals, decision: null, why: 'предохранитель: запись (article) — нужны сеть или два признака и ссылки к рекламодателю' };
    }
    return { ...out, empty, total, threshold: THRESHOLD, signals, decision: decision ? decision.reason : null };
}

// Узлы, похожие на рекламу, которые видны и не спрятаны нами.
function findLeftovers() {
    const found = new Map();
    const add = (el, kind) => {
        if (!el || el === document.body || insideCollapsed(el) || !seen(el)) {
            return;
        }
        if (!found.has(el)) {
            found.set(el, new Set());
        }
        found.get(el).add(kind);
    };
    for (const el of labelsIn(document.body, true)) {
        add(el, 'метка');
    }
    for (const el of document.querySelectorAll(BLOCK_ID_NODES)) {
        if (isBlockId(el) && seen(el, AD_MIN_AREA)) {
            add(el, 'номер блока');
        }
    }
    for (const el of document.querySelectorAll(NETWORK_NODES)) {
        if (seen(el, AD_MIN_AREA)) {
            add(el, 'сеть');
        }
    }
    for (const el of document.querySelectorAll('iframe[src]')) {
        if ((NETWORK.test(el.src) && seen(el, AD_MIN_AREA)) || blockedFrame(el, true)) {
            add(el, 'сеть');
        }
    }
    // Реклама по правилам списков движка, которую мы не спрятали.
    for (const el of listHits) {
        if (el.isConnected && listCreative(el)) {
            add(el, 'список');
        }
    }
    // Маркировка: текст с «Рекламодатель» или erid — в своём небольшом блоке.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (/рекламодатель|erid/i.test(node.nodeValue)) {
            const el = node.parentElement;
            if (el && !el.closest('script, style') && MARKING.some(re => re.test(el.innerText || ''))) {
                add(el, 'маркировка');
            }
        }
    }
    // Закрытый теневой DOM: метки и маркировка внутри — на его хосте.
    for (const host of document.body.querySelectorAll('*')) {
        const shadow = shadowOf(host);
        if (!shadow) {
            continue;
        }
        if (labelsIn(shadow, true).length) {
            add(host, 'метка в теневом DOM');
        }
        if (MARKING.some(re => re.test(shadowText(shadow)))) {
            add(host, 'маркировка в теневом DOM');
        }
    }
    // Вложенные — в пользу внешнего.
    const nodes = [...found.keys()];
    for (const el of nodes) {
        const outer = nodes.find(other => other !== el && other.contains(el));
        if (outer) {
            found.get(el).forEach(kind => found.get(outer).add(kind));
            found.delete(el);
        }
    }
    return found;
}

function leftoversReport() {
    beginPass();
    try {
        const found = findLeftovers();
        const items = [];
        for (const [el, kinds] of found) {
            if (items.length >= LEFTOVER_LIMIT) {
                break;
            }
            // Теневой DOM — у самого узла или внутри него.
            const shadows = shadowRootsIn(el);
            const slot = slotsFor(el)[0];
            items.push({
                kinds: [...kinds],
                tag: el.localName,
                id: el.id.slice(0, 80),
                size: sizeOf(el),
                text: [el.innerText || '', ...shadows.map(shadowText)].join(' ').replace(/\s+/g, ' ').trim().slice(0, 120),
                shadow: shadows.length ? (shadows.some(root => root.mode === 'open') ? 'open' : 'closed') : null,
                canvas: Boolean(el.querySelector('canvas') || shadows.some(root => root.querySelector('canvas'))),
                images: imagesOf(el),
                slot: slot ? explain(slot) : null,
                html: snippetOf(el)
            });
        }
        const kindsList = [...found.values()];
        return {
            count: found.size,
            // Не одна лишь метка: одиночная «Реклама» — часто ссылка в подвале.
            likely: kindsList.filter(kinds => [...kinds].some(kind => kind !== 'метка')).length,
            items
        };
    } finally {
        endPass();
    }
}

// Разведка (М5а/б): только факты, ничего не перехватываем.
const LOADER_MARKS = ['Ya.Context', 'AdvManager', 'yaContextCb', 'adfoxAsyncParams', 'adfox', 'adsbygoogle', 'googletag', 'VK.Retargeting'];
const RECON_URL = /an\.yandex\.|yandex\.ru\/ads|yastatic\.net\/(?:partner|pcode|safeframe)|adfox|ads\.vk\.com|ad\.mail\.ru|googlesyndication|doubleclick|get-direct|direct\.yandex/i;

function reconReport() {
    const loaders = new Set();
    const adScripts = new Set();
    for (const script of document.scripts) {
        if (script.src) {
            if (RECON_URL.test(script.src)) {
                adScripts.add(cleanUrl(script.src));
            }
        } else {
            const text = script.textContent;
            for (const mark of LOADER_MARKS) {
                if (text.includes(mark)) {
                    loaders.add(mark);
                }
            }
        }
    }
    // Запросы страницы (Resource Timing): рекламные — по адресу.
    const adResources = new Map();
    for (const entry of performance.getEntriesByType('resource')) {
        if (RECON_URL.test(entry.name)) {
            const key = entry.initiatorType + ' ' + cleanUrl(entry.name);
            adResources.set(key, (adResources.get(key) || 0) + 1);
        }
    }
    let shadowHosts = 0;
    for (const el of document.body.querySelectorAll('*')) {
        if (shadowOf(el)) {
            shadowHosts += 1;
        }
    }
    return {
        loaders: [...loaders],
        adScripts: [...adScripts].slice(0, 20),
        adResources: [...adResources].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([key, count]) => `${key} ×${count}`),
        shadowHosts
    };
}

/* ---------- самопроверка (platform/selfcheck) ---------- */

// Для страницы «Самопроверка»: что мы спрятали и не задели ли нужное — без
// текста страницы (почта, переписка): только имена, размеры и числа.
// Главный текст — блок с наибольшей прозой (абзацы от 80 знаков), как в
// режиме чтения; спрятанное нами считается видимым — иначе спрятанное
// письмо не нашлось бы.
const SELFCHECK_PROSE = 80;
const SELFCHECK_AD_TEXT = /реклам|рекламодател|erid|спонсор|sponsor|партн[её]рск|advertis/i;

function proseOf(root) {
    let total = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (parent && !parent.closest('script, style, noscript, template')) {
            total += node.nodeValue.trim().length;
        }
    }
    return total;
}

function mainTextBlock() {
    const prose = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || node.nodeValue.trim().length < SELFCHECK_PROSE || parent.closest('script, style, noscript, template')) {
            continue;
        }
        if (!parent.checkVisibility() && !insideCollapsed(parent)) {
            continue;
        }
        const box = parent.parentElement || parent;
        prose.set(box, (prose.get(box) || 0) + node.nodeValue.trim().length);
    }
    let main = null;
    for (const [box, total] of prose) {
        if (!main || total > prose.get(main)) {
            main = box;
        }
    }
    return main;
}

function selfCheckReport() {
    const main = mainTextBlock();
    const hidden = [];
    for (const [el, entry] of collapsed) {
        if (!el.isConnected || hidden.length >= 50) {
            continue;
        }
        const r = el.getBoundingClientRect();
        const d = entry.decision || {};
        hidden.push({
            reason: d.reason || null,
            score: typeof d.total === 'number' ? d.total : null,
            signals: d.signals || [],
            afterOther: Boolean(entry.afterOther),
            tag: el.localName,
            name: [el.id ? '#' + el.id : '', typeof el.className === 'string' ? el.className : ''].join(' ').trim().slice(0, 120),
            size: `${Math.round(r.width)}x${Math.round(r.height)}`,
            text: proseOf(el),
            main: Boolean(main && (el === main || el.contains(main))),
            // Метка бывает и в закрытом теневом DOM (Поиск Яндекса).
            adLike: [el.textContent || '', ...shadowRootsIn(el).map(shadowText)].some(text => SELFCHECK_AD_TEXT.test(text)) || Boolean(el.querySelector('iframe'))
        });
    }
    const left = leftoversReport();
    return {
        active,
        mainText: main ? proseOf(main) : 0,
        hidden,
        // Спрятанные слоты, отданные страницей под другое и открытые (8а).
        revealed: revealedCount,
        leftovers: {
            count: left.count,
            likely: left.likely,
            items: left.items.map(item => ({ kinds: item.kinds, tag: item.tag, id: item.id, size: item.size, shadow: item.shadow, canvas: item.canvas, images: item.images.map(src => { try { return new URL(src, location.href).hostname; } catch { return ''; } }), slot: item.slot }))
        },
        recon: reconReport()
    };
}

// ===== platform/generic/main.js =====

// Общий механизм на всех сайтах (Э3). Дёшево там, где рекламы нет: один
// MutationObserver на добавленные узлы, проходы пакетами. Уважает
// «выключено на сайте» и откатывается на лету. Где работать — решает
// platform/shared/site-state.js (вклеен в начало бандла).

let active = false;
let observer = null;
let batchTimer = null;
const pending = new Set();
// Откуда что-то удалили: сосед или сайт мог вынуть рекламу из блока
// позже первых перепроверок — такой блок смотрим снова.
const removedFrom = new Set();
const timers = [];

// Кандидаты: узлы с рекламным словом в class или id, следы рекламных
// сетей, метки «Реклама». Селектор — грубый отсев, точная проверка — по
// словам (nameStrength).
const NAME_PREFILTER = ['ad', 'rtb', 'sponsor', 'commercial', 'rekl', 'promo']
    .flatMap(w => [`[class*="${w}" i]`, `[id*="${w}" i]`]).join(', ');

function candidates(scope) {
    const out = new Set();
    if (scope.matches && scope.matches(NAME_PREFILTER) && nameStrength(scope) > 0) {
        out.add(scope);
    }
    for (const el of scope.querySelectorAll(NAME_PREFILTER)) {
        if (nameStrength(el) > 0) {
            out.add(el);
        }
    }
    for (const el of scope.querySelectorAll(NETWORK_NODES)) {
        out.add(el);
    }
    for (const el of scope.querySelectorAll(BLOCK_ID_NODES)) {
        if (isBlockId(el)) {
            out.add(el);
        }
    }
    for (const el of scope.querySelectorAll('iframe[src], script[src]')) {
        if ((NETWORK.test(el.src) || blockedFrame(el)) && el.parentElement) {
            out.add(el.parentElement);
        }
    }
    // Метки и маркировка без метки («Рекламодатель …, erid …») — за один
    // обход текста: маркировку одну decide() не принимает, но со ссылкой
    // учёта в той же карточке — да, а без кандидата карточку не смотрели.
    const marking = [];
    for (const el of labelsIn(scope, false, marking)) {
        out.add(el);
    }
    for (const el of marking) {
        out.add(el);
    }
    // Реклама по правилам списков движка (lists.js).
    for (const el of findListAddress(scope)) {
        out.add(el);
    }
    return out;
}

// После перезагрузки или обновления расширения скрипт на открытой вкладке
// остаётся, но связи с расширением у него больше нет: он не узнает ни о
// выключении на сайте, ни о новой таблице стилей. Его таблицу снимает
// новый фон (platform/background.js), инлайн-скрытие возвращаем сами — и
// замолкаем.
function orphaned() {
    let alive = false;
    try {
        alive = Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
        /* контекст расширения потерян */
    }
    if (!alive && active) {
        active = false;
        stop();
    }
    return !alive;
}

// Найденные кандидаты: повторные проходы перепроверяют их, а не ищут
// заново по всему дереву. Новые узлы приносит наблюдатель.
let known = new Set();

function evaluate(list) {
    const checked = new Set();
    beginPass();
    for (const el of list) {
        if (!el.isConnected || insideCollapsed(el)) {
            continue;
        }
        const unit = adUnitFrom(el);
        // Все места отвергнуты (предохранители записи и контента: статья
        // ленты, высокая колонка новостей), а реклама — пустая рамка
        // (обход 12.10: gazeta, championat) — прячем саму рамку. Только
        // пустую: видимое так не теряется, а скрытие снимет содержимое,
        // пришедшее позже.
        const slots = slotsFrom(unit);
        let ownTried = false;
        for (let root of slots) {
            if (checked.has(root) || insideCollapsed(root)) {
                break;
            }
            checked.add(root);
            let decision = verdict(root);
            if (!decision) {
                if (!ownTried && root === slots[slots.length - 1]) {
                    ownTried = true;
                    const own = outermostAlone(unit);
                    if (!slots.includes(own) && !visibleContent(own)) {
                        slots.push(own);
                    }
                }
                continue;
            }
            // Контейнер с рекламой — не слот (slots.js, mostlyAd). Отказ — от
            // этого признака: у ссылки учёта блок рекламы — сама ссылка, а
            // метка того же объявления даст весь блок, и слот подойдёт.
            if (!mostlyAd(root, unit)) {
                checked.delete(root);
                root = outermostAlone(unit);
                decision = checked.has(root) || insideCollapsed(root) ? null : verdict(root);
                checked.add(root);
            }
            if (decision && collapse(root, decision, decision.reason === 'empty' && hiddenAdTrace(root)) && decision.reason !== 'empty') {
                if (Date.now() - (revealedAt.get(root) || -Infinity) < STICKY_MS) {
                    collapsed.get(root).sticky = true;
                } else {
                    watchInside(root);
                }
            }
            break;
        }
    }
    endPass();
    keepCollapsed();
}

function pass(scope) {
    if (!active || !scope || !scope.isConnected) {
        return;
    }
    const found = candidates(scope);
    found.forEach(el => known.add(el));
    evaluate(found);
}

const fullPass = () => pass(document.body);

// Перепроверка: сосед или движок мог опустошить слот своим CSS — в дереве
// при этом ничего не меняется.
function recheck() {
    if (!active || orphaned()) {
        return;
    }
    known = new Set([...known].filter(el => el.isConnected));
    evaluate(known);
}

// Добавленные узлы — пакетом, не чаще раза в 200 мс. Узел, чей предок
// тоже в пакете, пройдёт вместе с предком.
function flush() {
    batchTimer = null;
    if (orphaned()) {
        return;
    }
    const nodes = new Set(pending);
    pending.clear();
    refill(nodes);
    const targets = [...removedFrom].filter(t => t.isConnected);
    removedFrom.clear();
    targets.forEach(noteChange);
    recheckChanged();
    if (active && targets.length) {
        const affected = [...known].filter(el => el.isConnected && targets.some(t => el.contains(t) || t.contains(el)));
        if (affected.length) {
            evaluate(affected);
        }
    }
    for (const node of nodes) {
        let covered = false;
        for (let up = node.parentElement; up && !covered; up = up.parentElement) {
            covered = nodes.has(up);
        }
        if (!covered && node.isConnected) {
            pass(node);
        }
    }
}

// Пустое место прячем условно. На страницах, которые собираются по частям
// (почта, ленты), «пусто» часто значит «ещё не загрузилось»: 10.10 на
// mail.ru рамка письма была пустой — только заготовка под рекламу, — её
// спрятали, и пришедшее следом письмо осталось невидимым. Пришло
// содержимое — скрытие снимаем и смотрим заново, когда таблица стилей
// обновится: реклама спрячется снова (уже как реклама или меньшим пустым
// местом), контент останется.
const REFILL_RECHECK_MS = 300;
const SKIP_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
// Значки (svg) не в счёт: кнопка-значок — не содержимое места.
const CONTENT_MEDIA = 'img, video, canvas, iframe, picture, object, embed';

// Есть ли у спрятанного узла содержимое. Размеров у него нет, поэтому —
// по разметке: текст (без скриптов и стилей) или картинки, видео, фреймы.
function hasContent(root) {
    if (root.querySelector(CONTENT_MEDIA)) {
        return true;
    }
    let length = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement && SKIP_TEXT.has(node.parentElement.tagName)) {
            continue;
        }
        length += node.nodeValue.trim().length;
        if (length > 2) {
            return true;
        }
    }
    return false;
}

// Снять скрытие и посмотреть заново, когда таблица стилей обновится.
function reveal(root) {
    uncollapse(root);
    timers.push(setTimeout(() => {
        if (active && root.isConnected) {
            pass(root);
            evaluate([...known].filter(el => el.isConnected && (root.contains(el) || el.contains(root))));
        }
    }, REFILL_RECHECK_MS));
}

// Слот, спрятанный как реклама, страница может отдать под другое (8а):
// виртуальные ленты и выдачи без перезагрузки переиспользуют узлы —
// меняют содержимое целиком или только текст и адреса (так обновляет
// узлы React). Спрятанный узел остался бы спрятанным вместе с записью.
// Поэтому изменения внутри такого слота смотрим: рекламный след остался
// (slots.js, adTraceLeft) — блок спрятан, как был (крутящийся баннер не
// мигает); следов нет — реклама ушла, скрытие снимаем. Снова спрятан
// вскоре после этого — разметка и вид расходятся (реклама без следов в
// разметке): такой слот больше не открываем, иначе он мигал бы с каждой
// сменой объявления.
const changedSlots = new Set();
const revealedAt = new WeakMap();
const STICKY_MS = 5000;
let revealedCount = 0;

// Правку текста и адресов наблюдатель всей страницы (только добавленные
// узлы) не видит — её слушаем лишь внутри спрятанных нами слотов.
let insideObserver = null;

function watchInside(root) {
    if (!insideObserver) {
        insideObserver = new MutationObserver(records => {
            if (orphaned()) {
                return;
            }
            for (const record of records) {
                noteChange(record.target.nodeType === 1 ? record.target : record.target.parentElement);
            }
            if (changedSlots.size && !batchTimer) {
                batchTimer = setTimeout(flush, 200);
            }
        });
    }
    insideObserver.observe(root, { subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'src'] });
}

function noteChange(node) {
    const root = node && node.isConnected && collapsedAbove(node);
    const entry = root && collapsed.get(root);
    if (entry && !entry.empty && !entry.sticky) {
        changedSlots.add(root);
    }
}

function recheckChanged() {
    const roots = [...changedSlots];
    changedSlots.clear();
    for (const root of roots) {
        const entry = collapsed.get(root);
        if (!entry || entry.sticky || !root.isConnected || adTraceLeft(root)) {
            continue;
        }
        revealedAt.set(root, Date.now());
        revealedCount += 1;
        reveal(root);
    }
}

function refill(nodes) {
    const roots = new Set();
    for (const node of nodes) {
        const root = node.isConnected && collapsedAbove(node);
        if (!root) {
            continue;
        }
        if (collapsed.get(root).empty) {
            roots.add(root);
        } else {
            noteChange(node);
        }
    }
    for (const root of roots) {
        if (hasContent(root)) {
            reveal(root);
        }
    }
}

function onMutations(records) {
    if (orphaned()) {
        return;
    }
    for (const record of records) {
        for (const node of record.addedNodes) {
            if (node.nodeType === 1) {
                pending.add(node);
            } else if (node.nodeType === 3 && node.parentElement) {
                pending.add(node.parentElement);
            }
        }
        if (record.removedNodes.length && record.target.nodeType === 1 && removedFrom.size < 50) {
            removedFrom.add(record.target);
        }
    }
    if ((pending.size || removedFrom.size) && !batchTimer) {
        batchTimer = setTimeout(flush, 200);
    }
    // Пути спрятанных узлов сверяем сразу, а не пакетом: вставка соседа
    // перед спрятанным узлом сдвигает номера, и путь попал бы в контент.
    if (collapsed.size && touchesCollapsed(records)) {
        syncStyles();
    }
}

// Полный поиск — один раз, при готовности разметки. После загрузки и
// дважды позже — перепроверка: движок и соседи прячут рекламу своим CSS,
// и пустое место видно только повторным взглядом.
function scheduleFullPasses() {
    const later = () => {
        recheck();
        timers.push(setTimeout(recheck, 1500), setTimeout(recheck, 4000));
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', fullPass, { once: true });
    } else {
        fullPass();
    }
    if (document.readyState === 'complete') {
        timers.push(setTimeout(later, 0));
    } else {
        window.addEventListener('load', later, { once: true });
    }
}

// Наблюдатель — только после готовности разметки: пока страница
// разбирается, каждый узел от парсера приходит как «добавленный», а всё
// это покрывает первый полный проход.
function observe() {
    if (active && !observer) {
        observer = new MutationObserver(onMutations);
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }
}

function start() {
    pushListsCss(true);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', observe, { once: true });
    } else {
        observe();
    }
    scheduleFullPasses();
}

function stop() {
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    if (insideObserver) {
        insideObserver.disconnect();
        insideObserver = null;
    }
    changedSlots.clear();
    clearTimeout(batchTimer);
    batchTimer = null;
    pending.clear();
    removedFrom.clear();
    timers.splice(0).forEach(clearTimeout);
    known = new Set();
    restoreAll();
}

function update(want) {
    if (want === active) {
        return;
    }
    active = want;
    if (active) {
        start();
    } else {
        stop();
    }
}

// Ошибка в дополнительной части отчёта не должна ломать весь отчёт.
function safely(build) {
    try {
        return build();
    } catch (error) {
        return { error: String(error && error.message || error).slice(0, 200) };
    }
}

// После перезагрузки расширения старая копия скрипта остаётся на
// открытых вкладках, и chrome.* в ней бросает исключения.
try {
    watchActive(location.hostname, update);
    // Для отчёта «Сообщить о проблеме»: что и почему схлопнуто здесь.
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message && message.action === 'getSelfCheck') {
            respond(safely(selfCheckReport));
            return;
        }
        if (message && message.action === 'getGenericReport') {
            respond({
                active,
                collapsed: collapsed.size,
                afterOther: collapseLog.filter(item => item.afterOther).length,
                hiddenBy: cssBroken ? 'inline' : 'user-css',
                // Сколько спрятанных слотов страница отдала под другое (8а).
                revealed: revealedCount,
                items: collapseLog.slice(),
                // Что похоже на рекламу, но осталось, и разведка (report.js).
                leftovers: active ? safely(leftoversReport) : null,
                recon: safely(reconReport)
            });
        }
    });
} catch {
    /* контекст расширения потерян — не работаем */
}

})();
