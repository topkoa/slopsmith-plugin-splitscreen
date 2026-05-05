(function () {
    'use strict';

    /* ======================================================================
     *  Split Screen Plugin
     *  Creates 2-4 independent highway panels, each showing a different
     *  arrangement from the same song. All panels sync to the shared
     *  <audio> element.
     * ====================================================================== */

    const LAYOUTS = {
        'top-bottom': { panels: 2, style: 'flex-col' },
        'left-right': { panels: 2, style: 'flex-row' },
        'quad':       { panels: 4, style: 'grid-2x2' },
    };

    const OFF_CLASS = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition';
    const ON_CLASS  = 'px-3 py-1.5 bg-blue-900/50 hover:bg-blue-900/60 rounded-lg text-xs text-blue-300 transition';
    const STORAGE_KEY = 'splitscreenPanelPrefs';
    const LYRICS_VALUE       = '__lyrics__';
    const JUMPING_TAB_VALUE  = '__jumping_tab__';
    const VIZ_PREFIX         = '__viz__';
    const DETECT_CHANNEL_CYCLE  = ['mono', 'left', 'right'];
    const DETECT_CHANNEL_LABELS = { mono: 'M', left: 'L', right: 'R' };

    let active = false;
    let controlsHidden = false;
    let layout = localStorage.getItem('splitscreenLayout') || 'top-bottom';
    let autoReactivate = localStorage.getItem('splitscreenAutoReactivate') === 'true';
    let alwaysSplit = localStorage.getItem('splitscreenAlwaysSplit') === 'true';
    let panels = [];       // { hw, canvas, ws, arrIndex, controls }
    let wrap = null;
    let currentFilename = null;
    let arrangements = []; // arrangement list from song_info
    let vizPlugins   = []; // {id, name, ...} — type=visualization plugins from /api/plugins
    let _starting    = false; // re-entrancy guard for startSplitScreen

    // Focus model — which panel currently "owns" multi-instance plugin
    // resources (MIDI input routing for piano, settings-gear placement, etc).
    // Defaults to panel 0; clicking another panel transfers focus.
    let focusedPanelIdx = 0;
    const focusListeners = new Set();
    function _focusedPanel() {
        if (!active || !panels.length) return null;
        if (focusedPanelIdx >= panels.length) focusedPanelIdx = 0;
        return panels[focusedPanelIdx];
    }
    function _emitFocusChange() {
        for (const fn of focusListeners) {
            try { fn(); } catch (_) { /* listener errors must not break peers */ }
        }
    }
    function _applyFocusBorder() {
        for (let i = 0; i < panels.length; i++) {
            panels[i].panelDiv.style.borderColor = i === focusedPanelIdx ? '#4080e0' : '#333';
        }
    }
    function _setFocusedPanel(idx) {
        if (idx < 0 || idx >= panels.length) return;
        if (idx === focusedPanelIdx) return;
        focusedPanelIdx = idx;
        _applyFocusBorder();
        _emitFocusChange();
    }
    function _findPanelIdxByCanvas(canvas) {
        if (!canvas) return -1;
        for (let i = 0; i < panels.length; i++) {
            if (panels[i].canvas === canvas) return i;
        }
        return -1;
    }

    async function fetchVizPlugins() {
        try {
            const resp = await fetch('/api/plugins');
            const all  = await resp.json();
            // Store metadata for all viz plugins; factory presence is checked at
            // populateSelect() time (not at fetch time), so the window['slopsmithViz_*']
            // globals are evaluated when the dropdown is first built.
            vizPlugins = (all || []).filter(p => p?.type === 'visualization');
        } catch (_) {
            // /api/plugins unavailable — fall back to scanning window for any
            // slopsmithViz_* factories that are already loaded so viz options
            // remain available even when the plugin registry can't be fetched
            // (preserves prior behaviour where 3D Highway was discoverable
            // by direct factory check alone).
            vizPlugins = Object.keys(window)
                .filter(k => k.startsWith('slopsmithViz_') && typeof window[k] === 'function')
                .map(k => ({ id: k.slice('slopsmithViz_'.length), name: k.slice('slopsmithViz_'.length) }));
        }
    }
    // Keep the promise so startSplitScreen / loadSongInFollower can await it —
    // panels are never populated before the list is ready even on a fast first
    // interaction.
    const _vizPluginsReady = fetchVizPlugins();

    // ══════════════════════════════════════════════════════════════════════
    //  Pop-out / follower-mode (multi-monitor support).
    //
    //  When the user clicks "Pop Out" on a panel in the main window, we open
    //  this same slopsmith app in a new browser window with `ssFollower=1`
    //  and a serialized panel config in URL params. The popup boots normally
    //  (loads app.js + all plugins) but the splitscreen IIFE detects the
    //  follower flag and instead of running the usual auto-Split UI, it
    //  builds a single full-window panel slaved to the main window's audio
    //  via BroadcastChannel('slopsmith-ss').
    //
    //  popups: in the main window, tracks every popup we've spawned so we
    //  can re-instate the panel when the popup posts a `docked` message.
    //  Keyed by popupId. { panelIdx, originalConfig }.
    //
    //  FOLLOWER: parsed once on script load. Truthy in the popup window
    //  only. Carries the panel config received from the opener.
    // ══════════════════════════════════════════════════════════════════════
    const popups = new Map();
    const FOLLOWER = (function () {
        try {
            const params = new URLSearchParams(window.location.search);
            if (params.get('ssFollower') !== '1') return null;
            const cfg = {
                popupId:     params.get('popupId') || '',
                filename:    params.get('filename') || '',
                arrangement: parseInt(params.get('arrangement'), 10) || 0,
                mode:        params.get('mode') || '2d',
                inverted:    params.get('inverted') === '1',
                mastery:     parseFloat(params.get('mastery')),
            };
            if (!cfg.filename) return null;
            return cfg;
        } catch (_) {
            return null;
        }
    })();
    const SS_CHANNEL_NAME = 'slopsmith-ss';
    let ssChannel = null;       // shared BroadcastChannel (lazily opened)
    function _ssChannel() {
        if (!ssChannel && typeof BroadcastChannel === 'function') {
            ssChannel = new BroadcastChannel(SS_CHANNEL_NAME);
        }
        return ssChannel;
    }

    // Public API for plugins that want per-panel state (e.g. 3D Highway reads
    // its per-panel palette/background settings via localStorage keys keyed
    // by panel index, and calls panelIndexFor(canvas) to resolve which panel
    // a canvas belongs to).
    window.slopsmithSplitscreen = {
        // Active state — false during normal main-player operation. Plugins
        // gate their splitscreen-aware code paths on this so they fall back
        // to the single-instance main-player path when the user isn't split.
        isActive() { return active; },

        // Identify a panel by the highway canvas its renderer received in init().
        panelIndexFor(canvas) {
            if (!active) return null;
            const i = _findPanelIdxByCanvas(canvas);
            return i === -1 ? null : i;
        },

        // Container element for per-panel chrome/overlays. Plugins that mount
        // their own DOM (piano overlay canvas, drums HUD) anchor against this
        // so the overlay sizes to the panel rect, not the whole #player.
        panelChromeFor(canvas) {
            if (!active) return null;
            const i = _findPanelIdxByCanvas(canvas);
            return i === -1 ? null : panels[i].panelDiv;
        },

        // Anchor for per-panel settings buttons (e.g. piano gear button).
        // The mini control bar is the natural place — already visible, already
        // panel-scoped, already used for invert/lyrics/tab/detect toggles.
        settingsAnchorFor(canvas) {
            if (!active) return null;
            const i = _findPanelIdxByCanvas(canvas);
            return i === -1 ? null : panels[i].bar;
        },

        // True when this canvas's panel is the focused one. Plugins use this
        // to route shared input (e.g. MIDI keyboard) to a single instance.
        isCanvasFocused(canvas) {
            if (!active) return true; // no panels => main-player single instance
            const i = _findPanelIdxByCanvas(canvas);
            if (i === -1) return false;
            if (focusedPanelIdx >= panels.length) focusedPanelIdx = 0;
            return i === focusedPanelIdx;
        },

        onFocusChange(fn) {
            if (typeof fn === 'function') focusListeners.add(fn);
        },
        offFocusChange(fn) {
            focusListeners.delete(fn);
        },
    };

    // 3D Highway palette IDs. Mirrors the PALETTES registry in the 3dhighway
    // plugin's screen.js — kept as a plain list here to avoid a runtime
    // dependency on the plugin being loaded.
    const H3D_PALETTES = [
        { id: 'default', label: 'Default' },
        { id: 'neon',    label: 'Neon' },
        { id: 'pastel',  label: 'Pastel' },
    ];

    // ── Settings sync ──
    const layoutSelect = document.getElementById('splitscreen-default-layout');
    if (layoutSelect) {
        layoutSelect.value = layout;
        layoutSelect.addEventListener('change', () => {
            layout = layoutSelect.value;
            localStorage.setItem('splitscreenLayout', layout);
            if (active) rebuildLayout();
        });
    }

    const autoReactivateCheckbox = document.getElementById('splitscreen-auto-reactivate');
    if (autoReactivateCheckbox) {
        autoReactivateCheckbox.checked = autoReactivate;
        autoReactivateCheckbox.addEventListener('change', () => {
            autoReactivate = autoReactivateCheckbox.checked;
            localStorage.setItem('splitscreenAutoReactivate', autoReactivate);
        });
    }

    const alwaysSplitCheckbox = document.getElementById('splitscreen-always-split');
    if (alwaysSplitCheckbox) {
        alwaysSplitCheckbox.checked = alwaysSplit;
        alwaysSplitCheckbox.addEventListener('change', () => {
            alwaysSplit = alwaysSplitCheckbox.checked;
            localStorage.setItem('splitscreenAlwaysSplit', alwaysSplit);
        });
    }

    // ── Panel preference persistence ──
    function savePanelPrefs() {
        const prefs = panels.map(p => ({
            arrName: p.jumpingTabMode
                ? JUMPING_TAB_VALUE + ':' + (arrangements[p.arrIndex]?.name || '')
                : p.vizMode
                ? VIZ_PREFIX + ':' + p.vizMode + ':' + (arrangements[p.arrIndex]?.name || '')
                : p.lyricsMode ? LYRICS_VALUE : (arrangements[p.arrIndex]?.name || ''),
            lyrics: typeof p.hw.getLyricsVisible === 'function' ? p.hw.getLyricsVisible() : true,
            inverted: p.hw.getInverted(),
            detectChannel: p.detectChannel || 'mono',
            barHidden: p.bar.style.display === 'none',
            mastery: p.hw.getMastery(),
        }));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    }

    function loadPanelPrefs() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY)) || null;
        } catch (_) {
            return null;
        }
    }

    function migratePanelPrefs(prefs) {
        if (!Array.isArray(prefs)) return prefs;
        return prefs.map(p => {
            if (p?.arrName?.startsWith('__3d_highway__:')) {
                return { ...p, arrName: VIZ_PREFIX + ':highway_3d:' + p.arrName.slice('__3d_highway__:'.length) };
            }
            return p;
        });
    }

    function resolveArrIndex(arrName) {
        if (!arrName || arrName === LYRICS_VALUE || arrName.startsWith(JUMPING_TAB_VALUE) || arrName.startsWith(VIZ_PREFIX + ':')) return -1;
        const lower = arrName.toLowerCase();
        for (let i = 0; i < arrangements.length; i++) {
            if ((arrangements[i].name || '').toLowerCase() === lower) return i;
        }
        return -1;
    }

    // ── Helpers ──
    function getWsUrl(filename, arrangement) {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const arrParam = arrangement !== undefined ? `?arrangement=${arrangement}` : '';
        return `${proto}//${location.host}/ws/highway/${filename}${arrParam}`;
    }

    function getDefaultArrangements(count) {
        // Assign arrangements intelligently: lead, rhythm, bass, then wrap
        const defaults = [];
        const byName = {};
        arrangements.forEach((a, i) => {
            const n = (a.name || '').toLowerCase();
            if (n.includes('lead') && !byName.lead) byName.lead = i;
            else if (n.includes('rhythm') && !byName.rhythm) byName.rhythm = i;
            else if (n.includes('bass') && !byName.bass) byName.bass = i;
        });
        const order = [byName.lead, byName.rhythm, byName.bass].filter(i => i !== undefined);
        // Fill remaining with whatever's available
        for (let i = 0; i < arrangements.length; i++) {
            if (!order.includes(i)) order.push(i);
        }
        for (let i = 0; i < count; i++) {
            defaults.push(order[i % order.length]);
        }
        return defaults;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Lyrics-only pane renderer
    // ══════════════════════════════════════════════════════════════════════

    function createLyricsPane(container) {
        const el = document.createElement('div');
        el.className = 'splitscreen-lyrics-pane';
        el.style.cssText =
            'position:absolute;top:0;left:0;right:0;bottom:0;' +
            'display:flex;flex-direction:column;justify-content:center;align-items:center;' +
            'background:#08080e;padding:24px;overflow:hidden;';
        container.appendChild(el);

        let lyrics = [];
        let lines = null;
        let ws = null;
        let raf = null;

        function parseLyrics(data) {
            lyrics = data;
            lines = null;
            if (!lyrics.length) return;

            const result = [];
            let line = null, word = null;

            const flushWord = () => {
                if (word && word.length) line.words.push(word);
                word = null;
            };
            const flushLine = () => {
                flushWord();
                if (line && line.words.length) result.push(line);
                line = null;
            };

            for (let i = 0; i < lyrics.length; i++) {
                const l = lyrics[i];
                const raw = l.w || '';
                const endsLine = raw.endsWith('+');
                const continuesWord = raw.endsWith('-');

                if (line && i > 0) {
                    const prev = lyrics[i - 1];
                    if (l.t - (prev.t + prev.d) > 4.0) flushLine();
                }

                if (!line) line = { words: [], start: l.t, end: l.t + l.d };
                if (!word) word = [];

                word.push(l);
                line.end = Math.max(line.end, l.t + l.d);

                if (!continuesWord) flushWord();
                if (endsLine) flushLine();
            }
            flushLine();
            lines = result;
        }

        function syllableText(s) {
            const t = s.w || '';
            return (t.endsWith('+') || t.endsWith('-')) ? t.slice(0, -1) : t;
        }

        function renderLine(lineData, currentTime) {
            const frag = document.createDocumentFragment();
            for (const word of lineData.words) {
                for (const syl of word) {
                    const span = document.createElement('span');
                    span.textContent = syllableText(syl);
                    const active = currentTime >= syl.t && currentTime < syl.t + syl.d;
                    const past = currentTime >= syl.t + syl.d;
                    if (active) {
                        span.style.color = '#60a0ff';
                        span.style.textShadow = '0 0 12px rgba(96,160,255,0.5)';
                    } else if (past) {
                        span.style.color = '#9ca3af';
                    } else {
                        span.style.color = '#555';
                    }
                    frag.appendChild(span);
                }
                const space = document.createDocumentFragment();
                space.appendChild(document.createTextNode(' '));
                frag.appendChild(space);
            }
            return frag;
        }

        function render() {
            raf = requestAnimationFrame(render);
            if (!lines || !lines.length) {
                if (!el.dataset.empty) {
                    el.innerHTML = '<span style="color:#555;font-style:italic">No lyrics</span>';
                    el.dataset.empty = '1';
                }
                return;
            }
            delete el.dataset.empty;

            const audio = document.getElementById('audio');
            const t = audio ? audio.currentTime : 0;

            let currentIdx = -1;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].start <= t) currentIdx = i;
                else break;
            }
            if (currentIdx === -1) {
                if (lines[0].start - t > 3.0) {
                    el.innerHTML = '';
                    return;
                }
                currentIdx = 0;
            }

            const currentLine = lines[currentIdx];
            const nextLine = lines[currentIdx + 1] || null;
            const gapToNext = nextLine ? (nextLine.start - currentLine.end) : Infinity;

            if (t > currentLine.end + 1.0 && gapToNext > 4.0) {
                el.innerHTML = '';
                return;
            }

            el.innerHTML = '';

            const curDiv = document.createElement('div');
            curDiv.style.cssText = 'font-size:clamp(20px, 4vw, 48px);font-weight:600;text-align:center;line-height:1.4;transition:opacity 0.3s;';
            curDiv.appendChild(renderLine(currentLine, t));
            el.appendChild(curDiv);

            if (nextLine && gapToNext <= 4.0) {
                const nextDiv = document.createElement('div');
                nextDiv.style.cssText = 'font-size:clamp(16px, 3vw, 36px);font-weight:400;text-align:center;line-height:1.4;margin-top:16px;color:#444;';
                nextDiv.appendChild(renderLine(nextLine, t));
                el.appendChild(nextDiv);
            }
        }

        function connect(filename, arrangement) {
            destroy();
            ws = new WebSocket(getWsUrl(filename, arrangement));
            ws.onmessage = (ev) => {
                const msg = JSON.parse(ev.data);
                if (msg.type === 'lyrics') parseLyrics(msg.data);
            };
            ws.onerror = () => {};
            ws.onclose = () => { ws = null; };
            raf = requestAnimationFrame(render);
        }

        function destroy() {
            if (raf) { cancelAnimationFrame(raf); raf = null; }
            if (ws) { ws.close(); ws = null; }
            lyrics = [];
            lines = null;
            el.innerHTML = '';
        }

        return { el, connect, destroy };
    }

    // ══════════════════════════════════════════════════════════════════════

    // ── Layout ──
    function createWrap() {
        if (wrap) wrap.remove();
        const player = document.getElementById('player');
        wrap = document.createElement('div');
        wrap.id = 'splitscreen-wrap';
        const controls = document.getElementById('player-controls');
        player.insertBefore(wrap, controls);
        return wrap;
    }

    function applyLayoutStyle(container, layoutKey) {
        // Note: bottom is set dynamically by sizeCanvases() to leave room for global controls
        container.style.cssText =
            'position:absolute;top:0;left:0;right:0;z-index:3;display:flex;';
        if (layoutKey === 'top-bottom') {
            container.style.flexDirection = 'column';
        } else if (layoutKey === 'left-right') {
            container.style.flexDirection = 'row';
        } else {
            container.style.flexDirection = 'row';
            container.style.flexWrap = 'wrap';
        }
    }

    function createPanel(index, container, layoutKey) {
        const panelDiv = document.createElement('div');
        panelDiv.className = 'splitscreen-panel';
        panelDiv.style.cssText = 'position:relative;overflow:hidden;box-sizing:border-box;border:1px solid #333;';

        if (layoutKey === 'quad') {
            panelDiv.style.width = '50%';
            panelDiv.style.height = '50%';
        } else if (layoutKey === 'left-right') {
            panelDiv.style.width = '50%';
            panelDiv.style.height = '100%';
        } else if (layoutKey === 'follower') {
            panelDiv.style.width = '100%';
            panelDiv.style.height = '100%';
        } else {
            panelDiv.style.width = '100%';
            panelDiv.style.height = '50%';
        }

        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'width:100%;height:100%;display:block;';
        panelDiv.appendChild(canvas);

        // Mini control bar
        const bar = document.createElement('div');
        bar.style.cssText =
            'position:absolute;bottom:0;left:0;right:0;' +
            'display:flex;align-items:center;gap:10px;padding:4px 8px;' +
            'flex-wrap:nowrap;overflow:hidden;' +
            'background:rgba(8,8,16,0.85);z-index:7;';

        // Panel label
        const label = document.createElement('span');
        label.style.cssText = 'font-size:11px;color:#888;font-weight:bold;min-width:16px;';
        label.textContent = `P${index + 1}`;
        bar.appendChild(label);

        // Arrangement selector
        const select = document.createElement('select');
        select.style.cssText =
            'background:#1a1a2e;border:1px solid #333;border-radius:4px;' +
            'padding:2px 4px;font-size:11px;color:#ccc;outline:none;max-width:120px;';
        bar.appendChild(select);

        // Arrangement name display
        const arrName = document.createElement('span');
        arrName.style.cssText = 'font-size:11px;color:#6b7280;';
        bar.appendChild(arrName);

        const makeToggleBtn = (label, marginLeft) => {
            const b = document.createElement('button');
            b.style.cssText =
                (marginLeft ? 'margin-left:' + marginLeft + ';' : '') +
                'padding:2px 8px;border-radius:4px;font-size:10px;' +
                'border:1px solid #333;cursor:pointer;background:#1a1a2e;color:#9ca3af;';
            b.textContent = label;
            return b;
        };
        const styleToggle = (btn, on, onColor) => {
            btn.style.background = on ? onColor : '#1a1a2e';
            btn.style.color = on ? '#fff' : '#9ca3af';
        };

        const invertBtn = makeToggleBtn('Invert');
        const updateInvertStyle = (on) => styleToggle(invertBtn, on, '#4c1d95');
        updateInvertStyle(false);
        bar.appendChild(invertBtn);

        const lyricsBtn = makeToggleBtn('Lyrics');
        const updateLyricsStyle = (on) => styleToggle(lyricsBtn, on, '#065f46');
        bar.appendChild(lyricsBtn);

        const tabBtn = makeToggleBtn('Tab');
        const updateTabStyle = (on) => styleToggle(tabBtn, on, '#1e40af');
        updateTabStyle(false);
        bar.appendChild(tabBtn);

        const detectBtn = makeToggleBtn('Detect');
        const updateDetectStyle = (on) => styleToggle(detectBtn, on, '#14532d');
        updateDetectStyle(false);
        bar.appendChild(detectBtn);

        const channelBtn = makeToggleBtn('M');
        channelBtn.title = 'Audio channel: Mono / Left / Right';
        bar.appendChild(channelBtn);

        const viewBtn = makeToggleBtn('CLS');
        viewBtn.title = 'Cycle 3D view style';
        viewBtn.style.display = 'none';
        bar.appendChild(viewBtn);

        const paletteSelect = document.createElement('select');
        paletteSelect.title = '3D Highway palette (this panel only)';
        paletteSelect.style.cssText =
            'background:#1a1a2e;border:1px solid #333;border-radius:4px;' +
            'padding:2px 4px;font-size:10px;color:#ccc;outline:none;display:none;';
        for (const p of H3D_PALETTES) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.label;
            paletteSelect.appendChild(opt);
        }
        bar.appendChild(paletteSelect);

        // Per-panel camera-smoothing slider (3D-only). Mirrors the plugin's
        // global slider in settings.html but writes the per-panel localStorage
        // key so this panel can have its own feel without touching the global.
        const camSmoothingWrap = document.createElement('span');
        camSmoothingWrap.title = '3D camera smoothing (this panel only)';
        camSmoothingWrap.style.cssText =
            'display:none;align-items:center;gap:4px;white-space:nowrap;';
        const camSmoothingHeading = document.createElement('span');
        camSmoothingHeading.style.cssText = 'font-size:10px;color:#6b7280;';
        camSmoothingHeading.textContent = 'Cam';
        const camSmoothingSlider = document.createElement('input');
        camSmoothingSlider.type = 'range';
        camSmoothingSlider.min = '0';
        camSmoothingSlider.max = '1';
        camSmoothingSlider.step = '0.05';
        camSmoothingSlider.value = '0.5';
        camSmoothingSlider.style.cssText = 'width:70px;';
        const camSmoothingLabel = document.createElement('span');
        camSmoothingLabel.style.cssText = 'font-size:10px;color:#9ca3af;width:24px;text-align:right;';
        camSmoothingLabel.textContent = '0.50';
        camSmoothingWrap.appendChild(camSmoothingHeading);
        camSmoothingWrap.appendChild(camSmoothingSlider);
        camSmoothingWrap.appendChild(camSmoothingLabel);
        bar.appendChild(camSmoothingWrap);

        const masteryHeading = document.createElement('span');
        masteryHeading.style.cssText = 'font-size:10px;color:#6b7280;white-space:nowrap;';
        masteryHeading.textContent = 'Mastery';
        bar.appendChild(masteryHeading);

        const masterySlider = document.createElement('input');
        masterySlider.type = 'range';
        masterySlider.min = '0';
        masterySlider.max = '100';
        masterySlider.step = '5';
        masterySlider.value = '100';
        masterySlider.disabled = true;
        masterySlider.style.cssText = 'width:52px;accent-color:#4080e0;cursor:not-allowed;opacity:0.4;';
        masterySlider.title = 'Master difficulty (requires multi-level chart)';
        bar.appendChild(masterySlider);

        const masteryLabel = document.createElement('span');
        masteryLabel.style.cssText = 'font-size:10px;color:#6b7280;min-width:26px;';
        masteryLabel.textContent = '—';
        bar.appendChild(masteryLabel);

        // Pop Out / Dock — visibility flips by mode (FOLLOWER => Dock; main => Pop Out).
        // The actual click handlers are wired in initPanel() so they have access
        // to the panel object via closure. We append at the end of the bar
        // (no `margin-left:auto` because barToggleBtn lives absolute-positioned
        // at bottom:0;right:0 and the auto-margin would collide with it).
        const popOutBtn = document.createElement('button');
        popOutBtn.style.cssText =
            'padding:2px 6px;border-radius:4px;font-size:10px;' +
            'border:1px solid #333;cursor:pointer;background:#1a1a2e;color:#9ca3af;' +
            'white-space:nowrap;';
        if (FOLLOWER) {
            popOutBtn.textContent = '⇲ Dock';
            popOutBtn.title = 'Return this panel to the main window';
        } else {
            popOutBtn.textContent = '⇱ Pop';
            popOutBtn.title = 'Open this panel in a new window';
        }
        bar.appendChild(popOutBtn);

        panelDiv.appendChild(bar);

        const barToggleBtn = document.createElement('button');
        barToggleBtn.style.cssText =
            'position:absolute;bottom:0;right:0;z-index:8;' +
            'display:flex;align-items:center;justify-content:center;' +
            'padding:2px 6px;border-radius:4px 0 0 0;cursor:pointer;' +
            'background:rgba(64,128,224,0.85);border:none;' +
            'font-size:10px;color:#fff;line-height:1;';
        barToggleBtn.textContent = '▾ Bar';
        barToggleBtn.title = 'Hide panel controls';
        panelDiv.appendChild(barToggleBtn);

        // Click-to-focus. Pointerdown (capture) so it fires before any inner
        // control swallows the event. Resolves the panel by index at fire
        // time — `panels` is rebuilt by rebuildLayout, so the closure can't
        // capture a stable panel reference here.
        panelDiv.addEventListener('pointerdown', () => {
            const i = panels.findIndex(p => p.panelDiv === panelDiv);
            if (i !== -1) _setFocusedPanel(i);
        }, true);

        container.appendChild(panelDiv);

        return {
            panelDiv, canvas, bar, barToggleBtn, select, arrName,
            invertBtn, updateInvertStyle,
            lyricsBtn, updateLyricsStyle,
            tabBtn, updateTabStyle,
            detectBtn, updateDetectStyle,
            channelBtn, viewBtn,
            paletteSelect,
            camSmoothingWrap, camSmoothingSlider, camSmoothingLabel,
            masteryHeading, masterySlider, masteryLabel,
            popOutBtn,
        };
    }

    function sizeCanvases() {
        if (!wrap || !panels.length) return;
        const controls = document.getElementById('player-controls');
        const controlsH = controls ? controls.offsetHeight : 50;
        // Make room for top-anchored siblings inside #player (e.g. the Section
        // Map plugin's bar at top:0 z-index:5) so panels don't render under them.
        const sm = document.getElementById('section-map');
        const topOffset = sm ? sm.offsetHeight : 0;
        wrap.style.top = topOffset + 'px';
        wrap.style.bottom = controlsH + 'px';
        for (const p of panels) {
            if (p.jumpingTabMode && p.jumpingTabPane) {
                p.jumpingTabPane.resize();
            } else if (!p.lyricsMode) {
                p.hw.resize();
            }
        }
    }

    // ── Highway re-creation (fixes issue #22: charts mix on mid-song arrangement switch) ──
    // hw.reconnect() / hw.connect() in core close+reopen the WS, but the OLD WS's
    // onmessage handler is bound with a closure that still references the same
    // outer-scope `notes`/`chords` arrays. Pending messages from the old socket
    // can fire after the arrays are cleared, leaking the previous chart's data
    // into the new arrangement. Replacing the highway instance entirely orphans
    // the old closure so late messages can't pollute the new chart.
    function recreatePanelHighway(panel) {
        const old = panel.hw;
        const inverted = old.getInverted();
        const lyricsVisible = typeof old.getLyricsVisible === 'function' ? old.getLyricsVisible() : true;
        const mastery = old.getMastery();
        old.stop();

        const hw = createHighway();
        hw.resize = function () {
            const c = panel.canvas;
            if (!c) return;
            const rect = panel.panelDiv.getBoundingClientRect();
            const barH = panel.bar.style.display === 'none' ? 0 : (panel.bar.offsetHeight || 28);
            const w = rect.width;
            const h = Math.max(0, rect.height - barH);
            c.style.width = w + 'px';
            c.style.height = h + 'px';
            const scale = hw.getRenderScale();
            c.width = Math.round(w * scale);
            c.height = Math.round(h * scale);
        };
        hw.init(panel.canvas);
        hw.setInverted(inverted);
        if (typeof hw.setLyricsVisible === 'function') hw.setLyricsVisible(lyricsVisible);
        hw.setMastery(mastery);
        hw.resize();
        panel.hw = hw;
    }

    // ── Per-panel 3D Highway palette ──
    // The 3D plugin reads h3d_bg_panel<N>_palette from localStorage on every
    // change event. Writing the per-panel key + re-firing the global setter
    // (with the global's existing value) triggers _bgEmitChange, which causes
    // each running 3D renderer to re-read settings — picking up the panel
    // override we just wrote. No global state changes hands.
    function _readPanelPalette(panelIdx) {
        try {
            return localStorage.getItem('h3d_bg_panel' + panelIdx + '_palette')
                || localStorage.getItem('h3d_bg_palette')
                || 'default';
        } catch (_) {
            return 'default';
        }
    }
    function _readPanelCameraSmoothing(panelIdx) {
        try {
            const stored = localStorage.getItem('h3d_bg_panel' + panelIdx + '_cameraSmoothing')
                ?? localStorage.getItem('h3d_bg_cameraSmoothing');
            const n = stored == null ? 0.5 : parseFloat(stored);
            return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
        } catch (_) {
            return 0.5;
        }
    }
    function _writePanelCameraSmoothing(panelIdx, value) {
        const v = String(value);
        try { localStorage.setItem('h3d_bg_panel' + panelIdx + '_cameraSmoothing', v); } catch (_) {}
        // Re-fire the global setter with its existing value so the 3D
        // plugin's _bgEmitChange runs and each renderer re-reads its
        // settings — picking up the per-panel override we just wrote.
        // No global state changes hands.
        if (typeof window.h3dBgSetCameraSmoothing === 'function') {
            const cur = (() => {
                try { return localStorage.getItem('h3d_bg_cameraSmoothing') || '0.5'; }
                catch (_) { return '0.5'; }
            })();
            window.h3dBgSetCameraSmoothing(cur);
        }
    }
    function _writePanelPalette(panelIdx, value) {
        try { localStorage.setItem('h3d_bg_panel' + panelIdx + '_palette', value); } catch (_) {}
        if (typeof window.h3dBgSetPalette === 'function') {
            const cur = (() => {
                try { return localStorage.getItem('h3d_bg_palette') || 'default'; }
                catch (_) { return 'default'; }
            })();
            window.h3dBgSetPalette(cur);
        }
    }
    function showPaletteSelect(panel) {
        const idx = panels.indexOf(panel);
        if (idx === -1) return;
        if (typeof window.slopsmithViz_highway_3d !== 'function') return;
        panel.paletteSelect.value = _readPanelPalette(idx);
        panel.paletteSelect.style.display = '';
    }
    function hidePaletteSelect(panel) {
        panel.paletteSelect.style.display = 'none';
    }

    function showCamSmoothing(panel) {
        const idx = panels.indexOf(panel);
        if (idx === -1) return;
        if (typeof window.slopsmithViz_highway_3d !== 'function') return;
        const v = _readPanelCameraSmoothing(idx);
        panel.camSmoothingSlider.value = String(v);
        panel.camSmoothingLabel.textContent = v.toFixed(2);
        panel.camSmoothingWrap.style.display = '';
    }
    function hideCamSmoothing(panel) {
        panel.camSmoothingWrap.style.display = 'none';
    }

    // ── Mastery slider helpers ──
    function hookPanelReady(panel) {
        panel.masterySlider.disabled = true;
        panel.masterySlider.style.opacity = '0.4';
        panel.masterySlider.style.cursor = 'not-allowed';
        panel.masteryLabel.textContent = '—';
        const prev = panel.hw._onReady;
        panel.hw._onReady = () => {
            if (prev) prev();
            const has = panel.hw.hasPhraseData();
            panel.masterySlider.disabled = !has;
            panel.masterySlider.style.opacity = has ? '1' : '0.4';
            panel.masterySlider.style.cursor = has ? 'pointer' : 'not-allowed';
            panel.masteryLabel.textContent = has ? panel.masterySlider.value + '%' : '—';
        };
    }

    // ── Panel lifecycle ──
    function populateSelect(panel, arrIndex) {
        panel.select.innerHTML = '';
        arrangements.forEach((a, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = a.name || `Arr ${i}`;
            if (i === arrIndex && !panel.lyricsMode) opt.selected = true;
            panel.select.appendChild(opt);
        });
        const lyricsOpt = document.createElement('option');
        lyricsOpt.value = LYRICS_VALUE;
        lyricsOpt.textContent = 'Lyrics';
        if (panel.lyricsMode) lyricsOpt.selected = true;
        panel.select.appendChild(lyricsOpt);

        if (typeof window.createJumpingTabPane === 'function') {
            arrangements.forEach((a, i) => {
                const jtOpt = document.createElement('option');
                jtOpt.value = JUMPING_TAB_VALUE + ':' + i;
                jtOpt.textContent = (a.name || `Arr ${i}`) + ' (JT)';
                if (panel.jumpingTabMode && panel.arrIndex === i) jtOpt.selected = true;
                panel.select.appendChild(jtOpt);
            });
        }

        vizPlugins.filter(vp => typeof window['slopsmithViz_' + vp.id] === 'function').forEach(vp => {
            arrangements.forEach((a, i) => {
                const opt = document.createElement('option');
                opt.value = VIZ_PREFIX + ':' + vp.id + ':' + i;
                opt.textContent = (a.name || `Arr ${i}`) + ' (' + (vp.name || vp.id) + ')';
                if (panel.vizMode === vp.id && panel.arrIndex === i) opt.selected = true;
                panel.select.appendChild(opt);
            });
        });
    }

    function enterLyricsMode(panel) {
        if (panel.lyricsMode) return;

        if (panel.jumpingTabMode) exitJumpingTabMode(panel, panel.arrIndex);
        if (panel.tabActive) togglePanelTab(panel);
        panel.hw.stop();
        panel.canvas.style.display = 'none';

        // Hide highway-specific buttons and mastery slider
        panel.invertBtn.style.display = 'none';
        panel.tabBtn.style.display = 'none';
        panel.masteryHeading.style.display = 'none';
        panel.masterySlider.style.display = 'none';
        panel.masteryLabel.style.display = 'none';
        hidePaletteSelect(panel);
        hideCamSmoothing(panel);

        panel.lyricsPane = createLyricsPane(panel.panelDiv);
        panel.lyricsPane.el.style.bottom = (panel.bar.offsetHeight || 28) + 'px';
        panel.lyricsPane.connect(currentFilename, 0);
        panel.lyricsMode = true;
        panel.select.value = LYRICS_VALUE;
        panel.arrName.textContent = 'Lyrics';
        savePanelPrefs();
    }

    function exitLyricsMode(panel, arrIndex) {
        if (!panel.lyricsMode) return;

        if (panel.lyricsPane) {
            panel.lyricsPane.destroy();
            panel.lyricsPane.el.remove();
            panel.lyricsPane = null;
        }

        panel.canvas.style.display = '';
        panel.invertBtn.style.display = '';
        panel.tabBtn.style.display = '';
        panel.masteryHeading.style.display = '';
        panel.masterySlider.style.display = '';
        panel.masteryLabel.style.display = '';
        panel.lyricsMode = false;

        panel.hw.init(panel.canvas);
        panel.hw.resize();
        panel.arrIndex = arrIndex;
        panel.arrName.textContent = arrangements[arrIndex]?.name || '';
        hookPanelReady(panel);
        panel.hw.connect(getWsUrl(currentFilename, arrIndex), { onSongInfo: () => {} });
        savePanelPrefs();
    }

    function enterJumpingTabMode(panel) {
        if (panel.jumpingTabMode) return;

        if (panel.lyricsMode) exitLyricsMode(panel, panel.arrIndex);
        if (panel.tabActive) togglePanelTab(panel);
        panel.hw.stop();
        panel.canvas.style.display = 'none';

        panel.invertBtn.style.display = 'none';
        panel.tabBtn.style.display = 'none';
        panel.masteryHeading.style.display = 'none';
        panel.masterySlider.style.display = 'none';
        panel.masteryLabel.style.display = 'none';
        hidePaletteSelect(panel);
        hideCamSmoothing(panel);

        const jtContainer = document.createElement('div');
        jtContainer.style.cssText =
            'position:absolute;top:0;left:0;right:0;bottom:' +
            ((panel.bar.offsetHeight || 28) + 'px') +
            ';overflow:hidden;background:#0f1420;z-index:2;';
        panel.panelDiv.appendChild(jtContainer);

        const pane = window.createJumpingTabPane({ container: jtContainer });
        if (currentFilename) {
            pane.connect(currentFilename, panel.arrIndex).catch(e => {
                console.warn('[splitscreen] jumping tab connect failed:', e.message);
            });
        }
        panel.jumpingTabMode = true;
        panel.jumpingTabPane = pane;
        panel.jumpingTabContainer = jtContainer;
        panel.select.value = JUMPING_TAB_VALUE + ':' + panel.arrIndex;
        panel.arrName.textContent = (arrangements[panel.arrIndex]?.name || '') + ' (JT)';
        savePanelPrefs();
    }

    function exitJumpingTabMode(panel, arrIndex) {
        if (!panel.jumpingTabMode) return;

        if (panel.jumpingTabPane) {
            panel.jumpingTabPane.destroy();
            panel.jumpingTabPane = null;
        }
        if (panel.jumpingTabContainer) {
            panel.jumpingTabContainer.remove();
            panel.jumpingTabContainer = null;
        }

        panel.canvas.style.display = '';
        panel.invertBtn.style.display = '';
        panel.tabBtn.style.display = '';
        panel.masteryHeading.style.display = '';
        panel.masterySlider.style.display = '';
        panel.masteryLabel.style.display = '';
        panel.jumpingTabMode = false;

        panel.hw.init(panel.canvas);
        panel.hw.resize();
        panel.arrIndex = arrIndex;
        panel.arrName.textContent = arrangements[arrIndex]?.name || '';
        hookPanelReady(panel);
        panel.hw.connect(getWsUrl(currentFilename, arrIndex), { onSongInfo: () => {} });
        savePanelPrefs();
    }

    function enterVizMode(panel, pluginId, rendererPreInstalled) {
        if (panel.vizMode) return;

        if (panel.lyricsMode) exitLyricsMode(panel, panel.arrIndex);
        if (panel.jumpingTabMode) exitJumpingTabMode(panel, panel.arrIndex);
        if (panel.tabActive) togglePanelTab(panel);

        panel.tabBtn.style.display = 'none';
        panel.viewBtn.style.display = 'none';

        // Skip setRenderer when the caller already installed the renderer
        // before hw.init (restore-on-load path) to avoid creating a redundant
        // renderer instance and to respect the canvas context-type lock order.
        if (!rendererPreInstalled) {
            // Recreate the highway on the same canvas so the previous 2D context
            // is discarded before the viz renderer (potentially WebGL) takes over.
            // Same mitigation used for viz-to-viz arrangement switches.
            recreatePanelHighway(panel);
            panel.hw.setRenderer(window['slopsmithViz_' + pluginId]());
        }
        hookPanelReady(panel);
        panel.hw.connect(getWsUrl(currentFilename, panel.arrIndex), { onSongInfo: () => {} });
        panel.vizMode = pluginId;

        panel.updateInvertStyle(panel.hw.getInverted());
        panel.invertBtn.onclick = () => {
            const on = !panel.hw.getInverted();
            panel.hw.setInverted(on);
            panel.updateInvertStyle(on);
            savePanelPrefs();
        };

        const vp = vizPlugins.find(p => p.id === pluginId);
        panel.select.value = VIZ_PREFIX + ':' + pluginId + ':' + panel.arrIndex;
        panel.arrName.textContent = (arrangements[panel.arrIndex]?.name || '') + ' (' + (vp?.name || pluginId) + ')';
        savePanelPrefs();
    }

    function exitVizMode(panel, arrIndex) {
        if (!panel.vizMode) return;

        // Clear the renderer first so it can release its resources (WebGL
        // context, event listeners) via its own cleanup path, then recreate
        // the highway to give the fresh 2D renderer a clean canvas.
        panel.hw.setRenderer(null);
        recreatePanelHighway(panel);
        panel.vizMode = null;

        panel.tabBtn.style.display = '';

        panel.arrIndex = arrIndex;
        panel.arrName.textContent = arrangements[arrIndex]?.name || '';
        hookPanelReady(panel);
        panel.hw.connect(getWsUrl(currentFilename, arrIndex), { onSongInfo: () => {} });

        panel.updateInvertStyle(panel.hw.getInverted());
        panel.invertBtn.onclick = () => {
            const on = !panel.hw.getInverted();
            panel.hw.setInverted(on);
            panel.updateInvertStyle(on);
            savePanelPrefs();
        };

        savePanelPrefs();
    }

    function initPanel(panel, arrIndex, prefs) {
        const isLyricsMode = prefs?.arrName === LYRICS_VALUE;
        const isJumpingTabMode = prefs?.arrName?.startsWith(JUMPING_TAB_VALUE) || false;
        const isVizMode = prefs?.arrName?.startsWith(VIZ_PREFIX + ':') || false;
        let savedVizPluginId = null;
        if (isJumpingTabMode) {
            const jtArrName = prefs.arrName.slice(JUMPING_TAB_VALUE.length + 1);
            const jtIdx = resolveArrIndex(jtArrName);
            panel.arrIndex = jtIdx >= 0 ? jtIdx : arrIndex;
        } else if (isVizMode) {
            const parts = prefs.arrName.split(':');
            savedVizPluginId = parts[1];
            const vizArrName = parts.slice(2).join(':');
            const vizIdx = resolveArrIndex(vizArrName);
            panel.arrIndex = vizIdx >= 0 ? vizIdx : arrIndex;
        } else {
            panel.arrIndex = isLyricsMode ? 0 : arrIndex;
        }
        panel.lyricsMode = false;
        panel.lyricsPane = null;
        panel.jumpingTabMode = false;
        panel.jumpingTabPane = null;
        panel.jumpingTabContainer = null;
        panel.vizMode = null;

        // For viz restore: install the renderer BEFORE hw.init so the canvas
        // context is locked to the correct type (2D vs WebGL) on first init.
        // See CLAUDE.md "Canvas context-type lock" caveat.
        const vizFactoryFn = isVizMode && savedVizPluginId
            ? window['slopsmithViz_' + savedVizPluginId]
            : null;
        if (typeof vizFactoryFn === 'function') {
            panel.hw.setRenderer(vizFactoryFn());
        }

        panel.hw.init(panel.canvas);

        // Apply saved preferences
        if (prefs && !isLyricsMode && !isJumpingTabMode && !isVizMode) {
            if (prefs.inverted !== undefined) panel.hw.setInverted(prefs.inverted);
            if (prefs.lyrics !== undefined && typeof panel.hw.setLyricsVisible === 'function') {
                panel.hw.setLyricsVisible(prefs.lyrics);
            }
        }

        const savedMastery = (prefs?.mastery !== undefined) ? prefs.mastery : 1;
        panel.hw.setMastery(savedMastery);
        panel.masterySlider.value = Math.round(savedMastery * 100);
        panel.masterySlider.oninput = () => {
            const pct = parseInt(panel.masterySlider.value);
            panel.hw.setMastery(pct / 100);
            panel.masteryLabel.textContent = pct + '%';
            savePanelPrefs();
        };

        panel.paletteSelect.onchange = () => {
            const idx = panels.indexOf(panel);
            if (idx === -1) return;
            _writePanelPalette(idx, panel.paletteSelect.value);
        };

        panel.camSmoothingSlider.oninput = () => {
            const idx = panels.indexOf(panel);
            if (idx === -1) return;
            const v = parseFloat(panel.camSmoothingSlider.value);
            panel.camSmoothingLabel.textContent = (Number.isFinite(v) ? v : 0.5).toFixed(2);
            _writePanelCameraSmoothing(idx, v);
        };

        // Pop Out / Dock button handler. In the main window: pop out this panel
        // into a new browser window. In the popup (FOLLOWER): post a `docked`
        // message so the main reinstates the panel, then close the popup.
        panel.popOutBtn.onclick = () => {
            if (FOLLOWER) dockFollowerPanel(panel);
            else popOutPanel(panel);
        };

        // Populate arrangement dropdown (includes Lyrics, JT, and viz plugin options)
        populateSelect(panel, arrIndex);

        panel.arrName.textContent = isLyricsMode ? 'Lyrics'
            : isJumpingTabMode ? 'Jumping Tab'
            : (isVizMode && typeof vizFactoryFn === 'function') ? (arrangements[panel.arrIndex]?.name || '') + ' (viz)'
            : (arrangements[arrIndex]?.name || '');

        panel.select.onchange = () => {
            const val = panel.select.value;
            if (val.startsWith(JUMPING_TAB_VALUE + ':')) {
                const jtIdx = parseInt(val.split(':')[1]);
                panel.arrIndex = jtIdx;
                if (panel.jumpingTabMode) {
                    panel.jumpingTabPane.destroy();
                    panel.jumpingTabPane = null;
                    panel.jumpingTabContainer.remove();
                    panel.jumpingTabContainer = null;
                    panel.jumpingTabMode = false;
                }
                enterJumpingTabMode(panel);
            } else if (val.startsWith(VIZ_PREFIX + ':')) {
                const parts    = val.split(':');
                const pluginId = parts[1];
                const vizIdx   = parseInt(parts[2]);
                panel.arrIndex = vizIdx;
                if (panel.vizMode) {
                    // Clear the current renderer before recreating so it can
                    // release its resources (WebGL context, event listeners).
                    panel.hw.setRenderer(null);
                    // Already in viz mode — recreate hw to avoid the old WS leaking
                    // notes from the previous arrangement into the new one.
                    recreatePanelHighway(panel);
                    panel.hw.setRenderer(window['slopsmithViz_' + pluginId]());
                    hookPanelReady(panel);
                    panel.hw.connect(getWsUrl(currentFilename, vizIdx), { onSongInfo: () => {} });
                    panel.vizMode = pluginId;
                    const vp = vizPlugins.find(p => p.id === pluginId);
                    panel.arrName.textContent = (arrangements[vizIdx]?.name || '') + ' (' + (vp?.name || pluginId) + ')';
                    // Re-bind invert handler on the fresh hw
                    panel.updateInvertStyle(panel.hw.getInverted());
                    panel.invertBtn.onclick = () => {
                        const on = !panel.hw.getInverted();
                        panel.hw.setInverted(on);
                        panel.updateInvertStyle(on);
                        savePanelPrefs();
                    };
                    savePanelPrefs();
                } else {
                    enterVizMode(panel, pluginId);
                }
            } else if (val === LYRICS_VALUE) {
                enterLyricsMode(panel);
            } else {
                const newIdx = parseInt(val);
                if (panel.jumpingTabMode) {
                    exitJumpingTabMode(panel, newIdx);
                } else if (panel.vizMode) {
                    exitVizMode(panel, newIdx);
                } else if (panel.lyricsMode) {
                    exitLyricsMode(panel, newIdx);
                } else {
                    switchPanelArrangement(panel, newIdx);
                }
            }
            savePanelPrefs();
        };

        // Per-panel invert toggle
        panel.updateInvertStyle(panel.hw.getInverted());
        panel.invertBtn.onclick = () => {
            const on = !panel.hw.getInverted();
            panel.hw.setInverted(on);
            panel.updateInvertStyle(on);
            savePanelPrefs();
        };

        // Per-panel lyrics toggle (uses highway factory's per-instance showLyrics)
        const hasLyricsApi = typeof panel.hw.setLyricsVisible === 'function';
        if (hasLyricsApi) {
            panel.updateLyricsStyle(panel.hw.getLyricsVisible());
            panel.lyricsBtn.onclick = () => {
                const on = !panel.hw.getLyricsVisible();
                panel.hw.setLyricsVisible(on);
                panel.updateLyricsStyle(on);
                savePanelPrefs();
            };
        } else {
            panel.lyricsBtn.disabled = true;
            panel.lyricsBtn.title = 'Highway lyrics API not available';
            panel.lyricsBtn.style.opacity = '0.4';
        }

        // Per-panel Highway/Tab mode toggle (uses tabview factory)
        const hasTabFactory = typeof window.createTabView === 'function';
        if (hasTabFactory) {
            panel.tabBtn.onclick = () => togglePanelTab(panel);
        } else {
            panel.tabBtn.disabled = true;
            panel.tabBtn.title = 'Tab View plugin not loaded';
            panel.tabBtn.style.opacity = '0.4';
        }

        // Per-panel note detection (uses note_detect factory)
        panel.detectChannel = prefs?.detectChannel || 'mono';
        panel.detector = null;
        panel.channelBtn.textContent = DETECT_CHANNEL_LABELS[panel.detectChannel];
        const hasNoteDetect = typeof window.createNoteDetector === 'function';
        if (hasNoteDetect) {
            panel.detectBtn.onclick = () => toggleDetect(panel);
            panel.channelBtn.onclick = () => cycleDetectChannel(panel);
        } else {
            panel.detectBtn.disabled = true;
            panel.detectBtn.title = 'Note Detect plugin not loaded';
            panel.detectBtn.style.opacity = '0.4';
            panel.channelBtn.disabled = true;
            panel.channelBtn.style.opacity = '0.4';
        }

        if (isLyricsMode) {
            enterLyricsMode(panel);
        } else if (isJumpingTabMode) {
            enterJumpingTabMode(panel);
        } else if (isVizMode && savedVizPluginId &&
                   typeof window['slopsmithViz_' + savedVizPluginId] === 'function') {
            // Renderer was already installed before hw.init above; pass true to
            // skip the redundant setRenderer call inside enterVizMode.
            enterVizMode(panel, savedVizPluginId, /* rendererPreInstalled */ true);
        } else {
            // Connect WebSocket. Pass an empty onSongInfo so core skips its
            // default writes to shared HUD / audio / arrangement dropdown
            // — otherwise every panel's song_info clobbers the main view.
            // See byrongamatos/slopsmith#27.
            hookPanelReady(panel);
            panel.hw.connect(getWsUrl(currentFilename, arrIndex), { onSongInfo: () => {} });
        }
    }

    async function togglePanelTab(panel) {
        if (panel.tabActive) {
            // Back to highway
            if (panel.tabInstance) {
                try { panel.tabInstance.destroy(); } catch (_) {}
                panel.tabInstance = null;
            }
            if (panel.tabContainer) {
                panel.tabContainer.remove();
                panel.tabContainer = null;
            }
            panel.canvas.style.display = '';
            panel.tabActive = false;
            panel.updateTabStyle(false);
            return;
        }

        const prevLabel = panel.tabBtn.textContent;
        panel.tabBtn.textContent = '…';
        panel.tabBtn.disabled = true;
        try {
            const decoded = decodeURIComponent(currentFilename);
            const url = '/api/plugins/tabview/gp5/' +
                encodeURIComponent(decoded) +
                '?arrangement=' + panel.arrIndex;
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(await resp.text());
            const data = await resp.arrayBuffer();

            const tabContainer = document.createElement('div');
            tabContainer.style.cssText =
                'position:absolute;top:0;left:0;right:0;bottom:' +
                ((panel.bar.offsetHeight || 28) + 'px') +
                ';overflow:auto;background:#fff;z-index:2;';
            panel.panelDiv.appendChild(tabContainer);

            const tv = window.createTabView({
                container: tabContainer,
                getBeats: () => panel.hw.getBeats(),
                getCurrentTime: () => document.getElementById('audio').currentTime,
            });
            await tv.load(data);
            tv.startSync();

            panel.canvas.style.display = 'none';
            panel.tabContainer = tabContainer;
            panel.tabInstance = tv;
            panel.tabActive = true;
            panel.updateTabStyle(true);
        } catch (e) {
            console.error('[splitscreen] tab view error:', e);
            alert('Tab View error: ' + (e.message || e));
        } finally {
            panel.tabBtn.textContent = prevLabel;
            panel.tabBtn.disabled = false;
        }
    }

    function toggleDetect(panel) {
        if (panel.detector) {
            panel.detector.destroy();
            panel.detector = null;
            panel.updateDetectStyle(false);
            return;
        }
        if (typeof window.createNoteDetector !== 'function') return;
        const channelMap = { mono: -1, left: 0, right: 1 };
        panel.detector = window.createNoteDetector({
            highway: panel.hw,
            container: panel.panelDiv,
            channel: channelMap[panel.detectChannel] ?? -1,
        });
        panel.detector.enable();
        panel.updateDetectStyle(true);
    }

    function cycleDetectChannel(panel) {
        const idx = DETECT_CHANNEL_CYCLE.indexOf(panel.detectChannel);
        panel.detectChannel = DETECT_CHANNEL_CYCLE[(idx + 1) % DETECT_CHANNEL_CYCLE.length];
        panel.channelBtn.textContent = DETECT_CHANNEL_LABELS[panel.detectChannel];
        if (panel.detector) {
            const channelMap = { mono: -1, left: 0, right: 1 };
            panel.detector.setChannel(channelMap[panel.detectChannel]);
        }
        savePanelPrefs();
    }

    function switchPanelArrangement(panel, arrIndex) {
        panel.arrIndex = arrIndex;
        panel.arrName.textContent = arrangements[arrIndex]?.name || '';
        if (panel.tabActive) togglePanelTab(panel);
        recreatePanelHighway(panel);
        hookPanelReady(panel);
        panel.hw.connect(getWsUrl(currentFilename, arrIndex), { onSongInfo: () => {} });
    }

    function teardownPanels() {
        for (const p of panels) {
            if (p.detector) {
                p.detector.destroy();
                p.detector = null;
            }
            if (p.lyricsPane) {
                p.lyricsPane.destroy();
                p.lyricsPane = null;
            }
            if (p.jumpingTabPane) {
                p.jumpingTabPane.destroy();
                p.jumpingTabPane = null;
            }
            if (p.vizMode) {
                p.hw.setRenderer(null);
                p.vizMode = null;
            }
            if (p.tabInstance) {
                try { p.tabInstance.destroy(); } catch (_) {}
                p.tabInstance = null;
            }
            p.hw.stop();
        }
        panels = [];
        if (wrap) {
            wrap.remove();
            wrap = null;
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Pop-out / dock helpers
    // ══════════════════════════════════════════════════════════════════════

    function _captureMode(panel) {
        if (panel.lyricsMode) return 'lyrics';
        if (panel.jumpingTabMode) return 'jt';
        if (panel.vizMode) return 'viz:' + panel.vizMode;
        return '2d';
    }

    function _captureFollowerConfig(panel) {
        return {
            arrangement: panel.arrIndex || 0,
            mode:        _captureMode(panel),
            inverted:    panel.hw.getInverted() ? 1 : 0,
            mastery:     panel.hw.getMastery(),
        };
    }

    function _newPopupId() {
        try {
            return crypto.randomUUID();
        } catch (_) {
            return 'p-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
        }
    }

    // Open a popup window pre-configured to show this panel as a follower.
    // The panel is removed from the main layout once the popup is opened
    // (slot collapses; rebuildLayout reflows remaining panels).
    function popOutPanel(panel) {
        if (!currentFilename) return;
        const idx = panels.indexOf(panel);
        if (idx === -1) return;
        if (typeof BroadcastChannel !== 'function') {
            alert('Pop-out requires a browser that supports BroadcastChannel.');
            return;
        }
        const cfg = _captureFollowerConfig(panel);
        const popupId = _newPopupId();

        const url = new URL(window.location.origin + '/');
        const sp = url.searchParams;
        sp.set('ssFollower', '1');
        sp.set('popupId', popupId);
        sp.set('filename', currentFilename);
        sp.set('arrangement', String(cfg.arrangement));
        sp.set('mode', cfg.mode);
        sp.set('inverted', String(cfg.inverted));
        if (Number.isFinite(cfg.mastery)) sp.set('mastery', String(cfg.mastery));

        const popup = window.open(url.toString(), popupId, 'popup,width=1280,height=420');
        if (!popup) {
            alert('Pop-out blocked by browser. Allow popups for this origin and try again.');
            return;
        }
        popups.set(popupId, { panelIdx: idx, originalConfig: cfg });

        // Open the channel in the main window so we can broadcast time and
        // listen for the popup's docked / closed messages.
        _ensureMainBroadcasterAndListener();
        _startPopupBroadcaster();

        // Remove this panel from the live layout. The remaining panels are
        // rebuilt; if popping leaves only 1 panel we stop split entirely and
        // the main view goes back to its default highway. If 2 remain in a
        // quad layout we downgrade to top-bottom so we don't leave an empty
        // default slot in the grid.
        const wasActive = active;
        const remaining = panels.filter(p => p !== panel);
        const savedPrefs = remaining.map(p => ({
            arrName: p.jumpingTabMode
                ? JUMPING_TAB_VALUE + ':' + (arrangements[p.arrIndex]?.name || '')
                : p.vizMode
                ? VIZ_PREFIX + ':' + p.vizMode + ':' + (arrangements[p.arrIndex]?.name || '')
                : p.lyricsMode ? LYRICS_VALUE : (arrangements[p.arrIndex]?.name || ''),
            lyrics: typeof p.hw.getLyricsVisible === 'function' ? p.hw.getLyricsVisible() : true,
            inverted: p.hw.getInverted(),
            detectChannel: p.detectChannel || 'mono',
            barHidden: p.bar.style.display === 'none',
            mastery: p.hw.getMastery(),
        }));

        if (wasActive && savedPrefs.length === 0) {
            // Single-panel split (rare) — pop out leaves nothing.
            stopSplitScreen();
            return;
        }
        if (wasActive && savedPrefs.length === 1) {
            // Last panel popped — go back to the default highway view.
            teardownPanels();
            stopSplitScreen();
            return;
        }
        // 2+ remaining. Downgrade quad → top-bottom if we'd otherwise leave
        // an empty default slot. Keep top-bottom / left-right as-is.
        if (wasActive && LAYOUTS[layout] && savedPrefs.length < LAYOUTS[layout].panels) {
            layout = 'top-bottom';
            try { localStorage.setItem('splitscreenLayout', layout); } catch (_) {}
        }
        if (wasActive) {
            teardownPanels();
            startSplitScreen(null, savedPrefs);
        }
    }

    // Called from the popup when the user clicks Dock or closes the window.
    // Posts the panel's current state back to the main window then closes.
    function dockFollowerPanel(panel) {
        if (!FOLLOWER) return;
        try {
            const ch = _ssChannel();
            if (ch) {
                ch.postMessage({
                    type: 'docked',
                    popupId: FOLLOWER.popupId,
                    finalState: _captureFollowerConfig(panel),
                });
            }
        } catch (_) {}
        try { window.close(); } catch (_) {}
    }

    // ── Main toggle ──
    function rebuildLayout() {
        const wasActive = active;
        const savedPrefs = wasActive ? captureCurrentPrefs() : null;
        // Flip active BEFORE teardown so the upcoming startSplitScreen
        // passes its `_starting || active` re-entrancy guard. Mirror the
        // ordering stopSplitScreen uses (active=false → emit → teardown)
        // so plugin destroy() runs against the inactive world view.
        active = false;
        _emitFocusChange();
        teardownPanels();
        if (wasActive) startSplitScreen(null, savedPrefs);
    }

    function captureCurrentPrefs() {
        return panels.map(p => ({
            arrName: p.jumpingTabMode
                ? JUMPING_TAB_VALUE + ':' + (arrangements[p.arrIndex]?.name || '')
                : p.vizMode
                ? VIZ_PREFIX + ':' + p.vizMode + ':' + (arrangements[p.arrIndex]?.name || '')
                : p.lyricsMode ? LYRICS_VALUE : (arrangements[p.arrIndex]?.name || ''),
            lyrics: typeof p.hw.getLyricsVisible === 'function' ? p.hw.getLyricsVisible() : true,
            inverted: p.hw.getInverted(),
            detectChannel: p.detectChannel || 'mono',
            barHidden: p.bar.style.display === 'none',
            mastery: p.hw.getMastery(),
        }));
    }

    async function startSplitScreen(existingArrangements, savedPrefs) {
        // Re-entrancy guard: prevent concurrent starts from double-clicks,
        // layout rebuilds, or auto-reactivate firing while a start is in flight.
        if (_starting || active) return;
        _starting = true;
        try {
        await _vizPluginsReady;

        const info = highway.getSongInfo();
        if (info && info.arrangements) {
            arrangements = info.arrangements;
        }
        if (arrangements.length === 0) return;

        // If no explicit arrangements or prefs passed, try loading from storage
        if (!existingArrangements && !savedPrefs) {
            savedPrefs = migratePanelPrefs(loadPanelPrefs());
        }

        const cfg = LAYOUTS[layout];
        const container = createWrap();
        applyLayoutStyle(container, layout);

        // Determine arrangements for each panel
        let arrDefaults;
        if (existingArrangements && existingArrangements.length >= cfg.panels) {
            arrDefaults = existingArrangements.slice(0, cfg.panels);
        } else if (savedPrefs && savedPrefs.length > 0) {
            arrDefaults = [];
            for (let i = 0; i < cfg.panels; i++) {
                const pref = savedPrefs[i % savedPrefs.length];
                if (pref && pref.arrName === LYRICS_VALUE) {
                    arrDefaults.push(0);
                } else if (pref && pref.arrName?.startsWith(JUMPING_TAB_VALUE)) {
                    const jtArrName = pref.arrName.slice(JUMPING_TAB_VALUE.length + 1);
                    const jtIdx = resolveArrIndex(jtArrName);
                    arrDefaults.push(jtIdx >= 0 ? jtIdx : 0);
                } else if (pref && pref.arrName?.startsWith(VIZ_PREFIX + ':')) {
                    const parts = pref.arrName.split(':');
                    const vizArrName = parts.slice(2).join(':');
                    const vizIdx = resolveArrIndex(vizArrName);
                    arrDefaults.push(vizIdx >= 0 ? vizIdx : 0);
                } else {
                    const idx = pref ? resolveArrIndex(pref.arrName) : -1;
                    arrDefaults.push(idx >= 0 ? idx : getDefaultArrangements(1)[0]);
                }
            }
        } else {
            arrDefaults = getDefaultArrangements(cfg.panels);
        }

        // Flip active BEFORE the panel-init loop. initPanel may install a
        // viz renderer (e.g. piano) whose init() calls back into
        // window.slopsmithSplitscreen.panelChromeFor() / settingsAnchorFor().
        // Those gate on isActive(); if active flips true only after the loop,
        // the renderer mounts to #player (main-player fast path) on the first
        // entry and is stuck full-screen until the next start cycle.
        active = true;
        focusedPanelIdx = 0;

        // Size the wrap NOW so panelDivs have a real rect during initPanel.
        // sizeCanvases() runs at end of start, but viz renderers (piano,
        // drums) measure panelChrome.clientWidth/Height in their init() —
        // a wrap with no `bottom` set has height:auto = 0 → panelDiv 50%
        // of 0 = 0 → renderer's bitmap = 0x0 → CSS upscales = pixelated.
        const initialControls = document.getElementById('player-controls');
        const initialControlsH = initialControls ? initialControls.offsetHeight : 0;
        container.style.bottom = initialControlsH + 'px';

        for (let i = 0; i < cfg.panels; i++) {
            const parts = createPanel(i, container, layout);
            const hw = createHighway();
            const panel = Object.assign({ hw, arrIndex: 0 }, parts);

            // Override resize BEFORE init — highway's default sizes to full window,
            // which clobbers all panels to overlap. Size to parent panel instead.
            hw.resize = function () {
                const c = panel.canvas;
                if (!c) return;
                const rect = panel.panelDiv.getBoundingClientRect();
                const barH = panel.bar.style.display === 'none' ? 0 : (panel.bar.offsetHeight || 28);
                const w = rect.width;
                const h = Math.max(0, rect.height - barH);
                c.style.width = w + 'px';
                c.style.height = h + 'px';
                const scale = hw.getRenderScale();
                c.width = Math.round(w * scale);
                c.height = Math.round(h * scale);
            };

            panels.push(panel);
            const panelPrefs = savedPrefs ? savedPrefs[i % savedPrefs.length] : null;
            initPanel(panel, arrDefaults[i], panelPrefs);
            panel.barToggleBtn.onclick = () => togglePanelBar(panel);
            if (panelPrefs?.barHidden) togglePanelBar(panel);
        }

        // Hide default highway canvas, ensure controls stay on top and at bottom
        const defaultCanvas = document.getElementById('highway');
        if (defaultCanvas) defaultCanvas.style.display = 'none';
        const controls = document.getElementById('player-controls');
        if (controls) {
            controls.style.position = 'relative';  // Required for z-index to work
            controls.style.zIndex = '10';
            controls.style.marginTop = 'auto';
        }

        sizeCanvases();
        // Paint focus border + notify any listeners that registered during
        // the per-panel init pass (piano subscribes from its init()).
        _applyFocusBorder();
        _emitFocusChange();
        updateBtn();
        setRedundantControlsHidden(true);
        // HUD: visible while loaded; fades out when audio begins playback.
        const audio = document.getElementById('audio');
        if (audio && !audio.paused) fadeOutHud();
        else showHud();
        savePanelPrefs();

        if (localStorage.getItem('splitscreenControlsHidden') === 'true') toggleControlsVisibility();

        // Hook into the time sync loop
        startTimeSync();
        } finally {
            _starting = false;
        }
    }

    function stopSplitScreen() {
        savePanelPrefs();
        // Flip active BEFORE teardown so any plugin destroy() that reads
        // isActive() during teardownPanels treats itself as transitioning
        // back to the main-player path. Notify listeners up-front for the
        // same reason — focus-change handlers should run with the new
        // (inactive) world view, not the old.
        active = false;
        _emitFocusChange();
        teardownPanels();
        setRedundantControlsHidden(false);
        restoreHud();

        // Restore default highway canvas and controls z-index
        const defaultCanvas = document.getElementById('highway');
        if (defaultCanvas) defaultCanvas.style.display = '';
        const controls = document.getElementById('player-controls');
        if (controls) {
            if (controlsHidden) controls.style.display = '';
            controls.style.zIndex = '10';  // keep controls above highway canvas at all times
            controls.style.marginTop = '';
        }
        controlsHidden = false;

        updateBtn();
        stopTimeSync();
    }

    function toggle() {
        if (_starting) return; // treat in-flight start as already active
        if (active) {
            stopSplitScreen();
        } else {
            startSplitScreen();
        }
    }

    // ── Time sync ──
    let syncInterval = null;

    function startTimeSync() {
        stopTimeSync();
        const audio = document.getElementById('audio');
        syncInterval = setInterval(() => {
            if (!audio || !active) return;
            const t = audio.currentTime;
            for (const p of panels) {
                if (!p.lyricsMode && !p.jumpingTabMode) p.hw.setTime(t);
            }
        }, 1000 / 60);
    }

    function stopTimeSync() {
        if (syncInterval) {
            clearInterval(syncInterval);
            syncInterval = null;
        }
    }

    // ── Popup time broadcaster ──
    // Broadcasts audio.currentTime over BroadcastChannel whenever there is
    // at least one popped-out panel listening. Runs INDEPENDENTLY of the
    // splitscreen sync loop above — the user can pop the only panel out,
    // main goes back to the default highway view, and the popup still
    // receives time updates. Started when the first popup is registered;
    // stopped when the last popup is dropped.
    let _popupBroadcastInterval = null;
    function _startPopupBroadcaster() {
        if (_popupBroadcastInterval) return;
        const audio = document.getElementById('audio');
        const ch = _ssChannel();
        if (!audio || !ch) return;
        _popupBroadcastInterval = setInterval(() => {
            if (popups.size === 0) { _stopPopupBroadcaster(); return; }
            ch.postMessage({ type: 'time', t: audio.currentTime });
        }, 1000 / 60);
    }
    function _stopPopupBroadcaster() {
        if (_popupBroadcastInterval) {
            clearInterval(_popupBroadcastInterval);
            _popupBroadcastInterval = null;
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Main-window broadcaster / listener for popped-out panels
    // ══════════════════════════════════════════════════════════════════════
    let _mainChannelListenerAttached = false;
    function _ensureMainBroadcasterAndListener() {
        if (FOLLOWER) return;            // never run in popup
        const ch = _ssChannel();
        if (!ch || _mainChannelListenerAttached) return;
        _mainChannelListenerAttached = true;
        ch.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.type === 'docked' && msg.popupId && popups.has(msg.popupId)) {
                _redockPanel(msg.popupId, msg.finalState || null);
            } else if (msg.type === 'closed' && msg.popupId && popups.has(msg.popupId)) {
                // Popup was closed without an explicit Dock click. Treat
                // the panel as removed; don't re-add. Just drop the entry.
                popups.delete(msg.popupId);
            }
        };
    }

    // Re-instate a panel that was popped out, using the original config
    // we captured at pop-out time, overlaid with anything the popup told
    // us via `finalState`.
    function _redockPanel(popupId, finalState) {
        const entry = popups.get(popupId);
        if (!entry) return;
        popups.delete(popupId);
        if (!currentFilename) return;

        // Decide where to slot the redocked panel back. If split is currently
        // active, capture the running prefs and append; otherwise start split
        // fresh with just this one panel.
        const merged = Object.assign({}, entry.originalConfig, finalState || {});
        const arrName = (merged.mode === 'lyrics') ? LYRICS_VALUE
            : (merged.mode === 'jt') ? (JUMPING_TAB_VALUE + ':' + (arrangements[merged.arrangement]?.name || ''))
            : merged.mode?.startsWith('viz:') ? (VIZ_PREFIX + ':' + merged.mode.slice(4) + ':' + (arrangements[merged.arrangement]?.name || ''))
            : (arrangements[merged.arrangement]?.name || '');
        const newPrefs = {
            arrName,
            lyrics: true,
            inverted: !!merged.inverted,
            detectChannel: 'mono',
            barHidden: false,
            mastery: Number.isFinite(merged.mastery) ? merged.mastery : 1,
        };

        let savedPrefs;
        if (active) {
            savedPrefs = captureCurrentPrefs();
            savedPrefs.push(newPrefs);
        } else {
            savedPrefs = [newPrefs];
        }

        if (active) {
            teardownPanels();
            startSplitScreen(null, savedPrefs);
        } else {
            startSplitScreen(null, savedPrefs);
        }
    }

    // ── Layout cycle button ──
    let layoutBtn = null;

    function createLayoutBtn() {
        if (layoutBtn) return layoutBtn;
        const c = document.getElementById('player-controls');
        if (!c) return null;
        const separator = c.querySelector('span.text-gray-700');
        layoutBtn = document.createElement('select');
        layoutBtn.id = 'splitscreen-layout-btn';
        layoutBtn.style.cssText =
            'background:#1a1a2e;border:1px solid #333;border-radius:6px;' +
            'padding:3px 6px;font-size:11px;color:#9ca3af;outline:none;display:none;';
        const options = [
            { value: 'top-bottom', label: '⬒ Top/Bottom' },
            { value: 'left-right', label: '⬓ Left/Right' },
            { value: 'quad', label: '⊞ Quad' },
        ];
        for (const o of options) {
            const opt = document.createElement('option');
            opt.value = o.value;
            opt.textContent = o.label;
            if (o.value === layout) opt.selected = true;
            layoutBtn.appendChild(opt);
        }
        layoutBtn.onchange = () => {
            layout = layoutBtn.value;
            localStorage.setItem('splitscreenLayout', layout);
            if (active) rebuildLayout();
        };
        if (separator) c.insertBefore(layoutBtn, separator);
        return layoutBtn;
    }

    // ── Player HUD fade (top-left song title fades out once playback begins) ──
    function showHud() {
        const hud = document.getElementById('player-hud');
        if (!hud) return;
        hud.style.transition = 'none';
        hud.style.opacity = '1';
    }

    function fadeOutHud() {
        const hud = document.getElementById('player-hud');
        if (!hud) return;
        hud.style.transition = 'opacity 1.5s ease-out';
        hud.style.opacity = '0';
    }

    function restoreHud() {
        const hud = document.getElementById('player-hud');
        if (!hud) return;
        hud.style.transition = '';
        hud.style.opacity = '';
    }

    function onAudioPlay() {
        if (active) fadeOutHud();
    }

    const _audio = document.getElementById('audio');
    if (_audio) _audio.addEventListener('play', onAudioPlay);

    // ── Redundant main-bar controls (hidden while split is active because each
    // panel exposes its own arrangement / mastery / lyrics / viz controls) ──
    const REDUNDANT_CONTROL_IDS = [
        'arr-select',
        'mastery-slider-label',
        'mastery-slider',
        'mastery-label',
        'btn-lyrics',
        'viz-picker-label',
        'viz-picker',
    ];

    function setRedundantControlsHidden(hide) {
        for (const id of REDUNDANT_CONTROL_IDS) {
            const el = document.getElementById(id);
            if (el) el.style.display = hide ? 'none' : '';
        }
    }

    // ── Hide/show controls bar ──
    let hideBtn = null;
    let floatBtn = null;

    function createHideBtn() {
        if (hideBtn) return hideBtn;
        const c = document.getElementById('player-controls');
        if (!c) return null;
        hideBtn = document.createElement('button');
        hideBtn.id = 'btn-splitscreen-hide-bar';
        hideBtn.className = OFF_CLASS;
        hideBtn.title = 'Hide controls bar';
        hideBtn.style.display = 'none';
        hideBtn.onclick = toggleControlsVisibility;
        const closeBtn = c.querySelector('button[onclick*="showScreen"]');
        if (closeBtn) {
            closeBtn.classList.remove('ml-auto');
            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'display:flex;gap:8px;margin-left:auto;align-items:center;';
            c.insertBefore(wrapper, closeBtn);
            wrapper.appendChild(hideBtn);
            wrapper.appendChild(closeBtn);
        } else {
            c.appendChild(hideBtn);
        }
        return hideBtn;
    }

    function createFloatingShowBtn() {
        if (floatBtn) return floatBtn;
        const player = document.getElementById('player');
        if (!player) return null;
        floatBtn = document.createElement('button');
        floatBtn.id = 'btn-splitscreen-float-controls';
        floatBtn.textContent = '▴ Controls';
        floatBtn.title = 'Show controls bar';
        floatBtn.style.cssText =
            'position:absolute;bottom:8px;right:8px;z-index:20;display:none;' +
            'padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;' +
            'background:rgba(64,128,224,0.85);color:#fff;border:none;';
        floatBtn.onclick = toggleControlsVisibility;
        player.appendChild(floatBtn);
        return floatBtn;
    }

    function togglePanelBar(panel) {
        const hiding = panel.bar.style.display !== 'none';
        panel.bar.style.display = hiding ? 'none' : '';
        if (hiding) {
            panel.barToggleBtn.textContent = '▴ Bar';
            panel.barToggleBtn.title = 'Show panel controls';
            panel.barToggleBtn.style.background = 'rgba(64,128,224,0.85)';
            panel.barToggleBtn.style.color = '#fff';
            panel.barToggleBtn.style.width = 'auto';
            panel.barToggleBtn.style.padding = '0 6px';
        } else {
            panel.barToggleBtn.textContent = '▾';
            panel.barToggleBtn.title = 'Hide panel controls';
            panel.barToggleBtn.style.background = 'rgba(64,128,224,0.85)';
            panel.barToggleBtn.style.color = '#fff';
            panel.barToggleBtn.style.width = '';
            panel.barToggleBtn.style.padding = '2px 6px';
        }
        if (panel.jumpingTabMode && panel.jumpingTabPane) {
            panel.jumpingTabPane.resize();
        } else if (!panel.lyricsMode) {
            panel.hw.resize();
        }
        savePanelPrefs();
    }

    function toggleControlsVisibility() {
        controlsHidden = !controlsHidden;
        localStorage.setItem('splitscreenControlsHidden', controlsHidden);
        const controls = document.getElementById('player-controls');
        if (controls) controls.style.display = controlsHidden ? 'none' : '';
        if (active) sizeCanvases();
        updateBtn();
    }

    // ── Toggle button ──
    function updateBtn() {
        const btn = document.getElementById('btn-splitscreen');
        if (btn) btn.className = active ? ON_CLASS : OFF_CLASS;
        if (layoutBtn) layoutBtn.style.display = active ? '' : 'none';
        if (hideBtn) {
            hideBtn.style.display = active ? '' : 'none';
            hideBtn.textContent = controlsHidden ? '▴ Bar' : '▾ Bar';
        }
        if (floatBtn) floatBtn.style.display = (active && controlsHidden) ? '' : 'none';
    }

    function injectBtn() {
        const c = document.getElementById('player-controls');
        if (!c) return;
        // Keep controls above highway/3D canvas at all times regardless of split state.
        c.style.position = 'relative';
        c.style.zIndex = '10';
        if (document.getElementById('btn-splitscreen')) return;
        const separator = c.querySelector('span.text-gray-700');
        const b = document.createElement('button');
        b.id = 'btn-splitscreen';
        b.className = OFF_CLASS;
        b.textContent = 'Split';
        b.title = 'Toggle split-screen multiplayer view';
        b.onclick = toggle;
        if (separator) c.insertBefore(b, separator);
        createLayoutBtn();
        createHideBtn();
        createFloatingShowBtn();
    }

    // ── Resize handler ──
    // sizeCanvases() is for main-window splitscreen — it reads the global
    // #player-controls height to compute the wrap's bottom offset. In a
    // popup #player-controls is force-hidden, so offsetHeight is 0 and
    // sizeCanvases would clobber the follower wrap's `bottom: FOLLOWER_TOOLBAR_H`
    // reservation, sliding the wrap (and every panel's bar) under the
    // follower toolbar. Follower mode has its own resize handler in
    // bootFollowerMode that resizes panels without touching the wrap.
    window.addEventListener('resize', () => {
        if (active && !FOLLOWER) sizeCanvases();
    });

    // ── Hook into playSong ──
    const _play = window.playSong;
    window.playSong = async function (f, a) {
        const wasActive = active;
        // In a follower window, never auto-stop split — the follower panel IS
        // the only thing on screen, and we drive its setup ourselves.
        if (!FOLLOWER && active) stopSplitScreen();
        await _play(f, a);

        currentFilename = f;

        // Try to grab arrangements eagerly via _onReady, but also poll as
        // a fallback — async plugins (e.g. 3dhighway) can cause the 'ready'
        // WS message to fire before _onReady is set, so we can't rely on it.
        const origOnReady = highway._onReady;
        let handled = false;
        highway._onReady = () => {
            const info = highway.getSongInfo();
            if (info && info.arrangements) {
                arrangements = info.arrangements;
            }
            if (origOnReady) origOnReady();
            highway._onReady = null;

            // Auto-follow: notify any popped-out panels that the song just
            // changed so they can swap to the new chart in their current
            // mode + arrangement. Only the main window broadcasts; FOLLOWER
            // windows skip this.
            if (!FOLLOWER && popups.size > 0 && ssChannel) {
                ssChannel.postMessage({ type: 'song-changed', filename: currentFilename });
            }

            if (!handled && !FOLLOWER && (alwaysSplit || (wasActive && autoReactivate))) {
                handled = true;
                startSplitScreen();
            }
        };

        // Fallback: poll for song info in case _onReady was missed
        if (!FOLLOWER && (alwaysSplit || (wasActive && autoReactivate))) {
            let attempts = 0;
            const poll = setInterval(() => {
                attempts++;
                if (handled || attempts > 30) { clearInterval(poll); return; }
                const info = highway.getSongInfo();
                if (info && info.arrangements && info.arrangements.length) {
                    clearInterval(poll);
                    if (!handled) {
                        handled = true;
                        arrangements = info.arrangements;
                        startSplitScreen();
                    }
                }
            }, 200);
        }

        if (!FOLLOWER) injectBtn();
    };

    // Clean up on screen change. In follower mode the popup never navigates
    // away from the player, but if something tries we don't tear down split
    // (the follower panel IS the player).
    const _show = window.showScreen;
    window.showScreen = function (id) {
        if (!FOLLOWER && id !== 'player' && active) stopSplitScreen();
        _show(id);
    };

    // ══════════════════════════════════════════════════════════════════════
    //  Follower-mode bootstrap (popup window only)
    //  The actual `if (FOLLOWER) bootFollowerMode();` invocation is at the
    //  bottom of this IIFE — all the `let` bindings the function references
    //  (especially _followerAudio) must be past their TDZ before we call it.
    // ══════════════════════════════════════════════════════════════════════

    // In follower mode, the popup's local <audio> element is paused (we never
    // surface a play button, and we can't programmatically auto-play across
    // browsers reliably). Lyrics pane, jumping tab pane, and the highway's
    // own time-driven helpers all read `audio.currentTime` directly though.
    // We shim the property here so reads in the popup return the time
    // broadcast from the main window — letting all those subsystems work
    // without needing per-mode rewires.
    let _followerCurrentTime = 0;
    function _installFollowerAudioShim(audio) {
        if (!audio) return;
        try {
            Object.defineProperty(audio, 'currentTime', {
                get() { return _followerCurrentTime; },
                set(_v) { /* ignore — popup audio is a follower */ },
                configurable: true,
            });
        } catch (e) {
            console.warn('[splitscreen-follower] failed to install audio.currentTime shim:', e);
        }
    }

    // Cached reference to the popup's <audio> element so the song-change
    // handler can re-assert mute / re-shim without re-querying.
    let _followerAudio = null;

    function bootFollowerMode() {
        // Hide non-panel chrome with a single CSS rule so we don't have to
        // chase every element id slopsmith renders. The follower wrap covers
        // the viewport at a high z-index; #player (and our wrap) stay visible.
        const style = document.createElement('style');
        style.textContent =
            'body.ss-follower #nav,' +
            'body.ss-follower header,' +
            'body.ss-follower .screen:not(#player),' +
            'body.ss-follower #player-controls,' +
            'body.ss-follower #player-hud,' +
            'body.ss-follower #section-map,' +
            'body.ss-follower #btn-splitscreen,' +
            'body.ss-follower #splitscreen-layout-btn,' +
            'body.ss-follower #btn-splitscreen-hide-bar,' +
            'body.ss-follower #btn-splitscreen-float-controls' +
            '{display:none !important;}' +
            'body.ss-follower #player{padding:0 !important;}' +
            'body.ss-follower{margin:0;overflow:hidden;}';
        document.head.appendChild(style);
        document.body.classList.add('ss-follower');

        // Mute the popup's local audio. The follower never plays; it slaves
        // to the main window's currentTime via BroadcastChannel.
        _followerAudio = document.getElementById('audio');
        if (_followerAudio) {
            _followerAudio.muted = true;
            _followerAudio.volume = 0;
        }
        // Shim audio.currentTime so anything that reads it (lyrics pane,
        // jumping tab pane, ...) sees the broadcast time, not the popup's
        // own paused-at-0 audio clock.
        _installFollowerAudioShim(_followerAudio);

        // Notify main when the popup is closed so the slot isn't held open
        // indefinitely. Registered once; survives song-change rebuilds.
        window.addEventListener('beforeunload', () => {
            try {
                const c = _ssChannel();
                if (c) c.postMessage({ type: 'closed', popupId: FOLLOWER.popupId });
            } catch (_) {}
        });

        // Resize handler: walk every live panel — multi-panel popups
        // (top-bottom, left-right, quad) need each highway / JT pane
        // resized, not just panels[0]. Mirrors sizeCanvases()'s loop
        // shape but doesn't touch wrap positioning (the follower wrap's
        // top/bottom are set once at build time and don't need to track
        // window chrome the way the main-window wrap does).
        window.addEventListener('resize', () => {
            for (const p of panels) {
                if (p.jumpingTabMode && p.jumpingTabPane) p.jumpingTabPane.resize();
                else if (!p.lyricsMode) p.hw.resize();
            }
        });

        // Wait one frame so all plugin IIFEs that loaded before us have
        // finished installing their playSong wraps and globals.
        requestAnimationFrame(() => {
            if (typeof window.showScreen === 'function') window.showScreen('player');
            loadSongInFollower(FOLLOWER.filename, [FOLLOWER]);
        });
    }

    // Load `filename` in the popup, wait for it to be ready, then build the
    // follower panels from `cfgs`. Used both on initial bootstrap
    // (cfgs = [FOLLOWER]) and on song-change (cfgs = current panel states).
    // The popup's main highway is shared across all panels for time / song
    // info purposes; per-panel arrangement is set inside each panel's own
    // WebSocket via initPanel.
    async function loadSongInFollower(filename, cfgs) {
        const firstArr = (cfgs[0] && cfgs[0].arrangement) || 0;
        try {
            await window.playSong(filename, firstArr);
        } catch (e) {
            console.error('[splitscreen-follower] playSong failed:', e);
            return;
        }
        // Re-assert mute (playSong resets audio.src; some browsers unmute
        // on src change). Also re-install the currentTime shim — the
        // <audio> element is the same instance so the property override
        // should still be in place, but cheap to re-confirm.
        if (_followerAudio) { _followerAudio.muted = true; _followerAudio.volume = 0; }
        await waitForHighwayReady();
        // Ensure viz plugin metadata is ready before buildFollowerLayout calls
        // populateSelect() — same guarantee startSplitScreen gives main panels.
        await _vizPluginsReady;
        // Honour the user's chosen layout (default 'follower' = single).
        // Pad cfgs with null so any extra slots get smart defaults inside
        // buildFollowerLayout.
        const needed = FOLLOWER_LAYOUT_PANELS[_followerLayoutKey] || 1;
        const padded = cfgs.slice();
        for (let i = padded.length; i < needed; i++) padded.push(null);
        buildFollowerLayout(padded, _followerLayoutKey);
        _buildFollowerToolbar();
    }

    function waitForHighwayReady() {
        return new Promise(resolve => {
            const info = highway.getSongInfo();
            if (info && info.arrangements && info.arrangements.length) {
                resolve();
                return;
            }
            const orig = highway._onReady;
            let resolved = false;
            highway._onReady = () => {
                if (orig) orig();
                highway._onReady = null;
                if (!resolved) { resolved = true; resolve(); }
            };
            let attempts = 0;
            const poll = setInterval(() => {
                attempts++;
                if (resolved || attempts > 60) { clearInterval(poll); if (!resolved) resolve(); return; }
                const i = highway.getSongInfo();
                if (i && i.arrangements && i.arrangements.length) {
                    clearInterval(poll);
                    if (!resolved) { resolved = true; resolve(); }
                }
            }, 100);
        });
    }

    // ── Follower layout state ─────────────────────────────────────────
    // The popup window can split itself the same way main can: 'follower'
    // (single full-window panel, default), 'top-bottom' (2 stacked),
    // 'left-right' (2 side-by-side), 'quad' (2x2). The layout is picked
    // from a selector in the popup's bottom toolbar.
    const FOLLOWER_LAYOUT_PANELS = {
        'follower':   1,
        'top-bottom': 2,
        'left-right': 2,
        'quad':       4,
    };
    let _followerLayoutKey = 'follower';
    const FOLLOWER_TOOLBAR_H = 32;

    // Convert a captured panel config (cfg) and arrIdx into the prefs
    // shape that initPanel expects.
    function _followerCfgToPrefs(cfg, arrIdx) {
        const arrName = (cfg.mode === 'lyrics') ? LYRICS_VALUE
            : (cfg.mode === 'jt') ? (JUMPING_TAB_VALUE + ':' + (arrangements[arrIdx]?.name || ''))
            : cfg.mode?.startsWith('viz:') ? (VIZ_PREFIX + ':' + cfg.mode.slice(4) + ':' + (arrangements[arrIdx]?.name || ''))
            : (arrangements[arrIdx]?.name || '');
        return {
            arrName,
            lyrics: true,
            inverted: !!cfg.inverted,
            detectChannel: 'mono',
            barHidden: false,
            mastery: Number.isFinite(cfg.mastery) ? cfg.mastery : 1,
        };
    }

    // Build N panels per `layoutKey` into the wrap div. `cfgs` is an array
    // of panel configs (one per slot); slots beyond cfgs.length get smart
    // defaults via getDefaultArrangements. Replaces the older single-panel
    // buildFollowerPanel so the popup can host any of the standard layouts.
    function buildFollowerLayout(cfgs, layoutKey) {
        layoutKey = FOLLOWER_LAYOUT_PANELS[layoutKey] ? layoutKey : 'follower';
        _followerLayoutKey = layoutKey;
        const panelCount = FOLLOWER_LAYOUT_PANELS[layoutKey];

        const info = highway.getSongInfo();
        if (info && info.arrangements) arrangements = info.arrangements;

        // Build the full-viewport wrap. Reuse the #splitscreen-wrap id so
        // any selectors elsewhere find it identically. We leave room at
        // the bottom for the follower toolbar.
        //
        // Block layout for single-panel mode, flex for multi-panel. With
        // a single child at width/height: 100%, the flexbox algorithm
        // doesn't reliably resolve the main-axis size — height: 100%
        // can collapse to the child's content height. That made the
        // panelDiv bounding rect 0-tall on first measure, the bar
        // (position:absolute; bottom:0) got clipped by the panel's
        // overflow:hidden, and the per-panel control bar appeared
        // missing. Block positioning (matches the original
        // buildFollowerPanel behavior) sizes height: 100% against the
        // position:fixed parent's definite dimensions cleanly. Multi-
        // panel layouts use 50% sizes which the flex algorithm resolves
        // fine, so they keep the flex container.
        const followerWrap = document.createElement('div');
        followerWrap.id = 'splitscreen-wrap';
        followerWrap.style.cssText =
            'position:fixed;top:0;left:0;right:0;bottom:' + FOLLOWER_TOOLBAR_H + 'px;' +
            'background:#000;z-index:9999;';
        if (layoutKey === 'top-bottom') {
            followerWrap.style.display = 'flex';
            followerWrap.style.flexDirection = 'column';
        } else if (layoutKey === 'left-right') {
            followerWrap.style.display = 'flex';
            followerWrap.style.flexDirection = 'row';
        } else if (layoutKey === 'quad') {
            followerWrap.style.display = 'flex';
            followerWrap.style.flexDirection = 'row';
            followerWrap.style.flexWrap = 'wrap';
        }
        // else: single (follower) — leave as block layout (no flex).
        document.body.appendChild(followerWrap);
        wrap = followerWrap;

        // Smart-default arrangement indices for slots beyond the explicit
        // cfgs (e.g. when user widens 1 → 4, slots 1..3 get lead/rhythm/bass
        // assignments via the same helper main uses).
        const defaultArrs = getDefaultArrangements(panelCount);

        for (let i = 0; i < panelCount; i++) {
            // Pick the layoutKey passed to createPanel so panel sizing is
            // correct: 'follower' for single, otherwise the layout name.
            const panelLayoutKey = (panelCount === 1) ? 'follower' : layoutKey;
            const parts = createPanel(i, followerWrap, panelLayoutKey);
            const hw = createHighway();
            const panel = Object.assign({ hw, arrIndex: 0 }, parts);

            // Same hw.resize override pattern startSplitScreen() uses.
            hw.resize = function () {
                const c = panel.canvas;
                if (!c) return;
                const rect = panel.panelDiv.getBoundingClientRect();
                const barH = panel.bar.style.display === 'none' ? 0 : (panel.bar.offsetHeight || 28);
                const w = rect.width;
                const h = Math.max(0, rect.height - barH);
                c.style.width = w + 'px';
                c.style.height = h + 'px';
                const scale = hw.getRenderScale();
                c.width = Math.round(w * scale);
                c.height = Math.round(h * scale);
            };

            panels.push(panel);

            // Pick this slot's config: explicit if cfgs has it, else smart default.
            const cfg = cfgs[i] || {
                arrangement: defaultArrs[i] || 0,
                mode: '2d',
                inverted: 0,
                mastery: 1,
            };
            const arrIdx = (cfg.arrangement >= 0 && cfg.arrangement < arrangements.length)
                ? cfg.arrangement : 0;
            initPanel(panel, arrIdx, _followerCfgToPrefs(cfg, arrIdx));

            // Wire the panel's bar-toggle button. startSplitScreen() does
            // this in main; follower-mode panels need the same hookup or
            // the per-panel ▾ Bar button is dead.
            panel.barToggleBtn.onclick = () => togglePanelBar(panel);
        }

        active = true;
        for (const p of panels) p.hw.resize();

        // Subscribe to the broadcast channel for time + song-change. Fans
        // out time updates to every panel; the listener captures `panels`
        // by reference so subsequent rebuilds (which mutate panels in
        // place via teardownPanels + push) automatically see new panels.
        const ch = _ssChannel();
        if (ch) {
            ch.onmessage = (ev) => {
                const msg = ev.data || {};
                if (msg.type === 'time' && Number.isFinite(msg.t)) {
                    _followerCurrentTime = msg.t;
                    for (const p of panels) {
                        if (!p.lyricsMode && !p.jumpingTabMode) p.hw.setTime(msg.t);
                    }
                    // Song-change toast lingers until playback begins.
                    _maybeDismissFollowerToastOnPlay(msg.t);
                } else if (msg.type === 'song-changed' && msg.filename && msg.filename !== currentFilename) {
                    _handleFollowerSongChange(msg.filename);
                }
            };
        }
    }

    // Bottom toolbar inside the popup window: layout picker + dock-all.
    // Built once per popup, the layout selector triggers rebuild of the
    // panel grid.
    let _followerToolbar = null;
    function _buildFollowerToolbar() {
        if (_followerToolbar) return _followerToolbar;
        const bar = document.createElement('div');
        bar.id = 'follower-toolbar';
        bar.style.cssText =
            'position:fixed;bottom:0;left:0;right:0;height:' + FOLLOWER_TOOLBAR_H + 'px;' +
            'display:flex;align-items:center;gap:10px;padding:0 10px;' +
            'background:rgba(8,8,16,0.95);border-top:1px solid #1f2937;' +
            'z-index:10001;font-family:sans-serif;color:#9ca3af;font-size:12px;';

        const label = document.createElement('span');
        label.textContent = 'Layout';
        label.style.cssText = 'font-size:11px;color:#6b7280;';
        bar.appendChild(label);

        const sel = document.createElement('select');
        sel.id = 'follower-layout-select';
        sel.style.cssText =
            'background:#1a1a2e;border:1px solid #333;border-radius:4px;' +
            'padding:3px 6px;font-size:12px;color:#ccc;outline:none;';
        const options = [
            { value: 'follower',   label: '⬜ Single' },
            { value: 'top-bottom', label: '⬒ Top/Bottom' },
            { value: 'left-right', label: '⬓ Left/Right' },
            { value: 'quad',       label: '⊞ Quad' },
        ];
        for (const o of options) {
            const opt = document.createElement('option');
            opt.value = o.value;
            opt.textContent = o.label;
            if (o.value === _followerLayoutKey) opt.selected = true;
            sel.appendChild(opt);
        }
        sel.onchange = () => rebuildFollowerLayout(sel.value);
        bar.appendChild(sel);

        document.body.appendChild(bar);
        _followerToolbar = bar;
        return bar;
    }

    // Rebuild the popup's panel grid into a new layout. Captures the
    // current panels' configs so existing slots survive the change; new
    // slots fill with smart defaults via getDefaultArrangements.
    function rebuildFollowerLayout(newLayoutKey) {
        if (!FOLLOWER_LAYOUT_PANELS[newLayoutKey]) return;
        if (newLayoutKey === _followerLayoutKey && panels.length === FOLLOWER_LAYOUT_PANELS[newLayoutKey]) return;

        // Capture current panel configs (in slot order) so the rebuilt
        // grid keeps existing arrangement / mode / inverted / mastery.
        const cfgs = panels.map(p => _captureFollowerConfig(p));

        teardownPanels();
        active = false;
        buildFollowerLayout(cfgs, newLayoutKey);
    }

    // Capture every popup panel's current state into an array of cfgs,
    // suitable for handing back to loadSongInFollower / buildFollowerLayout.
    // Reads from the live panels so any user changes since pop-out or
    // last layout change are honoured.
    function _captureAllFollowerConfigs() {
        return panels.map(p => _captureFollowerConfig(p));
    }

    // Rebuild the follower panels for a new song while preserving the
    // user's layout + per-panel mode + arrangement choices. Triggered by
    // the main window's `song-changed` broadcast.
    async function _handleFollowerSongChange(newFilename) {
        const cfgs = _captureAllFollowerConfigs();
        teardownPanels();
        active = false;
        await loadSongInFollower(newFilename, cfgs);
        // Briefly surface what the new song is so the popup viewer
        // (often on a second monitor, away from the main window's HUD)
        // sees the title / artist / tuning / per-panel arrangement
        // before notes start scrolling.
        _showFollowerSongToast(highway.getSongInfo());
    }

    // ── Song-change toast (popup only) ────────────────────────────────
    // An overlay shown right after _handleFollowerSongChange finishes
    // rebuilding the panels. Stays visible until the main window starts
    // playback (detected by time-broadcasts advancing past the baseline
    // captured at toast-creation). Replaces any prior toast in flight
    // so a rapid sequence of song changes doesn't pile up.
    const FOLLOWER_TOAST_FADE_MS = 400;
    // Time threshold (seconds) the broadcast `t` must exceed beyond the
    // baseline captured when the toast was shown, before we treat the
    // song as "started." 50ms covers floating-point slop and the 60Hz
    // broadcast interval (~17ms) without flapping.
    const FOLLOWER_TOAST_PLAY_THRESHOLD_S = 0.05;
    let _followerToast = null;
    let _followerToastBaselineTime = 0;

    // Common-tuning name resolver. Order-agnostic — works whether the
    // tuning array is high-to-low or low-to-high (we test both ends for
    // the drop pattern). Returns null for anything that isn't a flat
    // uniform offset or a one-string drop variant; the caller falls
    // back to displaying raw offsets in that case.
    function _resolveFollowerTuningName(tuning) {
        if (!Array.isArray(tuning) || tuning.length === 0) return null;
        const STANDARD_NAMES = {
            '0':  'E Standard',
            '-1': 'Eb Standard',
            '-2': 'D Standard',
            '-3': 'C# Standard',
            '-4': 'C Standard',
            '2':  'F# Standard',
        };
        const DROP_NAMES = {
            '0':  'Drop D',
            '-1': 'Drop Db',
            '-2': 'Drop C',
            '-3': 'Drop B',
            '-4': 'Drop Bb',
        };
        const allEqual = tuning.every(t => t === tuning[0]);
        if (allEqual) return STANDARD_NAMES[String(tuning[0])] || null;
        // One-string drop: low string is 2 semitones below an otherwise-
        // uniform offset. Test both possible orientations of the array.
        const last = tuning.length - 1;
        const headEqual = tuning.slice(0, last).every(t => t === tuning[0]);
        if (headEqual && tuning[last] === tuning[0] - 2) {
            return DROP_NAMES[String(tuning[0])] || null;
        }
        const tail = tuning.slice(1);
        const tailEqual = tail.every(t => t === tail[0]);
        if (tailEqual && tuning[0] === tail[0] - 2) {
            return DROP_NAMES[String(tail[0])] || null;
        }
        return null;
    }

    function _dismissFollowerToast() {
        if (!_followerToast) return;
        const toast = _followerToast;
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(-12px)';
        setTimeout(() => {
            if (_followerToast === toast) _followerToast = null;
            toast.remove();
        }, FOLLOWER_TOAST_FADE_MS);
    }

    // Called from the time-broadcast handler. Dismisses the toast the
    // first time the main window's audio.currentTime advances past the
    // baseline captured at toast-creation — i.e. play has actually
    // started. While main is paused at the new song's start (t = 0),
    // every broadcast carries the same t and the toast stays visible.
    function _maybeDismissFollowerToastOnPlay(t) {
        if (!_followerToast) return;
        if (t > _followerToastBaselineTime + FOLLOWER_TOAST_PLAY_THRESHOLD_S) {
            _dismissFollowerToast();
        }
    }

    function _showFollowerSongToast(info) {
        if (!info) return;
        // Replace any existing toast (rapid song-change sequence).
        if (_followerToast) { _followerToast.remove(); _followerToast = null; }

        const toast = document.createElement('div');
        toast.id = 'follower-song-toast';
        toast.style.cssText =
            'position:fixed;top:24px;left:50%;' +
            'transform:translateX(-50%) translateY(-12px);' +
            'min-width:280px;max-width:80vw;padding:14px 22px;' +
            'background:rgba(8,8,16,0.95);border:1px solid #4080e0;border-radius:8px;' +
            'box-shadow:0 6px 20px rgba(0,0,0,0.55);' +
            'z-index:10002;font-family:sans-serif;color:#e5e7eb;text-align:center;' +
            'opacity:0;transition:opacity ' + FOLLOWER_TOAST_FADE_MS + 'ms ease,' +
            'transform ' + FOLLOWER_TOAST_FADE_MS + 'ms ease;' +
            'pointer-events:none;';

        const title = document.createElement('div');
        title.style.cssText = 'font-size:18px;font-weight:600;color:#fff;line-height:1.25;';
        title.textContent = info.title || 'Untitled';
        toast.appendChild(title);

        if (info.artist) {
            const artist = document.createElement('div');
            artist.style.cssText = 'font-size:13px;color:#9ca3af;margin-top:2px;';
            artist.textContent = info.artist;
            toast.appendChild(artist);
        }

        const detailLines = [];
        const tuningName = _resolveFollowerTuningName(info.tuning);
        if (tuningName) detailLines.push('Tuning: ' + tuningName);
        else if (Array.isArray(info.tuning) && info.tuning.length > 0) {
            detailLines.push('Tuning: [' + info.tuning.join(', ') + ']');
        }
        if (Number.isFinite(info.capo) && info.capo > 0) detailLines.push('Capo: ' + info.capo);

        if (detailLines.length > 0) {
            const details = document.createElement('div');
            details.style.cssText = 'font-size:12px;color:#9ca3af;margin-top:8px;line-height:1.5;';
            details.textContent = detailLines.join(' · ');
            toast.appendChild(details);
        }

        // Per-panel arrangement breakdown — only shown when there are 2+
        // panels in the popup, since a single panel is self-evident
        // from the highway already visible behind the toast.
        if (panels.length > 1) {
            const panelInfo = document.createElement('div');
            panelInfo.style.cssText = 'font-size:11px;color:#9ca3af;margin-top:6px;line-height:1.4;';
            const panelLabels = panels.map((p, idx) => {
                const arrName = arrangements[p.arrIndex]?.name || 'Arr ' + p.arrIndex;
                const modeSuffix = p.lyricsMode ? ' (Lyrics)'
                    : p.jumpingTabMode ? ' (JT)'
                    : p.vizMode ? ' (' + (vizPlugins.find(vp => vp.id === p.vizMode)?.name || p.vizMode) + ')'
                    : '';
                return 'P' + (idx + 1) + ': ' + arrName + modeSuffix;
            });
            panelInfo.textContent = panelLabels.join(' · ');
            toast.appendChild(panelInfo);
        }

        document.body.appendChild(toast);
        _followerToast = toast;
        // Snapshot the current broadcast time so we can detect playback
        // starting later. While main is paused, time messages keep
        // arriving with this same value and the toast stays visible.
        _followerToastBaselineTime = _followerCurrentTime;

        // Animate in next frame so the initial opacity:0 / translateY
        // styles take effect before the transition kicks in.
        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateX(-50%) translateY(0)';
        });
    }

    // Kick off follower-mode bootstrap — placed at the very end of the IIFE
    // so all `let` bindings the function touches (e.g. _followerAudio) are
    // past their temporal dead zone by the time the function executes.
    if (FOLLOWER) bootFollowerMode();
})();
