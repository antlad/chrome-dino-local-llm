/**
 * Gameplay tests, run with `node --test`.
 *
 * These exercise the real game: real physics, real spawner, real collisions. The
 * physics engine has its own verifier in physics-check.mjs; this file is about
 * the rules on top of it, and about the things that only break once a renderer,
 * an input queue and a state machine are involved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Game, CONFIG } from '../src/game.js';
import { ObstacleField, makeRng } from '../src/obstacles.js';
import { PhysicsWorld } from '../src/physics.js';
import { Controller } from '../src/controller.js';
import { cactusCluster, pterodactylShape, segmentSpan } from '../src/shapes.js';

const SEEDS = [1, 7, 42, 101, 555, 2024, 31337];

function newGame(seed = 42) {
  const g = new Game({ seed });
  g.start();
  return g;
}

/** Run the autopilot for n ticks, returning the game. */
function drive(g, n) {
  for (let i = 0; i < n && g.state === 'running'; i++) g.autopilotStep();
  return g;
}

test('a dino with no input eventually dies to a cactus', () => {
  const g = new Game({ seed: 5 });
  g.start();
  let ticks = 0;
  while (g.state === 'running' && ticks < 2000) {
    g.step();
    ticks++;
  }
  assert.notEqual(g.state, 'running', 'standing still should not be survivable');
  assert.ok(g.lastCause, 'death must record a cause');
  assert.equal(g.lastCause.kind, 'cactus-small');
  assert.ok(g.score > 0, 'some score should have been earned on the way');
});

test('scoring tracks distance and is monotonic', () => {
  const g = newGame(9);
  let prev = 0;
  for (let i = 0; i < 600; i++) {
    g.autopilotStep();
    assert.ok(g.score >= prev, 'score went backwards');
    prev = g.score;
  }
  assert.ok(g.score >= 40, `expected a real score, got ${g.score}`);
  assert.equal(g.score, Math.floor(g.distance / 100));
});

test('crash kills the dino, records the contact, and stops scripted control', () => {
  const g = newGame(5);
  let ticks = 0;
  while (g.state === 'running' && ticks < 2000) {
    g.step();
    ticks++;
  }
  // The muscles fade out over a few frames rather than cutting instantly, so a
  // frame or two of life still reads on the way down.
  for (let i = 0; i < 12; i++) g.step();
  assert.equal(g.dino.alive, false);
  assert.equal(g.state, 'dead');
  assert.equal(g.dino.muscle, 0, 'muscles must have let go');
  assert.ok(g.dino.pelvis().invMass > 0, 'the root must be released from its pin');
  assert.ok(['cactus-small', 'cactus-large', 'pterodactyl'].includes(g.lastCause.kind));
  assert.ok(typeof g.lastCause.particle === 'string' && g.lastCause.particle.length > 0);
});

test('the corpse settles instead of jittering or sinking', () => {
  const g = newGame(5);
  let guard = 0;
  while (g.state === 'running' && guard++ < 2000) g.step();
  for (let i = 0; i < 400; i++) g.step();

  assert.equal(g.state, 'over');
  assert.equal(g.dino.settled, true, 'corpse should be flagged settled');
  assert.ok(g.world.totalKineticEnergy() < 0.5, 'corpse should not be buzzing');

  // The deepest point of the body, not the highest: penetration is measured by
  // the bottom of whichever particle sits lowest.
  let deepest = -Infinity;
  for (const p of g.world.particles) deepest = Math.max(deepest, p.y + p.radius);
  assert.ok(deepest <= CONFIG.groundY + 0.6, `something sank through the deck: ${deepest}`);
  assert.ok(deepest >= CONFIG.groundY - 1.5, 'the corpse should be lying on the deck, not hovering');
});

test('autopilot survives a long run on every seed', () => {
  for (const seed of SEEDS) {
    const g = newGame(seed);
    drive(g, 4000);
    assert.equal(
      g.state,
      'running',
      `seed ${seed} died at tick ${g.tick} to ${g.lastCause?.kind}/${g.lastCause?.particle}`
    );
    assert.ok(g.field.spawned > 8, `seed ${seed} should have seen obstacles`);
  }
});

test('same seed and same inputs give a bit-identical run', () => {
  const fingerprint = (seed) => {
    const g = new Game({ seed });
    g.start();
    for (let i = 0; i < 900 && g.state === 'running'; i++) g.autopilotStep();
    return JSON.stringify({
      tick: g.tick,
      score: g.score,
      state: g.state,
      cause: g.lastCause,
      particles: g.world.particles.map((p) => [p.x, p.y]),
    });
  };
  assert.equal(fingerprint(77), fingerprint(77));
  assert.equal(fingerprint(1234), fingerprint(1234));
  assert.notEqual(fingerprint(77), fingerprint(78), 'different seeds should diverge');
});

test('paused and ready states advance the body but not the world', () => {
  const g = new Game({ seed: 11 });
  const before = g.distance;
  for (let i = 0; i < 60; i++) g.step();
  assert.equal(g.distance, before, 'ready must not scroll the world');
  assert.ok(g.tick > 0, 'the body should still be simulated on the title screen');

  g.start();
  for (let i = 0; i < 60; i++) g.step();
  const moved = g.distance;
  assert.ok(moved > 0);
  g.pause(true);
  for (let i = 0; i < 60; i++) g.step();
  assert.equal(g.distance, moved, 'paused must freeze the world');
});

test('day and night alternate on a cycle', () => {
  const g = new Game({ seed: 3, config: { nightEvery: 200, nightLength: 120 } });
  g.start();
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    g.autopilotStep();
    seen.add(g.night);
  }
  assert.equal(seen.size, 2, 'both day and night should occur');
  assert.ok(g.nightPhase >= 0 && g.nightPhase <= 1);
});

test('high score survives a restart', () => {
  const g = newGame(5);
  let guard = 0;
  while (g.state === 'running' && guard++ < 3000) g.step();
  const best = g.highScore;
  assert.ok(best > 0);
  g.reset(6);
  g.start();
  assert.equal(g.score, 0);
  assert.equal(g.highScore, best, 'high score must persist across a reset');
});

test('obstacle geometry: extents and spans agree with their segments', () => {
  const rng = makeRng(9);
  const c = cactusCluster(3, true);
  const s = segmentSpan(c.segments);
  assert.ok(c.spanLeft <= 0, 'a cactus has arms reaching behind its trunk');
  assert.ok(c.spanRight > 0);
  assert.ok(c.height > 30 && c.height < 80, `cactus height off: ${c.height}`);

  const p = pterodactylShape(56, rng);
  assert.ok(p.spanLeft < -20, 'a pterodactyl tail sticks out behind the origin');
  assert.ok(p.spanRight > 30, 'and its beak well in front');
  assert.ok(p.height > 20 && p.height < 60);
});

test('the duck is short enough to clear a mid-height flyer', () => {
  const g = newGame(2);
  // Held through game.step(), which is what actually asks the body to crouch.
  // Calling setDuck directly gets overwritten by the per-tick intent.
  g.input.duck = true;
  // Let the gait settle before either measurement, or a mid-stride knee lift
  // reads as a change in height.
  for (let i = 0; i < 120; i++) g.step();
  const height = () =>
    CONFIG.groundY - Math.min(...g.dino.hitParticles().map((p) => p.y - p.radius));
  const ducking = height();

  g.input.duck = false;
  for (let i = 0; i < 120; i++) g.step();
  const standing = height();

  assert.ok(
    ducking < standing * 0.7,
    `duck only shaved ${standing.toFixed(1)} down to ${ducking.toFixed(1)}`
  );
  // The middle band starts 56 px above the deck, so the crouch has to beat that.
  assert.ok(ducking < 56, `crouched height ${ducking.toFixed(1)} still reaches the middle band`);
});

test('controller queues inputs onto tick boundaries', async () => {
  const g = new Game({ seed: 21 });
  const c = new Controller(g);
  g.start();
  const groundedBefore = g.dino.isGrounded();
  assert.ok(groundedBefore);

  c.press('jump');
  // Nothing moves until a tick is taken; press() must not step the world itself.
  assert.equal(g.tick, 0);
  await c.step(2);
  assert.equal(g.tick, 2);

  c.press('duck');
  await c.step(40);
  assert.equal(g.dino.ducking, true, 'duck should be held by the controller');

  c.press('unduck');
  await c.step(40);
  assert.equal(g.dino.ducking, false);
});

test('controller autopilot is what keeps the game alive under step()', async () => {
  const g = new Game({ seed: 6 });
  const c = new Controller(g);
  g.start();
  c.setAuto(true);
  assert.equal(g.auto, true, 'auto lives on the game so step() honours it');
  const state = await c.step(1500);
  assert.equal(state.state, 'running', JSON.stringify(state.cause));
  assert.ok(state.score > 10);
});

test('controller run() stops at game over and reports the cause', async () => {
  const g = new Game({ seed: 5 });
  const c = new Controller(g);
  g.start();
  const state = await c.run(3000);
  assert.equal(state.state, 'over');
  assert.ok(state.cause, 'cause should be reported');
  assert.match(state.cause.text, /struck the/);
});

test('controller restart gives a fresh deterministic run', async () => {
  const g = new Game({ seed: 5 });
  const c = new Controller(g);
  g.start();
  await c.step(300);
  c.reset(4242);
  assert.equal(g.state, 'ready');
  assert.equal(g.score, 0);
  g.start();
  c.setAuto(true);
  const a = await c.step(400);

  const g2 = new Game({ seed: 4242 });
  const c2 = new Controller(g2);
  g2.start();
  c2.setAuto(true);
  const b = await c2.step(400);
  assert.deepEqual(a.particles, b.particles);
  assert.equal(a.score, b.score);
});

test('hit test agrees with the colliders the solver uses', () => {
  const world = new PhysicsWorld({ groundY: CONFIG.groundY });
  const field = new ObstacleField(world, { groundY: CONFIG.groundY, seed: 3 });
  const o = field.spawn();
  o.x = 300;
  o.collider.x = 300;

  // A particle placed dead centre on the trunk must be reported as a hit.
  const inside = [{ x: 300, y: CONFIG.groundY - 20, radius: 6, id: 'probe' }];
  assert.ok(field.hitTest(inside), 'a body inside the cactus should register');

  const far = [{ x: 300, y: CONFIG.groundY - 300, radius: 6, id: 'probe' }];
  assert.equal(field.hitTest(far), null, 'a body clear above it should not');
});

test('the corpse tumbles from the impact instead of dropping in place', () => {
  // A body that simply fell straight down and lay flat is the other obvious tell
  // of a fake ragdoll. Death hands the body to the solver with the run momentum
  // it had plus the impact impulse, and it has to travel and rotate from there.
  //
  // Which *way* it goes is deliberately not asserted here. The dino is running
  // forward when it hits, so the corpse legitimately carries on past the cactus,
  // and the honest test for direction is the reversed-shove control in
  // physics-check.mjs, where the impulse is the only thing that differs between
  // two otherwise identical bodies. A fixed "ends up behind the cactus" bound
  // here was really a claim about the old conveyor-belt ground, not about the hit.
  const g = newGame(5);
  let guard = 0;
  while (g.state === 'running' && guard++ < 2000) g.step();
  const start = g.dino.comAtDeath;
  assert.ok(start, 'death should freeze the centre of mass to measure against');

  let spin = 0;
  let travel = 0;
  let prev = g.world.centerOfMass();
  for (let i = 0; i < 120; i++) {
    g.step();
    spin = Math.max(spin, Math.abs(g.world.angularMomentum(start)));
    const c = g.world.centerOfMass();
    travel += Math.hypot(c.x - prev.x, c.y - prev.y);
    prev = c;
  }
  assert.ok(travel > 60, `corpse should travel, measured ${travel.toFixed(0)} px`);
  assert.ok(spin > 20, `corpse should rotate, peak angular momentum ${spin.toFixed(0)}`);

  // And it has to come to rest inside the frame. A body that slides out of view
  // is the same bug wearing a different hat, so it is caught on the spot.
  for (let i = 0; i < 300; i++) g.step();
  const ps = g.dino.hitParticles();
  const left = Math.min(...ps.map((p) => p.x - p.radius));
  const right = Math.max(...ps.map((p) => p.x + p.radius));
  assert.ok(
    left > 0 && right < g.cfg.width,
    `corpse should stay on screen, measured ${left.toFixed(0)} .. ${right.toFixed(0)} of ${g.cfg.width}`
  );
});

test('the deck brakes on death instead of towing the corpse away', () => {
  // The deck is a treadmill: the runner holds a fixed screen x while the ground
  // and obstacles scroll beneath. That makes the ground a moving surface, and
  // friction pulls a body toward whatever the surface under it is doing, so a
  // belt that carried on running after a crash would tow the corpse off the left
  // of the screen forever, however well the body itself settled.
  //
  // The original freezes the world on a crash, so that is the contract: the deck
  // comes to a stop, and once it has, the corpse stops with it.
  const g = newGame(5);
  let guard = 0;
  while (g.state === 'running' && guard++ < 2000) g.step();
  assert.ok(g.deckSpeed > 3, 'should have been running on a moving deck');

  g.step();
  assert.equal(g.state, 'dead');
  let guard2 = 0;
  while (g.deckSpeed > 0 && guard2++ < 400) g.step();
  assert.equal(g.deckSpeed, 0, 'the deck should brake to a full stop');
  assert.ok(guard2 < 120, `the deck should stop quickly, took ${guard2} ticks`);

  // With the belt still, a long soak must not move the body. This is the exact
  // regression: a stale ground velocity kept a "settled" corpse sliding.
  //
  // The soak starts a couple of seconds after the crash rather than immediately,
  // because a body thrown off a moving belt genuinely does glide for a while, and
  // measuring the glide as if it were creep would make this test fail for the
  // wrong reason. What must not happen is motion that never ends.
  for (let i = 0; i < 400; i++) g.step();
  const before = g.world.centerOfMass();
  for (let i = 0; i < 300; i++) g.step();
  const after = g.world.centerOfMass();
  const drift = Math.hypot(after.x - before.x, after.y - before.y);
  assert.ok(
    drift < 8,
    `corpse should rest once the deck stops, drifted ${drift.toFixed(2)} px`
  );
  assert.ok(
    g.world.totalKineticEnergy() < 0.6,
    `corpse should be at rest, KE ${g.world.totalKineticEnergy().toFixed(4)}`
  );
});

test('every corpse comes to rest, not just the convenient one', () => {
  // A corpse that buzzes forever is the least obvious and most damaging failure
  // this simulation can have: it looks settled on screen, keeps a limb twitching
  // at a fixed energy indefinitely, and never reports `settled`. It is also
  // contact dependent, so it only shows up for the deaths where a limb lands
  // against an obstacle or another limb.
  //
  // Which is why this loops. The bug it caught lived for as long as it did behind
  // a single-seed assertion on a corpse that happened to land on clear deck. Ten
  // deaths, and three of them buzz.
  const seeds = [...SEEDS, 13, 3, 5];
  const failures = [];
  for (const seed of seeds) {
    const g = newGame(seed);
    let guard = 0;
    while (g.state === 'running' && guard++ < 2000) g.step();
    assert.notEqual(g.state, 'running', `seed ${seed} never died`);
    for (let i = 0; i < 600; i++) g.step();
    const ke = g.world.totalKineticEnergy();
    if (ke >= 0.25 || !g.dino.settled) {
      failures.push(`seed ${seed}: KE ${ke.toFixed(3)}, settled ${g.dino.settled}`);
    }
  }
  assert.deepEqual(failures, [], 'corpses still buzzing after 10 seconds');
});

test('spawn spacing never becomes impossible at top speed', () => {
  const world = new PhysicsWorld({ groundY: CONFIG.groundY });
  const field = new ObstacleField(world, { groundY: CONFIG.groundY, seed: 99 });
  // The body needs roughly this much clear deck to land from a full jump.
  const minGap = 240;
  let last = null;
  let worst = Infinity;
  for (let i = 0; i < 4000; i++) {
    const n = field.spawned;
    field.update(1, 13.2);
    if (field.spawned > n) {
      const o = field.list[field.list.length - 1];
      if (last) worst = Math.min(worst, o.x - (last.x + (last.spanRight ?? 0)));
      last = o;
    }
  }
  assert.ok(worst > minGap, `tightest gap was ${worst.toFixed(0)} px, jump needs ${minGap}`);
});

test('getState reports the ragdoll state a script needs', () => {
  const g = newGame(4);
  drive(g, 200);
  const s = g.getState();
  assert.equal(typeof s.score, 'number');
  assert.equal(s.state, 'running');
  assert.ok(s.dino.joints.spine, 'joint targets should be inspectable');
  assert.ok(Number.isFinite(s.dino.kineticEnergy));
  assert.equal(typeof s.dino.muscle, 'number');
});
