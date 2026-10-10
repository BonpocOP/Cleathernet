'use strict';

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
