'use strict';

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
