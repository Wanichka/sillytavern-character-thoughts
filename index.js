// Character Thoughts v1.3.5
// Stable card bindings, persistent character rosters, and folder file inputs.
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
//   ct_profiles_v1            -> AU profiles, avatars, uploads, saved/hidden names
//   ct_cardmap_v2             -> { card filename or group ID: profileId }
//
// Avatars live on disk under this extension's own folder:
//   .../sillytavern-character-thoughts/<profile.folder>/<file>
// The older avatars/<profile.folder>/<file> layout is also supported.
// You drop the image files in by hand; the menu just maps name -> filename.
// No avatar set / file missing -> coloured initial circle (never breaks).

import {
    eventSource,
    event_types,
} from '../../../../script.js';
import { isRoleplayDocked, registerRoleplayPanel } from './roleplay-tools-adapter.js';

const THOUGHTS_KEY = 'ct_thoughts_v1';
const PROFILES_KEY = 'ct_profiles_v1';
const CARDMAP_KEY = 'ct_cardmap_v2';
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
        if (context?.groupId != null) {
            return context.groups?.find(group => String(group.id) === String(context.groupId))?.name || 'Group';
        }
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

// Card filenames identify distinct cards even when their display names match.
// Groups have their own binding, independent of the current group speaker.
function getCurrentCardKey() {
    const context = getContextSafe();
    if (context?.groupId != null) return `group:${context.groupId}`;
    const card = context?.characters?.[context.characterId];
    return card?.avatar ? `card:${card.avatar}` : null;
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

function normalizeCharacterName(name) {
    return String(name ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

// Resolve an observed name to the character whose avatar it shares. Aliases
// belong to one avatar set; thought text keeps the name the model actually used.
function avatarOwner(profile, name) {
    const wanted = normalizeCharacterName(name);
    for (const [owner, aliases] of Object.entries(profile.aliases || {})) {
        if (normalizeCharacterName(owner) === wanted || aliases.some(alias => normalizeCharacterName(alias) === wanted)) {
            return owner;
        }
    }
    for (const owner of new Set([...Object.keys(profile.uploads || {}), ...Object.keys(profile.avatars || {})])) {
        if (normalizeCharacterName(owner) === wanted) return owner;
    }
    return name;
}

function parseAliases(text, owner) {
    const seen = new Set([normalizeCharacterName(owner)]);
    return String(text ?? '').split(',').map(name => name.trim().replace(/\s+/g, ' ')).filter(name => {
        const key = normalizeCharacterName(name);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function setAvatarAliases(profileId, owner, aliases) {
    const profiles = getProfiles();
    const profile = profiles[profileId];
    if (!profile) return { ok: false, conflict: owner };
    const claimed = new Set(aliases.map(normalizeCharacterName));
    for (const other of new Set([
        ...Object.keys(profile.aliases || {}),
        ...Object.keys(profile.uploads || {}),
        ...Object.keys(profile.avatars || {}),
    ])) {
        if (other === owner) continue;
        if (claimed.has(normalizeCharacterName(other)) && (profile.uploads?.[other] || profile.avatars?.[other] || profile.aliases?.[other]?.length)) {
            return { ok: false, conflict: other };
        }
        if ((profile.aliases?.[other] || []).some(alias => claimed.has(normalizeCharacterName(alias)))) {
            return { ok: false, conflict: other };
        }
    }
    profile.aliases ||= {};
    if (aliases.length) profile.aliases[owner] = aliases;
    else delete profile.aliases[owner];
    return { ok: saveProfiles(profiles) };
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
        return true;
    } catch (error) {
        console.error('[Character Thoughts] Failed to save profiles:', error);
        return false;
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
            characters: [],
            hiddenCharacters: [],
        };
        saveProfiles(profiles);
    }
    return profiles[profileId];
}

// Which AU profile is active — keyed by the ST CARD, not the chat.
// All chats of the same card share one profile (so switching chats never
// spawns duplicates). Reading or switching cards never creates a set.
// The user selects an existing set or explicitly creates one with +.
function getActiveProfileId() {
    const cardKey = getCurrentCardKey();
    if (!cardKey) return null;
    const map = getCardMap();
    const profiles = getProfiles();

    if (map[cardKey] && profiles[map[cardKey]]) {
        return map[cardKey];
    }

    return null;
}

function getActiveProfile() {
    const id = getActiveProfileId();
    const profiles = getProfiles();
    return profiles[id] || { name: 'default', folder: 'default', avatars: {} };
}

// Manual override: remember the chosen profile FOR THIS CARD, so it sticks
// across all of the card's chats.
function setActiveProfileId(profileId) {
    const cardKey = getCurrentCardKey();
    if (!cardKey || !getProfiles()[profileId]) return;
    const map = getCardMap();
    map[cardKey] = profileId;
    saveCardMap(map);
}

function rememberCharacters(names, profileId = getActiveProfileId(), { current = false } = {}) {
    const profiles = getProfiles();
    const profile = profiles[profileId];
    if (!profile) return;
    // Current thoughts are authoritative: observing a character saves them,
    // whether or not they have an avatar. History alone respects manual removal.
    const observed = new Set(names.map(normalizeCharacterName));
    const previousHidden = profile.hiddenCharacters || [];
    const hiddenNames = current
        ? previousHidden.filter(name => !observed.has(normalizeCharacterName(name)))
        : previousHidden;
    const hidden = new Set(hiddenNames.map(normalizeCharacterName));
    const known = new Set([
        ...(profile.characters || []),
        ...Object.keys(profile.avatars || {}),
        ...Object.keys(profile.uploads || {}),
        ...names,
    ].filter(name => !hidden.has(normalizeCharacterName(name))));
    const characters = [...known];
    if (JSON.stringify(characters) !== JSON.stringify(profile.characters)
        || hiddenNames.length !== previousHidden.length) {
        profile.characters = characters;
        profile.hiddenCharacters = hiddenNames;
        saveProfiles(profiles);
    }
}

// Backfill the roster from the open chat, including characters absent from the
// latest turn. Only current thoughts may re-add a previously removed character.
function rememberChatCharacters() {
    const names = new Set(Object.keys(getThoughts()));
    for (const message of getContextSafe()?.chat || []) {
        if (message?.is_user || message?.is_system) continue;
        for (const name of Object.keys(parseMessage(message?.mes) || {})) names.add(name);
    }
    rememberCharacters([...names]);
    rememberCharacters(Object.keys(getThoughts()), getActiveProfileId(), { current: true });
}

function removeCharacter(name, profileId) {
    const profiles = getProfiles();
    const profile = profiles[profileId];
    if (!profile) return false;
    const names = new Set([name, ...(profile.aliases?.[name] || [])]);
    const keys = new Set([...names].map(normalizeCharacterName));
    profile.characters = (profile.characters || []).filter(item => !keys.has(normalizeCharacterName(item)));
    profile.hiddenCharacters = [...new Set([...(profile.hiddenCharacters || []), ...names])];
    delete profile.avatars?.[name];
    delete profile.uploads?.[name];
    delete profile.aliases?.[name];
    return saveProfiles(profiles);
}

function validPathPart(value) {
    return !!value && value !== '.' && value !== '..' && !/[\\/\x00-\x1f]/.test(value);
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
    rememberCharacters(Object.keys(map), getActiveProfileId(), { current: true });
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
function setUploadedAvatar(name, dataUrl, id = getActiveProfileId()) {
    const profiles = getProfiles();
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

function resolveAvatarSources(name) {
    const profile = getActiveProfile();
    name = avatarOwner(profile, name);

    // 1) An image uploaded through the menu (stored as a data URL).
    const uploaded = profile?.uploads?.[name];
    if (uploaded) return [uploaded];

    // 2) A filename the user dropped into the profile's avatars folder.
    const file = profile?.avatars?.[name];
    if (file) {
        const folder = encodeURIComponent(profile.folder || 'default');
        const encodedFile = encodeURIComponent(file);
        try {
            return [
                new URL(`./${folder}/${encodedFile}`, import.meta.url).href,
                new URL(`./avatars/${folder}/${encodedFile}`, import.meta.url).href,
            ];
        } catch (error) {
            console.error('[Character Thoughts] Failed to build avatar URL:', error);
            return [];
        }
    }

    // 3) Nothing set -> caller draws the coloured initial circle.
    return [];
}

function resolveAvatarSrc(name) {
    return resolveAvatarSources(name)[0] || null;
}

function installAvatarFallbacks(container, selector) {
    container.querySelectorAll(selector).forEach(img => {
        const wrap = img.parentElement;
        const name = wrap.dataset.name || '';
        // Capture URLs now so a card switch cannot redirect a pending error
        // to the newly active card's folder.
        const sources = resolveAvatarSources(name);
        let next = 1;
        img.addEventListener('error', () => {
            if (next < sources.length) {
                img.src = sources[next++];
                return;
            }
            wrap.classList.add('ct-avatar-fallback');
            wrap.style.background = `hsl(${hueForName(name)} 48% 42%)`;
            wrap.textContent = initial(name);
        });
    });
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

    installAvatarFallbacks(body, '.ct-avatar img');
}

function renderSettings(container) {
    const activeId = getActiveProfileId();
    if (!getCurrentCardKey()) {
        container.innerHTML = '<div class="ct-empty">Open a character or group to configure avatars.</div>';
        return;
    }
    rememberCharacters(Object.keys(getThoughts()), activeId);
    const profiles = getProfiles();
    const active = profiles[activeId] || { characters: [], hiddenCharacters: [] };
    const knownNames = [...(active.characters || [])]
        .filter(name => avatarOwner(active, name) === name)
        .sort((a, b) => a.localeCompare(b));

    const profileOptions = (activeId ? '' : '<option value="" selected disabled>Choose an avatar set…</option>') + Object.keys(profiles).map((id) => {
        const selected = id === activeId ? ' selected' : '';
        return `<option value="${escapeHtml(id)}"${selected}>${escapeHtml(profiles[id].name || 'Unnamed set')}</option>`;
    }).join('');

    const charRows = knownNames.length
        ? knownNames.map((name) => {
            const src = resolveAvatarSrc(name);
            const hue = hueForName(name);
            const preview = src
                ? `<div class="ct-char-prev" data-name="${escapeHtml(name)}"><img src="${escapeHtml(src)}" alt=""></div>`
                : `<div class="ct-char-prev ct-avatar-fallback" style="background:hsl(${hue} 48% 42%)">${escapeHtml(initial(name))}</div>`;
            const hasUpload = !!active.uploads?.[name];
            const clearBtn = `<button class="ct-char-clear${hasUpload ? '' : ' ct-hidden'}" type="button" data-name="${escapeHtml(name)}" title="Remove uploaded image">✕</button>`;
            return `
                <div class="ct-char-row">
                    ${preview}
                    <span class="ct-char-name">${escapeHtml(name)}</span>
                    <div class="ct-char-btns">
                        <button class="ct-char-upload" type="button" data-name="${escapeHtml(name)}">Upload</button>
                        <button class="ct-char-folder" type="button" data-name="${escapeHtml(name)}" title="Use an image from a folder" aria-label="Use an image from a folder for ${escapeHtml(name)}">📁</button>
                        <button class="ct-char-aliases" type="button" data-name="${escapeHtml(name)}" title="Other names for this avatar">Names${active.aliases?.[name]?.length ? ` (${active.aliases[name].length})` : ''}</button>
                        ${clearBtn}
                        <button class="ct-char-remove" type="button" data-name="${escapeHtml(name)}" title="Remove character from this profile">🗑</button>
                    </div>
                </div>
            `;
        }).join('')
        : `<div class="ct-empty">${activeId ? 'No characters yet. They appear here after a turn with thoughts.' : 'Choose an existing set above, or use + to create one. No set is created automatically.'}</div>`;

    container.innerHTML = `
        <div class="ct-hint">Card: <b>${escapeHtml(getCurrentCardName())}</b>. The selected set is remembered for this card.</div>
        <div class="ct-set-row">
            <label for="ct-profile-select">Avatar set</label>
            <div class="ct-set-inline">
                <select id="ct-profile-select">${profileOptions}</select>
                <button id="ct-profile-new" type="button" title="New avatar set" aria-label="New avatar set">＋</button>
                <button id="ct-profile-rename" type="button" title="Rename avatar set" aria-label="Rename avatar set"${activeId ? '' : ' disabled'}>✎</button>
                <button id="ct-profile-delete" type="button" title="Delete this avatar set"${activeId ? '' : ' disabled'}>🗑</button>
            </div>
        </div>
        <div class="ct-hint">Upload a picture, or use 📁 for a file in an existing folder. Cards using the same set share its avatars and character list.</div>
        <div class="ct-set-divider"></div>
        <div class="ct-set-label">Avatars by character</div>
        <div class="ct-hint">Characters from thoughts and moods are saved automatically, even without a picture or after leaving the scene. Use <b>Names</b> to give one avatar several names.</div>
        ${(active.hiddenCharacters || []).length ? '<button id="ct-restore-characters" type="button" class="ct-char-clear">Restore removed characters</button>' : ''}
        <div id="ct-char-list">${charRows}</div>
        <details class="ct-panel-options"><summary>Panel size</summary>
            <button id="ct-size-reset" type="button" class="ct-char-clear">Reset size</button>
        </details>
    `;

    container.querySelector('#ct-profile-select')?.addEventListener('change', (event) => {
        setActiveProfileId(event.target.value);
        rememberChatCharacters();
        renderSettings(container);
        renderPanel();
    });

    container.querySelector('#ct-profile-new')?.addEventListener('click', () => {
        const name = (prompt('New avatar set name:') || '').trim();
        if (!name) return;
        const all = getProfiles();
        // Creating a set must never silently select another card's set.
        const existingId = Object.keys(all).find(
            (id) => (all[id].name || '').toLowerCase() === name.toLowerCase()
        );
        if (existingId) {
            alert('A set with this name already exists. Choose another name, or select the existing set from the list to share it.');
            return;
        }
        const id = `manual:${slugify(name)}:${Date.now()}`;
        ensureProfile(id, name);
        setActiveProfileId(id);
        rememberChatCharacters();
        renderSettings(container);
        renderPanel();
    });

    container.querySelector('#ct-profile-delete')?.addEventListener('click', () => {
        const all = getProfiles();
        if (!activeId || !all[activeId]) return;
        const label = all[activeId]?.name || activeId;
        if (!confirm(`Delete profile “${label}”?\nThe avatar image files on disk are NOT removed.`)) return;
        delete all[activeId];
        if (!saveProfiles(all)) return;
        // Cards that shared this set return to the explicit selection state.
        const bindings = getCardMap();
        for (const key of Object.keys(bindings)) {
            if (bindings[key] === activeId) bindings[key] = null;
        }
        saveCardMap(bindings);
        renderSettings(container);
        renderPanel();
    });

    container.querySelector('#ct-profile-rename')?.addEventListener('click', () => {
        const name = (prompt('Avatar set name:', active.name || '') || '').trim();
        if (!name) return;
        const all = getProfiles();
        if (all[activeId]) {
            all[activeId].name = name;
            saveProfiles(all);
            renderSettings(container);
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
                    const ok = setUploadedAvatar(name, dataUrl, activeId);
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
        if (!btn.hasAttribute('data-name')) return;
        btn.addEventListener('click', () => {
            const name = btn.getAttribute('data-name');
            setUploadedAvatar(name, null, activeId);
            renderSettings(container);
            renderPanel();
        });
    });

    container.querySelectorAll('.ct-char-folder').forEach(btn => {
        btn.addEventListener('click', () => {
            const name = btn.dataset.name;
            const folderInput = prompt('Folder inside this extension (for the whole set), for example medicine-au:', active.folder || '');
            if (folderInput === null) return;
            const folder = folderInput.trim();
            if (!validPathPart(folder)) {
                alert('Enter one folder name, without slashes or a full path.');
                return;
            }
            const fileInput = prompt(`Image filename for ${name}, including its extension:`, active.avatars?.[name] || '');
            if (fileInput === null) return;
            const file = fileInput.trim();
            if (!validPathPart(file)) {
                alert('Enter a filename without slashes, for example law.png.');
                return;
            }
            const all = getProfiles();
            if (!all[activeId]) return;
            all[activeId].folder = folder;
            all[activeId].avatars ||= {};
            all[activeId].avatars[name] = file;
            // Explicitly choosing a folder image replaces this character's upload.
            delete all[activeId].uploads?.[name];
            if (!saveProfiles(all)) alert('Could not save changes. Browser storage may be full.');
            renderPanel();
        });
    });
    container.querySelectorAll('.ct-char-aliases').forEach(btn => {
        btn.addEventListener('click', () => {
            const owner = btn.dataset.name;
            const input = prompt(`Other names for ${owner}, separated by commas:`, (active.aliases?.[owner] || []).join(', '));
            if (input === null) return;
            const result = setAvatarAliases(activeId, owner, parseAliases(input, owner));
            if (!result.ok) {
                alert(result.conflict
                    ? `“${result.conflict}” already has an avatar or name mapping in this set. Clear that assignment first.`
                    : 'Could not save names. Browser storage may be full.');
                return;
            }
            renderPanel();
        });
    });
    container.querySelectorAll('.ct-char-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            const name = btn.dataset.name;
            if (!confirm(`Remove “${name}” from this profile and clear their avatar? Chat messages and image files will stay.`)) return;
            if (!removeCharacter(name, activeId)) alert('Could not save changes. Browser storage may be full.');
            renderPanel();
        });
    });
    container.querySelector('#ct-restore-characters')?.addEventListener('click', () => {
        const all = getProfiles();
        if (!all[activeId]) return;
        all[activeId].characters = [...new Set([...(all[activeId].characters || []), ...(all[activeId].hiddenCharacters || [])])];
        all[activeId].hiddenCharacters = [];
        saveProfiles(all);
        renderPanel();
    });
    installAvatarFallbacks(container, '.ct-char-prev img');
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
        settings.style.display = 'flex';
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
    rememberChatCharacters();
    renderPanel();
}

function init() {
    createUi();
    rememberChatCharacters();
    renderPanel();

    eventSource.on(event_types.MESSAGE_RECEIVED, handleIncomingMessage);
    eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);

    log('Character Thoughts loaded.');
}

setTimeout(init, 1000);
