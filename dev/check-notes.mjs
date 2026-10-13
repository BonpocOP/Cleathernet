// Проверка рабочих записей (требования, STATUS, вопросы, идеи, план, память)
// на следы испорченных путей. Запись через скрипт в терминале не раз съедала
// обратную косую черту: `dev\night.bat` стал переводом строки, `Desktop\…` —
// словом `DesktopCleathernet`, `dev\perf-ru.bat` — `devperf-ru.bat`
// (13.10 — три раза за вечер). Хук после каждой команды терминала
// (.claude/settings.local.json) молчит, если всё чисто.
//
//   node check-notes.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const MEMORY = path.join(HOME, '.claude', 'projects', 'C--Users-homosapiens-Desktop-chrome-extention', 'memory');
const files = [
    path.join(ROOT, '.claude', 'CLAUDE.md'),
    ...['STATUS.md', 'QUESTIONS.md', 'IDEAS.md', 'INBOX.md'].map(name => path.join(ROOT, 'docs', name)),
    path.join(HOME, '.claude', 'plans', 'cozy-plotting-biscuit.md'),
    ...(fs.existsSync(MEMORY) ? fs.readdirSync(MEMORY).filter(name => name.endsWith('.md')).map(name => path.join(MEMORY, name)) : [])
].filter(file => fs.existsSync(file));

// Слитые пути: папка проекта сразу со следующим именем без разделителя.
const GLUED = /\b(?:Desktop(?=[A-ZА-Я])|dev(?=(?:perf|night|sweep|build|test|install)[\w-]*\.(?:bat|mjs|ps1))|fixtures(?=raw|private))/;

const problems = [];
for (const file of files) {
    const text = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
        if (GLUED.test(line)) problems.push(`${file}:${i + 1}: слитый путь — ${line.trim().slice(0, 80)}`);
    });
    // Абзац с нечётным числом обратных кавычек: перевод строки внутри `…`.
    let inFence = false;
    let start = 0;
    let ticks = 0;
    lines.forEach((line, i) => {
        if (line.trim().startsWith('```')) {
            inFence = !inFence;
            return;
        }
        if (inFence) return;
        if (!line.trim()) {
            if (ticks % 2) problems.push(`${file}:${start + 1}: нечётное число \` в абзаце — обрыв строки внутри кода?`);
            ticks = 0;
            start = i + 1;
            return;
        }
        ticks += (line.match(/`/g) || []).length;
    });
    if (ticks % 2) problems.push(`${file}:${start + 1}: нечётное число \` в абзаце — обрыв строки внутри кода?`);
}
if (problems.length) {
    console.log(`Испорченные записи (${problems.length}) — поправить инструментом Edit:\n${problems.slice(0, 15).join('\n')}`);
}
