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
