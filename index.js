// Context Tracker — a tiny always-on-screen badge with live chat context stats.
// Shows: last message id (SillyTavern's own 0-based id), number of visible
// (non-hidden) messages, token usage. A progress bar and a pulsing dot signal
// when it's time to summarize.

(function () {
    'use strict';

    const MODULE = 'context_tracker';
    const EDGE_MARGIN = 14;      // mandatory margin from screen edges, px
    const SCALE_MIN = 0.75;
    const SCALE_MAX = 2.5;

    const DEFAULTS = {
        enabled: true,
        interval: 100,           // summary threshold (visible messages); 0 = off
        showTokens: true,
        showProgress: true,
        tokenLimit: 0,           // manual max-context for display; 0 = auto-detect
        lang: 'en',              // 'en' | 'ru'
        scale: 1,
        pos: null,               // {x, y}
    };

    const I18N = {
        en: {
            start: 'start',
            msgs: 'messages',
            due: 'Time to summarize',
            s_show: 'Show badge',
            s_tokens: 'Show tokens',
            s_progress: 'Progress bar & "due" dot',
            s_interval: 'Summary interval (messages in context, 0 = off):',
            s_token_limit: 'Token limit for display (0 = auto-detect):',
            s_lang: 'Language:',
            s_reset: 'Reset badge position & size',
        },
        ru: {
            start: 'начало',
            msgs: 'сообщений',
            due: 'Пора делать пересказ',
            s_show: 'Показывать бейдж',
            s_tokens: 'Показывать токены',
            s_progress: 'Полоска прогресса и точка «пора»',
            s_interval: 'Интервал пересказа (сообщений в контексте, 0 — выкл.):',
            s_token_limit: 'Лимит токенов для отображения (0 — автоопределение):',
            s_lang: 'Язык:',
            s_reset: 'Сбросить позицию и размер бейджа',
        },
    };

    let ctx = null;
    let settings = null;
    let badge = null;
    let lastSignature = '';
    let tokenCacheKey = '';
    let tokenText = '—';
    let tokenOver = false;
    let pollTimer = null;

    // ---------- utils ----------

    function t(key) {
        const lang = I18N[settings.lang] ? settings.lang : 'en';
        return I18N[lang][key] ?? I18N.en[key] ?? key;
    }

    function getSettings() {
        const store = ctx.extensionSettings;
        if (!store[MODULE]) store[MODULE] = {};
        for (const k of Object.keys(DEFAULTS)) {
            if (store[MODULE][k] === undefined) store[MODULE][k] = DEFAULTS[k];
        }
        return store[MODULE];
    }

    function save() {
        ctx.saveSettingsDebounced();
    }

    function fmtTokens(n) {
        if (n === null || n === undefined || Number.isNaN(n)) return '—';
        if (n >= 1000) {
            const v = n / 1000;
            return (v >= 100 ? Math.round(v) : v.toFixed(1)).toString() + 'k';
        }
        return String(n);
    }

    function readIntFrom(id) {
        const el = document.getElementById(id);
        if (!el) return null;
        const v = parseInt(el.value ?? el.textContent, 10);
        return Number.isFinite(v) && v > 0 ? v : null;
    }

    function getMaxContext() {
        // manual limit from settings wins — needed when context size is set
        // to "unlimited" and auto-detection returns nonsense
        const manual = Number(settings.tokenLimit);
        if (Number.isFinite(manual) && manual > 0) return manual;
        // chat completion APIs (OpenAI/Claude/Gemini etc.) keep their max context
        // in a separate slider — check it first when that API is active
        const mainApi = ctx.mainApi ?? document.getElementById('main_api')?.value;
        if (mainApi === 'openai') {
            const v = readIntFrom('openai_max_context');
            if (v) return v;
        }
        if (typeof ctx.maxContext === 'number' && ctx.maxContext > 0) return ctx.maxContext;
        return readIntFrom('openai_max_context')
            ?? readIntFrom('max_context')
            ?? readIntFrom('max_context_counter');
    }

    async function countTokens(text) {
        try {
            if (typeof ctx.getTokenCountAsync === 'function') {
                return await ctx.getTokenCountAsync(text);
            }
            if (typeof ctx.getTokenCount === 'function') {
                return ctx.getTokenCount(text);
            }
        } catch (e) {
            console.warn(`[${MODULE}] token count failed, using estimate`, e);
        }
        return Math.round(text.length / 3.2); // rough fallback
    }

    // ---------- stats ----------

    function collect() {
        const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
        const total = chat.length;
        const visible = chat.filter(m => m && !m.is_system);
        // first non-hidden message = oldest message still in context.
        // Exact Tavern mesid (0-based): hid 0–295 → firstVisibleId = 296
        const firstIdx = chat.findIndex(m => m && !m.is_system);
        const firstVisibleId = firstIdx >= 0 ? firstIdx : null;
        return { chat, total, firstVisibleId, visible };
    }

    function signatureOf(s) {
        const lastLen = s.total ? String((s.chat[s.total - 1].mes || '').length) : '0';
        return `${s.total}:${s.visible.length}:${s.firstVisibleId}:${lastLen}`;
    }

    // ---------- badge ----------

    function buildBadge() {
        badge = document.createElement('div');
        badge.id = 'ctx-tracker-badge';
        badge.innerHTML = `
            <div class="ctt-accent"></div>
            <div class="ctt-header">
                <span class="ctt-title">context</span>
                <div class="ctt-dot"></div>
            </div>
            <div class="ctt-stats">
                <div class="ctt-stat"><span class="ctt-label" data-ctti="start"></span><span class="ctt-val" data-ctt="first">—</span></div>
                <div class="ctt-stat"><span class="ctt-label" data-ctti="msgs"></span><span class="ctt-val" data-ctt="visible">—</span></div>
                <div class="ctt-stat ctt-tokens-block"><span class="ctt-tokens" data-ctt="tokens">—</span></div>
            </div>
            <div class="ctt-progress"><div class="ctt-progress-fill"></div></div>
            <div class="ctt-resize" title="Resize"></div>
        `;
        document.body.appendChild(badge);
        refreshI18n();
        applyScale();
        initDrag();
        initResize();
        applyPosition();
    }

    function refreshI18n() {
        document.querySelectorAll('[data-ctti]').forEach(el => {
            el.textContent = t(el.getAttribute('data-ctti'));
        });
        const dot = badge?.querySelector('.ctt-dot');
        if (dot) dot.title = t('due');
    }

    function applyScale() {
        const s = Math.min(Math.max(Number(settings.scale) || 1, SCALE_MIN), SCALE_MAX);
        settings.scale = s;
        badge.style.transform = `scale(${s})`;
    }

    function applyPosition() {
        if (!badge) return;
        let x, y;
        if (settings.pos && Number.isFinite(settings.pos.x) && Number.isFinite(settings.pos.y)) {
            ({ x, y } = settings.pos);
        } else {
            const r = badge.getBoundingClientRect();
            x = window.innerWidth - r.width - EDGE_MARGIN - 10;
            y = 70;
        }
        const c = clampPos(x, y);
        badge.style.left = c.x + 'px';
        badge.style.top = c.y + 'px';
    }

    function clampPos(x, y) {
        // getBoundingClientRect respects the current scale
        const r = badge.getBoundingClientRect();
        const w = r.width || 140;
        const h = r.height || 80;
        const maxX = Math.max(EDGE_MARGIN, window.innerWidth - w - EDGE_MARGIN);
        const maxY = Math.max(EDGE_MARGIN, window.innerHeight - h - EDGE_MARGIN);
        return {
            x: Math.min(Math.max(x, EDGE_MARGIN), maxX),
            y: Math.min(Math.max(y, EDGE_MARGIN), maxY),
        };
    }

    function initDrag() {
        let dragging = false;
        let startX = 0, startY = 0, origX = 0, origY = 0;

        badge.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.ctt-resize')) return; // grip has its own handler
            dragging = true;
            badge.setPointerCapture(e.pointerId);
            badge.classList.add('ctt-dragging');
            startX = e.clientX;
            startY = e.clientY;
            const r = badge.getBoundingClientRect();
            origX = r.left;
            origY = r.top;
            e.preventDefault();
        });

        badge.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const c = clampPos(origX + (e.clientX - startX), origY + (e.clientY - startY));
            badge.style.left = c.x + 'px';
            badge.style.top = c.y + 'px';
        });

        const stop = (e) => {
            if (!dragging) return;
            dragging = false;
            badge.classList.remove('ctt-dragging');
            try { badge.releasePointerCapture(e.pointerId); } catch { /* noop */ }
            const r = badge.getBoundingClientRect();
            settings.pos = { x: r.left, y: r.top };
            save();
        };
        badge.addEventListener('pointerup', stop);
        badge.addEventListener('pointercancel', stop);

        window.addEventListener('resize', () => {
            if (badge) applyPosition();
        });
    }

    function initResize() {
        const grip = badge.querySelector('.ctt-resize');
        let resizing = false;
        let startX = 0, startY = 0, startScale = 1;

        grip.addEventListener('pointerdown', (e) => {
            resizing = true;
            grip.setPointerCapture(e.pointerId);
            badge.classList.add('ctt-resizing');
            startX = e.clientX;
            startY = e.clientY;
            startScale = settings.scale || 1;
            e.stopPropagation();
            e.preventDefault();
        });

        grip.addEventListener('pointermove', (e) => {
            if (!resizing) return;
            // diagonal drag = uniform scaling, proportions stay intact
            const delta = ((e.clientX - startX) + (e.clientY - startY)) / 2;
            settings.scale = startScale + delta / 140;
            applyScale();
        });

        const stop = (e) => {
            if (!resizing) return;
            resizing = false;
            badge.classList.remove('ctt-resizing');
            try { grip.releasePointerCapture(e.pointerId); } catch { /* noop */ }
            // after scaling, make sure the badge is still fully on screen
            const r = badge.getBoundingClientRect();
            const c = clampPos(r.left, r.top);
            badge.style.left = c.x + 'px';
            badge.style.top = c.y + 'px';
            settings.pos = { x: c.x, y: c.y };
            save();
        };
        grip.addEventListener('pointerup', stop);
        grip.addEventListener('pointercancel', stop);
    }

    function setText(key, value) {
        const el = badge.querySelector(`[data-ctt="${key}"]`);
        if (el) el.textContent = value;
    }

    // ---------- update ----------

    async function update(force = false) {
        if (!badge) return;

        badge.style.display = settings.enabled ? '' : 'none';
        if (!settings.enabled) return;

        const s = collect();
        const sig = signatureOf(s);
        if (!force && sig === lastSignature) return;
        lastSignature = sig;

        setText('first', s.firstVisibleId === null ? '—' : String(s.firstVisibleId));
        setText('visible', String(s.visible.length));

        // tokens — visible messages only, cached per signature
        const tokensBlock = badge.querySelector('.ctt-tokens-block');
        tokensBlock.style.display = settings.showTokens ? '' : 'none';
        if (settings.showTokens) {
            if (sig !== tokenCacheKey) {
                tokenCacheKey = sig;
                const text = s.visible.map(m => m.mes || '').join('\n');
                const count = await countTokens(text);
                // the chat may have changed during await — don't clobber fresh data
                if (tokenCacheKey === sig) {
                    const max = getMaxContext();
                    tokenText = fmtTokens(count) + (max ? ' / ' + fmtTokens(max) : '');
                    tokenOver = Boolean(max && count > max);
                }
            }
            setText('tokens', tokenText);
            badge.querySelector('.ctt-tokens')?.classList.toggle('ctt-over', tokenOver);
        }
        // context full (tokens over the limit) drives the pulse alarm
        badge.classList.toggle('ctt-full', settings.showTokens && tokenOver);

        // progress toward the summary threshold + "due" dot
        const bar = badge.querySelector('.ctt-progress');
        const fill = badge.querySelector('.ctt-progress-fill');
        const dot = badge.querySelector('.ctt-dot');
        const interval = Number(settings.interval) || 0;

        if (interval > 0 && settings.showProgress) {
            bar.style.display = '';
            const ratio = Math.min(s.visible.length / interval, 1);
            fill.style.width = (ratio * 100).toFixed(1) + '%';
            dot.classList.toggle('ctt-due', s.visible.length >= interval);
        } else {
            bar.style.display = 'none';
            dot.classList.remove('ctt-due');
        }
    }

    function scheduleUpdate() {
        clearTimeout(scheduleUpdate._t);
        scheduleUpdate._t = setTimeout(() => update(), 150);
    }

    // ---------- settings panel ----------

    function addSettingsPanel() {
        const html = `
        <div class="context-tracker-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Context Tracker</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label">
                        <input type="checkbox" id="ctt_enabled">
                        <span data-ctti="s_show"></span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="ctt_show_tokens">
                        <span data-ctti="s_tokens"></span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="ctt_show_progress">
                        <span data-ctti="s_progress"></span>
                    </label>
                    <label for="ctt_interval" data-ctti="s_interval"></label>
                    <input type="number" id="ctt_interval" class="text_pole" min="0" step="10">
                    <label for="ctt_token_limit" data-ctti="s_token_limit"></label>
                    <input type="number" id="ctt_token_limit" class="text_pole" min="0" step="1000">
                    <label for="ctt_lang" data-ctti="s_lang"></label>
                    <select id="ctt_lang" class="text_pole">
                        <option value="en">English</option>
                        <option value="ru">Русский</option>
                    </select>
                    <div class="menu_button" id="ctt_reset_pos">
                        <span data-ctti="s_reset"></span>
                    </div>
                </div>
            </div>
        </div>`;

        const target = document.getElementById('extensions_settings2')
            || document.getElementById('extensions_settings');
        if (!target) {
            console.warn(`[${MODULE}] extensions settings container not found`);
            return;
        }
        target.insertAdjacentHTML('beforeend', html);

        const $enabled = document.getElementById('ctt_enabled');
        const $tokens = document.getElementById('ctt_show_tokens');
        const $progress = document.getElementById('ctt_show_progress');
        const $interval = document.getElementById('ctt_interval');
        const $tokenLimit = document.getElementById('ctt_token_limit');
        const $lang = document.getElementById('ctt_lang');
        const $reset = document.getElementById('ctt_reset_pos');

        $enabled.checked = settings.enabled;
        $tokens.checked = settings.showTokens;
        $progress.checked = settings.showProgress;
        $interval.value = settings.interval;
        $tokenLimit.value = settings.tokenLimit;
        $lang.value = I18N[settings.lang] ? settings.lang : 'en';

        $enabled.addEventListener('change', () => { settings.enabled = $enabled.checked; save(); update(true); });
        $tokens.addEventListener('change', () => { settings.showTokens = $tokens.checked; save(); update(true); });
        $progress.addEventListener('change', () => { settings.showProgress = $progress.checked; save(); update(true); });
        $interval.addEventListener('input', () => {
            const v = parseInt($interval.value, 10);
            settings.interval = Number.isFinite(v) && v >= 0 ? v : 0;
            save();
            update(true);
        });
        $tokenLimit.addEventListener('input', () => {
            const v = parseInt($tokenLimit.value, 10);
            settings.tokenLimit = Number.isFinite(v) && v >= 0 ? v : 0;
            tokenCacheKey = ''; // force the denominator to refresh
            save();
            update(true);
        });
        $lang.addEventListener('change', () => {
            settings.lang = $lang.value;
            save();
            refreshI18n();
        });
        $reset.addEventListener('click', () => {
            settings.pos = null;
            settings.scale = 1;
            applyScale();
            applyPosition();
            save();
        });

        refreshI18n();
    }

    // ---------- events ----------

    function bindEvents() {
        const et = ctx.eventTypes || {};
        const names = [
            et.CHAT_CHANGED,
            et.MESSAGE_SENT,
            et.MESSAGE_RECEIVED,
            et.MESSAGE_DELETED,
            et.MESSAGE_EDITED,
            et.MESSAGE_SWIPED,
            et.MESSAGE_UPDATED,
            et.GENERATION_ENDED,
        ].filter(Boolean);
        for (const name of names) {
            ctx.eventSource.on(name, scheduleUpdate);
        }

        // safety net: /hide doesn't always emit events — a cheap signature
        // check every 2 s catches anything the events missed
        pollTimer = setInterval(() => update(), 2000);
    }

    // ---------- init ----------

    jQuery(async () => {
        try {
            ctx = SillyTavern.getContext();
        } catch (e) {
            console.error(`[${MODULE}] SillyTavern context is not available`, e);
            return;
        }
        settings = getSettings();
        buildBadge();
        addSettingsPanel();
        bindEvents();
        update(true);
    });
})();
