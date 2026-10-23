'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createGame } = require('../linear-doom.user.js');

const idle = { forward: 0, strafe: 0, turn: 0, shoot: false };

test('render returns rows x cols grid', () => {
  const g = createGame({ seed: 1 });
  const out = g.render(80, 28);
  assert.strictEqual(out.length, 28);
  assert.ok(out.every((r) => r.length === 80));
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
  for (const bad of ['fetch(', 'XMLHttpRequest', 'GM_xmlhttpRequest', 'localStorage', 'sessionStorage', 'WebSocket', 'sendBeacon', 'document.addEventListener', 'window.addEventListener']) {
    assert.ok(!src.includes(bad), 'found ' + bad);
  }
});
