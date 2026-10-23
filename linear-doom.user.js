// ==UserScript==
// @name         Quinn Doom (ASCII) for Linear
// @namespace    https://github.com/quinn-linear/quinn-doom
// @version      0.1.0
// @description  A tiny first-person ASCII Doom-style shooter that runs entirely in your browser tab on linear.app.
// @match        https://linear.app/*
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * Everything here is local: no network requests, no Linear API calls, no storage.
 * Keys are only handled while the game panel itself has focus.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- engine --

  const MAP_SRC = [
    '################',
    '#..............#',
    '#..##....##....#',
    '#..#......#....#',
    '#.........#..#.#',
    '#....##......#.#',
    '#....##........#',
    '#..#.......##..#',
    '#..#...........#',
    '#......#####...#',
    '#..............#',
    '################',
  ];
  const SPAWNS = [[13.5, 1.5], [13.5, 10.5], [8.5, 5.5], [2.5, 10.5], [6.5, 8.5]];
  const FOV = Math.PI / 3;
  const MAX_DEPTH = 16;
  const WALL_SHADES = '@#%*+=-:.';
  const FLOOR_SHADES = '.,-~:';
  const START_HEALTH = 100;
  const START_AMMO = 24;

  // Small deterministic PRNG so tests are reproducible.
  function makeRng(seed) {
    let s = seed >>> 0 || 1;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function createGame(opts) {
    opts = opts || {};
    const rng = opts.rng || makeRng(opts.seed || 1337);
    const map = MAP_SRC.map((r) => r.split(''));
    const game = {
      map,
      width: map[0].length,
      height: map.length,
      player: null,
      enemies: [],
      pickups: [],
      health: START_HEALTH,
      ammo: START_AMMO,
      kills: 0,
      state: 'playing', // playing | dead | won
      cooldown: 0,
      flash: 0,
      hurt: 0,
      time: 0,
    };

    function isWall(x, y) {
      const mx = Math.floor(x), my = Math.floor(y);
      if (my < 0 || my >= game.height || mx < 0 || mx >= game.width) return true;
      return map[my][mx] === '#';
    }
    game.isWall = isWall;

    function reset() {
      game.player = { x: 1.5, y: 1.5, a: 0.6 };
      game.health = START_HEALTH;
      game.ammo = START_AMMO;
      game.kills = 0;
      game.state = 'playing';
      game.cooldown = 0;
      game.flash = 0;
      game.hurt = 0;
      game.time = 0;
      game.enemies = SPAWNS.map(([x, y]) => ({ x, y, hp: 3, cd: 1 + rng(), alive: true, pain: 0 }));
      game.pickups = [
        { x: 8.5, y: 1.5, kind: 'ammo', taken: false },
        { x: 1.5, y: 8.5, kind: 'health', taken: false },
        { x: 14.5, y: 5.5, kind: 'ammo', taken: false },
        { x: 9.5, y: 10.5, kind: 'health', taken: false },
      ];
    }
    game.reset = reset;

    function tryMove(ent, dx, dy, radius) {
      if (!isWall(ent.x + dx + Math.sign(dx) * radius, ent.y)) ent.x += dx;
      if (!isWall(ent.x, ent.y + dy + Math.sign(dy) * radius)) ent.y += dy;
    }

    // Cast a ray; returns distance to wall and which side was hit.
    function cast(px, py, angle) {
      const dx = Math.cos(angle), dy = Math.sin(angle);
      let mx = Math.floor(px), my = Math.floor(py);
      const ddx = Math.abs(1 / (dx || 1e-9)), ddy = Math.abs(1 / (dy || 1e-9));
      const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
      let sdx = (dx < 0 ? px - mx : mx + 1 - px) * ddx;
      let sdy = (dy < 0 ? py - my : my + 1 - py) * ddy;
      let side = 0, dist = 0;
      while (dist < MAX_DEPTH) {
        if (sdx < sdy) { dist = sdx; sdx += ddx; mx += sx; side = 0; }
        else { dist = sdy; sdy += ddy; my += sy; side = 1; }
        if (my < 0 || my >= game.height || mx < 0 || mx >= game.width || map[my][mx] === '#') {
          return { dist: Math.min(dist, MAX_DEPTH), side };
        }
      }
      return { dist: MAX_DEPTH, side };
    }
    game.cast = cast;

    // input: {forward, strafe, turn} each in -1..1, shoot: bool
    function update(dt, input) {
      if (game.state !== 'playing') return;
      const p = game.player;
      game.time += dt;
      game.cooldown = Math.max(0, game.cooldown - dt);
      game.flash = Math.max(0, game.flash - dt);
      game.hurt = Math.max(0, game.hurt - dt);

      p.a += (input.turn || 0) * 2.4 * dt;
      const f = (input.forward || 0), s = (input.strafe || 0);
      const speed = 3.2 * dt;
      const mvx = (Math.cos(p.a) * f - Math.sin(p.a) * s) * speed;
      const mvy = (Math.sin(p.a) * f + Math.cos(p.a) * s) * speed;
      tryMove(p, mvx, mvy, 0.2);

      if (input.shoot) shoot();

      for (const e of game.enemies) {
        if (!e.alive) continue;
        e.pain = Math.max(0, e.pain - dt);
        const dx = p.x - e.x, dy = p.y - e.y;
        const d = Math.hypot(dx, dy);
        e.cd -= dt;
        if (d > 0.9 && e.pain <= 0) {
          const v = 1.1 * dt;
          tryMove(e, (dx / d) * v, (dy / d) * v, 0.25);
        }
        if (d < 1.2 && e.cd <= 0) {
          e.cd = 1.0;
          damage(8 + Math.floor(rng() * 5));
        }
      }

      for (const k of game.pickups) {
        if (k.taken || Math.hypot(k.x - p.x, k.y - p.y) > 0.6) continue;
        if (k.kind === 'ammo') { k.taken = true; game.ammo += 12; }
        else if (game.health < START_HEALTH) { k.taken = true; game.health = Math.min(START_HEALTH, game.health + 30); }
      }

      if (game.health <= 0) { game.health = 0; game.state = 'dead'; }
      else if (game.enemies.every((e) => !e.alive)) game.state = 'won';
    }
    game.update = update;

    function damage(n) {
      game.health -= n;
      game.hurt = 0.25;
    }
    game.damage = damage;

    // Hitscan: nearest living enemy within a small angular window and in line of sight.
    function shoot() {
      if (game.cooldown > 0 || game.ammo <= 0 || game.state !== 'playing') return false;
      game.cooldown = 0.3;
      game.ammo -= 1;
      game.flash = 0.08;
      const p = game.player;
      const wall = cast(p.x, p.y, p.a).dist;
      let best = null, bestD = Infinity;
      for (const e of game.enemies) {
        if (!e.alive) continue;
        const dx = e.x - p.x, dy = e.y - p.y;
        const d = Math.hypot(dx, dy);
        let da = Math.atan2(dy, dx) - p.a;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        // allow wider angle when close; 0.35 is roughly enemy radius
        if (Math.abs(Math.sin(da)) * d < 0.35 && Math.cos(da) > 0 && d < wall && d < bestD) {
          best = e; bestD = d;
        }
      }
      if (best) {
        best.hp -= 1;
        best.pain = 0.25;
        if (best.hp <= 0) { best.alive = false; game.kills += 1; }
        return true;
      }
      return false;
    }
    game.shoot = shoot;

    // Render to an array of strings (rows x cols).
    function render(cols, rows) {
      const p = game.player;
      const grid = [];
      for (let y = 0; y < rows; y++) grid.push(new Array(cols).fill(' '));
      const depth = new Array(cols).fill(MAX_DEPTH);

      for (let x = 0; x < cols; x++) {
        const ang = p.a - FOV / 2 + (x / cols) * FOV;
        const hit = cast(p.x, p.y, ang);
        // fisheye correction
        const dist = Math.max(0.05, hit.dist * Math.cos(ang - p.a));
        depth[x] = dist;
        const h = Math.min(rows, rows / dist);
        const top = Math.floor((rows - h) / 2), bot = Math.floor((rows + h) / 2);
        let idx = Math.min(WALL_SHADES.length - 1, Math.floor((dist / MAX_DEPTH) * WALL_SHADES.length * 1.6));
        if (hit.side === 1) idx = Math.min(WALL_SHADES.length - 1, idx + 1);
        const wc = hit.dist >= MAX_DEPTH ? ' ' : WALL_SHADES[idx];
        for (let y = 0; y < rows; y++) {
          if (y >= top && y < bot) grid[y][x] = wc;
          else if (y >= bot) {
            const t = (y - rows / 2) / (rows / 2);
            grid[y][x] = FLOOR_SHADES[Math.min(FLOOR_SHADES.length - 1, Math.floor((1 - t) * FLOOR_SHADES.length))];
          }
        }
      }

      // Sprites, far to near.
      const sprites = [];
      for (const e of game.enemies) if (e.alive) sprites.push({ x: e.x, y: e.y, ch: e.pain > 0 ? 'x' : 'M' });
      for (const k of game.pickups) if (!k.taken) sprites.push({ x: k.x, y: k.y, ch: k.kind === 'ammo' ? '+' : 'H', small: true });
      sprites.forEach((s) => { s.d = Math.hypot(s.x - p.x, s.y - p.y); });
      sprites.sort((a, b) => b.d - a.d);
      for (const s of sprites) {
        let da = Math.atan2(s.y - p.y, s.x - p.x) - p.a;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        if (Math.abs(da) > FOV / 2 + 0.3) continue;
        const dist = s.d * Math.cos(da);
        if (dist < 0.3) continue;
        const size = Math.min(rows, (rows / dist) * (s.small ? 0.35 : 0.8));
        const cx = Math.round((0.5 + da / FOV) * cols);
        const half = Math.max(0, Math.floor(size / 2));
        const cy = s.small ? Math.floor(rows / 2 + rows / dist / 4) : Math.floor(rows / 2);
        for (let x = cx - half; x <= cx + half; x++) {
          if (x < 0 || x >= cols || depth[x] < dist) continue;
          for (let y = cy - half; y <= cy + half; y++) {
            if (y >= 0 && y < rows) grid[y][x] = s.ch;
          }
        }
      }

      // Crosshair and muzzle flash.
      const mx = Math.floor(cols / 2), my = Math.floor(rows / 2);
      grid[my][mx] = '+';
      if (game.flash > 0) {
        for (let i = -2; i <= 2; i++) {
          const x = mx + i, y = rows - 2 - Math.abs(i);
          if (x >= 0 && x < cols && y >= 0) grid[y][x] = '*';
        }
      } else {
        const x = mx, y = rows - 1;
        grid[y][x] = '^';
        if (rows > 2) grid[y - 1][x] = '|';
      }
      return grid.map((r) => r.join(''));
    }
    game.render = render;

    reset();
    return game;
  }

  // Exposed for tests (Node only); the userscript has no other globals.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createGame, makeRng, MAP_SRC };
    return;
  }

  // -------------------------------------------------------------------- ui --

  const COLS = 80, ROWS = 28;
  const ROOT_ID = 'quinn-doom-root';
  let root = null, raf = 0, game = null, last = 0;
  const keys = new Set();

  function el(tag, css, text) {
    const n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text) n.textContent = text;
    return n;
  }

  function close() {
    cancelAnimationFrame(raf);
    keys.clear();
    if (root) root.remove();
    root = null;
    game = null;
  }

  function open() {
    if (root) { root.focus(); return; }
    game = createGame({ seed: Date.now() });
    root = el('div',
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#0b0b0b;color:#e8e8e8;' +
      'border:2px solid #b22;border-radius:6px;padding:8px;outline:none;box-shadow:0 8px 30px rgba(0,0,0,.6);' +
      'font:12px/1 ui-monospace,Menlo,Consolas,monospace;user-select:none');
    root.id = ROOT_ID;
    root.tabIndex = 0;
    root.setAttribute('role', 'application');
    root.setAttribute('aria-label', 'Quinn Doom ASCII game');

    const bar = el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px');
    const title = el('span', 'color:#f55;font-weight:bold', 'QUINN DOOM');
    const btns = el('span');
    const mk = (label, fn) => {
      const b = el('button', 'margin-left:6px;background:#222;color:#eee;border:1px solid #555;border-radius:3px;cursor:pointer;font:inherit;padding:2px 6px', label);
      b.type = 'button';
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    btns.append(mk('Restart', () => { game.reset(); root.focus(); }), mk('Close', close));
    bar.append(title, btns);

    const screen = el('pre', 'margin:0;font:inherit;line-height:1;letter-spacing:0;white-space:pre;color:#d8d8d8;background:#000;width:' + COLS + 'ch;height:' + ROWS + 'em;overflow:hidden');
    const hud = el('div', 'margin-top:6px;white-space:pre');
    const help = el('div', 'margin-top:4px;color:#888', 'Click here to focus · WASD/arrows move+turn · Q/E strafe · Space shoot · R restart · Esc close');
    root.append(bar, screen, hud, help);
    document.body.appendChild(root);

    // Key handling is scoped to the game panel, so Linear editors/inputs are never affected.
    const GAME_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'r', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'escape']);
    root.addEventListener('keydown', (e) => {
      if (e.target !== root || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (!GAME_KEYS.has(k)) return;
      e.preventDefault();
      e.stopPropagation();
      if (k === 'escape') return close();
      if (k === 'r') return game.reset();
      keys.add(k);
    });
    root.addEventListener('keyup', (e) => { keys.delete(e.key.toLowerCase()); });
    root.addEventListener('blur', () => keys.clear());
    root.addEventListener('mousedown', (e) => { if (e.target === root || e.target === screen) { e.preventDefault(); root.focus(); } });
    root.focus();

    last = performance.now();
    const frame = (now) => {
      if (!root) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const has = (...k) => k.some((x) => keys.has(x));
      game.update(dt, {
        forward: (has('w', 'arrowup') ? 1 : 0) - (has('s', 'arrowdown') ? 1 : 0),
        strafe: (has('e') ? 1 : 0) - (has('q') ? 1 : 0),
        turn: (has('d', 'arrowright') ? 1 : 0) - (has('a', 'arrowleft') ? 1 : 0),
        shoot: keys.has(' '),
      });
      const rows = game.render(COLS, ROWS);
      if (game.state !== 'playing') {
        const msg = game.state === 'won' ? ' YOU WIN - press R ' : ' YOU DIED - press R ';
        const r = Math.floor(ROWS / 2), c = Math.floor((COLS - msg.length) / 2);
        rows[r] = rows[r].slice(0, c) + msg + rows[r].slice(c + msg.length);
      }
      screen.textContent = rows.join('\n');
      screen.style.color = game.hurt > 0 ? '#f66' : '#d8d8d8';
      const alive = game.enemies.filter((e) => e.alive).length;
      hud.textContent = 'HEALTH ' + String(game.health).padStart(3) + '   AMMO ' + String(game.ammo).padStart(3) + '   ENEMIES ' + alive;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }

  // Launch button (inert until clicked) plus a userscript-manager menu entry.
  function addLauncher() {
    if (document.getElementById('quinn-doom-launcher')) return;
    const b = el('button', 'position:fixed;left:8px;bottom:8px;z-index:2147483646;opacity:.45;background:#222;color:#f55;border:1px solid #555;border-radius:4px;padding:2px 6px;font:11px ui-monospace,monospace;cursor:pointer', 'DOOM');
    b.id = 'quinn-doom-launcher';
    b.type = 'button';
    b.title = 'Play Quinn Doom (local ASCII game)';
    b.addEventListener('click', open);
    document.body.appendChild(b);
  }
  addLauncher();
  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('Play Quinn Doom', open);
})();
