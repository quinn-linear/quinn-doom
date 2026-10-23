// ==UserScript==
// @name         Quinn Doom (pixel) for Linear
// @namespace    https://github.com/quinn-linear/quinn-doom
// @version      0.1.0
// @description  A tiny first-person pixel-art Doom-style raycaster shooter that renders inline in the issue description area on linear.app, entirely local.
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
      bob: 0,
      bobAmp: 0,
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
      game.bob = 0;
      game.bobAmp = 0;
      game.enemies = SPAWNS.map(([x, y]) => ({ x, y, hp: 3, cd: 1 + rng(), alive: true, pain: 0, atk: 0 }));
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
          return { dist: Math.min(dist, MAX_DEPTH), side, mx, my };
        }
      }
      return { dist: MAX_DEPTH, side, mx, my };
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
      const moving = f !== 0 || s !== 0;
      game.bobAmp += ((moving ? 1 : 0) - game.bobAmp) * Math.min(1, dt * 8);
      if (moving) game.bob += dt * 9;

      if (input.shoot) shoot();

      for (const e of game.enemies) {
        if (!e.alive) continue;
        e.pain = Math.max(0, e.pain - dt);
        e.atk = Math.max(0, (e.atk || 0) - dt);
        const dx = p.x - e.x, dy = p.y - e.y;
        const d = Math.hypot(dx, dy);
        e.cd -= dt;
        if (d > 0.9 && e.pain <= 0) {
          const v = 1.1 * dt;
          tryMove(e, (dx / d) * v, (dy / d) * v, 0.25);
        }
        if (d < 1.2 && e.cd <= 0) {
          e.cd = 1.0;
          e.atk = 0.3;
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

    reset();
    return game;
  }

  // -------------------------------------------------------------- renderer --
  // Pixel-art software raycaster. Draws into an RGBA byte buffer (e.g. canvas
  // ImageData.data). All textures and sprites are generated procedurally at
  // startup: no image files, no downloads, no external assets.

  const TEX = 64; // wall/floor texture size
  const SPR = 32; // sprite size

  function hash2(x, y, seed) {
    let h = (Math.imul(x + 101, 374761393) + Math.imul(y + 211, 668265263) + Math.imul(seed, 2147483647)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function makeTexture(seed, paint) {
    const d = new Uint8ClampedArray(TEX * TEX * 3);
    for (let y = 0; y < TEX; y++) {
      for (let x = 0; x < TEX; x++) {
        const c = paint(x, y, (hash2(x, y, seed) - 0.5) * 2);
        const i = (y * TEX + x) * 3;
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
      }
    }
    return d;
  }

  function buildTextures() {
    const brick = makeTexture(1, (x, y, n) => {
      const row = Math.floor(y / 16), off = row % 2 ? 16 : 0;
      const bx = (x + off) % 32, by = y % 16;
      if (by < 2 || bx < 2) return [55 + n * 8, 50 + n * 8, 48 + n * 8];
      const tone = hash2(Math.floor((x + off) / 32), row, 7) * 30;
      return [150 + tone + n * 18, 65 + tone * 0.4 + n * 10, 45 + n * 8];
    });
    const panel = makeTexture(2, (x, y, n) => {
      const seam = x % 32 < 2 || y % 32 < 2;
      const rivet = (x % 32 === 4 || x % 32 === 27) && (y % 32 === 4 || y % 32 === 27);
      if (rivet) return [170, 175, 185];
      if (seam) return [35, 40, 48];
      if (y >= 28 && y < 36) { // glowing teal strip
        const g = 1 - Math.abs(y - 31.5) / 4;
        return [30 + g * 20, 120 + g * 110, 120 + g * 100];
      }
      return [78 + n * 7, 88 + n * 7, 104 + n * 7];
    });
    const stone = makeTexture(3, (x, y, n) => {
      const bx = Math.floor(x / 21), by = Math.floor(y / 21);
      const edge = x % 21 === 0 || y % 21 === 0;
      const base = 95 + hash2(bx, by, 5) * 35;
      return edge ? [45, 45, 50] : [base + n * 14, base * 0.97 + n * 14, base * 0.9 + n * 12];
    });
    const floor = makeTexture(4, (x, y, n) => {
      const grout = x % 32 === 0 || y % 32 === 0;
      const alt = (Math.floor(x / 32) + Math.floor(y / 32)) % 2;
      if (grout) return [25, 22, 22];
      return alt ? [78 + n * 8, 66 + n * 8, 58 + n * 8] : [62 + n * 8, 54 + n * 8, 50 + n * 8];
    });
    const ceil = makeTexture(5, (x, y, n) => {
      const line = x % 32 < 1 || y % 32 < 1;
      return line ? [22, 24, 32] : [44 + n * 5, 48 + n * 5, 62 + n * 5];
    });
    return { walls: [brick, panel, stone], floor, ceil };
  }

  // Sprite painter: returns RGBA bytes (SPR x SPR) with transparent background.
  function makeSprite(paint, whiten) {
    const d = new Uint8ClampedArray(SPR * SPR * 4);
    const set = (x, y, c) => {
      if (x < 0 || y < 0 || x >= SPR || y >= SPR) return;
      const i = (y * SPR + x) * 4;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
    };
    const rect = (x0, y0, x1, y1, c) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c);
    };
    const ell = (cx, cy, rx, ry, c) => {
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
          const nx = (x - cx) / rx, ny = (y - cy) / ry, r2 = nx * nx + ny * ny;
          if (r2 > 1) continue;
          const f = (1 - 0.3 * (nx * 0.6 + ny * 0.8)) * (r2 > 0.75 ? 0.65 : 1);
          set(x, y, [c[0] * f, c[1] * f, c[2] * f]);
        }
      }
    };
    paint({ rect, ell });
    if (whiten) {
      for (let i = 0; i < d.length; i += 4) {
        if (!d[i + 3]) continue;
        d[i] += (255 - d[i]) * whiten; d[i + 1] += (255 - d[i + 1]) * whiten; d[i + 2] += (255 - d[i + 2]) * whiten;
      }
    }
    return d;
  }

  const SKIN = [150, 60, 42], DARK = [92, 30, 26], BONE = [225, 215, 175], EYE = [255, 232, 60];

  function demonSprite(mode, whiten) {
    return makeSprite(({ rect, ell }) => {
      const stepA = mode === 'walk1';
      rect(stepA ? 9 : 10, 22, stepA ? 13 : 14, 31, DARK); // legs
      rect(stepA ? 19 : 18, stepA ? 22 : 21, stepA ? 23 : 22, stepA ? 28 : 31, DARK);
      ell(16, 17, 8, 8, SKIN); // torso
      if (mode === 'atk') {
        rect(5, 6, 8, 16, SKIN); rect(24, 6, 27, 16, SKIN); // raised arms
        rect(4, 3, 5, 6, BONE); rect(8, 3, 9, 6, BONE); rect(23, 3, 24, 6, BONE); rect(27, 3, 28, 6, BONE);
      } else {
        rect(6, 13, 9, 24, SKIN); rect(23, 13, 26, 24, SKIN);
        rect(6, 25, 7, 27, BONE); rect(9, 25, 9, 27, BONE); rect(22, 25, 22, 27, BONE); rect(25, 25, 26, 27, BONE);
      }
      ell(16, 8, 5.5, 5.5, SKIN); // head
      rect(10, 1, 11, 5, BONE); rect(21, 1, 22, 5, BONE); // horns
      rect(12, 7, 14, 8, EYE); rect(18, 7, 20, 8, EYE);
      if (mode === 'atk') rect(13, 10, 19, 13, [60, 5, 5]); else rect(14, 11, 18, 11, DARK);
    }, whiten);
  }

  function corpseSprite() {
    return makeSprite(({ rect, ell }) => {
      ell(16, 28, 12, 3.5, [105, 28, 24]);
      ell(11, 26, 5, 2.5, SKIN);
      ell(21, 27, 4, 2, DARK);
      rect(8, 23, 9, 26, BONE); rect(23, 24, 24, 26, BONE);
    });
  }

  function pickupSprite(kind) {
    return makeSprite(({ rect }) => {
      if (kind === 'ammo') {
        rect(6, 16, 25, 29, [72, 92, 52]); rect(6, 16, 25, 17, [110, 130, 80]);
        rect(6, 21, 25, 22, [230, 190, 60]);
        for (let x = 8; x < 25; x += 4) rect(x, 24, x + 1, 28, [200, 160, 60]);
      } else {
        rect(6, 14, 25, 29, [232, 232, 232]); rect(6, 14, 25, 15, [255, 255, 255]);
        rect(6, 28, 25, 29, [170, 170, 170]);
        rect(14, 16, 17, 27, [200, 25, 25]); rect(9, 19, 22, 22, [200, 25, 25]);
      }
    });
  }

  function createRenderer(game, w, h) {
    const proj = (w / 2) / Math.tan(FOV / 2);
    const half = h / 2;
    const tex = buildTextures();
    const sprites = {
      walk0: demonSprite('walk0'), walk1: demonSprite('walk1'), atk: demonSprite('atk'),
      pain: demonSprite('walk0', 0.6), corpse: corpseSprite(),
      ammo: pickupSprite('ammo'), health: pickupSprite('health'),
    };
    const off = new Float32Array(w), cosOff = new Float32Array(w);
    for (let x = 0; x < w; x++) { off[x] = Math.atan((x + 0.5 - w / 2) / proj); cosOff[x] = Math.cos(off[x]); }
    const depth = new Float32Array(w);
    const dirx = new Float32Array(w), diry = new Float32Array(w);

    function draw(buf) {
      const p = game.player;
      const flick = 1 + 0.06 * Math.sin(game.time * 13) + 0.03 * Math.sin(game.time * 31);
      const flash = game.flash > 0 ? 1 : 0;
      const light = (d) => Math.max(0.04, Math.min(1.35, (1.5 / (1 + 0.09 * d * d)) * flick + (flash * 1.2) / (1 + 0.3 * d)));

      for (let x = 0; x < w; x++) {
        const a = p.a + off[x];
        dirx[x] = Math.cos(a); diry[x] = Math.sin(a);
      }

      // Floor and ceiling (perspective-correct texture casting).
      for (let y = Math.floor(half); y < h; y++) {
        const perp = (0.5 * proj) / (y + 0.5 - half);
        const yc = h - 1 - y;
        for (let x = 0; x < w; x++) {
          const dist = perp / cosOff[x];
          const wx = p.x + dirx[x] * dist, wy = p.y + diry[x] * dist;
          const tx = ((wx - Math.floor(wx)) * TEX) | 0, ty = ((wy - Math.floor(wy)) * TEX) | 0;
          const ti = (ty * TEX + tx) * 3, l = light(dist);
          let i = (y * w + x) * 4;
          buf[i] = tex.floor[ti] * l; buf[i + 1] = tex.floor[ti + 1] * l; buf[i + 2] = tex.floor[ti + 2] * l; buf[i + 3] = 255;
          i = (yc * w + x) * 4;
          buf[i] = tex.ceil[ti] * l; buf[i + 1] = tex.ceil[ti + 1] * l; buf[i + 2] = tex.ceil[ti + 2] * l; buf[i + 3] = 255;
        }
      }

      // Walls.
      for (let x = 0; x < w; x++) {
        const hit = game.cast(p.x, p.y, p.a + off[x]);
        const dist = Math.max(0.05, hit.dist * cosOff[x]);
        depth[x] = hit.dist >= MAX_DEPTH ? MAX_DEPTH : dist;
        if (hit.dist >= MAX_DEPTH) continue;
        const lineH = proj / dist, top = half - lineH / 2;
        const hx = p.x + dirx[x] * hit.dist, hy = p.y + diry[x] * hit.dist;
        let u = hit.side === 0 ? hy - Math.floor(hy) : hx - Math.floor(hx);
        if ((hit.side === 0 && dirx[x] > 0) || (hit.side === 1 && diry[x] < 0)) u = 1 - u;
        const t = tex.walls[(hit.mx * 7 + hit.my * 13 + 100) % 3];
        const tx = Math.min(TEX - 1, (u * TEX) | 0);
        const l = light(hit.dist) * (hit.side === 1 ? 0.72 : 1);
        const y0 = Math.max(0, Math.floor(top)), y1 = Math.min(h - 1, Math.ceil(top + lineH) - 1);
        for (let y = y0; y <= y1; y++) {
          const ty = Math.min(TEX - 1, (((y + 0.5 - top) / lineH) * TEX) | 0);
          const ti = (ty * TEX + tx) * 3, i = (y * w + x) * 4;
          buf[i] = t[ti] * l; buf[i + 1] = t[ti + 1] * l; buf[i + 2] = t[ti + 2] * l; buf[i + 3] = 255;
        }
      }

      // Sprites, far to near, clipped by the wall depth buffer.
      const list = [];
      game.enemies.forEach((e, n) => {
        let img = 'corpse', hs = 0.45;
        if (e.alive) {
          hs = 0.9;
          img = e.pain > 0 ? 'pain' : (e.atk > 0 ? 'atk' : (Math.floor(game.time * 4 + n) % 2 ? 'walk1' : 'walk0'));
        }
        list.push({ x: e.x, y: e.y, img, hs });
      });
      game.pickups.forEach((k) => { if (!k.taken) list.push({ x: k.x, y: k.y, img: k.kind, hs: 0.45 }); });
      list.forEach((s) => { s.d = Math.hypot(s.x - p.x, s.y - p.y); });
      list.sort((a, b) => b.d - a.d);
      for (const s of list) {
        let da = Math.atan2(s.y - p.y, s.x - p.x) - p.a;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        if (Math.abs(da) > 1.2) continue;
        const dist = s.d * Math.cos(da);
        if (dist < 0.25) continue;
        const sh = (proj / dist) * s.hs, sw = sh;
        const bottom = half + proj / (2 * dist), top = bottom - sh;
        const left = w / 2 + Math.tan(da) * proj - sw / 2;
        const data = sprites[s.img], l = light(s.d);
        const x0 = Math.max(0, Math.floor(left)), x1 = Math.min(w - 1, Math.ceil(left + sw) - 1);
        const y0 = Math.max(0, Math.floor(top)), y1 = Math.min(h - 1, Math.ceil(bottom) - 1);
        for (let x = x0; x <= x1; x++) {
          if (depth[x] < dist) continue;
          const sx = Math.min(SPR - 1, (((x + 0.5 - left) / sw) * SPR) | 0);
          for (let y = y0; y <= y1; y++) {
            const sy = Math.min(SPR - 1, (((y + 0.5 - top) / sh) * SPR) | 0);
            const si = (sy * SPR + sx) * 4;
            if (!data[si + 3]) continue;
            const i = (y * w + x) * 4;
            buf[i] = data[si] * l; buf[i + 1] = data[si + 1] * l; buf[i + 2] = data[si + 2] * l;
          }
        }
      }

      drawWeapon(buf);

      // Crosshair.
      const cx = Math.floor(w / 2), cy = Math.floor(half);
      const white = [255, 255, 255];
      blend(buf, cx - 5, cy, cx - 3, cy, white, 0.7); blend(buf, cx + 3, cy, cx + 5, cy, white, 0.7);
      blend(buf, cx, cy - 5, cx, cy - 3, white, 0.7); blend(buf, cx, cy + 3, cx, cy + 5, white, 0.7);

      // Full-screen tint for damage / game over.
      let tint = null, amt = 0;
      if (game.state === 'dead') { tint = [120, 0, 0]; amt = 0.55; }
      else if (game.state === 'won') { tint = [30, 130, 40]; amt = 0.25; }
      else if (game.hurt > 0) { tint = [255, 30, 30]; amt = 0.4 * (game.hurt / 0.25); }
      if (tint) {
        for (let i = 0; i < buf.length; i += 4) {
          buf[i] += (tint[0] - buf[i]) * amt; buf[i + 1] += (tint[1] - buf[i + 1]) * amt; buf[i + 2] += (tint[2] - buf[i + 2]) * amt;
        }
      }
    }

    function drawWeapon(buf) {
      const recoil = game.cooldown > 0 ? (game.cooldown / 0.3) * 14 : 0;
      const amp = game.bobAmp || 0;
      const cx = Math.round(w / 2 + Math.sin(game.bob) * 6 * amp);
      const oy = Math.round(Math.abs(Math.cos(game.bob)) * 4 * amp + recoil);
      const k = game.flash > 0 ? 1.25 : 0.8;
      const c = (r, g, b) => [r * k, g * k, b * k];
      const R = (x0, y0, x1, y1, col) => blend(buf, cx + x0, h + y0 + oy, cx + x1, h + y1 + oy, col, 1);
      R(-24, -18, -12, 8, c(205, 150, 120)); R(12, -18, 24, 8, c(205, 150, 120)); // hands
      R(-12, -16, 12, 8, c(112, 72, 42)); R(-12, -16, -10, 8, c(80, 50, 30)); // grip
      R(-14, -40, 14, -14, c(82, 84, 92)); R(-14, -40, 14, -38, c(135, 137, 146)); R(-14, -16, 14, -14, c(48, 50, 56)); // slide
      R(-5, -70, 5, -40, c(62, 64, 70)); R(-3, -70, -2, -40, c(120, 122, 132)); // barrel
      R(-6, -72, 6, -66, c(35, 35, 40)); // muzzle ring
      if (game.flash > 0) {
        const fy = h - 76 + oy;
        for (let r = 16; r > 0; r -= 4) {
          const col = r > 10 ? [255, 190, 60] : (r > 5 ? [255, 235, 140] : [255, 255, 230]);
          blend(buf, cx - r, fy - r, cx + r, fy + r, col, 0.55);
        }
        blend(buf, cx - 2, fy - 30, cx + 2, fy - 6, [255, 200, 80], 0.8);
        blend(buf, cx - 26, fy - 2, cx - 8, fy + 2, [255, 200, 80], 0.8);
        blend(buf, cx + 8, fy - 2, cx + 26, fy + 2, [255, 200, 80], 0.8);
      }
    }

    function blend(buf, x0, y0, x1, y1, col, a) {
      x0 = Math.max(0, Math.round(x0)); x1 = Math.min(w - 1, Math.round(x1));
      y0 = Math.max(0, Math.round(y0)); y1 = Math.min(h - 1, Math.round(y1));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = (y * w + x) * 4;
          buf[i] += (col[0] - buf[i]) * a; buf[i + 1] += (col[1] - buf[i + 1]) * a; buf[i + 2] += (col[2] - buf[i + 2]) * a;
        }
      }
    }

    return { draw, width: w, height: h };
  }

  // ----------------------------------------------------- page-aware helpers --
  // Pure functions (no globals) so they can be unit-tested in Node.

  const ROOT_ID = 'quinn-doom-root';
  const ISSUE_PATH = /^\/[^/]+\/issue\/([A-Za-z0-9]+-\d+)(?:\/|$)/;

  // Returns the issue identifier (e.g. "ENG-12") for an issue page path, else null.
  function issueKey(pathname) {
    const m = ISSUE_PATH.exec(pathname || '');
    return m ? m[1].toUpperCase() : null;
  }

  function labelOf(node) {
    const get = (n) => (node.getAttribute && node.getAttribute(n)) || '';
    return [get('aria-label'), get('aria-placeholder'), get('data-placeholder'), get('placeholder')].join(' ');
  }

  // Finds the issue description editor so the game can be mounted *next to* it.
  // We only read the DOM; the game is never placed inside the editor itself.
  function findDescriptionEditor(root) {
    const editors = Array.prototype.slice.call(
      root.querySelectorAll('[contenteditable="true"], [contenteditable=""]')
    ).filter((n) => !(n.closest && n.closest('#' + ROOT_ID)));
    if (!editors.length) return null;
    const labelled = editors.find((n) => /description/i.test(labelOf(n)));
    if (labelled) return labelled;
    const inBlock = editors.find((n) => n.closest && n.closest('[class*="escription"], [data-testid*="escription"]'));
    if (inBlock) return inBlock;
    // Fallback: the title is typically the first editable, the description the second.
    return editors.length >= 2 ? editors[1] : null;
  }

  // Inserts `node` as a sibling after the editor's wrapper, never inside the editable.
  function mountAfterEditor(editor, node) {
    const host = editor.parentElement && editor.parentElement.parentElement ? editor.parentElement : editor;
    if (!host.parentElement) return false;
    host.insertAdjacentElement('afterend', node);
    return true;
  }

  // Exposed for tests (Node only); the userscript has no other globals.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createGame, createRenderer, demonSprite, makeRng, MAP_SRC, issueKey, findDescriptionEditor, mountAfterEditor };
    return;
  }

  // -------------------------------------------------------------------- ui --

  const RES_W = 320, RES_H = 180;
  const LAUNCHER_ID = 'quinn-doom-launcher';
  let root = null, raf = 0, game = null, last = 0, watch = 0, mountedKey = null;
  const keys = new Set();

  function el(tag, css, text) {
    const n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text) n.textContent = text;
    return n;
  }

  function notify(msg) {
    const b = document.getElementById(LAUNCHER_ID);
    if (!b) return;
    b.textContent = msg;
    setTimeout(() => { b.textContent = 'DOOM'; }, 2500);
  }

  function close() {
    cancelAnimationFrame(raf);
    clearInterval(watch);
    keys.clear();
    if (root) root.remove();
    root = null;
    game = null;
    mountedKey = null;
  }

  // Runs while the game is open: closes it on SPA navigation or if the description
  // area disappears (Linear re-renders), and never leaves duplicates behind.
  function guard() {
    const key = issueKey(location.pathname);
    if (!root || key !== mountedKey || !root.isConnected) return close();
    const dupes = document.querySelectorAll('#' + ROOT_ID);
    for (let i = 0; i < dupes.length; i++) if (dupes[i] !== root) dupes[i].remove();
  }

  function open() {
    if (root) { root.focus(); return; }
    const key = issueKey(location.pathname);
    if (!key) return notify('Open an issue first');
    const editor = findDescriptionEditor(document);
    if (!editor) return notify('No description found');

    game = createGame({ seed: Date.now() });
    root = el('div',
      'display:block;box-sizing:border-box;width:fit-content;max-width:100%;margin:12px 0;background:#0b0b0b;color:#e8e8e8;' +
      'border:1px solid #b22;border-radius:6px;padding:8px;outline:none;overflow:auto;' +
      'font:12px/1 ui-monospace,Menlo,Consolas,monospace;user-select:none');
    root.id = ROOT_ID;
    root.tabIndex = 0;
    root.setAttribute('contenteditable', 'false');
    root.setAttribute('role', 'application');
    root.setAttribute('aria-label', 'Quinn Doom game');

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

    const stage = el('div', 'position:relative;width:' + RES_W * 2 + 'px;max-width:100%;background:#000;line-height:0');
    const screen = el('canvas', 'display:block;width:100%;height:auto;image-rendering:pixelated;image-rendering:crisp-edges');
    screen.width = RES_W;
    screen.height = RES_H;
    const overlay = el('div', 'position:absolute;left:0;right:0;top:40%;text-align:center;font:bold 20px/1.2 ui-monospace,Menlo,Consolas,monospace;color:#fff;text-shadow:0 2px 0 #000;pointer-events:none');
    stage.append(screen, overlay);
    const ctx = screen.getContext('2d');
    const image = ctx.createImageData(RES_W, RES_H);
    const renderer = createRenderer(game, RES_W, RES_H);
    const hud = el('div', 'margin-top:6px;white-space:pre');
    const help = el('div', 'margin-top:4px;color:#888', 'Click here to focus · WASD/arrows move+turn · Q/E strafe · Space shoot · R restart · Esc close');
    root.append(bar, stage, hud, help);
    if (!mountAfterEditor(editor, root)) { root = null; game = null; return notify('No description found'); }
    mountedKey = key;

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
    root.focus({ preventScroll: false });
    watch = setInterval(guard, 400);

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
      renderer.draw(image.data);
      ctx.putImageData(image, 0, 0);
      overlay.textContent = game.state === 'won' ? 'YOU WIN - press R' : (game.state === 'dead' ? 'YOU DIED - press R' : '');
      const alive = game.enemies.filter((e) => e.alive).length;
      hud.textContent = 'HEALTH ' + String(game.health).padStart(3) + '   AMMO ' + String(game.ammo).padStart(3) + '   ENEMIES ' + alive;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }

  // Launch button (inert until clicked) plus a userscript-manager menu entry.
  // It only starts the game; the game itself renders inline in the issue description area.
  function addLauncher() {
    if (document.getElementById(LAUNCHER_ID)) return;
    const b = el('button', 'position:fixed;left:8px;bottom:8px;z-index:2147483646;opacity:.6;background:#222;color:#f55;border:1px solid #555;border-radius:4px;padding:2px 6px;font:11px ui-monospace,monospace;cursor:pointer', 'DOOM');
    b.id = LAUNCHER_ID;
    b.type = 'button';
    b.title = 'Play Quinn Doom inline in the issue description area (local only)';
    b.addEventListener('click', open);
    document.body.appendChild(b);
  }
  addLauncher();
  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('Play Quinn Doom', open);
})();
