# Split Screen Plugin — AI Agent Guide

All logic lives in a single IIFE in `screen.js`. There is no build step, no bundler, no imports. The plugin is loaded as a plain `<script>` tag by slopsmith core, which means every global it needs (`highway`, `createHighway`, `window.playSong`, `window.showScreen`) must already be on `window` when the script executes.

## Module structure

```
screen.js
├── Constants (LAYOUTS, OFF_CLASS, ON_CLASS, sentinel values)
├── Module-level state (active, controlsHidden, layout, panels, wrap, …)
├── Settings sync (reads settings.html checkboxes/selects on load)
├── Panel prefs persistence (savePanelPrefs, loadPanelPrefs, resolveArrIndex)
├── Helpers (getWsUrl, getDefaultArrangements)
├── createLyricsPane()           — self-contained lyrics renderer
├── Layout builders              — createWrap, applyLayoutStyle, createPanel, sizeCanvases
├── Panel lifecycle              — populateSelect, initPanel, enter*/exit* mode functions
├── Panel interactions           — togglePanelTab, toggleDetect, cycleDetectChannel, switchPanelArrangement
├── Teardown / rebuild           — teardownPanels, rebuildLayout, captureCurrentPrefs
├── Start / stop                 — startSplitScreen, stopSplitScreen, toggle
├── Time sync                    — startTimeSync, stopTimeSync
├── Toolbar buttons              — createLayoutBtn, createHideBtn, createFloatingShowBtn,
│                                  togglePanelBar, toggleControlsVisibility, updateBtn, injectBtn
└── Hooks into core              — wraps window.playSong, window.showScreen
```

## Constants

| Constant | Value | Purpose |
|---|---|---|
| `LAYOUTS` | object | Maps layout key → `{ panels: N, style }` |
| `OFF_CLASS` | Tailwind string | Inactive button style (used for Split btn) |
| `ON_CLASS` | Tailwind string | Active button style (used for Split btn) |
| `STORAGE_KEY` | `'splitscreenPanelPrefs'` | Per-panel prefs in localStorage |
| `LYRICS_VALUE` | `'__lyrics__'` | Sentinel for lyrics-only pane in dropdown/prefs |
| `JUMPING_TAB_VALUE` | `'__jumping_tab__'` | Sentinel for jumping tab pane |
| `VIZ_PREFIX` | `'__viz__'` | Prefix for generic viz-plugin entries. Select value: `__viz__:<pluginId>:<arrIndex>`; saved pref: `__viz__:<pluginId>:<arrName>` |
| `DETECT_CHANNEL_CYCLE` | `['mono','left','right']` | Channel cycle order |
| `DETECT_CHANNEL_LABELS` | `{mono:'M',left:'L',right:'R'}` | Channel button labels |

## Module-level state

| Variable | Type | Description |
|---|---|---|
| `active` | bool | Whether splitscreen is currently showing |
| `controlsHidden` | bool | Whether the global `#player-controls` bar is hidden |
| `layout` | string | Current layout key (`'top-bottom'`, `'left-right'`, `'quad'`) |
| `autoReactivate` | bool | Re-enter split on next song if it was active |
| `alwaysSplit` | bool | Auto-enter split on every song |
| `panels` | array | Live panel records (see Panel object shape below) |
| `wrap` | element\|null | The `#splitscreen-wrap` div, or null when inactive |
| `currentFilename` | string\|null | The filename passed to the last `playSong` call |
| `arrangements` | array | Arrangement list from the last `song_info` WebSocket message |
| `vizPlugins` | array | `{id, name, …}` entries from `/api/plugins` where `type==='visualization'` and the `slopsmithViz_<id>` factory is loaded. Populated once on page load via `fetchVizPlugins()`. |
| `syncInterval` | id\|null | The `setInterval` handle for the time sync loop |
| `layoutBtn` | element\|null | The layout `<select>` injected into `#player-controls` |
| `hideBtn` | element\|null | The `▾ Bar` button injected into `#player-controls` |
| `floatBtn` | element\|null | The floating `▴ Controls` restore button appended to `#player` |

## localStorage keys

| Key | What it stores |
|---|---|
| `splitscreenLayout` | Active layout key |
| `splitscreenAutoReactivate` | `'true'`/`'false'` |
| `splitscreenAlwaysSplit` | `'true'`/`'false'` |
| `splitscreenPanelPrefs` | JSON array of per-panel pref objects (see below) |
| `splitscreenControlsHidden` | `'true'`/`'false'` — whether bottom controls bar was hidden |

### Panel pref object shape (in `splitscreenPanelPrefs`)

```js
{
  arrName: string,       // arrangement name, or LYRICS_VALUE / JUMPING_TAB_VALUE:arrName / VIZ_PREFIX:pluginId:arrName
  lyrics: bool,          // per-panel highway lyrics toggle state
  inverted: bool,        // panel invert state
  detectChannel: string, // 'mono' | 'left' | 'right'
  barHidden: bool,       // whether the panel's mini control bar is hidden
}
```

Old `__3d_highway__:arrName` entries from pre-Wave C builds are migrated to `__viz__:highway_3d:arrName` on read by `migratePanelPrefs()`.

## Panel object shape

Each entry in `panels[]` is built with `Object.assign({ hw, arrIndex: 0 }, parts)` where `parts` comes from `createPanel()`. Properties set across the lifecycle:

```js
{
  // From createPanel():
  panelDiv,          // outer div.splitscreen-panel
  canvas,            // <canvas> for the highway
  bar,               // the mini control bar div (position:absolute, bottom:0)
  barToggleBtn,      // blue ▾/▴ Bar button (position:absolute, bottom:0, right:0, z-index:6)
  select,            // arrangement <select>
  arrName,           // <span> showing current arrangement name
  invertBtn,         // Invert toggle button
  updateInvertStyle, // fn(bool) — updates invertBtn appearance
  lyricsBtn,         // Lyrics toggle button
  updateLyricsStyle, // fn(bool)
  tabBtn,            // Tab toggle button
  updateTabStyle,    // fn(bool)
  detectBtn,         // Detect toggle button
  updateDetectStyle, // fn(bool)
  channelBtn,        // M/L/R channel button
  viewBtn,           // view button (hidden while any viz mode is active)

  // From startSplitScreen() / initPanel():
  hw,                // highway instance (createHighway())
  arrIndex,          // current arrangement index (integer)
  lyricsMode,        // bool — showing lyrics pane
  lyricsPane,        // { el, connect, destroy } | null
  jumpingTabMode,    // bool — showing jumping tab pane
  jumpingTabPane,    // pane object from createJumpingTabPane | null
  jumpingTabContainer, // the container div for the JT pane | null
  vizMode,           // string|null — plugin id of active viz renderer (e.g. 'highway_3d'), or null
  tabActive,         // bool — tab view overlay shown
  tabInstance,       // createTabView instance | null
  tabContainer,      // the container div for the tab view | null
  detectChannel,     // 'mono' | 'left' | 'right'
  detector,          // createNoteDetector instance | null
}
```

## Panel lifecycle

```
startSplitScreen()
  └─ createWrap()           — creates #splitscreen-wrap, inserts before #player-controls
  └─ applyLayoutStyle()     — sets flexDirection / flexWrap on the wrap
  └─ for each panel:
       createPanel()        — builds DOM (panelDiv, canvas, bar, buttons, barToggleBtn)
       createHighway()      — fresh highway instance from core
       hw.resize override   — sizes to panel BoundingClientRect minus bar height
       initPanel()          — sets mode booleans, wires button handlers, connects WebSocket
       barToggleBtn.onclick — wired after initPanel
       togglePanelBar()     — called if prefs.barHidden (restores hidden state)
  └─ sizeCanvases()         — sets wrap.style.bottom = controlsH, then hw.resize() each panel
  └─ startTimeSync()        — 60fps setInterval slaving panels to <audio>.currentTime

stopSplitScreen()
  └─ savePanelPrefs()
  └─ teardownPanels()       — destroys all sub-resources, removes wrap
  └─ restores #highway display, clears controls z-index / marginTop
  └─ if controlsHidden: restores controls display, resets controlsHidden = false
  └─ stopTimeSync()
```

## Panel render modes

Each panel is always in exactly one of these modes. Flags are mutually exclusive: entering one exits the others.

### Normal highway (default)
- `lyricsMode=false`, `jumpingTabMode=false`, `vizMode=null`
- `canvas` is visible, highway runs its default 2D renderer
- `hw.connect(wsUrl, { onSongInfo: () => {} })` — empty `onSongInfo` prevents clobbering the main player's HUD

### Lyrics pane (`lyricsMode=true`)
- Highway stopped (`hw.stop()`), `canvas` hidden
- `lyricsPane = createLyricsPane(panelDiv)` — self-contained div with its own WebSocket and rAF loop
- Invert / Lyrics / Tab buttons hidden while in this mode
- `lyricsPane.connect(filename, 0)` opens WS, listens only for `lyrics` messages

### Jumping Tab pane (`jumpingTabMode=true`)
- Highway stopped, `canvas` hidden
- `jumpingTabContainer` div appended to `panelDiv`
- `pane = window.createJumpingTabPane({ container })` — external plugin factory
- `pane.connect(filename, arrIndex)` — async, wrapped in try/catch
- Invert / Lyrics / Tab buttons hidden

### Viz renderer (`vizMode = pluginId string`)
- Highway NOT stopped — it stays alive with its WebSocket and rAF loop
- `panel.hw.setRenderer(window['slopsmithViz_' + pluginId]())` installs the renderer
- `canvas` stays visible (renderer draws to it)
- Tab / view buttons hidden; no per-panel settings bar shown (configure via global plugin settings)
- To exit: `panel.hw.setRenderer(null)` reverts to default 2D renderer
- **Canvas context-type lock:** the first `getContext('2d')` or `getContext('webgl')` call on a canvas locks it for its lifetime. Swapping renderers mid-session on the same canvas (e.g. 2D → WebGL → 2D) may not work without re-creating the canvas. The restore-on-load path is safe because `setRenderer` runs before `hw.init()`. For mid-session swaps between 2D and WebGL renderers, `recreatePanelHighway(panel)` is called first (same pattern as the arrangement-switch inside an already-active viz mode).

### Tab overlay (`tabActive=true`)
- Can coexist with normal highway mode (not with lyrics/JT/3D modes)
- `tabContainer` appended over the canvas (`z-index:2`)
- `createTabView({ container, getBeats, getCurrentTime })` — external plugin
- Canvas hidden while tab is active

## `sizeCanvases()` — call it whenever layout space changes

```js
function sizeCanvases() {
  wrap.style.bottom = controls.offsetHeight + 'px'; // respects hidden controls
  for (const p of panels) {
    if (p.jumpingTabMode && p.jumpingTabPane) p.jumpingTabPane.resize();
    else if (!p.lyricsMode) p.hw.resize();
  }
}
```

**Must be called after:**
- Splitscreen activates (inside `startSplitScreen`)
- The global controls bar is hidden/shown (`toggleControlsVisibility`)
- Window resize (`window.addEventListener('resize', ...)`)
- Layout change (`rebuildLayout`)

`hw.resize` for each panel is overridden to size the canvas to `panelDiv.getBoundingClientRect()` minus the bar height. When the bar is hidden (`bar.style.display === 'none'`), `barH = 0` and the canvas fills the full panel.

## Controls bar hide/show system

Two independent levels:

**Global controls bar** (`#player-controls`)
- `▾ Bar` button (`hideBtn`) injected into `#player-controls` right of the layout picker, inside a wrapper div that carries `ml-auto` (Close button is moved into the same wrapper so it stays rightmost)
- `toggleControlsVisibility()`: toggles `controlsHidden`, sets `controls.style.display`, saves to `splitscreenControlsHidden` in localStorage, calls `sizeCanvases()`, calls `updateBtn()`
- When hidden: floating `▴ Controls` pill (`floatBtn`) appears at `position:absolute; bottom:8px; right:8px; z-index:20` in `#player`
- `stopSplitScreen()` always restores controls and resets `controlsHidden = false`
- On next `startSplitScreen()`, reads `splitscreenControlsHidden` from localStorage and calls `toggleControlsVisibility()` if true

**Per-panel mini bar** (`panel.bar`)
- `barToggleBtn`: `position:absolute; bottom:0; right:0; z-index:6` — always on top of the bar
- `togglePanelBar(panel)`: toggles `bar.style.display`, updates button text/style, calls `hw.resize()` or `jumpingTabPane.resize()`, calls `savePanelPrefs()`
- State persisted in `barHidden` field of `splitscreenPanelPrefs`
- Restored in `startSplitScreen()` by calling `togglePanelBar(panel)` if `panelPrefs.barHidden`

## `playSong` wrapper and the `_onReady` race

The plugin wraps `window.playSong` to:
1. Stop any active splitscreen before the new song loads
2. Set `currentFilename` after the new song begins loading
3. Hook `highway._onReady` to grab `arrangements` and optionally auto-restart split

**The race:** async plugins (e.g. 3dhighway) can `await` inside the wrapper chain, allowing `ready` WebSocket messages to fire and clear `_onReady` before our hook runs. The poll fallback (checks every 200ms for up to 6 seconds) handles this case. Both paths set `handled = true` to ensure split is started at most once.

`injectBtn()` is called at the end of every `playSong` so the Split button is always present after the first song.

## DOM structure and z-index stack

```
#player  (position:fixed, inset:0, z-index:100)
  #highway              — default highway canvas, hidden when splitscreen active
  #splitscreen-wrap     — position:absolute, top:0, left:0, right:0, bottom:{controlsH}px, z-index:3
    .splitscreen-panel  — each panel, position:relative, overflow:hidden
      <canvas>          — the highway canvas
      .bar              — position:absolute, bottom:0, z-index:5
      .barToggleBtn     — position:absolute, bottom:0, right:0, z-index:6
      [lyricsPane div]  — position:absolute, inset:0, bottom:{barH}px (lyrics mode)
      [jtContainer div] — position:absolute, inset:0, bottom:{barH}px (jumping tab mode)
      [tabContainer]    — position:absolute, inset:0, bottom:{barH}px, z-index:2 (tab overlay)
  #player-controls      — position:relative, z-index:10, margin-top:auto (while splitscreen active)
  [floatBtn]            — position:absolute, bottom:8px, right:8px, z-index:20 (when bar hidden)
```

## External plugin integration points

The plugin capability-checks all external factories at runtime and gracefully disables the relevant button if the factory isn't loaded.

| Factory | Checked via | Used in |
|---|---|---|
| `window.createJumpingTabPane` | `typeof === 'function'` | `populateSelect()`, `enterJumpingTabMode()` |
| `window['slopsmithViz_' + id]` | resolved via `fetchVizPlugins()` | `populateSelect()`, `enterVizMode()` — auto-discovered for any `type=visualization` plugin |
| `window.createTabView` | `typeof === 'function'` | `initPanel()` (wires tabBtn) |
| `window.createNoteDetector` | `typeof === 'function'` | `initPanel()` (wires detectBtn/channelBtn) |

The `{ onSongInfo: () => {} }` passed to `hw.connect()` suppresses the default behavior where receiving `song_info` would overwrite the main player's HUD, audio element, and arrangement dropdown. This is required for every panel WebSocket connection. See slopsmith issue #27.

## Adding a new panel mode

Follow the lyrics/jumping-tab pattern:
1. Add a sentinel constant (e.g. `const MY_MODE_VALUE = '__my_mode__'`)
2. Add a factory check in `populateSelect()` and push options with the sentinel as value prefix
3. Write `enterMyMode(panel)` and `exitMyMode(panel, arrIndex)` — mirror the existing enter/exit pairs: hide/show appropriate buttons, manage your DOM nodes and lifecycle, call `savePanelPrefs()` at the end
4. Add the sentinel prefix to `resolveArrIndex()` so it returns -1 (not treated as an arrangement name)
5. Handle the value prefix in `panel.select.onchange` inside `initPanel()`
6. Add mode flag and resource fields to the `panel` object inside `initPanel()` (init them to `false`/`null`)
7. Tear down in `teardownPanels()` — destroy resources and null refs
8. Add the `arrName` encoding in `savePanelPrefs()` and `captureCurrentPrefs()`
9. Add pref restoration in `startSplitScreen()` (the block that builds `arrDefaults`)
10. Update `sizeCanvases()` if your mode needs its own resize path (like jumping tab does)

## Common pitfalls

- **`hw.resize` override must be set before `hw.init()`** — the override happens in `startSplitScreen()` before `initPanel()`. If you call `initPanel` first, the highway will size itself to the full window on init and clobber siblings.
- **Never use `margin-left:auto` on bar buttons** — the bar is `flex-wrap:nowrap;overflow:hidden`. Auto margins cause button positions to shift when the bar is toggled. All buttons are left-to-right; the `barToggleBtn` is absolutely positioned outside the flex flow.
- **`sizeCanvases()` uses `controls.offsetHeight`** — when the controls bar is hidden (`display:none`), `offsetHeight` returns 0 and `wrap.style.bottom` becomes `'0px'`, filling the full viewport. This is correct and intentional.
- **The `onSongInfo: () => {}` empty callback is mandatory** — omitting it causes every panel's WebSocket `song_info` message to overwrite the main player's audio `src`, arrangement dropdown, and HUD.
- **Plugin load order** — screen.js loads alphabetically. Plugins that wrap `playSong` before splitscreen (alphabetically earlier names) run closer to the original; later-loading plugins run first. This affects the `_onReady` hookup timing.
- **`currentFilename` may be percent-encoded** — always `decodeURIComponent(currentFilename)` before building URLs in pane plugins. `getWsUrl()` handles this internally for highway connections.
- **`rebuildLayout()` uses `captureCurrentPrefs()`** — this captures the live state of running panels. `savePanelPrefs()` also writes the same data to localStorage. They share the same object shape; `captureCurrentPrefs` just returns the array in memory instead of persisting it.

## Git and PR conventions

- All work goes on feature branches off `main` in this repo (`topkoa/slopsmith-plugin-splitscreen`)
- PRs target `topkoa/slopsmith-plugin-splitscreen` — NOT `byrongamatos/slopsmith-plugin-splitscreen` (the upstream)
- Use `gh pr create --repo topkoa/slopsmith-plugin-splitscreen --base main --head topkoa:<branch>` from inside the plugin directory
- Do not base feature branches on `upstream/main` — the fork and upstream can diverge; always branch from `origin/main`
