// Свежая сборка — в папку, из которой расширение загружено в браузер.
//
// build/extension для этого не годится: тесты пересобирают её на ходу, и
// загруженное расширение ломается посреди работы. Поэтому — копия, и на
// копии отметка сборки (version_name: дата и коммит): её видно в
// chrome://extensions и в отчёте «Сообщить о проблеме», так что всегда
// понятно, какая сборка стоит. Версия (version) не меняется — от неё
// зависит проверка обновлений.
//
//   node install-local.mjs [папка]   (по умолчанию Desktop\Cleathernet-test)
//
// После — chrome://extensions → Cleathernet → «Обновить» (круглая стрелка).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DEV, '..');
const BUILD = path.join(ROOT, 'build', 'extension');
const target = path.resolve(process.argv[2] || path.join(os.homedir(), 'Desktop', 'Cleathernet-test'));

// Стираем только папку, где уже лежит Cleathernet (или пустую/новую).
if (fs.existsSync(target)) {
    const manifest = path.join(target, 'manifest.json');
    const ours = fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === 'Cleathernet';
    if (!ours && fs.readdirSync(target).length) {
        throw new Error(`${target} — не папка Cleathernet, не трогаю`);
    }
}

execFileSync(process.execPath, [path.join(DEV, 'build-extension.mjs')], { cwd: DEV, stdio: 'inherit' });

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const commit = git('rev-parse', '--short', 'HEAD');
const dirty = git('status', '--porcelain').length > 0;
const now = new Date();
const pad = n => String(n).padStart(2, '0');
const stamp = `${pad(now.getDate())}.${pad(now.getMonth() + 1)} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(BUILD, target, { recursive: true });
// Индексы правил Chrome строит сам при загрузке.
fs.rmSync(path.join(target, '_metadata'), { recursive: true, force: true });

const manifestFile = path.join(target, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
manifest.version_name = `${manifest.version} · сборка ${stamp} · ${commit}${dirty ? ' + правки' : ''}`;
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

console.log(`\n${target}\n${manifest.version_name}\nДальше: chrome://extensions → Cleathernet → «Обновить» (круглая стрелка), открытые вкладки — F5.`);
