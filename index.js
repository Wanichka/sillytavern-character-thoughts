// Character Thoughts v0.2
// Shows each character's current thoughts (and mood) parsed from the
// <char_thoughts> and <char_mood> info blocks in the latest assistant message.
// UI: refresh moved into the header as an icon; Copy/Clear footer removed.
//
// Storage model (three independent layers):
//   ct_thoughts_v1::<chatId>  -> parsed thoughts/mood for THIS chat (resets per chat)
//   ct_profiles_v1            -> AU profiles: { profileId: { name, folder, avatars } }
//   ct_chatmap_v1             -> { chatId: profileId } (which AU a chat uses)
//
// Avatars live on disk under this extension's own folder:
//   .../third-party/character-thoughts/avatars/<profile.folder>/<file>
// You drop the image files in by hand; the menu just maps name -> filename.
// No avatar set / file missing -> coloured initial circle (never breaks).

import {
    eventSource,
    event_types,
} from '../../../../script.js';

const THOUGHTS_KEY = 'ct_thoughts_v1';
const PROFILES_KEY = 'ct_profiles_v1';
const CHATMAP_KEY = 'ct_chatmap_v1';
const DEBUG = false;

function log(...args) {
    if (!DEBUG) return;
    console.log('[Character Thoughts]', ...args);
}

/* ----------------------------- context helpers ----------------------------- */

function getContextSafe() {
    return window.SillyTavern?.getContext?.() || null;
}

function getCurrentChatId() {
    const context = getContextSafe();
    try {
        return context?.getCurrentChatId?.() ?? context?.chatId ?? null;
    } catch (error) {
        console.error('[Character Thoughts] Failed to read chat id:', error);
        return null;
    }
}

function getCurrentCardName() {
    const context = getContextSafe();
    try {
        if (context?.characters && context?.characterId != null) {
            const card = context.characters[context.characterId];
            if (card?.name) return card.name;
        }
        if (context?.name2) return context.name2;
    } catch (error) {
        console.error('[Character Thoughts] Failed to read card name:', error);
    }
    return 'default';
}

/* ------------------------------ small utilities ----------------------------- */

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function stripHtml(value) {
    const div = document.createElement('div');
    div.innerHTML = value ?? '';
    return div.textContent || div.innerText || '';
}

function normalizeText(text) {
    return stripHtml(text)
        .replace(/\r/g, '')
        .replace(/\u00A0/g, ' ')
        .replace(/\u3164/g, ' ')
        .replace(/ㅤ/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function slugify(text) {
    const slug = String(text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9а-яё]+/gi, '-')
        .replace(/^-+|-+$/g, '');
    return slug || 'profile';
}

function initial(name) {
    const trimmed = String(name ?? '').trim();
    return trimmed ? trimmed[0].toUpperCase() : '?';
}

// Stable hue from a name so each character gets a consistent fallback colour.
function hueForName(name) {
    let hash = 0;
    const text = String(name ?? '');
    for (let i = 0; i < text.length; i++) {
        hash = (hash * 31 + text.charCodeAt(i)) % 360;
    }
    return hash;
}

/* -------------------------------- storage ---------------------------------- */

function getThoughtsKey() {
    const chatId = getCurrentChatId();
    return chatId ? `${THOUGHTS_KEY}::${chatId}` : THOUGHTS_KEY;
}

function getThoughts() {
    try {
        const raw = localStorage.getItem(getThoughtsKey());
        return raw ? JSON.parse(raw) : {};
    } catch (error) {
        console.error('[Character Thoughts] Failed to read thoughts:', error);
        return {};
    }
}

function saveThoughts(map) {
    try {
        localStorage.setItem(getThoughtsKey(), JSON.stringify(map, null, 2));
    } catch (error) {
        console.error('[Character Thoughts] Failed to save thoughts:', error);
    }
}

function getProfiles() {
    try {
        const raw = localStorage.getItem(PROFILES_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (error) {
        console.error('[Character Thoughts] Failed to read profiles:', error);
        return {};
    }
}

function saveProfiles(profiles) {
    try {
        localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles, null, 2));
    } catch (error) {
        console.error('[Character Thoughts] Failed to save profiles:', error);
    }
}

function getChatMap() {
    try {
        const raw = localStorage.getItem(CHATMAP_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (error) {
        console.error('[Character Thoughts] Failed to read chat map:', error);
        return {};
    }
}

function saveChatMap(map) {
    try {
        localStorage.setItem(CHATMAP_KEY, JSON.stringify(map));
    } catch (error) {
        console.error('[Character Thoughts] Failed to save chat map:', error);
    }
}

function ensureProfile(profileId, displayName) {
    const profiles = getProfiles();
    if (!profiles[profileId]) {
        profiles[profileId] = {
            name: displayName || profileId,
            folder: slugify(displayName || profileId),
            avatars: {},
        };
        saveProfiles(profiles);
    }
    return profiles[profileId];
}

// Which AU profile is active for the current chat.
// Default: derive from the ST card name, so a brand-new card -> a fresh
// profile automatically. The chat keeps that binding once set; the menu can
// override it manually.
function getActiveProfileId() {
    const chatId = getCurrentChatId();
    const map = getChatMap();

    if (chatId && map[chatId]) {
        return map[chatId];
    }

    const cardName = getCurrentCardName();
    const profileId = `card:${cardName}`;
    ensureProfile(profileId, cardName);

    if (chatId) {
        map[chatId] = profileId;
        saveChatMap(map);
    }

    return profileId;
}

function getActiveProfile() {
    const profiles = getProfiles();
    return profiles[getActiveProfileId()] || { name: 'default', folder: 'default', avatars: {} };
}

function setActiveProfileId(profileId) {
    const chatId = getCurrentChatId();
    if (!chatId) return;
    const map = getChatMap();
    map[chatId] = profileId;
    saveChatMap(map);
}

/* --------------------------------- parsing --------------------------------- */

function extractTagBlock(text, tag) {
    const plain = normalizeText(text);
    const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = plain.match(regex);
    return match ? match[1].trim() : null;
}

function stripBlockPrefix(text) {
    return String(text ?? '').replace(/^\s*(?:Thoughts|Mood)\s*=\s*/i, '').trim();
}

// Splits "Name1: text ; Name2: text" into segments.
// A new character starts ONLY at the start of the block or after a ';' that is
// followed by a short "Name:". A ';' sitting inside a sentence (no "Name:"
// after it) stays part of the current character's text — this is what stops a
// single multi-clause thought from being split into a phantom character.
function parseNamedSegments(block) {
    const text = stripBlockPrefix(block);
    if (!text) return [];

    const headerRegex = /(?:^|;)\s*([^:;\n.!?…]{1,40}?)\s*:\s*/g;
    const headers = [];
    let match;

    while ((match = headerRegex.exec(text)) !== null) {
        headers.push({
            name: match[1].trim(),
            start: match.index,
            contentStart: headerRegex.lastIndex,
        });
    }

    const results = [];
    for (let i = 0; i < headers.length; i++) {
        const current = headers[i];
        const next = headers[i + 1];
        const end = next ? next.start : text.length;
        const raw = text.slice(current.contentStart, end).trim();
        const clean = raw.replace(/\*/g, '').replace(/\s*;\s*$/g, '').trim();
        if (current.name) {
            results.push({ name: current.name, text: clean });
        }
    }

    return results;
}

function parseMessage(messageText) {
    const thoughtsBlock = extractTagBlock(messageText, 'char_thoughts');
    const moodBlock = extractTagBlock(messageText, 'char_mood');

    if (!thoughtsBlock && !moodBlock) {
        return null;
    }

    const thoughts = thoughtsBlock ? parseNamedSegments(thoughtsBlock) : [];
    const moods = moodBlock ? parseNamedSegments(moodBlock) : [];

    const map = {};

    for (const item of thoughts) {
        map[item.name] = { name: item.name, thought: item.text, mood: '' };
    }
    for (const item of moods) {
        if (map[item.name]) {
            map[item.name].mood = item.text;
        } else {
            map[item.name] = { name: item.name, thought: '', mood: item.text };
        }
    }

    return Object.keys(map).length ? map : null;
}

function updateFromText(messageText, showAlerts = false) {
    const map = parseMessage(messageText);

    if (!map) {
        if (showAlerts) {
            alert('No <char_thoughts> or <char_mood> block found in the last message.');
        }
        return false;
    }

    saveThoughts(map);
    renderPanel();
    return true;
}

/* ----------------------- reading the last message --------------------------- */

function getLastAssistantMessageText() {
    const context = getContextSafe();
    const chat = context?.chat;

    if (Array.isArray(chat)) {
        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];
            if (message && !message.is_user && message.mes) {
                return message.mes;
            }
        }
    }

    const nodes = Array.from(document.querySelectorAll('#chat .mes:not([is_user="true"])'));
    if (nodes.length) {
        const last = nodes[nodes.length - 1];
        return last.innerText || last.textContent || '';
    }

    return '';
}

/* --------------------------------- avatars --------------------------------- */

function resolveAvatarUrl(name) {
    const profile = getActiveProfile();
    const file = profile?.avatars?.[name];
    if (!file) return null;

    const folder = encodeURIComponent(profile.folder || 'default');
    const encodedFile = encodeURIComponent(file);

    try {
        return new URL(`avatars/${folder}/${encodedFile}`, import.meta.url).href;
    } catch (error) {
        console.error('[Character Thoughts] Failed to build avatar URL:', error);
        return null;
    }
}

/* --------------------------------- rendering -------------------------------- */

function renderThoughtsList(body) {
    const map = getThoughts();
    const names = Object.keys(map);

    if (names.length === 0) {
        body.innerHTML = '<div class="ct-empty">No thoughts captured yet. Play a turn, or use “Parse last”.</div>';
        return;
    }

    body.innerHTML = names.map((name) => {
        const item = map[name];
        const url = resolveAvatarUrl(name);
        const hue = hueForName(name);

        const avatar = url
            ? `<div class="ct-avatar" data-name="${escapeHtml(name)}"><img src="${escapeHtml(url)}" alt=""></div>`
            : `<div class="ct-avatar ct-avatar-fallback" data-name="${escapeHtml(name)}" style="background:hsl(${hue} 48% 42%)">${escapeHtml(initial(name))}</div>`;

        const mood = item.mood
            ? `<div class="ct-mood">${escapeHtml(item.mood)}</div>`
            : '';

        const thought = item.thought
            ? `<div class="ct-thought">${escapeHtml(item.thought)}</div>`
            : '<div class="ct-thought ct-thought-empty">—</div>';

        return `
            <div class="ct-card">
                ${avatar}
                <div class="ct-content">
                    <div class="ct-name">${escapeHtml(name)}</div>
                    ${mood}
                    ${thought}
                </div>
            </div>
        `;
    }).join('');

    // Swap a broken/missing image for the coloured initial circle.
    body.querySelectorAll('.ct-avatar img').forEach((img) => {
        img.addEventListener('error', () => {
            const wrap = img.parentElement;
            const name = wrap.getAttribute('data-name') || '';
            wrap.classList.add('ct-avatar-fallback');
            wrap.style.background = `hsl(${hueForName(name)} 48% 42%)`;
            wrap.textContent = initial(name);
        });
    });
}

function renderSettings(container) {
    const profiles = getProfiles();
    const activeId = getActiveProfileId();
    const active = profiles[activeId] || { name: 'default', folder: 'default', avatars: {} };

    // Character names worth listing: those seen in this chat + any already mapped.
    const known = new Set([
        ...Object.keys(getThoughts()),
        ...Object.keys(active.avatars || {}),
    ]);
    const knownNames = Array.from(known);

    const profileOptions = Object.keys(profiles).map((id) => {
        const selected = id === activeId ? ' selected' : '';
        return `<option value="${escapeHtml(id)}"${selected}>${escapeHtml(profiles[id].name || id)}</option>`;
    }).join('');

    const charRows = knownNames.length
        ? knownNames.map((name) => `
            <div class="ct-char-row">
                <span class="ct-char-name">${escapeHtml(name)}</span>
                <input class="ct-char-file" type="text" spellcheck="false"
                    data-name="${escapeHtml(name)}"
                    value="${escapeHtml(active.avatars?.[name] || '')}"
                    placeholder="e.g. law.png">
            </div>
        `).join('')
        : '<div class="ct-empty">No characters yet. They appear here after a turn with thoughts.</div>';

    container.innerHTML = `
        <div class="ct-set-row">
            <label>Profile (AU)</label>
            <div class="ct-set-inline">
                <select id="ct-profile-select">${profileOptions}</select>
                <button id="ct-profile-new" type="button" title="New profile">＋</button>
            </div>
        </div>
        <div class="ct-set-row">
            <label>Profile name</label>
            <input id="ct-profile-name" type="text" value="${escapeHtml(active.name || '')}">
        </div>
        <div class="ct-set-row">
            <label>Avatar folder</label>
            <input id="ct-profile-folder" type="text" spellcheck="false" value="${escapeHtml(active.folder || '')}">
        </div>
        <div class="ct-hint">Put image files in:<br>…/character-thoughts/avatars/<b>${escapeHtml(active.folder || 'folder')}</b>/</div>
        <div class="ct-set-divider"></div>
        <div class="ct-set-label">Avatars by character</div>
        <div id="ct-char-list">${charRows}</div>
    `;

    container.querySelector('#ct-profile-select')?.addEventListener('change', (event) => {
        setActiveProfileId(event.target.value);
        renderSettings(container);
        renderPanel();
    });

    container.querySelector('#ct-profile-new')?.addEventListener('click', () => {
        const name = prompt('New profile (AU) name:');
        if (!name) return;
        const id = `manual:${slugify(name)}:${Date.now()}`;
        ensureProfile(id, name);
        setActiveProfileId(id);
        renderSettings(container);
        renderPanel();
    });

    container.querySelector('#ct-profile-name')?.addEventListener('change', (event) => {
        const all = getProfiles();
        if (all[activeId]) {
            all[activeId].name = event.target.value.trim() || all[activeId].name;
            saveProfiles(all);
            renderSettings(container);
        }
    });

    container.querySelector('#ct-profile-folder')?.addEventListener('change', (event) => {
        const all = getProfiles();
        if (all[activeId]) {
            all[activeId].folder = slugify(event.target.value);
            saveProfiles(all);
            renderSettings(container);
            renderPanel();
        }
    });

    container.querySelectorAll('.ct-char-file').forEach((input) => {
        input.addEventListener('change', (event) => {
            const name = event.target.getAttribute('data-name');
            const file = event.target.value.trim();
            const all = getProfiles();
            if (!all[activeId]) return;
            all[activeId].avatars = all[activeId].avatars || {};
            if (file) {
                all[activeId].avatars[name] = file;
            } else {
                delete all[activeId].avatars[name];
            }
            saveProfiles(all);
            renderPanel();
        });
    });
}

function renderPanel() {
    const body = document.querySelector('#ct-body');
    if (body && body.style.display !== 'none') {
        renderThoughtsList(body);
    }
    const settings = document.querySelector('#ct-settings');
    if (settings && settings.style.display !== 'none') {
        renderSettings(settings);
    }
}

/* ----------------------------------- UI ------------------------------------ */

function showView(view) {
    const body = document.querySelector('#ct-body');
    const settings = document.querySelector('#ct-settings');
    if (!body || !settings) return;

    if (view === 'settings') {
        body.style.display = 'none';
        settings.style.display = 'block';
        renderSettings(settings);
    } else {
        settings.style.display = 'none';
        body.style.display = 'block';
        renderThoughtsList(body);
    }
}

function createUi() {
    if (document.querySelector('#ct-panel')) return;

    const button = document.createElement('button');
    button.id = 'ct-button';
    button.textContent = 'Thoughts';
    document.body.appendChild(button);

    const panel = document.createElement('div');
    panel.id = 'ct-panel';
    panel.style.display = 'none';
    panel.innerHTML = `
        <div id="ct-header">
            <div id="ct-title">Character Thoughts</div>
            <div id="ct-header-actions">
                <button id="ct-refresh" type="button" title="Refresh from last message">⟳</button>
                <button id="ct-gear" type="button" title="Settings">⚙</button>
                <button id="ct-close" type="button" title="Close">×</button>
            </div>
        </div>
        <div id="ct-body"></div>
        <div id="ct-settings" style="display:none"></div>
    `;
    document.body.appendChild(panel);

    let settingsOpen = false;

    button.addEventListener('click', () => {
        const visible = panel.style.display !== 'none';
        panel.style.display = visible ? 'none' : 'block';
        if (!visible) {
            settingsOpen = false;
            showView('list');
        }
    });

    panel.querySelector('#ct-close').addEventListener('click', () => {
        panel.style.display = 'none';
    });

    panel.querySelector('#ct-gear').addEventListener('click', () => {
        settingsOpen = !settingsOpen;
        showView(settingsOpen ? 'settings' : 'list');
    });

    panel.querySelector('#ct-refresh').addEventListener('click', () => {
        const btn = panel.querySelector('#ct-refresh');
        // Restart the spin animation on every click for tactile feedback.
        btn.classList.remove('ct-spinning');
        void btn.offsetWidth;
        btn.classList.add('ct-spinning');

        const text = getLastAssistantMessageText();
        if (text) updateFromText(text, false);
    });
}

/* --------------------------------- events ---------------------------------- */

function handleIncomingMessage(data) {
    let text = '';
    if (typeof data === 'string') text = data;
    else if (data?.mes) text = data.mes;
    else if (data?.message?.mes) text = data.message.mes;

    if (!text) text = getLastAssistantMessageText();
    if (!text) return;

    updateFromText(text, false);
}

function handleChatChanged() {
    renderPanel();
}

function init() {
    createUi();
    renderPanel();

    eventSource.on(event_types.MESSAGE_RECEIVED, handleIncomingMessage);
    eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);

    log('Character Thoughts loaded.');
}

setTimeout(init, 1000);
