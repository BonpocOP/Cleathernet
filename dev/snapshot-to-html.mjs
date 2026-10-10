// Снимок страницы (MHTML) → один HTML со встроенными стилями, без скриптов.
//
// Расширение не видит страницы file:// (без разрешения «доступ к файлам»),
// а MHTML браузер открывает только с диска. Поэтому для тестов на сборке
// снимок переводим в обычный HTML и отдаём его по настоящему адресу сайта
// (page.route) — так на нём срабатывают и правила движка для этого сайта.
//
// Что теряется: скрипты (страница «замирает» в момент снимка — для тестов
// вёрстки это и нужно), содержимое фреймов, картинки из снимка (ссылки
// остаются, в тесте сеть закрыта — картинка пустая, но размер из CSS
// сохраняется).
//
//   node snapshot-to-html.mjs <page.mhtml> <out.html> [--width 1600]

import { chromium } from 'playwright';
import { browserOptions } from './browser.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [file, out] = process.argv.slice(2);
const wi = process.argv.indexOf('--width');
const width = wi === -1 ? 1600 : Number(process.argv[wi + 1]);
if (!file || !out) {
    console.error('node snapshot-to-html.mjs <page.mhtml> <out.html> [--width 1600]');
    process.exit(2);
}

const browser = await chromium.launch({ ...browserOptions(), headless: true });
try {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.route('**/*', route => (route.request().url().startsWith('file:') ? route.continue() : route.abort()));
    await page.goto(pathToFileURL(path.resolve(file)).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);

    const html = await page.evaluate(() => {
        // Все правила всех таблиц стилей — в один <style>. @import и
        // медиазапросы cssText сохраняет; недоступные таблицы пропускаем.
        const css = [];
        for (const sheet of document.styleSheets) {
            try { for (const rule of sheet.cssRules) css.push(rule.cssText); } catch { /* чужой источник */ }
        }
        const doc = document.documentElement.cloneNode(true);
        doc.querySelectorAll('script, noscript, link[rel="stylesheet"], link[rel="preload"], link[rel="prefetch"], link[rel="modulepreload"], style, base').forEach(n => n.remove());
        // Содержимое фреймов в снимке есть, но в HTML его не перенести:
        // оставляем пустой фрейм того же размера.
        doc.querySelectorAll('iframe').forEach(f => { f.removeAttribute('src'); f.removeAttribute('srcdoc'); });
        doc.querySelectorAll('[srcset]').forEach(n => n.removeAttribute('srcset'));
        const style = document.createElement('style');
        style.textContent = css.join('\n');
        const head = doc.querySelector('head');
        head.prepend(style);
        const meta = document.createElement('meta');
        meta.setAttribute('charset', 'utf-8');
        head.prepend(meta);
        return '<!doctype html>\n' + doc.outerHTML;
    });
    await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await fs.writeFile(out, html);
    console.log(`${out}: ${(html.length / 1024 / 1024).toFixed(1)} МБ`);
} finally {
    await browser.close();
}
