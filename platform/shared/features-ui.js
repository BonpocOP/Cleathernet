// Флажки функций из каталога (platform/features.json) — общие для
// настроек и страницы первого запуска.
//
// Типы функций:
//   ruleset — набор правил движка uBO Lite (ruleset — его номер);
//   privacy — настройки самого браузера (chrome.privacy.websites.*,
//             settings — их имена). «Включено» — значит выключена
//             рекламная функция браузера. Браузер сам возвращает всё как
//             было, когда расширение удаляют или выключают.

const send = message => chrome.runtime.sendMessage(message);

// Настройки браузера, которых в этом браузере нет (старый Chrome, другая
// сборка Chromium), пропускаем.
const privacySetting = name => {
    try {
        return chrome.privacy && chrome.privacy.websites && chrome.privacy.websites[name] || null;
    } catch {
        return null;
    }
};

export const privacySupported = feature => feature.settings.some(name => privacySetting(name));

// Защита включена, если все доступные настройки функции выключены.
export async function privacyOn(feature) {
    const states = await Promise.all(feature.settings.map(name => privacySetting(name))
        .filter(Boolean)
        .map(setting => setting.get({})));
    return {
        on: states.length > 0 && states.every(state => state.value === false),
        // Настройку держит политика организации или другое расширение.
        locked: states.some(state => state.levelOfControl === 'not_controllable' || state.levelOfControl === 'controlled_by_other_extensions')
    };
}

export async function setPrivacy(feature, on) {
    for (const name of feature.settings) {
        const setting = privacySetting(name);
        if (!setting) {
            continue;
        }
        if (on) {
            await setting.set({ value: false });
        } else {
            await setting.clear({});
        }
    }
}

export async function setRuleset(id, on) {
    const enabled = await send({ what: 'getEnabledRulesets' });
    const next = on
        ? [...new Set(enabled.concat(id))]
        : enabled.filter(item => item !== id);
    await send({ what: 'applyRulesets', enabledRulesets: next });
}

export const loadCatalog = () => fetch(chrome.runtime.getURL('ygab/platform/features.json')).then(response => response.json());

// Разделы с флажками. status(text) — короткое сообщение о сохранении.
export async function renderSections(catalog, container, status = () => {}) {
    const enabled = await send({ what: 'getEnabledRulesets' });
    container.textContent = '';
    for (const section of catalog.sections) {
        const features = section.features.filter(feature => feature.type === 'ruleset' || (feature.type === 'privacy' && privacySupported(feature)));
        if (!features.length) {
            continue;
        }
        const card = document.createElement('section');
        card.className = 'card';
        card.dataset.section = section.id;
        const heading = document.createElement('h2');
        heading.textContent = section.title;
        const list = document.createElement('ul');
        list.className = 'toggles';
        card.append(heading, list);
        for (const feature of features) {
            list.append(await toggle(feature, enabled, status));
        }
        container.append(card);
    }
}

async function toggle(feature, enabled, status) {
    const item = document.createElement('li');
    item.className = 'toggle';
    const label = document.createElement('label');
    label.className = 'toggle__label';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.feature = feature.id;
    if (feature.type === 'ruleset') {
        box.dataset.ruleset = feature.ruleset;
        box.checked = enabled.includes(feature.ruleset);
    } else {
        const state = await privacyOn(feature).catch(() => ({ on: false, locked: true }));
        box.checked = state.on;
        box.disabled = state.locked;
    }
    box.addEventListener('change', async () => {
        box.disabled = true;
        try {
            if (feature.type === 'ruleset') {
                await setRuleset(feature.ruleset, box.checked);
            } else {
                await setPrivacy(feature, box.checked);
            }
            status(box.checked ? `«${feature.title}» включено` : `«${feature.title}» выключено`);
        } catch {
            box.checked = !box.checked;
            status('Не удалось сохранить');
        } finally {
            box.disabled = false;
        }
    });
    const text = document.createElement('span');
    text.className = 'toggle__text';
    const title = document.createElement('span');
    title.className = 'toggle__name';
    title.textContent = feature.title;
    const small = document.createElement('span');
    small.className = 'toggle__hint';
    small.textContent = feature.hint;
    text.append(title, small);
    label.append(box, text);
    item.append(label);
    return item;
}
