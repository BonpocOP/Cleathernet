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
function nameStrength(el, withData = false) {
    const values = [typeof el.className === 'string' ? el.className : el.getAttribute('class') || '', el.id || ''];
    if (withData) {
        for (const attr of el.attributes) {
            if (attr.name.startsWith('data-') && attr.value.length < 80) {
                values.push(attr.value);
            }
        }
    }
    let best = 0;
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
        if (NETWORK.test(node.src) && counts(node)) {
            return true;
        }
    }
    return false;
}

/* ---------- ссылки учёта кликов ---------- */

// Переход через счётчик рекламной системы. erid — метка по закону о
// рекламе; её часто не ставят, поэтому она лишь один из признаков.
const TRACKING_LINKS = [
    'a[href*="/_sttc/"]', 'a[href*="yabs.yandex."]', 'a[href*="an.yandex."]',
    'a[href*="erid="]', 'a[href*="googleadservices."]', 'a[href*="/aclk?"]',
    'a[href*="doubleclick.net"]', 'a[href*="ads.vk.com"]', 'a[href*="ad.mail.ru"]'
].join(', ');

const trackingIn = root => root.matches(TRACKING_LINKS) || Boolean(root.querySelector(TRACKING_LINKS));

/* ---------- метка «Реклама» ---------- */

// Отдельная короткая надпись, а не слово в тексте. Сама по себе ничего не
// решает (статья о рекламе, рубрика, ссылка «Реклама» на сайте): нужен
// второй признак.
const LABELS = new Set(['реклама', 'соцреклама', 'промо', 'sponsored', 'advertisement', 'advertising', 'ad', 'ads', 'спонсор', 'партнёрский материал', 'партнерский материал']);
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

// Элементы-метки внутри узла: текст элемента целиком — метка (или
// маркировка одной строкой, начинающаяся с метки).
function labelsIn(root, visibleOnly = false) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.nodeValue;
        const el = node.parentElement;
        if (!el || value.length > 240) {
            continue;
        }
        const label = value.length <= 40
            ? isLabelText(value) && isLabelText(el.textContent)
            : isMarkingLabel(value);
        if (label && (!visibleOnly || seen(el))) {
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

// Ссылка на свою же страницу («Реклама на сайте» в подвале или меню) — не
// рекламная метка, её сайт прячет сам (узкий экран, выпадающее меню).
const ownPageLink = el => {
    const link = el.closest('a[href]');
    try {
        return Boolean(link) && new URL(link.href, location.href).hostname === location.hostname;
    } catch {
        return false;
    }
};
// Спрятанное — только значок: метка и украшения («· 0+», «•••»).
const ORPHAN_EXTRA = 8;
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
        label: labelsDeep(root, visibleOnly).some(label => !isMarkingLabel(label.textContent) || atTextEdge(root, label)),
        // Маркировка — текст: у пустого места его нет.
        marking: visibleOnly && markingIn(root),
        tracking: trackingIn(root),
        name: nameLevel({
            strong: names.strong > 0,
            cover: Boolean(names.strong && names.outer && covering(names.outer)),
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

// Есть ли у блока видимое содержимое: текст, картинки, видео, фреймы — в
// том числе в закрытом теневом DOM (снаружи такой блок пустой, но на
// экране в нём реклама: Яндекс, 08–09.10).
const MEDIA = 'img, video, canvas, iframe, svg, picture, object, embed';
const sizable = el => {
    const r = el.getBoundingClientRect();
    return r.width > 20 && r.height > 20;
};

function visibleContent(el) {
    if ((el.innerText || '').trim().length > 2) {
        return true;
    }
    for (const media of el.querySelectorAll(MEDIA)) {
        if (sizable(media)) {
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
        if (others || (parent.innerText || '').trim().length > (node.innerText || '').trim().length + 2) {
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

// Откуда искать слот: от подписи — вверх до ближайшего узла, где кроме
// подписи есть сама реклама.
function adUnitFrom(el) {
    // Метку спрятал кто-то другой — блок рекламы её видимый предок.
    const orphan = orphanUnit(el);
    if (orphan) {
        return orphan;
    }
    let node = el;
    for (let i = 0; i < MAX_LEVELS && labelOnly(node); i += 1) {
        const parent = node.parentElement;
        if (!parent || parent === document.body || parent === document.documentElement) {
            break;
        }
        node = parent;
    }
    return node;
}

// Кандидаты в слоты от признака, от ближнего к дальнему: элементы
// списков по пути вверх, а если списка нет — самая внешняя обёртка.
function slotsFor(el) {
    const out = [];
    el = adUnitFrom(el);
    let node = el;
    for (let i = 0; i <= MAX_LEVELS && node && node !== document.body; i += 1) {
        if (listItem(node)) {
            out.push(node);
        }
        node = node.parentElement;
    }
    if (!out.length) {
        out.push(outermostAlone(el));
    }
    return out;
}

// Предохранители: то, что точно не рекламный слот.
const NEVER = 'html, body, main, article, nav, header, footer, form, [role="main"], [contenteditable]';
const HAS_NEVER = 'main, article, nav, form, input, textarea, select, [role="main"], [contenteditable]';

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
        if ((isNetworkNode(el) || nameStrength(el) > 0) && !insideCollapsed(el) && getComputedStyle(el).display === 'none') {
            return true;
        }
    }
    return false;
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
    // Одну подпись без рекламы не прячем никогда (R11).
    if (!empty && labelOnly(root)) {
        return null;
    }
    // Пустое место — по любому следу, видимый блок — только по видимым
    // (signs.js, «видимость следа»).
    return decide(evidence(root, !empty), empty);
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
    for (const entry of collapsed.values()) {
        if (entry.selector && !entry.inline) {
            selectors.push(entry.selector);
        }
    }
    const css = selectors.length ? selectors.join(',\n') + ' { display: none !important; }' : '';
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
    }
    pushCss();
}

// decision — из verdict(): причина, сумма сил и признаки (для отчёта:
// почему спрятано).
function collapse(el, decision = null, afterOther = false) {
    if (collapsed.has(el)) {
        return false;
    }
    // empty — спрятано как пустое место: решение условное, его снимает
    // содержимое, пришедшее позже (main.js, refilled).
    collapsed.set(el, { selector: null, inline: null, empty: Boolean(decision && decision.reason === 'empty') });
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

// Спрятанный пустым предок узла, если есть.
function emptyCollapsedAbove(node) {
    for (let up = node; up; up = up.parentElement) {
        const entry = collapsed.get(up);
        if (entry) {
            return entry.empty ? up : null;
        }
    }
    return null;
}

function restoreAll() {
    for (const [el, entry] of collapsed) {
        unhideInline(el, entry);
    }
    collapsed.clear();
    collapseLog.length = 0;
    pushCss();
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
        return { ...out, why: 'предохранитель: контент (main/article/form, много текста или выше 2,5 экрана)' };
    }
    const ev = evidence(root, !empty);
    const decision = decide(ev, empty);
    const { total, signals } = score(ev);
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
        if (NETWORK.test(el.src) && seen(el, AD_MIN_AREA)) {
            add(el, 'сеть');
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
        if (NETWORK.test(el.src) && el.parentElement) {
            out.add(el.parentElement);
        }
    }
    for (const el of labelsIn(scope)) {
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
        for (const root of slotsFor(el)) {
            if (checked.has(root) || insideCollapsed(root)) {
                break;
            }
            checked.add(root);
            const decision = verdict(root);
            if (decision) {
                collapse(root, decision, decision.reason === 'empty' && hiddenAdTrace(root));
                break;
            }
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

function refill(nodes) {
    const roots = new Set();
    for (const node of nodes) {
        const root = node.isConnected && emptyCollapsedAbove(node);
        if (root) {
            roots.add(root);
        }
    }
    for (const root of roots) {
        if (!hasContent(root)) {
            continue;
        }
        uncollapse(root);
        timers.push(setTimeout(() => {
            if (active && root.isConnected) {
                pass(root);
                evaluate([...known].filter(el => el.isConnected && (root.contains(el) || el.contains(root))));
            }
        }, REFILL_RECHECK_MS));
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
        if (message && message.action === 'getGenericReport') {
            respond({
                active,
                collapsed: collapsed.size,
                afterOther: collapseLog.filter(item => item.afterOther).length,
                hiddenBy: cssBroken ? 'inline' : 'user-css',
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
