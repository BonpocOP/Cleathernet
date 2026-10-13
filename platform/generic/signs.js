'use strict';

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
