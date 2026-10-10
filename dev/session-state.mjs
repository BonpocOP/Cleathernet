// Снимок состояния проекта на конец рабочей сессии и сравнение с ним в
// начале следующей — чтобы новая сессия начиналась с «что изменилось», а
// не с перечитывания всей прошлой переписки (навыки end-session и
// start-session в .claude/skills).
//
//   node session-state.mjs --save   записать снимок (.claude/last-session.json)
//   node session-state.mjs --diff   что изменилось с прошлого снимка
//
// Снимок — вне git (.claude/ исключена): в нём имена присланных файлов.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, '.claude', 'last-session.json');
// Папки, куда приходит новое без меня: отчёты знакомого, снимки страниц.
const WATCH = ['test/fixtures/raw/reports', 'test/fixtures/raw/fp', 'test/fixtures/private/snippets', 'docs'];
const BROWSER_COPY = path.join(os.homedir(), 'Desktop', 'Cleathernet-test', 'manifest.json');

const git = (...args) => {
    try {
        return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch {
        return '';
    }
};

function listFiles(dir) {
    const abs = path.join(ROOT, dir);
    const out = {};
    if (!fs.existsSync(abs)) {
        return out;
    }
    const walk = (folder, prefix) => {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                walk(path.join(folder, entry.name), rel);
            } else {
                const stat = fs.statSync(path.join(folder, entry.name));
                out[rel] = { size: stat.size, mtime: Math.round(stat.mtimeMs) };
            }
        }
    };
    walk(abs, '');
    return out;
}

function snapshot() {
    let browserBuild = null;
    try {
        browserBuild = JSON.parse(fs.readFileSync(BROWSER_COPY, 'utf8')).version_name || null;
    } catch { /* папки браузера нет */ }
    let engine = null;
    try {
        engine = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor', 'ubol.json'), 'utf8')).version;
    } catch { /* нет закрепления */ }
    return {
        savedAt: new Date().toISOString(),
        head: git('rev-parse', '--short', 'HEAD'),
        branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
        ahead: git('rev-list', '--count', '@{u}..HEAD'),
        dirty: git('status', '--porcelain').split('\n').filter(Boolean),
        browserBuild,
        engine,
        files: Object.fromEntries(WATCH.map(dir => [dir, listFiles(dir)]))
    };
}

if (process.argv.includes('--save')) {
    const now = snapshot();
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(now, null, 1));
    console.log(`Снимок записан: ${now.savedAt}, HEAD ${now.head}, незакоммичено ${now.dirty.length}, в браузере «${now.browserBuild}»`);
    process.exit(0);
}

// --diff
if (!fs.existsSync(STATE)) {
    console.log('Снимка прошлой сессии нет (.claude/last-session.json) — читать STATUS и план целиком.');
    process.exit(0);
}
const was = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const now = snapshot();
const lines = [];
lines.push(`Прошлая сессия закончилась: ${was.savedAt}`);
if (was.head !== now.head) {
    lines.push(`Коммиты с тех пор: ${git('log', '--oneline', `${was.head}..HEAD`) || '(история изменилась: было ' + was.head + ', стало ' + now.head + ')'}`);
} else {
    lines.push(`Коммитов нет, HEAD ${now.head}`);
}
lines.push(`Впереди GitHub: ${now.ahead || '?'} коммит(а); незакоммичено файлов: ${now.dirty.length}${now.dirty.length !== was.dirty.length ? ` (было ${was.dirty.length})` : ''}`);
if (was.browserBuild !== now.browserBuild) {
    lines.push(`Сборка в браузере сменилась: «${was.browserBuild}» → «${now.browserBuild}»`);
}
if (was.engine !== now.engine) {
    lines.push(`uBO Lite: ${was.engine} → ${now.engine}`);
}
for (const dir of WATCH) {
    const before = was.files[dir] || {};
    const after = now.files[dir] || {};
    const added = Object.keys(after).filter(name => !before[name]);
    const changed = Object.keys(after).filter(name => before[name] && (before[name].mtime !== after[name].mtime || before[name].size !== after[name].size));
    const removed = Object.keys(before).filter(name => !after[name]);
    if (added.length || changed.length || removed.length) {
        lines.push(`${dir}: новых ${added.length}${added.length ? ' — ' + added.slice(0, 15).join(', ') : ''}; изменено ${changed.length}${changed.length ? ' — ' + changed.slice(0, 15).join(', ') : ''}${removed.length ? `; удалено ${removed.length}` : ''}`);
    }
}
if (lines.length <= 3) {
    lines.push('Новых файлов нет.');
}
console.log(lines.join('\n'));
