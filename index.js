// Character Thoughts v1.2
// Shows each character's current thoughts (and mood) parsed from the
// <char_thoughts> and <char_mood> info blocks in the latest assistant message.
// v1.2: HEIGHT-only resize. The width stays fixed at the value from style.css
//   (the whole extension set shares it), so the grip is a thin strip along the
//   BOTTOM EDGE with a vertical cursor instead of a corner square: a corner
//   grip promises two axes and invites mis-taps on a tablet.
// v1.1: the panel became resizable.
//   This is a REAL resize (height in px), not the proportional
//   transform: scale() used by the Context Tracker badge: the badge has three
//   numbers and nothing to scroll, while this panel has a scrollable list, so
//   growing it must show MORE text rather than bigger text.
//   - Height is saved per browser (ct_panel_size) and re-clamped to the visible
//     viewport whenever the panel is opened or the window/orientation changes,
//     so a height saved on a big screen can never leave the panel unusable on a
//     small one.
//   - While resizing, a dragged panel (one with an explicit left/top) is
//     re-clamped live, so growing it cannot push it off the bottom edge.
//   - Under 600px wide the grip is hidden and saved heights are ignored: there
//     the panel is full-screen by design (see the media query in style.css).
//   - The grip's CSS is injected from here on purpose, so updating
//     touches index.js only and style.css can stay as it is.
// v1.0: the top gap for floating browser toolbars is now enforced in CSS too
// (--ct-top-gap), not only during drags; DRAG_TOP_MARGIN raised to match it;
// clamping uses visualViewport when available; saved positions are re-clamped
// at the moment the panel is opened (a hidden panel measures 0x0) and on
// window resize / orientation change.
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
import { isRoleplayDocked, registerRoleplayPanel } from './roleplay-tools-adapter.js';

const THOUGHTS_KEY = 'ct_thoughts_v1';
const PROFILES_KEY = 'ct_profiles_v1';
const CARDMAP_KEY = 'ct_cardmap_v1';
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

function getCardMap() {
    try {
        const raw = localStorage.getItem(CARDMAP_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (error) {
        console.error('[Character Thoughts] Failed to read card map:', error);
        return {};
    }
}

function saveCardMap(map) {
    try {
        localStorage.setItem(CARDMAP_KEY, JSON.stringify(map));
    } catch (error) {
        console.error('[Character Thoughts] Failed to save card map:', error);
    }
}

function ensureProfile(profileId, displayName) {
    const profiles = getProfiles();
    if (!profiles[profileId]) {
        profiles[profileId] = {
            name: displayName || profileId,
            folder: slugify(displayName || profileId),
            avatars: {},
            uploads: {},
        };
        saveProfiles(profiles);
    }
    return profiles[profileId];
}

// Which AU profile is active — keyed by the ST CARD, not the chat.
// All chats of the same card share one profile (so switching chats never
// spawns duplicates). A card seen for the first time gets its own profile
// created automatically once. The menu can override the binding per card.
function getActiveProfileId() {
    const cardName = getCurrentCardName();
    const map = getCardMap();

    if (map[cardName]) {
        return map[cardName];
    }

    // First time we see this card: create its profile and bind it.
    const profileId = `card:${cardName}`;
    ensureProfile(profileId, cardName);
    map[cardName] = profileId;
    saveCardMap(map);
    return profileId;
}

function getActiveProfile() {
    const profiles = getProfiles();
    return profiles[getActiveProfileId()] || { name: 'default', folder: 'default', avatars: {} };
}

// Manual override: remember the chosen profile FOR THIS CARD, so it sticks
// across all of the card's chats.
function setActiveProfileId(profileId) {
    const cardName = getCurrentCardName();
    const map = getCardMap();
    map[cardName] = profileId;
    saveCardMap(map);
}

/* --------------------------------- parsing --------------------------------- */

function extractTagBlock(text, tag) {
    // Match the tag in the RAW text first. normalizeText() runs text through the
    // DOM (stripHtml), which turns <char_thoughts> into a real, empty element and
    // drops the literal tag — so the block must be captured before normalizing.
    // Only the inner content is normalized afterwards.
    const raw = String(text ?? '');
    const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = raw.match(regex);
    return match ? normalizeText(match[1]).trim() : null;
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

    // A new character starts at the block start or after ';', followed by a
    // short "Name:". Dots are allowed in names (e.g. "Trafalgar D. Water Law");
    // !?… stay excluded so a whole exclamatory sentence can't be read as a name.
    const headerRegex = /(?:^|;)\s*([^:;\n!?…]{1,40}?)\s*:\s*/g;
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

/* ----------------------------- avatar upload -------------------------------- */

// Store/clear an uploaded avatar (a data URL) for a character in the active
// profile. Returns false if the browser refused to save (storage full).
function setUploadedAvatar(name, dataUrl) {
    const profiles = getProfiles();
    const id = getActiveProfileId();
    if (!profiles[id]) return false;

    profiles[id].uploads = profiles[id].uploads || {};
    if (dataUrl) {
        profiles[id].uploads[name] = dataUrl;
    } else {
        delete profiles[id].uploads[name];
    }

    try {
        localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
        return true;
    } catch (error) {
        console.error('[Character Thoughts] Failed to save avatar (storage full?):', error);
        return false;
    }
}

// Open a native file picker for one image, then hand the File to a callback.
function pickImageFile(onPicked) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (file) onPicked(file);
        input.remove();
    });
    document.body.appendChild(input);
    input.click();
}

// Square cropper: drag to pan, slider to zoom. Saves a downscaled JPEG data URL.
function openImageCropper(file, onSave) {
    const reader = new FileReader();
    reader.onerror = () => alert('Could not read that image file.');
    reader.onload = () => buildCropper(reader.result, onSave);
    reader.readAsDataURL(file);
}

function buildCropper(dataUrl, onSave) {
    const WIN = Math.min(260, Math.max(180, window.innerWidth - 80)); // on-screen crop square
    const OUT = 256;   // saved avatar resolution
    const MAX_ZOOM = 4;

    const overlay = document.createElement('div');
    overlay.className = 'ct-crop-overlay';
    overlay.innerHTML = `
        <div class="ct-crop-box">
            <div class="ct-crop-title">Adjust avatar</div>
            <div class="ct-crop-window" style="width:${WIN}px;height:${WIN}px">
                <img class="ct-crop-img" alt="" draggable="false">
            </div>
            <input class="ct-crop-zoom" type="range" min="1" max="${MAX_ZOOM}" step="0.01" value="1">
            <div class="ct-crop-actions">
                <button class="ct-crop-cancel" type="button">Cancel</button>
                <button class="ct-crop-save" type="button">Save</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const img = overlay.querySelector('.ct-crop-img');
    const win = overlay.querySelector('.ct-crop-window');
    const zoom = overlay.querySelector('.ct-crop-zoom');

    win.style.touchAction = 'none';

    let nw = 0;
    let nh = 0;
    let cover = 1;  // scale at which the image just covers the window
    let k = 1;      // current scale
    let tx = 0;
    let ty = 0;

    function clampPan() {
        const dispW = nw * k;
        const dispH = nh * k;
        tx = Math.min(0, Math.max(WIN - dispW, tx));
        ty = Math.min(0, Math.max(WIN - dispH, ty));
    }
    function apply() {
        img.style.width = `${nw * k}px`;
        img.style.height = `${nh * k}px`;
        img.style.left = `${tx}px`;
        img.style.top = `${ty}px`;
    }

    img.onload = () => {
        nw = img.naturalWidth;
        nh = img.naturalHeight;
        cover = Math.max(WIN / nw, WIN / nh);
        k = cover;
        tx = (WIN - nw * k) / 2;
        ty = (WIN - nh * k) / 2;
        apply();
    };
    img.onerror = () => { alert('Could not load that image.'); overlay.remove(); };
    img.src = dataUrl;

    zoom.addEventListener('input', () => {
        const newK = cover * parseFloat(zoom.value);
        const cx = WIN / 2;
        const cy = WIN / 2;
        // keep the window centre anchored to the same source point while zooming
        const srcX = (cx - tx) / k;
        const srcY = (cy - ty) / k;
        k = newK;
        tx = cx - srcX * k;
        ty = cy - srcY * k;
        clampPan();
        apply();
    });

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let baseTx = 0;
    let baseTy = 0;

    win.addEventListener('pointerdown', (event) => {
        dragging = true;
        startX = event.clientX;
        startY = event.clientY;
        baseTx = tx;
        baseTy = ty;
        try { win.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
    });
    win.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        tx = baseTx + (event.clientX - startX);
        ty = baseTy + (event.clientY - startY);
        clampPan();
        apply();
    });
    function endDrag(event) {
        dragging = false;
        try { win.releasePointerCapture(event.pointerId); } catch (e) { /* ignore */ }
    }
    win.addEventListener('pointerup', endDrag);
    win.addEventListener('pointercancel', endDrag);

    function close() { overlay.remove(); }

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close();
    });
    overlay.querySelector('.ct-crop-cancel').addEventListener('click', close);

    overlay.querySelector('.ct-crop-save').addEventListener('click', () => {
        const canvas = document.createElement('canvas');
        canvas.width = OUT;
        canvas.height = OUT;
        const ctx = canvas.getContext('2d');

        // Map the visible window back to source (natural) pixels.
        const srcSize = WIN / k;
        const srcX = -tx / k;
        const srcY = -ty / k;

        let out;
        try {
            ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, OUT, OUT);
            out = canvas.toDataURL('image/jpeg', 0.85);
        } catch (error) {
            console.error('[Character Thoughts] Crop failed:', error);
            alert('Could not process that image.');
            return;
        }
        close();
        onSave(out);
    });
}

function resolveAvatarSrc(name) {
    const profile = getActiveProfile();

    // 1) An image uploaded through the menu (stored as a data URL).
    const uploaded = profile?.uploads?.[name];
    if (uploaded) return uploaded;

    // 2) A filename the user dropped into the profile's avatars folder.
    const file = profile?.avatars?.[name];
    if (file) {
        const folder = encodeURIComponent(profile.folder || 'default');
        const encodedFile = encodeURIComponent(file);
        try {
            return new URL(`avatars/${folder}/${encodedFile}`, import.meta.url).href;
        } catch (error) {
            console.error('[Character Thoughts] Failed to build avatar URL:', error);
            return null;
        }
    }

    // 3) Nothing set -> caller draws the coloured initial circle.
    return null;
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
        const url = resolveAvatarSrc(name);
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
        ? knownNames.map((name) => {
            const src = resolveAvatarSrc(name);
            const hue = hueForName(name);
            const preview = src
                ? `<div class="ct-char-prev"><img src="${escapeHtml(src)}" alt=""></div>`
                : `<div class="ct-char-prev ct-avatar-fallback" style="background:hsl(${hue} 48% 42%)">${escapeHtml(initial(name))}</div>`;
            const hasUpload = !!active.uploads?.[name];
            const clearBtn = `<button class="ct-char-clear${hasUpload ? '' : ' ct-hidden'}" type="button" data-name="${escapeHtml(name)}" title="Remove uploaded image">✕</button>`;
            return `
                <div class="ct-char-row">
                    ${preview}
                    <span class="ct-char-name">${escapeHtml(name)}</span>
                    <div class="ct-char-btns">
                        <button class="ct-char-upload" type="button" data-name="${escapeHtml(name)}">Upload</button>
                        ${clearBtn}
                    </div>
                </div>
            `;
        }).join('')
        : '<div class="ct-empty">No characters yet. They appear here after a turn with thoughts.</div>';

    container.innerHTML = `
        <div class="ct-set-row">
            <label>Profile (AU)</label>
            <div class="ct-set-inline">
                <select id="ct-profile-select">${profileOptions}</select>
                <button id="ct-profile-new" type="button" title="New profile">＋</button>
                <button id="ct-profile-delete" type="button" title="Delete this profile">🗑</button>
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
        <div class="ct-hint">Click <b>Upload</b> on a character to pick and crop an image. Saved avatars stay with this profile.</div>
        <div class="ct-set-divider"></div>
        <div class="ct-set-label">Panel</div>
        <div class="ct-hint">Drag the strip along the bottom edge to make the panel taller or shorter. <b>Reset size</b> puts it back to the default.</div>
        <button id="ct-size-reset" type="button" class="ct-char-clear">Reset size</button>
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
        const name = (prompt('New profile (AU) name:') || '').trim();
        if (!name) return;
        const all = getProfiles();
        // If a profile with this name already exists, switch to it instead of
        // creating a duplicate.
        const existingId = Object.keys(all).find(
            (id) => (all[id].name || '').toLowerCase() === name.toLowerCase()
        );
        const id = existingId || `manual:${slugify(name)}:${Date.now()}`;
        if (!existingId) ensureProfile(id, name);
        setActiveProfileId(id);
        renderSettings(container);
        renderPanel();
    });

    container.querySelector('#ct-profile-delete')?.addEventListener('click', () => {
        const all = getProfiles();
        const ids = Object.keys(all);
        if (ids.length <= 1) {
            alert('Can’t delete the only profile.');
            return;
        }
        const label = all[activeId]?.name || activeId;
        if (!confirm(`Delete profile “${label}”?\nThe avatar image files on disk are NOT removed.`)) return;
        delete all[activeId];
        saveProfiles(all);
        // Point this chat at another existing profile so it isn't recreated.
        setActiveProfileId(Object.keys(all)[0]);
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

    container.querySelector('#ct-size-reset')?.addEventListener('click', () => {
        resetPanelSize();
    });

    container.querySelectorAll('.ct-char-upload').forEach((btn) => {
        btn.addEventListener('click', () => {
            const name = btn.getAttribute('data-name');
            pickImageFile((file) => {
                openImageCropper(file, (dataUrl) => {
                    const ok = setUploadedAvatar(name, dataUrl);
                    if (!ok) {
                        alert('Not enough browser storage to save this avatar. Try removing some saved images.');
                        return;
                    }
                    renderSettings(container);
                    renderPanel();
                });
            });
        });
    });

    container.querySelectorAll('.ct-char-clear').forEach((btn) => {
        // The size-reset button borrows this class for styling only.
        if (btn.id === 'ct-size-reset') return;
        btn.addEventListener('click', () => {
            const name = btn.getAttribute('data-name');
            setUploadedAvatar(name, null);
            renderSettings(container);
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

/* ------------------------------- draggable UI ------------------------------- */

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

// Keep a dragged element on-screen. The top margin ensures the draggable
// header can never hide under a floating browser toolbar (tablet/mobile).
// IMPORTANT: DRAG_TOP_MARGIN must match --ct-top-gap in style.css — the CSS
// value protects the DEFAULT (never-dragged) position, this one protects
// dragged/restored positions. Change them together.
const DRAG_EDGE = 8;
const DRAG_TOP_MARGIN = 100;

// Visible viewport size. visualViewport is more honest than innerWidth/Height
// on tablets/phones where browser chrome expands and collapses.
function viewportSize() {
    const vv = window.visualViewport;
    if (vv && vv.width && vv.height) {
        return { w: vv.width, h: vv.height };
    }
    return { w: window.innerWidth, h: window.innerHeight };
}

function clampToViewport(el, left, top) {
    const w = el.offsetWidth || 0;
    const h = el.offsetHeight || 0;
    const vp = viewportSize();
    const maxLeft = Math.max(DRAG_EDGE, vp.w - w - DRAG_EDGE);
    const maxTop = Math.max(DRAG_TOP_MARGIN, vp.h - h - DRAG_EDGE);
    return {
        left: clamp(left, DRAG_EDGE, maxLeft),
        top: clamp(top, DRAG_TOP_MARGIN, maxTop),
    };
}

function applyPosition(el, left, top) {
    if (isRoleplayDocked(el)) return;
    // Inline !important beats the fixed-position rules (and the mobile media
    // query) in style.css, so a dragged element actually moves.
    el.style.setProperty('left', `${left}px`, 'important');
    el.style.setProperty('top', `${top}px`, 'important');
    el.style.setProperty('right', 'auto', 'important');
    el.style.setProperty('bottom', 'auto', 'important');
}

function restorePosition(el, storageKey) {
    if (isRoleplayDocked(el)) return;
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return;
        // A hidden element measures 0x0, which makes the clamp meaningless.
        // Skip now; the caller re-runs this at the moment the element is shown.
        if (!el.offsetWidth && !el.offsetHeight) return;
        const p = clampToViewport(el, saved.left, saved.top);
        applyPosition(el, p.left, p.top);
    } catch (error) {
        console.error('[Character Thoughts] Failed to restore position:', error);
    }
}

// Drag `el` by `handle`; remembers position. clickAction (if any) fires only on
// a genuine click, never at the end of a drag, and inner <button>s in the
// handle keep working.
function makeDraggable(el, { storageKey, handle = el, clickAction = null } = {}) {
    restorePosition(el, storageKey);
    handle.style.touchAction = 'none';

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;

    handle.addEventListener('pointerdown', (event) => {
        if (isRoleplayDocked(el)) return;
        const innerButton = event.target.closest('button');
        if (innerButton && innerButton !== el) return;
        if (event.button != null && event.button !== 0) return;

        dragging = true;
        moved = false;
        const rect = el.getBoundingClientRect();
        baseLeft = rect.left;
        baseTop = rect.top;
        startX = event.clientX;
        startY = event.clientY;
        try { handle.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
    });

    handle.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 5) return;
        moved = true;
        const p = clampToViewport(el, baseLeft + dx, baseTop + dy);
        applyPosition(el, p.left, p.top);
    });

    function finish(event) {
        if (!dragging) return;
        dragging = false;
        try { handle.releasePointerCapture(event.pointerId); } catch (e) { /* ignore */ }
        if (moved) {
            const rect = el.getBoundingClientRect();
            try {
                localStorage.setItem(storageKey, JSON.stringify({ left: rect.left, top: rect.top }));
            } catch (e) { /* ignore */ }
        }
    }
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);

    if (clickAction) {
        el.addEventListener('click', (event) => {
            if (moved) { moved = false; return; }
            clickAction(event);
        });
    }
}

/* ------------------------------- resizable UI ------------------------------- */

// Real resize (height in px), not transform: scale() — the panel body scrolls,
// so a taller panel must show MORE text, not bigger text. The width is left to
// style.css on purpose: all three extensions share it.
const SIZE_KEY = 'ct_panel_size';
const PANEL_MIN_H = 200;
const COMPACT_WIDTH = 600;  // must match the media query in style.css

// Under this width style.css takes the panel full-screen; a saved height would
// fight that layout, so resizing is disabled there entirely.
function isCompactViewport() {
    return viewportSize().w <= COMPACT_WIDTH;
}

function clampHeight(height) {
    const vp = viewportSize();
    const maxH = Math.max(PANEL_MIN_H, vp.h - DRAG_TOP_MARGIN - DRAG_EDGE);
    return clamp(height, PANEL_MIN_H, maxH);
}

function applyHeight(el, height) {
    if (isRoleplayDocked(el)) return;
    el.style.setProperty('height', `${height}px`, 'important');
}

function clearSize(el) {
    el.style.removeProperty('height');
}

// Re-applied on open and on resize/orientation change, so a height saved on a
// large screen can never leave the panel taller than the current viewport.
function restoreSize(el, storageKey) {
    if (isRoleplayDocked(el)) return;
    if (isCompactViewport()) {
        clearSize(el);
        return;
    }
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (!saved || !Number.isFinite(saved.h)) return;
        applyHeight(el, clampHeight(saved.h));
    } catch (error) {
        console.error('[Character Thoughts] Failed to restore height:', error);
    }
}

function resetPanelSize() {
    const panel = document.querySelector('#ct-panel');
    try {
        localStorage.removeItem(SIZE_KEY);
    } catch (e) { /* ignore */ }
    if (panel) {
        clearSize(panel);
        // The panel may have been dragged; keep it fully on-screen at its
        // default size too.
        restorePosition(panel, 'ct_panel_pos');
    }
}

// The grip's styles live here rather than in style.css so that updating this
// extension only ever means replacing index.js.
function ensureResizeStyles() {
    if (document.querySelector('#ct-resize-styles')) return;

    const style = document.createElement('style');
    style.id = 'ct-resize-styles';
    style.textContent = `
        /* A strip along the bottom edge: height-only resize, so the grip
           must not look like a two-axis corner. The inner bar is the visible
           handle; the strip around it is a bigger touch target. */
        #ct-resize {
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            height: 14px;
            z-index: 3;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: ns-resize;
            touch-action: none;
        }
        #ct-resize::before {
            content: '';
            width: 42px;
            height: 3px;
            border-radius: 3px;
            background: currentColor;
            opacity: 0.25;
            transition: opacity 0.2s ease;
        }
        #ct-panel:hover #ct-resize::before,
        #ct-panel.ct-resizing #ct-resize::before {
            opacity: 0.6;
        }
        #ct-panel.ct-resizing {
            user-select: none;
        }
        @media (max-width: ${COMPACT_WIDTH}px) {
            #ct-resize { display: none; }
        }
    `;
    document.head.appendChild(style);
}

// Resize `el` vertically by dragging `grip`; remembers the height. Horizontal
// pointer movement is ignored entirely — the width belongs to style.css. A
// panel that has been dragged (explicit left/top) is re-clamped live, so
// growing it cannot push it off the bottom edge.
function makeResizable(el, { storageKey, grip } = {}) {
    if (!grip) return;
    grip.style.touchAction = 'none';

    let resizing = false;
    let startY = 0;
    let baseH = 0;

    grip.addEventListener('pointerdown', (event) => {
        if (isRoleplayDocked(el)) return;
        if (event.button != null && event.button !== 0) return;
        if (isCompactViewport()) return;

        resizing = true;
        baseH = el.getBoundingClientRect().height;
        startY = event.clientY;
        el.classList.add('ct-resizing');
        try { grip.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
        // Stop the header's drag logic and text selection from joining in.
        event.preventDefault();
        event.stopPropagation();
    });

    grip.addEventListener('pointermove', (event) => {
        if (!resizing) return;
        applyHeight(el, clampHeight(baseH + (event.clientY - startY)));

        // Only a dragged panel is anchored by left/top; an untouched one is
        // anchored to the bottom by CSS and stays on-screen by itself.
        if (el.style.top) {
            const rect = el.getBoundingClientRect();
            const p = clampToViewport(el, rect.left, rect.top);
            applyPosition(el, p.left, p.top);
        }
    });

    function finish(event) {
        if (!resizing) return;
        resizing = false;
        el.classList.remove('ct-resizing');
        try { grip.releasePointerCapture(event.pointerId); } catch (e) { /* ignore */ }

        const rect = el.getBoundingClientRect();
        try {
            localStorage.setItem(storageKey, JSON.stringify({ h: rect.height }));
            if (el.style.top) {
                localStorage.setItem('ct_panel_pos', JSON.stringify({ left: rect.left, top: rect.top }));
            }
        } catch (e) { /* ignore */ }
    }
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
}

function createUi() {
    if (document.querySelector('#ct-panel')) return;

    ensureResizeStyles();

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
        <div id="ct-resize" title="Drag to change height"></div>
    `;
    document.body.appendChild(panel);

    // Keep the last card clear of the grip strip.
    const body = panel.querySelector('#ct-body');
    if (body) body.style.paddingBottom = '18px';

    // Height first: the position clamp depends on the panel's dimensions.
    restoreSize(panel, SIZE_KEY);

    let settingsOpen = false;

    function toggleButton() {
        const visible = panel.style.display !== 'none';
        panel.style.display = visible ? 'none' : 'flex';
        if (!visible) {
            settingsOpen = false;
            showView('list');
            // The panel is measurable only now that it's shown — re-clamp any
            // saved size and position so it can't sit under a floating browser
            // toolbar or hang off the screen.
            restoreSize(panel, SIZE_KEY);
            restorePosition(panel, 'ct_panel_pos');
        }
    }

    button.addEventListener('click', toggleButton);
    makeDraggable(panel, { storageKey: 'ct_panel_pos', handle: panel.querySelector('#ct-header') });
    makeResizable(panel, { storageKey: SIZE_KEY, grip: panel.querySelector('#ct-resize') });

    // Rotating the tablet / resizing the window changes what "on-screen" means:
    // re-clamp an open panel so it never ends up half off the viewport.
    window.addEventListener('resize', () => {
        if (panel.style.display !== 'none') {
            restoreSize(panel, SIZE_KEY);
            restorePosition(panel, 'ct_panel_pos');
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

    registerRoleplayPanel({
        id: 'thoughts', title: 'Character Thoughts', minHeight: 160,
        element: panel, launcher: button,
        controls: panel.querySelector('#ct-header-actions'),
        onShow: () => renderThoughtsList(body),
        onRelease: () => {
            if (panel.style.display !== 'none') {
                restoreSize(panel, SIZE_KEY);
                restorePosition(panel, 'ct_panel_pos');
            }
        },
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
