// Запуск замера наборов движка с российского IP — для perf-ru.bat.
// Батник держим только в ASCII: русский текст в .bat после chcp 65001
// cmd.exe читает со сбитой позицией и выполняет обрывки строк (11.10:
// «'лась' is not recognized…»). Сообщения пишет node — он выводит
// кириллицу в консоль сам, без смены кодовой страницы.
//
// Сборка, затем perf-rulesets.mjs --geo-ru --runs 2 --resume; оба вывода
// дописываются в docs/research/perf-ru.log.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.join(here, '..', 'docs', 'research', 'perf-ru.log');
fs.mkdirSync(path.dirname(logPath), { recursive: true });

function run(args) {
  return new Promise(resolve => {
    const log = fs.openSync(logPath, 'a');
    fs.writeSync(log, `\n=== ${new Date().toISOString()} node ${args.join(' ')}\n`);
    const child = spawn(process.execPath, args, { cwd: here, stdio: ['ignore', log, log] });
    child.on('error', err => { fs.writeSync(log, String(err) + '\n'); fs.closeSync(log); resolve(1); });
    child.on('close', code => { fs.closeSync(log); resolve(code ?? 1); });
  });
}

console.log('Сборка Cleathernet...');
if (await run(['build-extension.mjs'])) {
  console.log('Сборка не удалась, подробности в docs\\research\\perf-ru.log');
  process.exit(1);
}
console.log('Замер идёт, около полутора часов. Окно можно свернуть, но не закрывать.');
console.log('Ход — в docs\\research\\perf-ru.log');
if (await run(['perf-rulesets.mjs', '--geo-ru', '--runs', '2', '--resume'])) {
  console.log('Замер прервался, подробности в docs\\research\\perf-ru.log.');
  console.log('Запустите снова — продолжит с места обрыва.');
  process.exit(1);
}
console.log('Готово. Результат: docs\\research\\perf-rulesets.json');
