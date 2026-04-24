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

    let active = false;
    let layout = localStorage.getItem('splitscreenLayout') || 'top-bottom';
    let panels = [];       // { hw, canvas, ws, arrIndex, controls }
    let wrap = null;
    let currentFilename = null;
    let arrangements = []; // arrangement list from song_info

    // Focus-driven inter-plugin coordination. Wave C adds per-panel
    // setRenderer picker support; plugins like piano/drums that use
    // a MIDI / audio-input singleton across the page need to know
    // WHICH panel currently owns that singleton. The focused panel
    // is the one the user most recently clicked. When splitscreen
    // is inactive, focus is null and plugins fall back to their
    // single-instance fast path.
    let _focusedPanelIndex = null;
    const _focusBus = new EventTarget();

    // Cached /api/plugins response for the per-panel viz picker.
    // Lazily populated on first splitscreen start. Intersected with
    // `window.slopsmithViz_<id>` presence so the picker only lists
    // plugins whose factory actually loaded.
    let _vizPlugins = null;
    let _vizPluginsPromise = null;

    function _fetchVizPlugins() {
        if (_vizPlugins) return Promise.resolve(_vizPlugins);
        if (_vizPluginsPromise) return _vizPluginsPromise;
        _vizPluginsPromise = fetch('/api/plugins')
            .then(r => {
                if (!r.ok) throw new Error('[splitscreen] /api/plugins HTTP ' + r.status);
                return r.json();
            })
            .then(list => {
                _vizPlugins = (Array.isArray(list) ? list : [])
                    .filter(p => p && p.type === 'visualization')
                    .filter(p => typeof window['slopsmithViz_' + p.id] === 'function');
                return _vizPlugins;
            })
            .catch(e => {
                // Do NOT cache an empty result on failure — a 500
                // during app startup or a transient network blip
                // would otherwise wedge every subsequent panel-open
                // at "Highway only" until a full page reload.
                // Returning [] for the in-flight request is the
                // right graceful degradation; nulling
                // _vizPluginsPromise lets the NEXT call retry.
                console.warn('[splitscreen] /api/plugins fetch failed:', e);
                _vizPluginsPromise = null;
                return [];
            });
        return _vizPluginsPromise;
    }

    function setFocusedPanel(index) {
        if (!active) return;
        if (_focusedPanelIndex === index) return;
        const previous = _focusedPanelIndex;
        _focusedPanelIndex = index;
        // Visual indicator — accent the focused panel with a subtle
        // inner border. Cheap inline style update; no class / CSS
        // dependency.
        for (let i = 0; i < panels.length; i++) {
            const p = panels[i];
            if (!p || !p.panelDiv) continue;
            p.panelDiv.style.boxShadow = (i === index)
                ? 'inset 0 0 0 2px rgba(64,128,224,0.9)'
                : 'none';
            if (p.focusPill) {
                p.focusPill.style.display = (i === index) ? '' : 'none';
            }
        }
        _focusBus.dispatchEvent(new CustomEvent('focus-change', {
            detail: { newPanelId: index, previousPanelId: previous },
        }));
    }

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
        container.style.cssText =
            'position:absolute;top:0;left:0;right:0;bottom:0;z-index:3;display:flex;';
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
        panelDiv.style.cssText = 'position:relative;overflow:hidden;';

        if (layoutKey === 'quad') {
            panelDiv.style.width = '50%';
            panelDiv.style.height = '50%';
        } else if (layoutKey === 'left-right') {
            panelDiv.style.width = '50%';
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
            'display:flex;align-items:center;gap:6px;padding:4px 8px;' +
            'background:rgba(8,8,16,0.85);z-index:5;';

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

        // Per-panel viz picker (slopsmith#36 Wave C). Populated from
        // /api/plugins intersected with `window.slopsmithViz_<id>`
        // presence, plus a static "Highway" entry for the built-in
        // 2D renderer. Selection calls panel.hw.setRenderer(factory())
        // — or setRenderer(null) for "Highway". Populated in initPanel
        // once the cached plugin list resolves; the <select> is
        // inserted empty here so its DOM position is reserved.
        const vizSelect = document.createElement('select');
        vizSelect.style.cssText =
            'background:#1a1a2e;border:1px solid #333;border-radius:4px;' +
            'padding:2px 4px;font-size:11px;color:#ccc;outline:none;max-width:110px;';
        vizSelect.title = 'Visualization';
        const vizDefault = document.createElement('option');
        vizDefault.value = 'default';
        vizDefault.textContent = 'Highway';
        vizSelect.appendChild(vizDefault);
        bar.appendChild(vizSelect);

        // Focus pill — visible only on the currently-focused panel so
        // plugins that route MIDI / audio to the focused panel (piano,
        // drums under Wave C) have a clear user-facing signal about
        // which one owns the input. Hidden by default; setFocusedPanel
        // toggles display.
        const focusPill = document.createElement('span');
        focusPill.textContent = 'FOCUS';
        focusPill.style.cssText =
            'margin-left:4px;padding:1px 6px;border-radius:4px;' +
            'background:rgba(64,128,224,0.25);color:#8ab4ff;' +
            'font-size:9px;font-weight:bold;letter-spacing:0.5px;display:none;';
        bar.appendChild(focusPill);

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

        const invertBtn = makeToggleBtn('Invert', 'auto');
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

        // Per-panel master-difficulty slider (slopsmith#48 PR 3).
        // Volatile — resets to 100 each splitscreen session to avoid
        // stale state across layout changes (quad → 2-panel etc.).
        // Compact: no text label, `title` tooltip carries the current
        // value. Keeps the panel bar usable in quad layout.
        const difficultySlider = document.createElement('input');
        difficultySlider.type = 'range';
        difficultySlider.min = '0';
        difficultySlider.max = '100';
        difficultySlider.value = '100';
        difficultySlider.step = '5';
        difficultySlider.style.cssText = 'width:60px;accent-color:#4080e0;cursor:pointer;';
        difficultySlider.title = 'Difficulty: 100%';
        difficultySlider.setAttribute('aria-label', `Panel ${index + 1} difficulty`);
        bar.appendChild(difficultySlider);

        panelDiv.appendChild(bar);
        container.appendChild(panelDiv);

        // Click-to-focus. Listen on the panel root so anywhere inside
        // (canvas, control bar, etc.) counts as "user is interacting
        // with this panel." setFocusedPanel below short-circuits when
        // the index is already focused, so clicks inside controls
        // (including their own onclick handlers) don't thrash the
        // focus bus. Capture phase so the focus update lands before
        // the clicked element's own handler runs — matters for
        // plugins that read focus state during their click handler.
        panelDiv.addEventListener('click', () => setFocusedPanel(index), true);

        return {
            panelDiv, canvas, bar, select, arrName,
            vizSelect, focusPill,
            invertBtn, updateInvertStyle,
            lyricsBtn, updateLyricsStyle,
            tabBtn, updateTabStyle,
            difficultySlider,
        };
    }

    function sizeCanvases() {
        if (!wrap || !panels.length) return;
        const controls = document.getElementById('player-controls');
        const controlsH = controls ? controls.offsetHeight : 50;
        wrap.style.bottom = controlsH + 'px';
        for (const p of panels) p.hw.resize();
    }

    // ── Panel lifecycle ──
    function initPanel(panel, arrIndex) {
        panel.arrIndex = arrIndex;
        panel.hw.init(panel.canvas);

        // Populate arrangement dropdown
        panel.select.innerHTML = '';
        arrangements.forEach((a, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = a.name || `Arr ${i}`;
            if (i === arrIndex) opt.selected = true;
            panel.select.appendChild(opt);
        });

        panel.arrName.textContent = arrangements[arrIndex]?.name || '';

        panel.select.onchange = () => {
            const newIdx = parseInt(panel.select.value);
            switchPanelArrangement(panel, newIdx);
        };

        // Per-panel viz picker — requires slopsmith core with
        // setRenderer support (Wave A, slopsmith#84 onwards). Older
        // cores expose createHighway() without setRenderer; calling
        // it would throw and leave the panel's controls in a broken
        // state. Mirror the capability-check pattern used for the
        // lyrics and mastery controls: disable the <select> and
        // explain via tooltip.
        const hasSetRenderer = typeof panel.hw.setRenderer === 'function';
        if (!hasSetRenderer) {
            panel.vizSelect.disabled = true;
            panel.vizSelect.title =
                'Per-panel visualization requires a slopsmith core with setRenderer support';
            panel.vizSelect.style.opacity = '0.4';
        } else {
            // Populate asynchronously once /api/plugins has been
            // fetched (cached across panels). The "Highway" option
            // is already inserted statically so the picker has
            // something usable before the fetch resolves.
            _fetchVizPlugins().then(vizList => {
                if (!panels.includes(panel)) return;  // panel torn down
                // Clear any prior plugin entries (defensive; only the
                // static "default" option exists today, but a layout
                // rebuild could call initPanel on the same element).
                for (let i = panel.vizSelect.options.length - 1; i >= 0; i--) {
                    if (panel.vizSelect.options[i].value !== 'default') {
                        panel.vizSelect.remove(i);
                    }
                }
                for (const p of vizList) {
                    const opt = document.createElement('option');
                    opt.value = p.id;
                    opt.textContent = p.name || p.id;
                    panel.vizSelect.appendChild(opt);
                }
            });
        }

        panel.vizSelect.onchange = () => {
            if (!hasSetRenderer) return;
            const id = panel.vizSelect.value;
            if (id === 'default' || !id) {
                panel.hw.setRenderer(null);
                return;
            }
            const factory = window['slopsmithViz_' + id];
            if (typeof factory !== 'function') {
                console.error(
                    `[splitscreen] viz picker: factory slopsmithViz_${id} unavailable; ` +
                    `resetting panel ${panel._index + 1} to Highway`
                );
                panel.vizSelect.value = 'default';
                panel.hw.setRenderer(null);
                return;
            }
            let renderer;
            try { renderer = factory(); }
            catch (e) {
                console.error(`[splitscreen] viz picker: factory slopsmithViz_${id} threw:`, e);
                panel.vizSelect.value = 'default';
                panel.hw.setRenderer(null);
                return;
            }
            if (!renderer || typeof renderer.draw !== 'function') {
                console.error(
                    `[splitscreen] viz picker: factory slopsmithViz_${id} returned an invalid renderer`
                );
                panel.vizSelect.value = 'default';
                panel.hw.setRenderer(null);
                return;
            }
            panel.hw.setRenderer(renderer);
        };

        // Per-panel invert toggle
        panel.updateInvertStyle(panel.hw.getInverted());
        panel.invertBtn.onclick = () => {
            const on = !panel.hw.getInverted();
            panel.hw.setInverted(on);
            panel.updateInvertStyle(on);
        };

        // Per-panel lyrics toggle (uses highway factory's per-instance showLyrics)
        const hasLyricsApi = typeof panel.hw.setLyricsVisible === 'function';
        if (hasLyricsApi) {
            panel.updateLyricsStyle(panel.hw.getLyricsVisible());
            panel.lyricsBtn.onclick = () => {
                const on = !panel.hw.getLyricsVisible();
                panel.hw.setLyricsVisible(on);
                panel.updateLyricsStyle(on);
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

        // Per-panel master-difficulty (slopsmith#48 PR 3). The highway
        // factory's _mastery closure is per-instance, so setMastery on
        // one panel doesn't leak to the others. We deliberately don't
        // listen to the global `song:ready` event here (which would
        // mean calling window.slopsmith.on('song:ready', handler)):
        // every panel emits on the same bus, so a handler on one panel
        // would also fire for the others' ready events with their
        // hasPhraseData in the payload. The per-instance _onReady
        // callback slot is the right mechanism.
        const hasMasteryApi =
            typeof panel.hw.setMastery === 'function' &&
            typeof panel.hw.hasPhraseData === 'function';
        if (hasMasteryApi) {
            const applyMasteryAvailability = () => {
                const has = panel.hw.hasPhraseData();
                panel.difficultySlider.disabled = !has;
                panel.difficultySlider.title = has
                    ? `Difficulty: ${panel.difficultySlider.value}%`
                    : 'Source chart has a single difficulty level — slider disabled';
            };
            const syncMasteryFromSlider = () => {
                // Push the slider's UI value into the highway on each
                // ready so the two can't drift. Without this, if core's
                // default _mastery ever changes (or a future plugin
                // adjusts it pre-ready), the slider would show 100%
                // while the panel rendered filtered. Redundant-but-safe
                // on a fresh session (both sides already at 100%), and
                // correctly no-ops on arrangement switches where PR 2's
                // reconnect preserves _mastery at whatever the user
                // previously dragged to.
                const parsed = parseInt(panel.difficultySlider.value, 10);
                if (!Number.isFinite(parsed)) return;
                panel.hw.setMastery(Math.max(0, Math.min(100, parsed)) / 100);
            };
            panel.difficultySlider.oninput = () => {
                // parseInt + finite guard + clamp (pre-review lesson:
                // defensive numeric handling on any user/plugin input)
                const parsed = parseInt(panel.difficultySlider.value, 10);
                if (!Number.isFinite(parsed)) return;
                const pct = Math.max(0, Math.min(100, parsed));
                panel.hw.setMastery(pct / 100);
                // Only refresh the tooltip's value when phrase data is
                // available; otherwise leave the "disabled" explanation.
                if (panel.hw.hasPhraseData()) {
                    panel.difficultySlider.title = `Difficulty: ${pct}%`;
                }
            };
            // Set _onReady BEFORE connect so the hook is guaranteed to
            // be installed when the WebSocket's 'ready' message lands.
            // Preserve any existing _onReady (none expected today, but
            // future composition should chain rather than clobber).
            const prevOnReady = panel.hw._onReady;
            panel.hw._onReady = () => {
                if (prevOnReady) prevOnReady();
                syncMasteryFromSlider();
                applyMasteryAvailability();
            };
        } else {
            panel.difficultySlider.disabled = true;
            panel.difficultySlider.title =
                'Master-difficulty requires a slopsmith core with setMastery / hasPhraseData support';
            panel.difficultySlider.style.opacity = '0.4';
        }

        // Connect WebSocket
        panel.hw.connect(getWsUrl(currentFilename, arrIndex));
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

    function switchPanelArrangement(panel, arrIndex) {
        panel.arrIndex = arrIndex;
        panel.arrName.textContent = arrangements[arrIndex]?.name || '';
        // If panel was in tab mode, drop out — the loaded GP5 is for the old arrangement.
        if (panel.tabActive) togglePanelTab(panel);
        panel.hw.reconnect(currentFilename, arrIndex);
    }

    function teardownPanels() {
        // Emit a final focus-change BEFORE destroying the panels so
        // Wave C consumers (piano / drums MIDI routing etc.) have a
        // chance to detach from the panel they were routing to
        // while its DOM still exists. newPanelId: null signals "no
        // panel is focused anymore — unhook your singleton inputs".
        //
        // Clear _focusedPanelIndex BEFORE dispatching so the public
        // focusedPanelId() getter returns null during the handler
        // call, matching detail.newPanelId. Otherwise a consumer
        // that reads focusedPanelId() inside its focus-change
        // handler would see the OLD focused index while the event
        // payload claims the focus moved to null — an observable
        // inconsistency.
        const previous = _focusedPanelIndex;
        _focusedPanelIndex = null;
        if (previous !== null) {
            _focusBus.dispatchEvent(new CustomEvent('focus-change', {
                detail: { newPanelId: null, previousPanelId: previous },
            }));
        }
        for (const p of panels) {
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

    // ── Main toggle ──
    function rebuildLayout() {
        const wasActive = active;
        const oldArrangements = panels.map(p => p.arrIndex);
        teardownPanels();
        if (wasActive) startSplitScreen(oldArrangements);
    }

    function startSplitScreen(existingArrangements) {
        if (arrangements.length === 0) return;

        const cfg = LAYOUTS[layout];
        const container = createWrap();
        applyLayoutStyle(container, layout);

        // Determine arrangements for each panel
        const arrDefaults = existingArrangements && existingArrangements.length >= cfg.panels
            ? existingArrangements.slice(0, cfg.panels)
            : getDefaultArrangements(cfg.panels);

        for (let i = 0; i < cfg.panels; i++) {
            const parts = createPanel(i, container, layout);
            const hw = createHighway();
            const panel = Object.assign({ hw, arrIndex: 0, _index: i }, parts);

            // Override resize BEFORE init — highway's default sizes to full window,
            // which clobbers all panels to overlap. Size to parent panel instead.
            hw.resize = function () {
                const c = panel.canvas;
                if (!c) return;
                const rect = panel.panelDiv.getBoundingClientRect();
                const barH = panel.bar.offsetHeight || 28;
                const w = rect.width;
                const h = Math.max(0, rect.height - barH);
                c.style.width = w + 'px';
                c.style.height = h + 'px';
                const scale = hw.getRenderScale();
                c.width = Math.round(w * scale);
                c.height = Math.round(h * scale);
            };

            panels.push(panel);
            initPanel(panel, arrDefaults[i]);
        }

        // Hide default highway canvas, ensure controls stay on top
        const defaultCanvas = document.getElementById('highway');
        if (defaultCanvas) defaultCanvas.style.display = 'none';
        const controls = document.getElementById('player-controls');
        if (controls) controls.style.zIndex = '10';

        sizeCanvases();
        active = true;
        updateBtn();

        // Default focus to panel 0 so plugins that route MIDI / audio
        // to the focused panel have a sensible initial target. User
        // can click another panel to re-route at any time.
        _focusedPanelIndex = null;  // force setFocusedPanel to emit
        setFocusedPanel(0);

        // Hook into the time sync loop
        startTimeSync();
    }

    function stopSplitScreen() {
        teardownPanels();
        active = false;

        // Restore default highway canvas and controls z-index
        const defaultCanvas = document.getElementById('highway');
        if (defaultCanvas) defaultCanvas.style.display = '';
        const controls = document.getElementById('player-controls');
        if (controls) controls.style.zIndex = '';

        updateBtn();
        stopTimeSync();
    }

    function toggle() {
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
                p.hw.setTime(t);
            }
        }, 1000 / 60);
    }

    function stopTimeSync() {
        if (syncInterval) {
            clearInterval(syncInterval);
            syncInterval = null;
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

    // ── Toggle button ──
    function updateBtn() {
        const btn = document.getElementById('btn-splitscreen');
        if (btn) btn.className = active ? ON_CLASS : OFF_CLASS;
        if (layoutBtn) layoutBtn.style.display = active ? '' : 'none';
    }

    function injectBtn() {
        const c = document.getElementById('player-controls');
        if (!c || document.getElementById('btn-splitscreen')) return;
        const separator = c.querySelector('span.text-gray-700');
        const b = document.createElement('button');
        b.id = 'btn-splitscreen';
        b.className = OFF_CLASS;
        b.textContent = 'Split';
        b.title = 'Toggle split-screen multiplayer view';
        b.onclick = toggle;
        if (separator) c.insertBefore(b, separator);
        createLayoutBtn();
    }

    // ── Resize handler ──
    window.addEventListener('resize', () => {
        if (active) sizeCanvases();
    });

    // ── Hook into playSong ──
    const _play = window.playSong;
    window.playSong = async function (f, a) {
        // Teardown any active split screen before playing new song
        if (active) stopSplitScreen();
        await _play(f, a);

        currentFilename = f;
        // Wait for song_info to arrive so we have the arrangement list
        const origOnReady = highway._onReady;
        highway._onReady = () => {
            const info = highway.getSongInfo();
            if (info && info.arrangements) {
                arrangements = info.arrangements;
            }
            if (origOnReady) origOnReady();
            highway._onReady = null;
        };

        injectBtn();
    };

    // Clean up on screen change
    const _show = window.showScreen;
    window.showScreen = function (id) {
        if (id !== 'player' && active) stopSplitScreen();
        _show(id);
    };

    // ── Public surface for per-instance-aware viz plugins ──────────
    //
    // slopsmith#36 Wave C contract: when splitscreen is active, a
    // plugin can consult this surface to discover (a) that it's
    // running inside a panel rather than the main player, (b) which
    // panel currently has user focus, and (c) DOM anchors inside its
    // own panel's chrome for injecting per-instance UI (gear buttons,
    // settings strips, etc.).
    //
    // Gate on `isActive()` rather than presence — this object is
    // registered unconditionally once the plugin script loads, even
    // while splitscreen is toggled off. Plugins that subscribe to
    // onFocusChange and check isActive() at handler time get the
    // right behaviour; plugins that only existence-check would
    // unnecessarily disable their single-instance main-player
    // fast path just because the splitscreen plugin is installed.
    // Wave B plugins today don't consult this surface at all;
    // Wave C plugin PRs opt in.
    window.slopsmithSplitscreen = {
        // True while the splitscreen overlay is visible.
        isActive: () => active,

        // Numeric panel index (0-based) of the currently-focused
        // panel, or null when splitscreen is inactive. "Focus" here
        // is a splitscreen-local concept — the panel the user last
        // clicked, used to route MIDI / audio / other singletons to
        // a single panel when N panels all host the same plugin.
        focusedPanelId: () => active ? _focusedPanelIndex : null,

        // Subscribe / unsubscribe to focus-change events. Handler
        // receives a CustomEvent with
        // `detail = { newPanelId, previousPanelId }`. Plugins that
        // bind to a focused panel should re-attach on newPanelId
        // matches and detach on previousPanelId matches.
        onFocusChange: (fn) => _focusBus.addEventListener('focus-change', fn),
        offFocusChange: (fn) => _focusBus.removeEventListener('focus-change', fn),

        // Map a canvas element back to its panel's root DOM node.
        // Plugins that want to inject a per-instance UI affordance
        // (gear button, toggle, badge) use this to find the right
        // container — `#player-controls` is the main-player anchor
        // and doesn't exist per-panel.
        panelChromeFor: (canvasEl) => {
            if (!active || !canvasEl) return null;
            for (const p of panels) {
                if (p.canvas === canvasEl) return p.panelDiv;
            }
            return null;
        },

        // A specific element inside the panel's chrome that plugins
        // can append their gear / settings affordances to. Today
        // this is the panel's bottom control bar; callers should
        // insertBefore / appendChild as appropriate.
        settingsAnchorFor: (canvasEl) => {
            if (!active || !canvasEl) return null;
            for (const p of panels) {
                if (p.canvas === canvasEl) return p.bar;
            }
            return null;
        },

        // Imperative focus control — useful from a plugin's settings
        // UI where the user chose to route MIDI to a specific panel
        // via a dropdown rather than a click. Idempotent.
        // Range comparisons fall through silently for non-numerics
        // (NaN comparisons always yield false), so coerce to a
        // Number and require an integer before the range check to
        // reject `<select>` string values that failed to parse,
        // floating-point inputs, and arbitrary plugin-provided junk.
        setFocusedPanelId: (index) => {
            if (!active) return;
            const panelIndex = Number(index);
            if (!Number.isInteger(panelIndex)) return;
            if (panelIndex < 0 || panelIndex >= panels.length) return;
            setFocusedPanel(panelIndex);
        },
    };
})();
