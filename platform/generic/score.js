'use strict';

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
