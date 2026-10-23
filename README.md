# Quinn Doom

A tiny first-person ASCII Doom-style shooter that runs inside the Linear web app as a userscript. Original rendering (raycaster) and no proprietary assets.

**Fully local:** no Linear API calls, no network requests, no storage, nothing written to issues or documents. Game state, input and rendering live in the page's memory and vanish when you close the panel.

## Install

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/) or Violentmonkey.
2. Create a new script and paste in the contents of [`linear-doom.user.js`](linear-doom.user.js) (or open the raw file on GitHub and let the manager offer to install it).
3. Open `https://linear.app`. A faint **DOOM** button appears at the bottom-left (also available from the manager's menu: *Play Quinn Doom*).

## Play

Click **DOOM**, then click the game panel so it has focus.

| Key | Action |
| --- | --- |
| W / ↑, S / ↓ | Move forward / back |
| A / ←, D / → | Turn left / right |
| Q / E | Strafe left / right |
| Space | Shoot (hold to auto-fire) |
| R or **Restart** | Restart |
| Esc or **Close** | Close the game |

Kill all 5 monsters (`M`); pick up `+` ammo and `H` health. Keys are handled only while the panel is focused, so typing in Linear's editors and inputs is never intercepted; click outside the panel (or close it) to return to Linear.

## Develop / test

```
npm test
```

Uses Node's built-in test runner against the game engine (the script exports it only under Node), plus a check that the script contains no network/storage calls or global key listeners. Requires Node 18+.
