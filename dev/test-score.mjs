// Оценка признаков (platform/generic/score.js) против прежней цепочки
// «если» из slots.js verdict() (до этапа 3, коммит 96ac424) плюс
// записанные намеренные изменения (expected): перебор всех сочетаний
// признаков, решения и причины должны совпасть везде.
//
// Прежняя логика перенесена сюда дословно, как функция от признаков. Если
// решение когда-нибудь намеренно меняется (новый признак, другие силы),
// этот тест покажет, в каких именно сочетаниях, — и тогда legacy правится
// осознанно, с записью «почему».
//
// Без браузера: score.js выполняется в vm, функции страницы ему не нужны.
//
//   node test-score.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = {};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'platform', 'generic', 'score.js'), 'utf8') +
    '\n;this.api = { nameLevel, decide };', context);
const { nameLevel, decide } = context.api;

// slots.js verdict() до этапа 3, после предохранителей. rootWeakRaw —
// nameStrength(root, true) === 1.
function legacy({ empty, network, label, tracking, strong, cover, weak, rootWeakRaw }) {
    if (empty) {
        return strong || weak || network || label ? 'empty' : null;
    }
    if (network) {
        return 'network';
    }
    if (label && (tracking || strong || weak)) {
        return 'label';
    }
    if (strong && cover) {
        return 'name';
    }
    if (weak >= 2 && (rootWeakRaw || tracking)) {
        return 'name';
    }
    return null;
}

// Намеренные изменения после этапа 3 — каждое со своей причиной.
// Этап 4 (10.10): маркировка по закону (marking). Сама не решает; с меткой
// или ссылкой учёта — реклама; с парой «promo» — тоже (2 + 2). В
// сочетаниях без маркировки — прежняя логика.
function expected(c) {
    const was = legacy(c);
    if (!c.marking || c.empty || was) {
        return was;
    }
    if (c.label) {
        return 'label';
    }
    return c.tracking || c.weak >= 2 ? 'marking' : null;
}

// Новое: то же, что evidence() собирает со страницы.
function current(c) {
    const ev = {
        network: c.network,
        label: c.label,
        marking: c.marking,
        tracking: c.tracking,
        name: nameLevel({ strong: c.strong, cover: c.strong && c.cover, weak: c.weak, rootWeak: c.weak >= 2 && c.rootWeakRaw })
    };
    const d = decide(ev, c.empty);
    return d ? d.reason : null;
}

const bools = [false, true];
let total = 0;
const diffs = [];
for (const empty of bools) for (const network of bools) for (const label of bools) for (const marking of bools) for (const tracking of bools)
for (const strong of bools) for (const cover of bools) for (const weak of [0, 1, 2, 3]) for (const rootWeakRaw of bools) {
    const c = { empty, network, label, marking, tracking, strong, cover, weak, rootWeakRaw };
    total += 1;
    const was = expected(c);
    const now = current(c);
    if (was !== now) {
        diffs.push({ ...c, было: was, стало: now });
    }
}

const ok = diffs.length === 0;
console.log(`${ok ? 'ОК  ' : 'СБОЙ'} оценка признаков совпадает с прежней логикой и записанными изменениями во всех ${total} сочетаниях`);
if (!ok) {
    console.log(JSON.stringify(diffs.slice(0, 20), null, 1));
    console.log(`расхождений: ${diffs.length}`);
}
process.exit(ok ? 0 : 1);
