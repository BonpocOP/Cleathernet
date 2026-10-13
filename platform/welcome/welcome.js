import { ensureSetup } from '../setup.js';
import { loadCatalog, renderSections } from '../shared/features-ui.js';

const $ = id => document.getElementById(id);

let statusTimer = 0;
function status(text) {
    $('status').textContent = text;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { $('status').textContent = ''; }, 2500);
}

// Флажки — после настройки: показываем то, что уже включено, а не
// состояние до неё. Не удалась настройка — всё равно показываем как есть.
const showFeatures = () => loadCatalog()
    .then(catalog => renderSections(catalog, $('features'), status))
    .catch(error => console.warn('ygab features', error));

ensureSetup().then(() => {
    $('setup').textContent = 'Готово: фильтры настроены. Вот что включено:';
    $('setup').dataset.state = 'ok';
}).catch(error => {
    // Не страшно: попап повторит настройку при первом открытии.
    $('setup').textContent = 'Фильтры не удалось донастроить сейчас — это произойдёт, когда вы откроете меню расширения.';
    $('setup').dataset.state = 'error';
    console.warn('ygab setup', error);
}).finally(showFeatures);
