// Общий механизм (Э3): реклама, которую оставили общие списки, скрыта
// вместе с местом, а обычный контент не тронут — на любом сайте, без
// правил сайта.
//
// Страницы — образцы из test/fixtures, отдаются по настоящим адресам
// сайтов без сети (page.route): так на них срабатывают и правила движка
// uBO Lite для этого сайта, как у пользователя. Каждая страница
// открывается дважды: в браузере без расширений (как было) и со сборкой
// Cleathernet (build/extension) — и результаты сравниваются.
//
// Снимки Авито тяжёлые и в git не хранятся (test/fixtures/raw/pages,
// делаются из MHTML: node snapshot-to-html.mjs). Если их нет, эти
// проверки пропускаются, остальные работают где угодно.
//
// Присланный пропуск сразу становится случаем с todo (каким этапом плана
// он закрывается): прогон остаётся зелёным, пропуски печатаются строкой
// «Ждут исправления». Исправили — снять todo.
//
//   node test-generic.mjs [--headed] [--only <часть id>]

import { chromium } from 'playwright';
import { browserOptions } from './browser.mjs';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DEV, '..');
const EXT = path.join(ROOT, 'build', 'extension');
// Образцы вырезаны из страниц, присланных пользователями из России, — не
// наши: лежат локально в test/fixtures/private (в git не попадают). Нет
// образца (GitHub, чужая машина) — случай пропускается.
const SNIPPETS = path.join(ROOT, 'test', 'fixtures', 'private', 'snippets');
class MissingSample extends Error {}
const PAGES = path.join(ROOT, 'test', 'fixtures', 'raw', 'pages');
const headed = process.argv.includes('--headed');
const oi = process.argv.indexOf('--only');
const only = oi === -1 ? null : process.argv[oi + 1];
// Сколько ждать после загрузки: движку — вставить косметику, нам —
// пройти по странице.
const SETTLE_MS = 2500;

const snippet = async name => {
    const file = path.join(SNIPPETS, name);
    if (!existsSync(file)) {
        throw new MissingSample(path.relative(ROOT, file));
    }
    return (await fs.readFile(file, 'utf8')).replace(/^<!--[\s\S]*?-->\s*/, '');
};
const page = (title, css, body) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head><body>${body}</body></html>`;

// ---------- страницы с рекламой ----------
// slot — внешний контейнер рекламы: он должен перестать занимать место.
// content — то, что должно остаться видимым, как без расширения.

const kinogo = async ({ neighbor = false } = {}) => page('Сериал — смотреть онлайн бесплатно',
    `body{margin:0;font:14px Arial,sans-serif;background:#161616;color:#ddd}
     .wrapper{width:960px;margin:0 auto}
     h1{margin:15px 20px;font-size:22px}
     .player{display:block;width:900px;height:500px;margin:15px 20px 0;background:#000}
     .fdesc{margin:15px 20px;line-height:1.5}
     .comment{margin:0 20px;padding:10px 0;border-bottom:1px solid #333}` +
    // Сосед (uBO, AdBlock) спрятал сам баннер, но не обёртку с min-height.
    (neighbor ? '.kinogo-short, ins[data-cp-host] { display: none !important; }' : ''),
    `<div class="wrapper">
       <h1 class="title">Сериал «Пример» (2026) — 1 сезон</h1>
       <video class="player" id="player" width="900" height="500"></video>
       ${await snippet('kinogo-kng-rekl.html')}
       <div class="fdesc" id="description">Описание сериала: главный герой возвращается в родной город и узнаёт, что за время его отсутствия всё изменилось.</div>
       <div class="comments">
         <div class="comment"><b>Аня</b><p>Смотрю второй раз, очень нравится.</p></div>
         <div class="comment"><b>Олег</b><p>Когда будет вторая серия?</p></div>
       </div>
     </div>`);

const vk = async () => page('Новости',
    `body{margin:0;font:13px -apple-system,Arial,sans-serif;background:#edeef0;color:#000}
     #page_body{display:flex;gap:16px;width:960px;margin:16px auto}
     #main_feed{width:550px}
     #narrow_column{width:300px}
     .page_block{background:#fff;border-radius:8px;margin-bottom:16px;padding:12px}
     .post{min-height:120px}
     .apps_feedRightAppsBlock__ava{width:276px;height:156px;display:block}
     .apps_feedRightAppsBlock__hide{float:right;width:16px;height:16px}`,
    `<div id="page_body">
       <div id="main_feed">
         <div class="page_block post"><b>Сообщество «Кулинария»</b><p>Рецепт осеннего супа из тыквы с имбирём.</p></div>
         <div class="page_block post"><b>Мария Иванова</b><p>Наконец-то съездили на море, фото будут позже.</p></div>
         <div class="page_block post"><b>Новости города</b><p>В субботу на набережной пройдёт ярмарка.</p></div>
       </div>
       <div id="narrow_column">
         <div class="page_block friends_block"><b>Друзья онлайн</b><p>Мария, Олег, Анна</p></div>
         ${await snippet('vk-feed-promo-game.html')}
         <div class="page_block groups_block"><b>Сообщества</b><p>Кулинария · Новости города · Бег</p></div>
       </div>
     </div>`);

// Обычные результаты — настоящие (yandex-search-organic.html, три <li>).
// Плюс один наш, по их вёрстке: слово «реклама» в заголовке, тексте и
// быстрой ссылке — ловушка для поиска метки по подстроке.
const organic = (title, host, text, sitelink = '') =>
    `<li class="aGxDtSiQdfbXz"><div class="Organic Typo Typo_text_m Typo_line_s"><div class="OrganicTitle OrganicTitle_size_l"><a class="Link OrganicTitle-Link link" href="https://${host}/"><h2 class="OrganicTitle-LinkText"><span class="OrganicTitleContentSpan">${title}</span></h2></a></div><div class="Organic-Subtitle"><div class="Path Organic-Path"><a class="Link Path-Item link" href="https://${host}/"><b>${host}</b></a></div></div><div class="Organic-ContentWrapper"><div class="OrganicText Typo Typo_text_m Typo_line_m"><span class="OrganicTextContentSpan">${text}</span></div>${sitelink ? `<div class="Sitelinks Organic-Sitelinks"><div class="Sitelinks-Item"><a class="Link Sitelinks-Title link" href="https://${host}/help">${sitelink}</a></div></div>` : ''}</div></div></li>`;

const yandexSearch = async () => {
    const [organic1, organic2, organic3] = (await snippet('yandex-search-organic.html')).trim().split('\n');
    return page('яндекс диск — Яндекс: нашлось 2 млн результатов',
    `body{margin:0;font:15px Arial,sans-serif;color:#000}
     .content{width:620px;margin:20px 0 0 160px}
     #search-result{list-style:none;margin:0;padding:0}
     #search-result > li{margin-bottom:24px}
     .OrganicTitle-LinkText{font-size:18px;margin:0;font-weight:normal}
     .Favicon{display:inline-block}
     .Extralinks{display:none}
     .Sitelinks-Item{display:inline-block;margin-right:12px}`,
    `<div class="content"><ul id="search-result">
       ${await snippet('yandex-search-promo-first.html')}
       ${organic1}
       <li class="aGxDtSiQdfbXz">${await snippet('yandex-search-promo-wrapped.html')}</li>
       ${organic('Реклама в Яндекс Диске: как отключить', 'pikabu.ru', 'Реклама в приложении мешает? Рассказываем, как убрать рекламу и что даёт подписка. Промо-страница с тарифами — на сайте.', 'Реклама')}
       <li class="aGxDtSiQdfbXz">${await snippet('yandex-search-direct-block.html')}</li>
       ${organic2}
       ${await snippet('yandex-search-promo-middle.html')}
       ${organic3}
     </ul></div>`);
};

// Догрузка: скрипт страницы добавляет рекламный результат в выдачу уже
// после загрузки — как лента при прокрутке.
const yandexLate = async () => {
    const [organic1, organic2, organic3] = (await snippet('yandex-search-organic.html')).trim().split('\n');
    const late = JSON.stringify(await snippet('yandex-search-promo-middle.html'));
    return page('яндекс диск — Яндекс: догрузка', '#search-result{list-style:none;margin:0;padding:0} #search-result > li{margin-bottom:24px}',
        `<ul id="search-result">${organic1}${organic2}${organic3}</ul>
         <script>setTimeout(() => document.getElementById('search-result').insertAdjacentHTML('beforeend', ${late}), 800);</script>`);
};

// Яндекс Видео (08–09.10): реклама в списке роликов и баннер справа.
// Содержимое обоих — в закрытом теневом DOM (так их прислали: при
// копировании блок пустой). Обычные ролики — по вёрстке списка, текст наш.
const yandexVideo = async () => {
    const video = (n, title, meta) => `<li class="rpdfYZavCFeature rpdfYZavCFeature_position_${n}"><a class="vItem" href="https://vk.com/video-${n}"><span class="vThumb"></span><span class="vText"><span class="vTitle">${title}</span><span class="vMeta">${meta}</span></span></a></li>`;
    return page('сериалы — Яндекс Видео',
        `body{margin:0;font:15px Arial,sans-serif;color:#000}
         .SearchPageColumns{display:flex;gap:80px;margin:24px 0 0 140px}
         #video-list{list-style:none;margin:0;padding:0;width:740px}
         #video-list > li{margin-bottom:12px}
         .vItem{display:flex;gap:16px;color:#000;text-decoration:none}
         .vThumb{display:block;width:228px;height:128px;border-radius:12px;background:#333}
         .vTitle{display:block;font-size:17px;color:#001a8f}
         .vMeta{display:block;color:#666;margin-top:6px}
         .SearchPageColumns-Right{width:640px}
         .RightSerpListFeature{list-style:none;margin:0;padding:0}`,
        `<div class="SearchPageColumns"><ul id="video-list">
           ${video(0, 'Обзор сериала «Пример» — Видео от канала', 'VK Видео · 23K · 2 авг 2021')}
           ${video(1, 'Трейлер второго сезона — Видео от канала', 'VK Видео · 5 окт 2026')}
           ${video(2, 'Интервью с актёрами — Видео от канала', 'VK Видео · 4 окт 2026')}
           ${video(3, 'Лучшие сериалы года — подборка', 'VK Видео · 5K · 29 окт 2022')}
           ${await snippet('yandex-video-list-ad.html')}
           ${video(5, 'Обзор новых сериалов осени', 'VK Видео · 12K · 1 окт 2026')}
         </ul>
         ${await snippet('yandex-video-right-banner.html')}</div>
         <script>window.yaContextCb = window.yaContextCb || [];</script>`);
};

// Яндекс Карты (27.09): «Соцреклама» в карточке места, между хлебными
// крошками и подвалом; содержимое — в закрытом теневом DOM.
const yandexMaps = async () => page('Остановка — Яндекс Карты',
    `body{margin:0;font:14px Arial,sans-serif;color:#000}
     .sidebar-view{width:420px;padding:0 20px;background:#fff}
     .review{padding:12px 0;border-bottom:1px solid #eee}
     .breadcrumbs-view{padding:16px 0;color:#666}
     .card-footer-view{padding:16px 0;color:#666}
     .map{position:fixed;left:460px;top:0;right:0;bottom:0;background-image:linear-gradient(#e8eef0,#dfe7ea)}`,
    `<div class="sidebar-view"><div class="business-reviews-card-view">
       <div class="review"><b>Покупатель</b><p>Удобная остановка, рядом магазин и аптека, навес от дождя.</p></div>
       <div class="review"><b>Житель района</b><p>Автобусы ходят редко вечером, расписание стоит уточнять.</p></div>
       <div class="business-reviews-card-view__more">Посмотреть все 12 отзывов</div>
     </div>
     <div class="masstransit-stop-panel-view__breadcrumbs"><div class="breadcrumbs-view"><a href="https://yandex.ru/maps/">Карты</a> · <a href="https://yandex.ru/maps/213/moscow/">Москва</a> · <a href="https://yandex.ru/maps/213/moscow/transport/">Общественный транспорт</a></div></div>
     ${await snippet('yandex-maps-social-ad.html')}
     <footer class="card-footer-view"><a href="https://yandex.ru/support/maps/">Сообщить об ошибке</a> · <a href="https://mobile.yandex.ru/apps/maps/">Мобильное приложение</a></footer>
     </div><div class="map" title="карта — фон с градиентом, как картинка: не пустое место"></div>`);

// VK, лента (09.10): «Игра для вас» между постами. Лента — виртуальный
// список, как у VK: пункты стоят абсолютно, их места пересчитывает скрипт
// страницы по размеру каждого пункта (ResizeObserver). Спрятанный блок не
// должен оставить дыру, а посты — сместиться поверх друг друга.
const vkFeed = async () => {
    const post = (n, name, text) => `<article data-index="${n}" tabindex="0" style="position: absolute; width: 100%; top: 0px; left: 0px;"><div><section class="post"><b>${name}</b><p>${text}</p><div class="photo"></div></section></div></article>`;
    return page('Новости',
        `body{margin:0;font:13px -apple-system,Arial,sans-serif;background:#edeef0;color:#000}
         #feed-rows{position:relative;width:550px;margin:16px auto}
         section{background:#fff;border-radius:12px;margin-bottom:16px;padding:12px}
         .photo{height:300px;background:#c9d3de;border-radius:8px}`,
        `<div id="feed-rows">
           ${post(0, 'Сообщество «Настольные игры»', 'Собираемся в субботу в клубе, приносите свои коробки.')}
           ${post(1, 'Сообщество «Кулинария»', 'Рецепт осеннего супа из тыквы с имбирём.')}
           ${post(2, 'Новости города', 'В субботу на набережной пройдёт ярмарка.')}
           ${await snippet('vk-feed-recommended-game.html')}
           ${post(4, 'Беговой клуб', 'Забег выходного дня: фотографии участников.')}
         </div>
         <script>(() => {
           const list = document.getElementById('feed-rows');
           const layout = () => {
             let y = 0;
             for (const row of list.querySelectorAll(':scope > article')) {
               row.style.transform = 'translateY(' + y + 'px)';
               y += row.offsetHeight;
             }
             list.style.height = y + 'px';
           };
           const ro = new ResizeObserver(layout);
           list.querySelectorAll(':scope > article').forEach(row => ro.observe(row));
           layout();
         })();</script>`);
};

// Авито, каталог новостроек (10.10): карусель застройщика с маркировкой —
// <div> среди <li> списка ЖК. Стилей Авито нет — только размеры, чтобы
// карточки и карусель выглядели как на сайте (значки svg в образце
// вычищены — без размера они растягиваются до 300×150).
const avitoDevelopments = async () => page('Новостройки в Москве',
    `body{margin:0;font:14px Arial,sans-serif;color:#000}
     #dev-list{list-style:none;width:1100px;margin:16px auto;padding:0}
     #dev-list > li{display:flex;gap:24px;padding:24px 0;min-height:220px}
     #dev-list img{width:220px;height:160px;object-fit:cover;background:#ddd}
     [data-marker="brandspace-nd-widget"]{margin:24px 0;padding:24px;border-radius:24px;background:#f2f1f0}
     [data-marker="brandspace-nd-widget"] svg{width:16px;height:16px}`,
    `<div data-marker="developments-list"><ul id="dev-list">
       ${await snippet('avito-developments-brandspace.html')}
     </ul></div>`);

// Яндекс Карты, карточка остановки (10.10): плашка «Кешбэк 20%» со значком
// «Реклама» над расписанием и адресом остановки (адрес выдуман).
const yandexMapsStop = async ({ neighbor = false } = {}) => page('Примерная улица, остановка — Яндекс Карты',
    `body{margin:0;font:14px Arial,sans-serif;color:#000}` +
    // Сосед или движок спрятал только значок «Реклама» (так делает RU AdList
    // при повторном заходе) — плашка осталась без пометки.
    (neighbor ? '.advert-badge{display:none !important}' : '') +
    `
     .sidebar-view{width:420px;padding:0 20px;background:#fff}
     .banner-preview-view__preview{display:flex;align-items:center;gap:12px;padding:12px;border-radius:12px;background:#f4f5f7}
     .banner-preview-view__icon{width:40px;height:40px;border-radius:8px;background-color:#fc3f1d}
     .schedule,.address{padding:16px 0;border-bottom:1px solid #eee}
     .map{position:fixed;left:460px;top:0;right:0;bottom:0;background-image:linear-gradient(#e8eef0,#dfe7ea)}`,
    `<div class="sidebar-view">
       ${await snippet('yandex-maps-offer-banner.html')}
       <div class="schedule"><b>Расписание</b><p>Пока нет информации</p></div>
       <div class="address"><b>Адрес</b><p><a href="/maps/213/moscow/geo/primernaya_ulitsa/1/">Москва, Примерная улица</a></p></div>
     </div><div class="map" title="карта — фон с градиентом, как картинка: не пустое место"></div>`);

// Почта mail.ru, открытое письмо (10.10; классы — как в разметке почты,
// текст, дата и адреса выдуманы). Прокручиваемая область письма названа по
// рекламе сверху (scrollable_top-line-adv-2pane) — это контейнер, а не
// реклама; ручка ширины колонки 7 px с js-promo-id_… — не место рекламы. Сначала в
// рамке письма только заготовка под рекламу (пустая, место держит),
// письмо приходит через секунду — так почта собирает страницу. В шапке
// письма — кнопки-значки с js-promo-id_… (подсказки интерфейса, не
// реклама): без текста они выглядят пустыми, но малы для рекламного
// места (порог приманок 100×50) — трогать их нельзя.
const mailLetterLate = ({ late = true, neighbor = false, noAd = false } = {}) => page('Входящие — Почта Mail',
    `body{margin:0;font:14px Arial,sans-serif;color:#000;background:#eef0f3}
     .layout__main-frame{width:1100px;min-height:700px;margin:16px auto;background:#fff;border-radius:16px}
     .scrollable{height:700px;overflow:auto}
     .letter-list-item-adv{height:96px;margin:12px;border-radius:12px;background:#f0f1f3}
     .letter__head{display:flex;gap:12px;align-items:center;padding:16px}
     .letter__flag{display:inline-block}
     .letter__flag .button2{display:inline-block;padding:6px}
     .letter-body{padding:16px 24px;min-height:300px}` +
    // Движок (RU AdList) прячет саму заготовку рекламы, как вживую.
    (neighbor ? '.letter-list-item-adv{display:none !important}' : ''),
    `<div class="layout__resizer  js-promo-id_left-column-resizer layout__resizer_left" style="position:fixed;left:0;top:0;width:7px;height:100vh;background:#e4e6ea"></div>
     <div class="layout__main-frame"><div class="scrollable scrollable_content scrollable_styled scrollable_background-transparent scrollable_scroll-style_traditional scrollable_top-line-adv-2pane scrollable_top-line-adv-2pane_high-block"><div class="layout__content-column"><div class="layout__letter-content">
       ${noAd ? '' : '<div class="react-async"><div class="letter-list-item-adv letter-list-item-adv_rounded letter-list-item-adv_topline"><div class="letter-list-item-adv__container"><div class="letter-list-item-adv-placeholder"><div class="letter-list-item-adv-placeholder__string"></div></div><div class="letter-list-item-adv__adv-content"></div></div></div></div>'}
     </div></div></div></div>
     <template id="letter">
       <div class="letter__head"><b class="letter__author">Магазин игр</b><span class="letter__date">1 января, 12:00</span>
         <div class="letter__flag  js-promo-id_letter-head-share-button" data-promo-id="letter-head-share-button"><span class="button2 button2_has-ico" title="Скопировать ссылку"><svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg></span></div>
         <div class="letter__flag  js-promo-id_letter-head-calendar-button" data-promo-id="letter-head-calendar-button"><span class="button2 button2_has-ico" title="Добавить в календарь"><svg width="20" height="20" viewBox="0 0 20 20"><rect x="3" y="3" width="14" height="14"/></svg></span></div>
       </div>
       <div class="letter__body"><div class="letter-body"><p class="letter-text">Продавец товара написал сообщение. У вас появились новые сообщения в чате с продавцом по заказу 12345678.</p><a class="letter-link" href="https://shop.example/order/1">Перейти к заказу</a></div></div>
     </template>
     <script>setTimeout(() => document.querySelector('.layout__letter-content').append(document.getElementById('letter').content.cloneNode(true)), ${late ? 1000 : 0});</script>`);

// Нативная реклама на обычном сайте (синтетический образец, этап 4):
// карточка в ленте новостей с меткой «Реклама» и маркировкой по закону —
// без рекламных классов, сетей и ссылок учёта. Метка сама не решает,
// маркировка сама не решает, вместе — реклама.
const nativeMarked = () => page('Новости города',
    `body{margin:0;font:15px Arial,sans-serif;color:#222}
     .news-grid{display:grid;grid-template-columns:repeat(3,300px);gap:16px;width:932px;margin:24px auto}
     .news-card{border:1px solid #ddd;border-radius:8px;padding:12px;min-height:160px}
     .tag{display:inline-block;padding:1px 6px;background:#eee;border-radius:4px;font-size:12px}
     .legal{font-size:10px;color:#888}`,
    `<div class="news-grid" id="news">
       <div class="news-card"><h3>В городе открыли новый каток</h3><p>Каток будет работать до марта.</p></div>
       <div class="news-card"><h3>Расписание электричек изменится</h3><p>С понедельника — новые часы.</p></div>
       <div class="news-card" id="native"><span class="tag">Реклама</span><h3>Кредит наличными под 0%</h3><p>Оформите онлайн за 5 минут.</p><p class="legal">Реклама. Рекламодатель ООО «Банк Пример», ИНН 7700000002. erid: 2VtzqwXYZ12</p></div>
       <div class="news-card"><h3>Ярмарка в субботу</h3><p>На набережной — фермерские продукты.</p></div>
       <div class="news-card"><h3>Ремонт моста</h3><p>Движение ограничат на две недели.</p></div>
       <div class="news-card"><h3>Погода на неделю</h3><p>Ожидается похолодание.</p></div>
     </div>`);

// ---------- контрольные страницы: рекламы нет, трогать нечего ----------

// Ловушки для маркировки по закону (этап 4): новость о законе о рекламе
// цитирует маркировку в карточке ленты, а подвал сайта — с ОГРН, ИНН и
// ссылкой «Реклама». Других признаков рекламы нет — трогать нельзя.
const newsMarking = () => page('Новости — закон о рекламе',
    `body{margin:0;font:15px Arial,sans-serif;color:#222}
     .news-grid{display:grid;grid-template-columns:repeat(3,300px);gap:16px;width:932px;margin:24px auto}
     .news-card{border:1px solid #ddd;border-radius:8px;padding:12px;min-height:160px}
     .site-bottom{width:932px;margin:24px auto;padding:16px 0;border-top:1px solid #ddd;color:#666;font-size:13px}`,
    `<div class="news-grid" id="news">
       <div class="news-card"><h3>В городе открыли новый каток</h3><p>Каток будет работать до марта.</p></div>
       <div class="news-card"><h3>Как теперь маркируют рекламу</h3><p>Пример пометки: «Реклама. Рекламодатель ООО «Ромашка», ИНН 7700000000, erid: 2VtzqvABCde».</p><a href="https://news.example.ru/zakon?utm_source=SECRETTOKEN#x">Подробнее</a></div>
       <div class="news-card"><h3>Расписание электричек изменится</h3><p>С понедельника — новые часы.</p></div>
       <div class="news-card"><h3>Ярмарка в субботу</h3><p>На набережной — фермерские продукты.</p></div>
       <div class="news-card"><h3>Ремонт моста</h3><p>Движение ограничат на две недели.</p></div>
       <div class="news-card"><h3>Погода на неделю</h3><p>Ожидается похолодание.</p></div>
     </div>
     <div class="site-bottom" id="legal">© 2026 ООО «Городские новости», ОГРН 1027700000000, ИНН 7700000001. <a href="/reklama/">Реклама</a> · <a href="/contacts/">Контакты</a></div>`);

// Ловушка к R11 (В — маркировка строкой как метка): короткая заметка, где
// пример маркировки стоит отдельным абзацем, и сайт без тега <article>.
// Это текст о рекламе, а не реклама.
const markingExample = () => page('Как маркировать рекламу — заметки',
    `body{margin:0;font:16px Georgia,serif;color:#222}
     .wrap{width:720px;margin:24px auto}
     .post-list{display:grid;gap:24px}
     .post{padding:16px;border:1px solid #ddd;border-radius:8px}
     .example{padding:8px 12px;background:#f6f6f6;font:13px monospace}`,
    `<div class="wrap"><h1>Заметки маркетолога</h1><div class="post-list">
       <div class="post"><h2>Как маркировать рекламу в 2026 году</h2>
         <p>С 2022 года интернет-реклама в России помечается. В пометке — слово «Реклама», рекламодатель и его ИНН, а ещё токен erid, который выдаёт оператор рекламных данных.</p>
         <p class="example">Реклама. Рекламодатель ООО «Ромашка», ИНН 7700000000, erid: 2VtzqvABCde</p>
         <p>Пометку ставят рядом с объявлением. Без неё штраф — до полумиллиона рублей.</p></div>
       <div class="post"><h2>Где брать токен erid</h2><p>Его выдаёт оператор рекламных данных после регистрации креатива.</p></div>
       <div class="post"><h2>Что делать блогеру</h2><p>Блогер тоже маркирует рекламные посты, если получает за них деньги.</p></div>
     </div></div>`);

// Ловушки к «осиротевшей рекламе»: ссылка «Реклама» спрятана самим сайтом —
// в выпадающем меню среди других пунктов и в подвале на узком экране.
const hiddenAdLinks = () => page('Городской портал',
    `body{margin:0;font:15px Arial,sans-serif;color:#222}
     .top{display:flex;gap:24px;padding:16px 32px;background:#f4f4f4}
     .more ul{display:none;position:absolute;list-style:none;margin:0;padding:8px;background:#fff}
     .wrap{width:900px;margin:24px auto}
     .card{padding:16px;margin-bottom:16px;border:1px solid #ddd}
     .links{display:flex;gap:16px;padding:16px 32px;color:#666}
     .links .wide{display:none}`,
    `<nav class="top"><a href="/">Главная</a><a href="/news/">Новости</a>
       <div class="more">Ещё<ul><li><a href="/about/">О проекте</a></li><li><a href="/reklama/">Реклама</a></li><li><a href="/contacts/">Контакты</a></li></ul></div></nav>
     <div class="wrap">
       <div class="card"><h2>Каток откроется в субботу</h2><p>Залить лёд обещают к выходным.</p></div>
       <div class="card"><h2>Новое расписание автобусов</h2><p>С понедельника маршрут 12 ходит чаще.</p></div>
     </div>
     <div class="links"><a href="/about/">О нас</a><a class="wide" href="/reklama/">Реклама</a><a href="/contacts/">Контакты</a><span>© 2026 Городской портал</span></div>`);

const blog = () => page('Как работает реклама в интернете — блог',
    `body{margin:0;font:16px Georgia,serif;color:#222}
     .site-header{padding:16px 32px;background:#f5f5f5;box-shadow:0 1px 3px #0002}
     .layout{display:flex;gap:32px;width:1000px;margin:24px auto}
     article{width:680px}
     .article-cover{width:300px;height:250px;background:#eee}
     aside.sidebar{width:280px}
     .adaptive-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:24px}
     .card{border:1px solid #ddd;padding:12px;min-height:120px}
     .badge{display:inline-block;padding:2px 6px;background:#e0f0ff;font-size:12px}
     .subscribe{padding:16px;background:#fafafa;min-height:140px}`,
    `<header class="site-header padding-lg"><nav class="header-nav"><a href="/">Главная</a> · <a href="/advice">Советы</a> · <a href="/address">Контакты</a></nav></header>
     <div class="layout">
       <article class="post-content" data-type="advice">
         <h1>Как работает реклама в интернете</h1>
         <p>Реклама — главный источник дохода многих сайтов. В этой статье разбираем, как устроены рекламные сети и почему блокировщики рекламы так популярны.</p>
         <!-- Обложка ещё не загрузилась: пустой блок 300×250, как у баннера, но без единого рекламного следа. -->
         <div class="article-cover lazy" data-src="/img/cover.jpg"></div>
         <p>Промо-акции и промокоды — тоже реклама, но их обычно ищут сами покупатели.</p>
         <div class="adaptive-grid" id="related">
           <div class="card"><span class="badge">Маркетинг</span><h3>Что такое контекстная реклама</h3></div>
           <div class="card"><span class="badge">Советы</span><h3>Как выбрать блокировщик</h3></div>
           <div class="card"><span class="badge">Разбор</span><h3>Почему сайты просят отключить AdBlock</h3></div>
           <div class="card"><span class="badge">Новости</span><h3>Закон о маркировке рекламы</h3></div>
           <div class="card"><span class="badge">Советы</span><h3>Download-менеджеры без рекламы</h3></div>
           <div class="card"><span class="badge">Разбор</span><h3>Как работает загрузка страниц</h3></div>
         </div>
       </article>
       <aside class="sidebar">
         <div class="subscribe" id="subscribe"><h3>Подписка</h3><p>Раз в неделю — лучшие статьи.</p></div>
       </aside>
     </div>`);

const shop = () => page('Каталог — магазин',
    `body{margin:0;font:14px Arial,sans-serif}
     .catalog{display:grid;grid-template-columns:repeat(4,240px);gap:16px;width:1008px;margin:24px auto}
     .product-card{height:320px;border:1px solid #eee;border-radius:8px}
     .product-card--loading{background:#f3f3f3}
     .cart{width:1008px;margin:24px auto;padding:16px;border:1px solid #ddd}
     .promo-code input{width:200px}`,
    `<div class="catalog" id="catalog">
       <div class="product-card"><img width="240" height="200" alt=""><p>Чайник электрический</p><b>2 490 ₽</b></div>
       <div class="product-card"><img width="240" height="200" alt=""><p>Кофемолка</p><b>1 990 ₽</b></div>
       <div class="product-card"><img width="240" height="200" alt=""><p>Тостер</p><b>3 290 ₽</b></div>
       <div class="product-card"><img width="240" height="200" alt=""><p>Блендер</p><b>4 590 ₽</b></div>
       <!-- Догрузка каталога: пустые карточки без рекламных следов. -->
       <div class="product-card product-card--loading"></div>
       <div class="product-card product-card--loading"></div>
       <div class="product-card product-card--loading"></div>
       <div class="product-card product-card--loading"></div>
     </div>
     <form class="cart" id="cart"><h3>Корзина</h3><label class="promo-code">Промокод <input name="promo" placeholder="AUTUMN"></label> <button>Применить</button></form>`);

// Признаки рекламы на Авито — только для проверяющего (видна ли реклама),
// механизм их не знает. Взяты из inspect-snapshot.mjs (R2).
const AVITO_ADS = [
    'div[class^="adv-"]', 'div[class*=" adv-"]', 'div[class*="advRoot"]',
    'div[class*="avito-ads-container"]', 'div[class*="index-advRootWidget"]',
    'div[class^="advert-"]', 'div[class^="items-ads-"]', 'div[class^="style-ads"]',
    'div[data-key^="advBannerWidget"]', '[id^="ads_"]', '[data-code^="ads_"]',
    'ins.adsbygoogle', '[id^="yandex_rtb"]', '[id*="adfox"]', '[id*="_R-A-"]'
];
const AVITO_CONTENT = ['[data-marker="item"]', '[data-marker="bx-recommendations-block-item"]'];

// Лента, которая меняется рядом со спрятанным блоком: вставки перед ним
// сдвигают номера соседей, второй рекламный блок страница сама заменяет
// постом. Путь к спрятанному узлу не должен «уехать» на контент (шаг 5).
const shifting = async () => page('Лента',
    `body{margin:0;font:14px Arial,sans-serif}
     .feed{width:640px;margin:16px auto}
     .post{min-height:80px;margin-bottom:12px;background:#f4f4f4;padding:8px}
     .ad-slot{width:600px;height:250px;margin-bottom:12px}`,
    `<div class="feed">
       <div class="post">Первый пост: открылась новая библиотека.</div>
       <div class="ad-slot"><ins class="adsbygoogle" style="display:block;width:600px;height:250px"></ins></div>
       <div class="post">Второй пост: расписание электричек изменится.</div>
       <div class="ad-slot"><ins class="adsbygoogle" style="display:block;width:600px;height:250px"></ins></div>
       <div class="post">Третий пост: в парке высадили клёны.</div>
     </div>
     <script>
       addEventListener('load', () => {
         const feed = document.querySelector('.feed');
         const post = text => Object.assign(document.createElement('div'), { className: 'post', textContent: text });
         setTimeout(() => feed.prepend(post('Новый пост сверху: ярмарка в субботу.')), 600);
         setTimeout(() => feed.insertBefore(post('Пост перед рекламой: погода на неделю.'), feed.querySelector('.ad-slot')), 1200);
         setTimeout(() => { const slots = feed.querySelectorAll('.ad-slot'); slots[1].replaceWith(post('Пост вместо рекламы: концерт в пятницу.')); }, 1800);
         // Через 60 мс после каждой правки (раньше, чем пройдёт пакет
         // наблюдателя): не спрятан ли пост.
         window.__glitches = [];
         for (const t of [660, 1260, 1860]) setTimeout(() => {
           for (const p of feed.querySelectorAll('.post')) if (!p.checkVisibility()) window.__glitches.push(p.textContent.slice(0, 20));
         }, t);
       });
     </script>`);

// Блок «promo» с картинкой — одно слабое слово, не реклама. Через 2 с
// после загрузки его содержимое вынимают (сосед или сайт после сбоя
// рекламы): осталась пустая коробка со следом — её схлопываем сразу, не
// дожидаясь поздней перепроверки (шаг 4).
const emptiedLater = async () => page('Главная',
    `body{margin:0;font:14px Arial,sans-serif}
     .col{width:640px;margin:16px auto}
     .news{min-height:60px;margin-bottom:12px}
     .promo-box{width:600px;height:240px;margin-bottom:12px}`,
    `<div class="col">
       <div class="news">Новость: в городе открыли каток.</div>
       <div class="promo-box"><img alt="" width="600" height="240" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="></div>
       <div class="news">Новость: изменилось расписание автобусов.</div>
     </div>
     <script>addEventListener('load', () => setTimeout(() => document.querySelector('.promo-box img').remove(), 2000));</script>`);

// Почта (mail.ru, 08.10): в списке писем пропали все письма. Реклама в
// списке приходит не всегда, и её строка бывает пустой, спрятанной
// движком или вовсе одним скриптом. Механизм не должен принять за слот
// весь список: след, которого не видно, не делает видимый блок рекламой.
// Список — элемент колонки (панель, список, листалка), как в почте.
const MAIL_AD = {
    zero: '<div class="letter-adv"><iframe src="https://ad.mail.ru/adi/12345" width="0" height="0" style="border:0"></iframe></div>',
    hidden: '<div class="letter-adv" style="display:none"><span class="adv-label">Реклама</span><iframe src="https://ad.mail.ru/adi/12345" width="600" height="90"></iframe></div>',
    script: '<script src="https://ad.mail.ru/static/ads-async.js"></script>'
};
const mail = variant => () => {
    const letter = (from, subject, date) => `<a class="letter" href="/inbox/0:${date.replace(/\D/g, '')}/"><b class="letter__from">${from}</b><span class="letter__subject">${subject}</span><span class="letter__date">${date}</span></a>`;
    return page('Входящие — Почта',
        `body{margin:0;font:14px Arial,sans-serif}
         .app{display:flex;gap:16px}
         .sidebar{width:200px;padding:12px}
         .sidebar a{display:block;margin-bottom:8px}
         .main{display:flex;flex-direction:column;width:900px}
         .toolbar{height:48px;line-height:48px}
         .letters{display:flex;flex-direction:column}
         .letter{display:flex;gap:16px;height:44px;align-items:center;padding:0 12px;border-bottom:1px solid #eee;color:#000;text-decoration:none}
         .letter__from{width:180px}
         .pager{height:40px;line-height:40px}`,
        `<div class="app">
           <nav class="sidebar"><a href="/compose/">Написать письмо</a><a href="/inbox/">Входящие</a><a href="/sent/">Отправленные</a></nav>
           <div class="main">
             <div class="toolbar">Выделить все · Удалить · В архив</div>
             <div class="letters" id="letters">
               ${letter('Мама', 'Купи хлеба по дороге', '08.10')}
               ${letter('Госуслуги', 'Запись к врачу подтверждена', '07.10')}
               ${letter('Олег', 'Фото с дачи', '06.10')}
               ${MAIL_AD[variant]}
               ${letter('Банк', 'Выписка за сентябрь', '05.10')}
               ${letter('Анна', 'Встреча в субботу', '04.10')}
             </div>
             <div class="pager">1–5 из 5</div>
           </div>
         </div>`);
};

const CASES = [
    { id: 'почта: пустая строка рекламы в списке писем', url: 'https://mail.example.ru/inbox/', html: mail('zero'), content: ['.letter', '.toolbar', '.pager'] },
    { id: 'почта: строка рекламы спрятана', url: 'https://mail.example.ru/inbox/hidden', html: mail('hidden'), content: ['.letter', '.toolbar', '.pager'] },
    { id: 'почта: рекламный скрипт внутри списка', url: 'https://mail.example.ru/inbox/script', html: mail('script'), content: ['.letter', '.toolbar', '.pager'] },
    // report5 (вживую): заготовки рекламы в рамке нет вовсе — область письма
    // пряталась по одному модификатору scrollable_top-line-adv-2pane.
    { id: 'почта: письмо на месте, рекламы в рамке нет вовсе', url: 'https://e.mail.ru/inbox/0:3:0/', html: () => mailLetterLate({ late: false, noAd: true }), content: ['.letter-text', '.letter-link', '.letter__flag', '.layout__resizer'] },
    { id: 'почта: письмо уже на месте, область названа по рекламе сверху', url: 'https://e.mail.ru/inbox/0:2:0/', html: () => mailLetterLate({ late: false, neighbor: true }), content: ['.letter-text', '.letter-link', '.letter__flag', '.layout__resizer'] },
    { id: 'почта: письмо пришло после пустой рамки с заготовкой рекламы', url: 'https://e.mail.ru/inbox/0:1:0/', html: () => mailLetterLate(), slot: '.react-async', content: ['.letter-text', '.letter-link', '.letter__flag', '.layout__resizer'] },
    { id: 'kinogo: баннер под плеером (kng-rekl)', url: 'https://kinogo.online/serial.html', html: () => kinogo(), slot: 'div.kng-rekl', content: ['h1', 'video.player', '#description', '.comment'] },
    { id: 'kinogo: сосед спрятал баннер, осталась обёртка 200 px', url: 'https://kinogo.online/serial2.html', html: () => kinogo({ neighbor: true }), afterOther: true, slot: 'div.kng-rekl', content: ['h1', 'video.player', '#description', '.comment'] },
    { id: 'VK: промо игры в правой колонке', url: 'https://vk.com/feed', html: vk, slot: 'div.apps_feedRightAppsBlock', content: ['.post', '.friends_block', '.groups_block'] , todo: 'этап 6: самопродвижение — только имя и ссылки на свой сайт (R12: одного имени для видимого мало)' },
    { id: 'Яндекс.Поиск: «Промо» и «Реклама» в выдаче', url: 'https://yandex.ru/search/?text=%D1%8F%D0%BD%D0%B4%D0%B5%D0%BA%D1%81+%D0%B4%D0%B8%D1%81%D0%BA', html: yandexSearch,
        slot: '#search-result > li:has(.OrganicTitle-Link[href*="_sttc"])', content: ['#search-result > li:not(:has([href*="_sttc"]))'] },
    { id: 'Яндекс.Поиск: реклама пришла после загрузки', url: 'https://yandex.ru/search/?text=late', html: yandexLate,
        slot: '#search-result > li:has(.OrganicTitle-Link[href*="_sttc"])', content: ['#search-result > li:not(:has([href*="_sttc"]))'] },
    { id: 'лента меняется рядом со спрятанным блоком', url: 'https://feed.example.ru/', html: shifting, ads: ['.ad-slot'], content: ['.post'] },
    { id: 'пустой блок после того, как рекламу вынули', url: 'https://portal.example.ru/', html: emptiedLater, afterOther: false, slot: '.promo-box', content: ['.news'] },
    // Пропуски 08–09.10 (R10): Яндекс — исправлены на этапе 4 (номер блока,
    // теневой DOM); VK — ждёт этапа 6 (todo, см. «прогон»).
    { id: 'Яндекс Видео: «Алиса AI» в списке роликов', url: 'https://yandex.ru/video/search?text=avito', html: yandexVideo,
        slot: '#video-list > li:has([id*="R-I-"])', content: ['#video-list > li:not(:has([id*="R-I-"]))'] },
    { id: 'Яндекс Видео: баннер справа', url: 'https://yandex.ru/video/search?text=serialy', html: yandexVideo,
        slot: '.SearchPageColumns-Right', content: ['#video-list > li:not(:has([id*="R-I-"]))'] },
    { id: 'Яндекс Карты: «Соцреклама» в карточке места', url: 'https://yandex.ru/maps/213/moscow/stops/station__1/', html: yandexMaps,
        slot: 'div:has(> [data-ssr-uid="123-2-5"])', content: ['.review', '.breadcrumbs-view', '.card-footer-view'] },
    { id: 'VK: «Игра для вас» в ленте', url: 'https://vk.com/feed?section=top', html: vkFeed,
        slot: 'section:has([data-testid="recommendationblockheader-title"])', content: ['article:not(:has([data-testid^="recommendationblock"])) section'], todo: 'этап 6: самопродвижение, подсказка сайта VK' },
    // Пропуск 10.10 (R11): пряталась только строка маркировки (adLabel),
    // карусель оставалась. Слот теперь ищется от блока с самой рекламой.
    { id: 'Авито: карусель застройщика в каталоге новостроек', url: 'https://www.avito.ru/moskva/kvartiry/catalog/novostroyki', html: avitoDevelopments,
        slot: '[data-marker="brandspace-nd-widget"]', content: ['#dev-list > li'] },
    // Пропуск 10.10, тот же класс (R11): прятался только значок «Реклама».
    { id: 'Яндекс Карты: «Кешбэк» со значком «Реклама» в карточке остановки', url: 'https://yandex.ru/maps/213/moscow/stops/stop__2/', html: yandexMapsStop,
        slot: '.masstransit-stop-panel-view__offer-banner-wrapper', content: ['.schedule', '.address'] },
    // Значок «Реклама» спрятал движок или сосед, плашка осталась без пометки.
    { id: 'Яндекс Карты: значок «Реклама» спрятан соседом — плашка без пометки', url: 'https://yandex.ru/maps/213/moscow/stops/stop__3/', html: () => yandexMapsStop({ neighbor: true }),
        slot: '.masstransit-stop-panel-view__offer-banner-wrapper', content: ['.schedule', '.address'] },
    { id: 'нативная реклама: метка и маркировка по закону', url: 'https://city.example.ru/news', html: nativeMarked,
        slot: '#native', content: ['.news-card:not(#native)'] },
    { id: 'контроль: маркировка в новости и ОГРН в подвале', url: 'https://news.example.ru/zakon-o-reklame', html: newsMarking, control: true },
    { id: 'контроль: ссылка «Реклама» спрятана самим сайтом (меню, подвал)', url: 'https://gorod.example.ru/', html: hiddenAdLinks, control: true },
    { id: 'контроль: пример маркировки отдельным абзацем', url: 'https://notes.example.ru/markirovka', html: markingExample, control: true },
    { id: 'контроль: статья о рекламе', url: 'https://blog.example.ru/reklama-v-internete', html: blog, control: true },
    { id: 'контроль: каталог с догрузкой и промокодом', url: 'https://shop.example.ru/catalog', html: shop, control: true },
    { id: 'Авито: главная', url: 'https://www.avito.ru/', file: 'avito.ru.html', ads: AVITO_ADS, content: AVITO_CONTENT },
    { id: 'Авито: выдача «Автомобили»', url: 'https://www.avito.ru/moskva/avtomobili', file: 'avito.ru_moskva-avtomobili.html', ads: AVITO_ADS, content: AVITO_CONTENT },
    { id: 'Авито: выдача «Квартиры»', url: 'https://www.avito.ru/moskva/kvartiry/prodam', file: 'avito.ru_moskva-kvartiry-prodam.html', ads: AVITO_ADS, content: AVITO_CONTENT }
];

// ---------- замер на странице ----------
// Выполняется в странице; возвращает всё, что сравниваем.
function measure({ slot, ads, content }) {
    const visible = el => el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && el.getBoundingClientRect().width * el.getBoundingClientRect().height > 0;
    function visibleContent(el) {
        if ((el.innerText || '').trim().length > 2) return true;
        for (const m of el.querySelectorAll('img, video, canvas, iframe, svg, picture')) {
            const r = m.getBoundingClientRect();
            if (r.width > 20 && r.height > 20) return true;
        }
        const bg = getComputedStyle(el).backgroundImage;
        return Boolean(bg && bg !== 'none');
    }
    // Дыры — видимые блоки заметного размера без содержимого (как в R2).
    // Скелетоны догрузки ленты — не дыры.
    function holes() {
        const out = [];
        for (const el of document.body.querySelectorAll('div, section, li, aside, ins')) {
            const r = el.getBoundingClientRect();
            if (r.width < 150 || r.height < 100 || !visible(el) || visibleContent(el)) continue;
            if (out.some(o => o.contains(el))) continue;
            // Пустое место внутри карточки контента — часть карточки, а не
            // рекламная дыра (Авито: колонка «о продавце» бывает пустой).
            if (content && content.some(sel => el.closest(sel))) continue;
            if (el.matches('[class*="skeleton" i], [class*="loading" i], [class*="lazy" i]') || el.querySelector('[class*="skeleton" i]')) continue;
            out.push(el);
        }
        return out.map(el => {
            const r = el.getBoundingClientRect();
            return { cls: (el.getAttribute('class') || el.tagName).slice(0, 60), size: `${Math.round(r.width)}x${Math.round(r.height)}`, y: Math.round(r.top + scrollY) };
        });
    }
    const pathOf = el => {
        const parts = [];
        for (let n = el; n && n !== document.documentElement; n = n.parentElement) parts.push(n.tagName + ':' + [...n.parentElement.children].indexOf(n));
        return parts.reverse().join('>');
    };
    const out = {
        height: document.documentElement.scrollHeight,
        holes: holes(),
        slots: slot ? [...document.querySelectorAll(slot)].map(el => ({ visible: visible(el), h: Math.round(el.getBoundingClientRect().height) })) : [],
        ads: ads ? [...document.querySelectorAll(ads.join(','))].filter(el => visible(el) && el.getBoundingClientRect().height >= 50)
            .filter((el, _, all) => !all.some(o => o !== el && o.contains(el)))
            .map(el => ({ cls: (el.getAttribute('class') || el.id).slice(0, 60), size: `${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}` })) : [],
        content: {}
    };
    for (const sel of content || []) {
        const shown = [...document.querySelectorAll(sel)].filter(visible);
        out.content[sel] = { count: shown.length, text: shown.map(el => el.innerText.trim().replace(/\s+/g, ' ')).join('|').length };
    }
    // Для контрольных: все видимые элементы.
    out.visiblePaths = content || slot ? null : [...document.body.querySelectorAll('*')].filter(visible).map(pathOf);
    return out;
}

// ---------- прогон ----------
const results = [];
const check = (name, ok, detail) => {
    results.push({ ok: Boolean(ok), name, detail });
    console.log(`${ok ? 'ОК  ' : 'СБОЙ'} ${name}${ok ? '' : '  → ' + JSON.stringify(detail)}`);
};

// Пропуск, который ещё не исправлен (case.todo — каким этапом плана):
// главные проверки случая («реклама скрыта», «дыр нет», «видимой рекламы
// нет») не роняют прогон, а копятся отдельно. Проверки «контент не тронут»
// и «атрибуты не тронуты» — обычные: ломать соседнее нельзя и сейчас. Если
// все главные проверки случая прошли — todo пора снять (сбой ниже).
const todos = new Map();
const todoCheck = (c, name, ok, detail) => {
    if (!todos.has(c.id)) todos.set(c.id, { why: c.todo, passed: [], failed: [] });
    todos.get(c.id)[ok ? 'passed' : 'failed'].push(name);
    console.log(`${ok ? 'ЖДЁТ+' : 'ЖДЁТ '} ${name}${ok ? '' : '  → ' + JSON.stringify(detail)}`);
};

const cases = [];
for (const c of CASES) {
    if (only && !c.id.includes(only)) continue;
    if (c.file) {
        const file = path.join(PAGES, c.file);
        if (!existsSync(file)) { console.log(`ПРОПУСК ${c.id}: нет снимка ${path.relative(ROOT, file)}`); continue; }
        cases.push({ ...c, body: await fs.readFile(file, 'utf8') });
    } else {
        try {
            cases.push({ ...c, body: await c.html() });
        } catch (error) {
            if (!(error instanceof MissingSample)) {
                throw error;
            }
            console.log(`ПРОПУСК ${c.id}: нет образца ${error.message}`);
        }
    }
}

async function serve(context) {
    // Сети нет: страницы — из образцов, всё остальное обрывается (как
    // картинки и скрипты, которых нет в снимке).
    await context.route('**/*', route => {
        const url = route.request().url();
        // Свои страницы расширения (попап) — как есть.
        if (url.startsWith('chrome-extension://')) return route.continue();
        const hit = cases.find(c => c.url === url);
        return hit ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: hit.body }) : route.abort();
    });
}

// Отчёт общего механизма со страницы — так же, как его берёт попап.
async function genericReport(context, url) {
    const worker = context.serviceWorkers().find(w => w.url().endsWith('/ygab/background.js'));
    return worker ? worker.evaluate(async url => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url === url);
        if (!tab) return { error: 'нет вкладки', urls: tabs.map(t => t.url) };
        return chrome.tabs.sendMessage(tab.id, { action: 'getGenericReport' }, { frameId: 0 }).catch(e => ({ error: String(e) }));
    }, url) : null;
}

// Наблюдатель страницы за атрибутами: скрытие не должно их трогать (шаг 5).
const watchAttributes = () => {
    window.__attrChanges = [];
    new MutationObserver(records => {
        for (const r of records) window.__attrChanges.push(r.attributeName + '@' + (r.target.getAttribute('class') || r.target.localName));
    }).observe(document, { attributes: true, subtree: true });
};

async function run(context, c, withReport = false) {
    const tab = await context.newPage();
    await tab.setViewportSize({ width: 1600, height: 900 });
    await tab.addInitScript(watchAttributes);
    try {
        await tab.goto(c.url, { waitUntil: 'load', timeout: 60000 });
        await tab.waitForTimeout(SETTLE_MS);
        const out = await tab.evaluate(measure, { slot: c.slot, ads: c.ads, content: c.content });
        out.attrChanges = await tab.evaluate(() => window.__attrChanges.slice(0, 10));
        out.glitches = await tab.evaluate(() => window.__glitches || []);
        if (withReport) out.report = await genericReport(context, c.url);
        return out;
    } finally {
        await tab.close();
    }
}

// Как было: браузер без расширений.
const plain = await chromium.launch({ ...browserOptions(), headless: !headed });
const plainContext = await plain.newContext();
await serve(plainContext);
const before = {};
for (const c of cases) before[c.id] = await run(plainContext, c);
await plain.close();

// Со сборкой Cleathernet. Язык браузера русский — как у пользователей
// (при нём движок сам включает RU AdList).
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ygab-generic-'));
const context = await chromium.launchPersistentContext(profile, {
    ...browserOptions(),
    headless: !headed,
    args: ['--lang=ru', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
});
try {
    // Дождаться первого запуска: страница приветствия настраивает движок
    // (наборы правил); без этого страницы открылись бы до настройки.
    const isWelcome = p => p.url().endsWith('/ygab/platform/welcome/welcome.html');
    const welcome = context.pages().find(isWelcome) || await context.waitForEvent('page', { predicate: isWelcome, timeout: 15000 }).catch(() => null);
    if (welcome) await welcome.waitForFunction(() => document.getElementById('setup').dataset.state, null, { timeout: 20000 }).catch(() => {});
    check('первый запуск: движок настроен', welcome && await welcome.evaluate(() => document.getElementById('setup').dataset.state) === 'ok', welcome && welcome.url());
    await serve(context);

    for (const c of cases) {
        const was = before[c.id];
        const now = await run(context, c, true);
        // Незаметность: наши правки не видны наблюдателю атрибутов страницы.
        // Смотрим то, чем прячут, — style, class, hidden: остальное может
        // ставить движок по правилам списков (RU AdList на vk.com ставит
        // <html href-sanitizer>, так же у чистого uBO Lite).
        const ownChanges = now.attrChanges.filter(x => /^(style|class|hidden)@/.test(x) && !was.attrChanges.includes(x));
        check(`${c.id}: атрибуты страницы не тронуты`, ownChanges.length === 0, ownChanges);
        console.log(`\n— ${c.id}`);
        if (c.id.startsWith('контроль: маркировка')) {
            // Цитата с маркировкой — остаток с объяснением, ссылка «Реклама»
            // в подвале — не «похожий на рекламу»; токенов из адресов нет.
            const left = now.report && now.report.leftovers;
            const quote = left && left.items.find(item => item.kinds.includes('маркировка'));
            const footer = left && left.items.find(item => item.kinds.length === 1 && item.kinds[0] === 'метка');
            // Ссылка «Реклама» в подвале ведёт на свою страницу — это
            // навигация, не метка рекламы (R12): в остатках её нет.
            check(`${c.id}: отчёт — цитата с маркировкой видна как остаток, «2 из 4, только маркировка»; ссылка «Реклама» в подвале — не метка`,
                left && left.likely === 1 && quote && quote.slot && quote.slot.total === 2 && quote.slot.decision === null && quote.slot.signals.join() === 'marking' && !footer, left);
            check(`${c.id}: в отчёте нет параметров адресов`, left && !JSON.stringify(left).includes('SECRETTOKEN'), left && left.items.map(item => item.html));
        }
        if (c.control) {
            const lost = was.visiblePaths.filter(p => !now.visiblePaths.includes(p));
            check(`${c.id}: ничего не скрыто`, lost.length === 0, lost.slice(0, 5));
            check(`${c.id}: высота страницы та же`, Math.abs(now.height - was.height) <= 1, { было: was.height, стало: now.height });
            continue;
        }
        if (c.id.startsWith('лента')) {
            check(`${c.id}: посты не пропадали и на миг`, now.glitches.length === 0, now.glitches);
        }
        if (c.afterOther) {
            check(`${c.id}: отчёт — схлопнуто после соседа`, now.report && now.report.afterOther >= 1 && now.report.hiddenBy === 'user-css', now.report);
        }
        const main = c.todo ? (name, ok, detail) => todoCheck(c, name, ok, detail) : check;
        if (c.slot) {
            // Образец на месте: без расширения слот виден.
            check(`${c.id}: образец — без расширения блок виден`, was.slots.length > 0 && was.slots.some(s => s.visible && s.h > 0), was.slots);
            main(`${c.id}: реклама скрыта`, was.slots.length > 0 && now.slots.every(s => !s.visible || s.h === 0), {
                было: was.slots, стало: now.slots,
                спрятали: ((now.report && now.report.items) || []).map(i => `${i.reason} ${i.score} [${i.signals}] ${i.tag}.${i.name || ''} ${i.size}`),
                осталось: now.report && now.report.leftovers && now.report.leftovers.items.map(i => ({ kinds: i.kinds, slot: i.slot }))
            });
        }
        if (c.ads) {
            main(`${c.id}: видимой рекламы нет`, now.ads.length === 0, { было: was.ads.length, осталось: now.ads });
        }
        main(`${c.id}: дыр нет`, now.holes.length === 0, { было: was.holes.length, осталось: now.holes });
        // Каждое скрытие объяснено в отчёте: причина, сумма сил, признаки.
        const items = (now.report && now.report.items) || [];
        if (items.length) {
            check(`${c.id}: отчёт объясняет каждое скрытие`, items.every(i => i.reason && typeof i.score === 'number' && i.signals.length > 0), items.slice(0, 3));
        }
        // Реклама спрятана — в отчёте не осталось похожего на рекламу.
        if (c.slot && !c.todo) {
            const left = now.report && now.report.leftovers;
            check(`${c.id}: отчёт — похожего на рекламу не осталось`, left && left.likely === 0, left);
        }
        if (c.id.startsWith('Яндекс Видео: баннер')) {
            const recon = now.report && now.report.recon;
            check(`${c.id}: разведка — загрузчик рекламы Яндекса на странице замечен`, recon && recon.loaders.includes('yaContextCb') && typeof recon.shadowHosts === 'number', recon);
        }
        const changed = Object.keys(was.content).filter(sel => was.content[sel].count !== now.content[sel].count || was.content[sel].text !== now.content[sel].text)
            .map(sel => ({ sel, было: was.content[sel], стало: now.content[sel] }));
        // Тронут — сразу видно, что и почему мы спрятали.
        const hiddenByUs = ((now.report && now.report.items) || []).map(i => `${i.reason} ${i.score} [${i.signals}] ${i.tag}.${i.name || ''} ${i.size}`);
        check(`${c.id}: контент не тронут`, changed.length === 0 && Object.values(was.content).some(v => v.count > 0), changed.length ? { changed, hiddenByUs } : was.content);
    }

    // Выключение на сайте — без перезагрузки: всё возвращается как было;
    // включение — снова скрыто. Список сайтов меняем так же, как попап.
    const toggle = cases.find(c => c.id.startsWith('kinogo: баннер'));
    let afterAll = null;
    if (toggle) {
        console.log('\n— выключение на сайте без перезагрузки');
        const isOurs = w => w.url().endsWith('/ygab/background.js');
        const worker = context.serviceWorkers().find(isOurs) || await context.waitForEvent('serviceworker', { predicate: isOurs, timeout: 10000 });
        const setOff = hosts => worker.evaluate(list => chrome.storage.local.set({ 'ygab.offSites': list }), hosts);
        const tab = await context.newPage();
        await tab.setViewportSize({ width: 1600, height: 900 });
        await tab.goto(toggle.url, { waitUntil: 'load' });
        await tab.waitForTimeout(SETTLE_MS);
        // Стиль из исходной разметки — в той же записи, в какой браузер
        // отдаёт cssText (0 → 0px и т. п.).
        const original = await snippet('kinogo-kng-rekl.html').then(html => html.match(/class="kng-rekl" style="([^"]*)"/)[1]);
        const slotState = () => tab.evaluate(([sel, raw]) => {
            const el = document.querySelector(sel);
            const probe = document.createElement('div');
            probe.setAttribute('style', raw);
            return { visible: el.checkVisibility(), same: el.style.cssText === probe.style.cssText, style: el.style.cssText, height: document.documentElement.scrollHeight };
        }, [toggle.slot, original]);
        const on = await slotState();
        await setOff(['kinogo.online']);
        await tab.waitForTimeout(500);
        const off = await slotState();
        check('скрыт без правки узла: инлайн-стиль как в исходной разметке', !on.visible && on.same, on);
        check('выключили на сайте — блок вернулся, его стиль как в исходной разметке, высота как без расширения',
            !on.visible && off.visible && off.same && off.height === before[toggle.id].height, { on, off, было: before[toggle.id].height });
        await setOff([]);
        await tab.waitForTimeout(SETTLE_MS);
        const again = await slotState();
        check('включили обратно — снова скрыт', !again.visible, again);
        await tab.close();

        // То же — настоящим ползунком попапа, как это делает человек.
        console.log('\n— ползунок в попапе');
        const ourWorker = async () => context.serviceWorkers().find(isOurs) || context.waitForEvent('serviceworker', { predicate: isOurs, timeout: 15000 });
        const extId = new URL((await ourWorker()).url()).host;
        const flip = async page => {
            // Вкладку ищем со страницы расширения: после перезагрузки
            // расширения Playwright не видит его новый фон.
            const panel = await context.newPage();
            await panel.goto(`chrome-extension://${extId}/ygab/platform/popup/popup.html`);
            const tabId = await panel.evaluate(async url => ((await chrome.tabs.query({})).find(t => t.url === url) || {}).id, page.url());
            await panel.goto(`chrome-extension://${extId}/ygab/platform/popup/popup.html?tab=${tabId}`);
            await panel.waitForFunction(() => !document.getElementById('siteOn').disabled, null, { timeout: 10000 }).catch(() => {});
            const was = await panel.evaluate(() => document.getElementById('siteOn').checked);
            await panel.click('label.switch');
            await panel.waitForFunction(was => document.getElementById('siteOn').checked !== was && !document.getElementById('siteOn').disabled, was, { timeout: 5000 }).catch(() => {});
            const now = await panel.evaluate(() => document.getElementById('siteOn').checked);
            await panel.close();
            return now;
        };
        const state = page => page.evaluate(sel => {
            const el = document.querySelector(sel);
            return { visible: el.checkVisibility(), height: document.documentElement.scrollHeight };
        }, toggle.slot);
        const plainHeight = before[toggle.id].height;

        const live = await context.newPage();
        await live.setViewportSize({ width: 1600, height: 900 });
        await live.goto(toggle.url, { waitUntil: 'load' });
        await live.waitForTimeout(SETTLE_MS);
        const hidden = await state(live);
        const switchedOff = await flip(live);
        await live.waitForTimeout(500);
        const offNow = await state(live);
        check('ползунок: выключили — реклама вернулась сразу, без обновления страницы',
            !hidden.visible && switchedOff === false && offNow.visible && offNow.height === plainHeight, { hidden, switchedOff, offNow, было: plainHeight });
        await live.reload({ waitUntil: 'load' });
        await live.waitForTimeout(SETTLE_MS);
        const offReloaded = await live.evaluate(measure, { slot: toggle.slot, content: toggle.content });
        const plain = before[toggle.id];
        check('ползунок: выключено и страница обновлена — как без расширения',
            offReloaded.height === plain.height && JSON.stringify(offReloaded.slots) === JSON.stringify(plain.slots) && offReloaded.holes.length === plain.holes.length,
            { без: { height: plain.height, slots: plain.slots }, сНами: { height: offReloaded.height, slots: offReloaded.slots } });
        const switchedOn = await flip(live);
        await live.waitForTimeout(SETTLE_MS);
        const onNow = await state(live);
        check('ползунок: включили — реклама снова скрыта без обновления', switchedOn === true && !onNow.visible, { switchedOn, onNow });

        // Перезагрузка расширения — в самом конце (ниже): после неё
        // Playwright теряет фон расширения.
        afterAll = async () => {
            // Расширение перезагрузили (пересборка, обновление), а вкладка
            // осталась открытой: старый скрипт на ней больше не слышит
            // расширение. Спрятанное им не должно остаться навсегда — после
            // выключения на сайте реклама должна вернуться.
            console.log('\n— перезагрузка расширения при открытой вкладке');
            await live.reload({ waitUntil: 'load' });
            await live.waitForTimeout(SETTLE_MS);
            const beforeReload = await state(live);
            // Как кнопка «Обновить» на chrome://extensions.
            const extensionsPage = await context.newPage();
            await extensionsPage.goto('chrome://extensions');
            // Режим разработчика, как у того, кто ставит распакованную папку:
            // без него Chrome после перезагрузки выключает такое расширение.
            await extensionsPage.evaluate(() => new Promise(resolve => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, resolve)));
            const reloaded = await extensionsPage.evaluate(id => new Promise(resolve => chrome.developerPrivate.reload(id, { failQuietly: true }, () => resolve(chrome.runtime.lastError ? String(chrome.runtime.lastError.message) : 'ok'))), extId);
            await extensionsPage.close();
            await live.waitForTimeout(3000);
            // Таблицу прежнего экземпляра снимает новый фон: спрятанное
            // возвращается само, хотя скрипт на вкладке уже ничего не может.
            const afterReload = await state(live);
            const offAfterReload = await flip(live);
            await live.waitForTimeout(800);
            const orphan = await state(live);
            check('перезагрузили расширение при открытой вкладке — спрятанное вернулось само, ползунок показывает «выключено» и ничего не прячет',
                reloaded === 'ok' && !beforeReload.visible && afterReload.visible && afterReload.height === plainHeight &&
                offAfterReload === false && orphan.visible && orphan.height === plainHeight, { reloaded, beforeReload, afterReload, offAfterReload, orphan, было: plainHeight });
            await flip(live);
            await live.close();
        };
    }

    // Приманки детекторов: с нашим слоем детекторы видят ровно то же, что
    // без него (движок работает в обоих случаях). Плюс своя приманка со
    // словом «rekl», которой нет в общих списках: её прячем только мы.
    if (!only) {
        console.log('\n— приманки детекторов');
        const DETECT_URL = 'https://detect.example.ru/news';
        const detectHtml = `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body>
            <p>Новости дня: в городе открылся новый парк.</p>
            <div class="rekl-box" id="rekl-bait" style="position:absolute;left:-9999px;top:0;width:300px;height:250px">&nbsp;</div>
            <script>${await fs.readFile(path.join(DEV, 'detectors.js'), 'utf8')}</script></body></html>`;
        await context.route(DETECT_URL, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: detectHtml }));
        const isOurs = w => w.url().endsWith('/ygab/background.js');
        const worker = context.serviceWorkers().find(isOurs);
        const detect = async off => {
            await worker.evaluate(list => chrome.storage.local.set({ 'ygab.offSites': list }), off ? ['detect.example.ru'] : []);
            const tab = await context.newPage();
            await tab.goto(DETECT_URL, { waitUntil: 'load' });
            await tab.waitForTimeout(SETTLE_MS);
            const found = await tab.evaluate(async () => {
                const r = await window.__detectorsReady;
                const own = document.getElementById('rekl-bait');
                return { bait: r.bait, yandexBait: r.yandexBait, globals: r.suspiciousGlobals, attributes: r.suspiciousAttributes, styles: r.foreignStyleRules,
                    reklBait: getComputedStyle(own).display === 'none' || own.getClientRects().length === 0 };
            });
            await tab.close();
            return found;
        };
        const without = await detect(true);
        const withUs = await detect(false);
        await worker.evaluate(() => chrome.storage.local.set({ 'ygab.offSites': [] }));
        check('детекторы видят с нашим слоем то же, что без него', JSON.stringify(withUs) === JSON.stringify(without), { безНас: without, сНами: withUs });
        check('своя приманка «rekl» за краем страницы не тронута', !withUs.reklBait, withUs);
    }

    if (afterAll) await afterAll();
} finally {
    await context.close();
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}

for (const [id, t] of todos) {
    check(`${id}: всё ещё ждёт исправления (${t.why}) — если прошло, снять todo`, t.failed.length > 0, { прошло: t.passed });
}

const passed = results.filter(r => r.ok).length;
console.log(`\nИтого: ${passed} из ${results.length}`);
if (todos.size) {
    console.log(`Ждут исправления: ${todos.size} — ${[...todos].map(([id, t]) => `${id} (${t.why})`).join('; ')}`);
}
process.exit(passed === results.length ? 0 : 1);
