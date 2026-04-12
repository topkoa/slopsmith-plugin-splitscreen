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

## Requirements

- Slopsmith with the highway factory (`createHighway()`) exposed on `window` — available in all recent builds
- A song with ≥2 arrangements to see any benefit; 1-arrangement songs simply render the same view in every panel

## Other Plugins

- [Stems](https://github.com/topkoa/slopsmith-plugin-stems) — live multi-stem mixer for `.sloppak` songs
- [Sloppak Converter](https://github.com/topkoa/slopsmith-plugin-sloppak-converter) — convert PSARCs into `.sloppak` files in-app

## License

MIT
