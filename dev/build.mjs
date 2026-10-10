// Сборка скриптов страницы в один файл внутри замыкания.
//
// Content scripts одного расширения делят изолированный мир. Пока мы одни,
// 155 наших глобальных объявлений никому не мешают, но рядом встанут скрипты
// uBO Lite (Э2) — и имена начнут сталкиваться. Поэтому src/content/*.js
// склеиваются в порядке из src/content/order.json и заворачиваются в
// (() => { ... })(): наружу не торчит ни одно имя.
//
// Семантика не меняется: файлы и раньше жили в одной области видимости,
// теперь это область функции, а не глобальная.
//
// Результат — src/bundle/content.js — коммитится, чтобы расширение ставилось
// из папки без сборки.
//
// Так же собирается общий механизм сборки Cleathernet (Э3):
// platform/generic/*.js → platform/bundle/generic.js. Два замыкания не
// делят имён: у общего механизма свои OFF_SITES_KEY и прочее.
//
// Общие файлы сборки (shared) — ES-модули без импортов из platform/shared:
// страницы расширения их импортируют, а сюда они вклеиваются в начало
// замыкания без слова export. Бандл Игр (src/content) их не получает:
// слой Игр не меняем.
//
//   node build.mjs          собрать
//   node build.mjs --check  проверить, что собранные файлы не устарели (для тестов)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BUNDLES = [
    { src: 'src/content', out: 'src/bundle/content.js' },
    { src: 'platform/generic', out: 'platform/bundle/generic.js', shared: ['platform/shared/site-state.js'] }
];

// Общий ES-модуль → текст для замыкания: без export. Импортов быть не
// должно — в замыкании их некуда деть.
function sharedPart(file) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
    if (/^\s*import\s/m.test(text)) {
        throw new Error(`${file}: в общем файле для бандла не должно быть import`);
    }
    return `// ===== ${file} =====\n${text.replace(/^export (?=(?:const|let|function|async function|class) )/gm, '').trimEnd()}\n`;
}

function bundle(dir, shared = []) {
    const SRC = path.join(ROOT, dir);
    const order = JSON.parse(fs.readFileSync(path.join(SRC, 'order.json'), 'utf8'));
    const present = fs.readdirSync(SRC).filter(name => name.endsWith('.js')).sort();
    const missing = present.filter(name => !order.includes(name));
    if (missing.length) {
        throw new Error(`Файлы не указаны в ${dir}/order.json: ` + missing.join(', '));
    }

    const parts = order.map(name => {
        const text = fs.readFileSync(path.join(SRC, name), 'utf8')
            .replace(/\r\n/g, '\n')
            .replace(/^'use strict';\n/, '');
        return `// ===== ${dir}/${name} =====\n${text.trimEnd()}\n`;
    });

    return [
        `// Собрано dev/build.mjs из ${dir}/*.js — не править руками.`,
        '// Правки — в исходниках, затем `node dev/build.mjs`.',
        '(() => {',
        "'use strict';",
        '',
        shared.map(sharedPart).concat(parts).join('\n'),
        '})();',
        ''
    ].join('\n');
}

let stale = false;
for (const { src, out, shared } of BUNDLES) {
    const file = path.join(ROOT, out);
    const text = bundle(src, shared);
    if (process.argv.includes('--check')) {
        const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
        if (current !== text) {
            console.error(`${out} устарел: запустите node dev/build.mjs`);
            stale = true;
        } else {
            console.log(`${out} актуален`);
        }
    } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
        console.log(`${out} — ${text.length} байт`);
    }
}
if (stale) {
    process.exit(1);
}
