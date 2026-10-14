'use strict';

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
// Соседние поддомены портала (auto.* → help.*) — тот же сайт, а не
// рекламодатель (14.10, подвал портала: «Помощь», «О проекте» на help.*).
// Сайт — два последних уровня, три, если второй — общий (co.uk, com.ru).
// Только здесь: признак сети (lists.js) ad.mail.ru на news.mail.ru должен
// по-прежнему считать чужим.
const SHARED_SECOND_LEVEL = /^(co|com|net|org|gov|edu|ac|msk|spb)$/;

function siteOf(host) {
    const parts = host.replace(/^www\./, '').split('.');
    const keep = parts.length > 2 && SHARED_SECOND_LEVEL.test(parts[parts.length - 2]) ? 3 : 2;
    return parts.slice(-keep).join('.');
}

function leadsAway(root) {
    const links = [...root.querySelectorAll('a[href]')].filter(a => /^https?:/i.test(a.href));
    if (!links.length || links.length > LEADS_AWAY_MAX_LINKS) {
        return false;
    }
    const here = siteOf(location.hostname);
    const away = links.filter(a => {
        try {
            return siteOf(new URL(a.href).hostname) !== here;
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
