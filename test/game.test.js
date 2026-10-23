'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createGame } = require('../linear-doom.user.js');

const idle = { forward: 0, strafe: 0, turn: 0, shoot: false };

const { createRenderer } = require('../linear-doom.user.js');
const W = 160, H = 90;
function frame(g) {
  const buf = new Uint8ClampedArray(W * H * 4);
  createRenderer(g, W, H).draw(buf);
  return buf;
}
const px = (buf, x, y) => Array.from(buf.slice((y * W + x) * 4, (y * W + x) * 4 + 3));

test('renderer fills an opaque, textured frame deterministically', () => {
  const g = createGame({ seed: 1 });
  const a = frame(g), b = frame(g);
  assert.deepStrictEqual(a, b);
  const colors = new Set();
  for (let i = 0; i < a.length; i += 4) {
    assert.strictEqual(a[i + 3], 255);
    colors.add((a[i] << 16) | (a[i + 1] << 8) | a[i + 2]);
  }
  assert.ok(colors.size > 200, 'expected textured output, got ' + colors.size + ' colors');
});

test('renderer draws enemies, lighting flash and hurt tint', () => {
  const g = createGame({ seed: 1 });
  g.player.a = 0;
  g.enemies.forEach((e) => (e.alive = false));
  const empty = frame(g);
  g.enemies[0].alive = true;
  g.enemies[0].x = g.player.x + 2; g.enemies[0].y = g.player.y;
  const withEnemy = frame(g);
  assert.notDeepStrictEqual(withEnemy, empty);
  assert.notDeepStrictEqual(px(withEnemy, 72, 30), px(empty, 72, 30));
  g.flash = 0.08;
  const lit = frame(g);
  assert.ok(lit[(10 * W + 20) * 4] > withEnemy[(10 * W + 20) * 4], 'muzzle flash should brighten the scene');
  g.flash = 0; g.hurt = 0.25;
  const hurt = frame(g);
  assert.ok(hurt[(10 * W + 20) * 4] > withEnemy[(10 * W + 20) * 4] + 20, 'hurt should tint red');
});

test('weapon animates with recoil', () => {
  const g = createGame({ seed: 1 });
  g.enemies.forEach((e) => (e.alive = false));
  const idleF = frame(g);
  g.cooldown = 0.3;
  const recoil = frame(g);
  assert.notDeepStrictEqual(idleF.slice(70 * W * 4), recoil.slice(70 * W * 4));
});

test('walls occlude sprites', () => {
  const g = createGame({ seed: 1 });
  g.player = { x: 1.5, y: 1.5, a: Math.PI };
  g.enemies.forEach((e) => (e.alive = false));
  const a = frame(g);
  g.enemies[0] = { x: -3, y: 1.5, hp: 3, cd: 9, alive: true, pain: 0, atk: 0 };
  assert.deepStrictEqual(frame(g), a);
});

test('player cannot walk through walls', () => {
  const g = createGame({ seed: 1 });
  g.enemies.forEach((e) => (e.alive = false));
  g.player.a = Math.PI; // face west wall
  for (let i = 0; i < 200; i++) g.update(0.05, { ...idle, forward: 1 });
  assert.ok(!g.isWall(g.player.x, g.player.y));
  assert.ok(g.player.x > 1);
});

test('shooting consumes ammo and kills an enemy in front', () => {
  const g = createGame({ seed: 1 });
  g.player.a = 0;
  g.enemies = [{ x: g.player.x + 3 * Math.cos(g.player.a), y: g.player.y + 3 * Math.sin(g.player.a), hp: 2, cd: 9, alive: true, pain: 0 }];
  const ammo = g.ammo;
  assert.ok(g.shoot());
  assert.strictEqual(g.ammo, ammo - 1);
  g.cooldown = 0;
  g.shoot();
  assert.strictEqual(g.enemies[0].alive, false);
  assert.strictEqual(g.kills, 1);
});

test('cannot shoot through walls or without ammo', () => {
  const g = createGame({ seed: 1 });
  g.player = { x: 1.5, y: 1.5, a: Math.PI };
  g.enemies = [{ x: -5, y: 1.5, hp: 1, cd: 9, alive: true, pain: 0 }];
  assert.strictEqual(g.shoot(), false);
  g.ammo = 0; g.cooldown = 0;
  assert.strictEqual(g.shoot(), false);
  assert.strictEqual(g.ammo, 0);
});

test('enemies damage the player, death state and restart', () => {
  const g = createGame({ seed: 1 });
  g.enemies.forEach((e) => { e.x = g.player.x + 0.5; e.y = g.player.y; e.cd = 0; });
  for (let i = 0; i < 400 && g.state === 'playing'; i++) g.update(0.05, idle);
  assert.strictEqual(g.state, 'dead');
  g.reset();
  assert.strictEqual(g.state, 'playing');
  assert.strictEqual(g.health, 100);
  assert.strictEqual(g.enemies.filter((e) => e.alive).length, 5);
});

test('win when all enemies are dead', () => {
  const g = createGame({ seed: 1 });
  g.enemies.forEach((e) => (e.alive = false));
  g.update(0.05, idle);
  assert.strictEqual(g.state, 'won');
});

test('userscript makes no network or storage calls', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'linear-doom.user.js'), 'utf8');
  const body = src.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, '');
  assert.ok(!/https?:\/\//.test(body), 'no URLs in script body');
  for (const bad of ['new Image', 'Image(', 'importScripts', 'fetch(', 'XMLHttpRequest', 'GM_xmlhttpRequest', 'localStorage', 'sessionStorage', 'WebSocket', 'sendBeacon', 'document.addEventListener', 'window.addEventListener']) {
    assert.ok(!src.includes(bad), 'found ' + bad);
  }
});

const { issueKey, findDescriptionEditor, mountAfterEditor } = require('../linear-doom.user.js');

test('issueKey recognises issue pages only', () => {
  assert.strictEqual(issueKey('/acme/issue/ENG-12/some-title'), 'ENG-12');
  assert.strictEqual(issueKey('/acme/issue/eng-12'), 'ENG-12');
  assert.strictEqual(issueKey('/acme/team/ENG/active'), null);
  assert.strictEqual(issueKey('/'), null);
  assert.strictEqual(issueKey(undefined), null);
});

function fakeEditor(attrs, opts) {
  opts = opts || {};
  return {
    getAttribute: (n) => attrs[n] || '',
    closest: (sel) => (sel.includes('escription') && opts.inDescription ? {} : null),
  };
}
const fakeRoot = (list) => ({ querySelectorAll: () => list });

test('findDescriptionEditor prefers labelled editor, handles none/one', () => {
  const title = fakeEditor({ 'aria-label': 'Issue title' });
  const desc = fakeEditor({ 'data-placeholder': 'Add description…' });
  const comment = fakeEditor({ 'aria-label': 'Leave a comment' });
  assert.strictEqual(findDescriptionEditor(fakeRoot([title, comment, desc])), desc);
  assert.strictEqual(findDescriptionEditor(fakeRoot([])), null);
  assert.strictEqual(findDescriptionEditor(fakeRoot([title])), null);
  assert.strictEqual(findDescriptionEditor(fakeRoot([title, comment])), comment); // positional fallback
  const wrapped = fakeEditor({}, { inDescription: true });
  assert.strictEqual(findDescriptionEditor(fakeRoot([title, comment, wrapped])), wrapped);
});

test('mountAfterEditor inserts a sibling outside the editable', () => {
  const calls = [];
  const wrapper = { parentElement: {}, insertAdjacentElement: (pos, n) => calls.push([pos, n]) };
  const editor = { parentElement: Object.assign(wrapper, { parentElement: {} }) };
  wrapper.parentElement = { };
  editor.parentElement = wrapper;
  const node = {};
  assert.ok(mountAfterEditor(editor, node));
  assert.deepStrictEqual(calls, [['afterend', node]]);
  assert.strictEqual(mountAfterEditor({ parentElement: null, insertAdjacentElement() {} }, node), false);
});

test('userscript inline mount does not write into the editor or use history hooks', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'linear-doom.user.js'), 'utf8');
  for (const bad of ['execCommand', 'innerHTML', 'history.pushState', 'history.replaceState', 'position:fixed;right']) {
    assert.ok(!src.includes(bad), 'found ' + bad);
  }
});
