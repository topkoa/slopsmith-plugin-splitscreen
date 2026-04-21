# Slopsmith Plugin: Split Screen

A plugin for [Slopsmith](https://github.com/byrongamatos/slopsmith) that shows 2–4 highway panels side-by-side during playback, each rendering a different arrangement of the same song. Practice lead and rhythm at once, watch bass against lead, or run a quad view of every arrangement a song has.

## Features

- **Three layouts** — Top/Bottom (2P), Left/Right (2P), and Quad (4P, 2×2 grid)
- **Per-panel arrangement selector** — each panel has its own dropdown; swap what it renders mid-playback without restarting the song
- **Per-panel invert toggle** — flip individual panels between player and audience perspective independently
- **Smart defaults** — opens with lead → rhythm → bass auto-assigned across panels when those arrangements exist, wrapping to fill the rest
- **Single shared audio** — all panels slave to the core `<audio>` element, so there's only one sound source and no drift between views
- **Live layout switching** — change layout from the player toolbar without reloading the song; existing arrangement selections are preserved when panel counts match

## Installation

```bash
cd /path/to/slopsmith/plugins
git clone https://github.com/topkoa/slopsmith-plugin-splitscreen.git splitscreen
docker compose restart
```

## Usage

1. Open any song in the player.
2. Click the **Split** button in the player toolbar to activate. The highway is replaced by your configured layout of panels.
3. Use each panel's dropdown to pick which arrangement it shows. Click **Invert** on a panel to flip just that one.
4. Click **Split** again to return to the single-highway view.

Split screen works with both PSARC and `.sloppak` songs — any song with more than one arrangement benefits.

## Settings

Open **Settings → Split Screen** to pick the default layout (Top/Bottom, Left/Right, or Quad). The choice is stored in `localStorage` as `splitscreenLayout` and applies the next time you toggle split screen on.

## How it works

Each panel is an independent highway instance:

1. Creates its own `<canvas>` and a fresh `Highway` via the core factory
2. Opens its own WebSocket to `/ws/highway/{filename}?arrangement={index}` so the server streams just that arrangement's notes/chords/beats
3. Overrides the highway's default `resize()` (which would size to the full window and clobber siblings) to size to its parent panel instead
4. Slaves its timeline to the shared core `<audio>` element — one sound source, N visualizers

On layout change, panels are torn down and rebuilt; arrangement selections are carried across when the new layout has at least as many panels as the old one. On player exit, `teardownPanels()` closes every WebSocket and removes the wrap div cleanly.

## Integrating Your Plugin With Split Screen

Split screen can host any visualization plugin as a per-panel pane mode — it appears as an option in each panel's arrangement dropdown and gets its own container, lifecycle, and preference persistence. Two plugins already integrate this way: the built-in **Lyrics** pane and [Jumping Tab](https://github.com/renanboni/slopsmith-plugin-jumpingtab).

To make your plugin compatible, you need to export a **factory function** on `window` and follow a simple contract.

### The Factory Contract

Split screen discovers your plugin at runtime by checking for a named factory function on `window`. If it exists, your plugin's options appear in the panel dropdown. If it doesn't (plugin not installed), everything degrades gracefully — no errors, no missing options.

Your factory must:

1. **Accept a `{ container }` argument** — `container` is a `<div>` that split screen creates and manages. Your plugin renders inside it. You do not create or position the container — split screen handles that.

2. **Return an object with `connect()`, `destroy()`, and `resize()` methods.**

```js
window.createMyVisualization = function ({ container }) {
    // Set up your renderer inside `container`.
    // Create your own canvas, DOM elements, etc. here.
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:100%;display:block;';
    container.appendChild(canvas);

    // Your internal state — must be independent per instance.
    // Split screen may create multiple instances simultaneously.
    let ws = null;
    let raf = null;
    let destroyed = false;

    function render() {
        if (destroyed) return;
        const audio = document.getElementById('audio');
        const now = audio ? audio.currentTime : 0;
        // ... draw your visualization using `now` ...
        raf = requestAnimationFrame(render);
    }

    return {
        // Called with the song filename and arrangement index.
        // Open your own WebSocket, fetch data, and start rendering.
        connect(filename, arrangementIndex) {
            // e.g. open ws://host/ws/highway/{filename}?arrangement={idx}
            // Parse incoming messages, populate your state, start RAF loop
        },

        // Called when the panel switches away from your mode, or on teardown.
        // You MUST clean up: cancel RAF, close WebSocket, remove DOM nodes.
        destroy() {
            destroyed = true;
            if (raf) { cancelAnimationFrame(raf); raf = null; }
            if (ws) { ws.close(); ws = null; }
            if (canvas.parentNode) canvas.remove();
        },

        // Called when the panel resizes (layout change, window resize).
        // Update your canvas backing store to match the new container size.
        resize() {
            const rect = canvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            canvas.width = Math.floor(rect.width * dpr);
            canvas.height = Math.floor(rect.height * dpr);
        },
    };
};
```

### Key Rules

| Rule | Why |
|------|-----|
| **No shared mutable state** | Split screen may create 2–4 instances of your factory at once (one per panel). Each must have its own canvas, WebSocket, RAF handle, and internal state. If your plugin uses module-level variables, use a context-swap pattern (see Jumping Tab's implementation) or refactor to closures. |
| **Own your WebSocket** | Each pane opens its own WebSocket to `/ws/highway/{filename}?arrangement={index}`. Do not reuse the main highway's connection — it may be stopped or pointed at a different arrangement. |
| **Sync to `<audio>` directly** | Read `document.getElementById('audio').currentTime` in your RAF loop. Do not rely on split screen calling `setTime()` — that's only for highway instances. Your pane manages its own timing. |
| **Clean up completely in `destroy()`** | Cancel your RAF, close your WebSocket, and remove any DOM nodes you created inside the container. Split screen removes the container div itself — you just need to clean up what you put in it. |
| **Handle `resize()` properly** | The container's dimensions change when the user switches layouts or resizes the browser. Update your canvas backing store (respecting `devicePixelRatio`) so the visualization stays crisp. |
| **No arrangement assumptions** | Your `connect()` receives an arrangement index. Honor it — don't hardcode index 0 or assume "Lead". |

### Registering With Split Screen

Once your factory exists, you need a small integration in split screen's `screen.js`. The pattern is:

**1. Define a sentinel value** for your mode (used in dropdown values and preference storage):
```js
const MY_VIZ_VALUE = '__my_viz__';
```

**2. Add options to `populateSelect()`** — one per arrangement, gated on your factory:
```js
if (typeof window.createMyVisualization === 'function') {
    arrangements.forEach((a, i) => {
        const opt = document.createElement('option');
        opt.value = MY_VIZ_VALUE + ':' + i;
        opt.textContent = (a.name || `Arr ${i}`) + ' (MyViz)';
        panel.select.appendChild(opt);
    });
}
```

**3. Add `enter` / `exit` functions** that mirror the lyrics pane pattern:
- `enterMyVizMode(panel)`: stop highway, hide canvas + buttons, create container, call factory, connect
- `exitMyVizMode(panel, arrIndex)`: destroy pane, restore canvas + buttons, reconnect highway

**4. Wire into the `select.onchange` handler, `initPanel()`, `teardownPanels()`, `savePanelPrefs()`, `captureCurrentPrefs()`, `sizeCanvases()`, and `startTimeSync()`** — each needs a branch or guard for your mode. Follow the existing jumping tab or lyrics patterns exactly.

### Testing Checklist

Before shipping, verify:

- [ ] Multiple panels can run your visualization simultaneously without interference
- [ ] Switching between your mode and highway/lyrics/jumping tab transitions cleanly
- [ ] `destroy()` leaves no orphaned RAF loops, WebSocket connections, or DOM nodes
- [ ] Preferences persist across songs (correct arrangement restores)
- [ ] Your dropdown options don't appear when your plugin is not installed
- [ ] Resizing the browser or switching layouts updates your canvas correctly

### Reference Implementations

- **Lyrics pane** — `createLyricsPane()` in [screen.js](screen.js) (~60 lines). Simplest example: DOM-based renderer, single WebSocket, RAF loop for karaoke highlighting.
- **Jumping Tab pane** — `window.createJumpingTabPane()` in the [Jumping Tab plugin](https://github.com/renanboni/slopsmith-plugin-jumpingtab). Canvas-based renderer with context-swapping to reuse existing draw functions across multiple instances.

### WebSocket Data Reference

The highway WebSocket (`/ws/highway/{filename}?arrangement={index}`) streams these messages in order:

| Message | Shape | Description |
|---------|-------|-------------|
| `song_info` | `{ type, title, artist, arrangement, duration, tuning }` | Song metadata and tuning array (6 elements for guitar, 4 for bass) |
| `sections` | `{ type, data: [{ time, name }] }` | Named sections (Intro, Verse, Chorus, etc.) |
| `notes` | `{ type, data: [{ t, s, f, sus, ho, po, sl, bn }] }` | Single notes — `t`=time, `s`=string, `f`=fret, `sus`=sustain, technique flags |
| `chords` | `{ type, data: [{ t, notes: [{ s, f, sus, ho, po, sl, bn }] }] }` | Chord events — each has a time and an array of per-string notes |
| `beats` | `{ type, data: [{ time, measure }] }` | Beat timestamps with measure numbers |
| `lyrics` | `{ type, data: [{ w, t, d }] }` | Syllables — `w`=word, `t`=time, `d`=duration. `-` joins to previous word, `+` marks line break |
| `ready` | `{ type: 'ready' }` | All data has been sent — safe to finalize and start rendering |

Messages arrive in the order listed above. Do not start rendering until you receive `ready`.

## Requirements

- Slopsmith with the highway factory (`createHighway()`) exposed on `window` — available in all recent builds
- A song with ≥2 arrangements to see any benefit; 1-arrangement songs simply render the same view in every panel

## Other Plugins

- [Stems](https://github.com/topkoa/slopsmith-plugin-stems) — live multi-stem mixer for `.sloppak` songs
- [Sloppak Converter](https://github.com/topkoa/slopsmith-plugin-sloppak-converter) — convert PSARCs into `.sloppak` files in-app

## License

MIT
