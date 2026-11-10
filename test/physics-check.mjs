// Headless rig for tuning the ragdoll without a browser.
//
//   node test/physics-check.mjs            # run all probes, print a table
//   node test/physics-check.mjs --frames   # print an ASCII pose timeline
//
// Everything here is the same code the browser runs: there is no fake physics
// stand-in, so a number that looks right here looks right on screen.

import { PhysicsWorld, angleAt, wrapAngle } from '../src/physics.js';
import { DinoRagdoll, SKELETON, NEUTRAL } from '../src/ragdoll.js';

const GROUND = 372;

function makeWorld(opts = {}) {
  return new PhysicsWorld({
    gravity: 0.9,
    damping: 0.992,
    iterations: 7,
    substeps: 1,
    groundY: GROUND,
    ...opts,
  });
}

function makeDino(opts = {}) {
  const world = makeWorld(opts.world);
  const dino = new DinoRagdoll(world, { x: 130, groundY: GROUND, ...opts.dino });
  return { world, dino };
}

const pad = (s, n) => String(s).padStart(n);
const padR = (s, n) => String(s).padEnd(n);

function footStats(dino) {
  const f = dino.particle('footL');
  const g = dino.particle('footR');
  return {
    lowL: GROUND - (f.y + f.radius),
    lowR: GROUND - (g.y + g.radius),
    kneeLX: f.x - dino.particle('pelvis').x,
    kneeRX: g.x - dino.particle('pelvis').x,
  };
}

function bodyExtent(dino) {
  let top = Infinity;
  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (const p of dino.world.particles) {
    top = Math.min(top, p.y - p.radius);
    bottom = Math.max(bottom, p.y + p.radius);
    left = Math.min(left, p.x - p.radius);
    right = Math.max(right, p.x + p.radius);
  }
  return { top, bottom, left, right, height: bottom - top, width: right - left };
}

/** Current value of a joint, relative to its rest pose, in the engine's convention. */
function jointValue(dino, ang) {
  return dino.world.angleValue(ang);
}

/** How far each joint is from its motor target, in degrees. */
function poseError(dino) {
  let worst = 0;
  let sum = 0;
  let n = 0;
  for (const ang of Object.values(dino.joints)) {
    const err = Math.abs(wrapAngle(jointValue(dino, ang) - ang.target));
    worst = Math.max(worst, err);
    sum += err;
    n++;
  }
  return { worst: (worst * 180) / Math.PI, avg: ((sum / Math.max(n, 1)) * 180) / Math.PI };
}

/** Bone-length drift: rods should hold, braces should only breathe a little. */
function stretchReport(world) {
  let worstRod = 0;
  let worstBrace = 0;
  for (const rod of world.rods) {
    const a = world.particles[rod.a];
    const b = world.particles[rod.b];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const ratio = d / rod.rest0;
    if (rod.group === 'flesh') worstRod = Math.max(worstRod, Math.abs(ratio - 1));
    else worstBrace = Math.max(worstBrace, Math.abs(ratio - 1));
  }
  return { worstRod, worstBrace };
}

/** Joint limits must never be blown, alive or dead. */
function limitReport(dino) {
  let violations = 0;
  let worst = 0;
  for (const ang of Object.values(dino.joints)) {
    const cur = jointValue(dino, ang);
    if (cur < ang.lo - 1e-3) {
      violations++;
      worst = Math.max(worst, ang.lo - cur);
    }
    if (cur > ang.hi + 1e-3) {
      violations++;
      worst = Math.max(worst, cur - ang.hi);
    }
  }
  return { violations, worstDeg: (worst * 180) / Math.PI };
}

// ---------------------------------------------------------------------------
// probes
// ---------------------------------------------------------------------------

function probeStand() {
  const { world, dino } = makeDino();
  for (let i = 0; i < 120; i++) dino.update(1, { speed: 0 });
  const ext = bodyExtent(dino);
  const err = poseError(dino);
  return {
    name: 'stand idle',
    ok: err.avg < 12 && ext.bottom > GROUND - 3 && ext.top > GROUND - 120,
    checks: [
      ['pose err avg (deg)', err.avg.toFixed(1)],
      ['pose err worst (deg)', err.worst.toFixed(1)],
      ['height (px)', ext.height.toFixed(1)],
      ['bottom vs ground', (GROUND - ext.bottom).toFixed(1)],
      ['head top', (GROUND - ext.top).toFixed(1)],
      ['width', ext.width.toFixed(1)],
    ],
  };
}

function probeRun() {
  const { world, dino } = makeDino();
  let contactL = 0;
  let contactR = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  let worst = 0;
  for (let i = 0; i < 240; i++) {
    dino.update(1, { speed: 7 });
    const f = footStats(dino);
    if (f.lowL < 2) contactL++;
    if (f.lowR < 2) contactR++;
    const pelvis = dino.particle('pelvis').y;
    minY = Math.min(minY, pelvis);
    maxY = Math.max(maxY, pelvis);
    worst = Math.max(worst, Math.abs(pelvis - dino.standY()));
  }
  const st = stretchReport(world);
  const err = poseError(dino);
  const total = 240;
  return {
    name: 'run cycle',
    ok: contactL / total > 0.2 && contactR / total > 0.2 && st.worstRod < 0.06,
    checks: [
      ['foot L contact %', ((contactL / total) * 100).toFixed(0)],
      ['foot R contact %', ((contactR / total) * 100).toFixed(0)],
      ['bob amplitude (px)', (maxY - minY).toFixed(1)],
      ['root drift from stand', worst.toFixed(1)],
      ['worst flesh stretch %', (st.worstRod * 100).toFixed(2)],
      ['worst brace stretch %', (st.worstBrace * 100).toFixed(1)],
      ['pose err avg (deg)', err.avg.toFixed(1)],
    ],
  };
}

function probeJump() {
  const { world, dino } = makeDino();
  for (let i = 0; i < 30; i++) dino.update(1, { speed: 7 });
  const y0 = dino.particle('pelvis').y;
  dino.jump();
  let apex = Infinity;
  let air = 0;
  let landed = -1;
  for (let i = 0; i < 240; i++) {
    dino.update(1, { speed: 7, jumpHeld: i < 12 });
    const py = dino.particle('pelvis').y;
    if (!dino.grounded) air++;
    apex = Math.min(apex, py);
    if (landed < 0 && i > 8 && dino.grounded) landed = i;
  }
  const analytic = (dino.JUMP_VELOCITY ** 2) / (2 * dino.FALL_GRAVITY);
  const head = bodyExtent(dino);
  return {
    name: 'jump arc',
    ok: landed > 0 && Math.abs(y0 - apex) > 90,
    checks: [
      ['apex height (px)', (y0 - apex).toFixed(1)],
      ['analytic target (px)', analytic.toFixed(1)],
      ['air ticks', air],
      ['landed at tick', landed],
      ['grounded after', dino.grounded],
      ['head height in air', (GROUND - head.top).toFixed(0)],
    ],
  };
}

function probeDuck() {
  const { world, dino } = makeDino();
  for (let i = 0; i < 60; i++) dino.update(1, { speed: 7 });
  const before = bodyExtent(dino);
  for (let i = 0; i < 90; i++) dino.update(1, { speed: 7, ducking: true });
  const after = bodyExtent(dino);
  const feet = footStats(dino);
  return {
    name: 'duck',
    ok: after.height < before.height * 0.78 && feet.lowL < 4 && feet.lowR < 4,
    checks: [
      ['standing height', before.height.toFixed(1)],
      ['ducking height', after.height.toFixed(1)],
      ['reduction %', (((before.height - after.height) / before.height) * 100).toFixed(0)],
      ['foot L off ground', feet.lowL.toFixed(1)],
      ['foot R off ground', feet.lowR.toFixed(1)],
      ['bottom', (GROUND - after.bottom).toFixed(1)],
    ],
  };
}

function probeDeathTumble() {
  const { world, dino } = makeDino();
  for (let i = 0; i < 60; i++) dino.update(1, { speed: 8 });
  dino.die({ dir: -1, speed: 8, height: 0.2, x: dino.frontX() });
  const origin = () => dino.comAtDeath;
  let maxSpin = 0;
  let airborneTicks = 0;
  let comPath = 0;
  let prev = world.centerOfMass();
  for (let i = 0; i < 300; i++) {
    dino.update(1, { speed: 0 });
    maxSpin = Math.max(maxSpin, Math.abs(world.angularMomentum(origin())));
    const c = world.centerOfMass();
    comPath += Math.hypot(c.x - prev.x, c.y - prev.y);
    prev = c;
    if (!dino.grounded) airborneTicks++;
  }
  const ext = bodyExtent(dino);
  const lim = limitReport(dino);
  const ke = world.totalKineticEnergy();
  // A corpse that translates and rotates is a ragdoll. One that just falls
  // straight down and lies flat is not.
  return {
    name: 'death tumble',
    ok:
      maxSpin > 20 &&
      comPath > 120 &&
      ke < 0.5 &&
      ext.bottom > GROUND - 6 &&
      lim.violations === 0,
    checks: [
      ['peak angular momentum', maxSpin.toFixed(1)],
      ['com travel (px)', comPath.toFixed(0)],
      ['final KE', ke.toFixed(4)],
      ['settled', !!dino.settled],
      ['resting height', ext.height.toFixed(1)],
      ['resting width', ext.width.toFixed(1)],
      ['bottom vs ground', (GROUND - ext.bottom).toFixed(2)],
      ['limit violations', lim.violations],
      ['worst violation (deg)', lim.worstDeg.toFixed(1)],
    ],
  };
}

function probeHeadHit() {
  // Same body, hit in the face instead of the shins: must spin the other way.
  // Measured on the frame of death, before the deck has had any say. Sampling
  // later lets the first bounce dominate and both cases end up rotating the
  // same way regardless of where they were struck.
  const low = makeDino();
  const high = makeDino();
  for (const { dino } of [low, high]) for (let i = 0; i < 60; i++) dino.update(1, { speed: 8 });
  const lowHit = low.dino.frontX();
  const highHit = high.dino.frontX();
  low.dino.die({ dir: -1, speed: 8, height: 0.1, x: lowHit });
  high.dino.die({ dir: -1, speed: 8, height: 0.9, x: highHit });
  const a = low.world.angularMomentum(low.dino.comAtDeath);
  const b = high.world.angularMomentum(high.dino.comAtDeath);
  return {
    name: 'impact point decides spin',
    ok: Math.sign(a) !== Math.sign(b) && Math.abs(a) > 200 && Math.abs(b) > 200,
    checks: [
      ['leg-hit angular momentum', a.toFixed(1)],
      ['head-hit angular momentum', b.toFixed(1)],
      ['opposite signs', String(Math.sign(a) !== Math.sign(b))],
    ],
  };
}

function probeDeterminism() {
  const run = () => {
    const { world, dino } = makeDino();
    for (let i = 0; i < 60; i++) dino.update(1, { speed: 8 });
    dino.die({ dir: -1, speed: 8, height: 0.4, x: dino.frontX() });
    for (let i = 0; i < 200; i++) dino.update(1, { speed: 0 });
    return JSON.stringify(
      world.particles.map((p) => [p.id, +p.x.toFixed(9), +p.y.toFixed(9)])
    );
  };
  const a = run();
  const b = run();
  return {
    name: 'determinism',
    ok: a === b,
    checks: [['identical float streams', String(a === b)], ['hash length', a.length]],
  };
}

function probeStability() {
  // Long soak: no NaN, no explosion, no particle buried through the floor.
  const { world, dino } = makeDino();
  let nan = 0;
  let buried = 0;
  for (let i = 0; i < 3000; i++) {
    if (i === 90) dino.jump();
    if (i === 300) dino.die({ dir: -1, speed: 10, height: 0.5, x: dino.frontX() });
    dino.update(1, { speed: i < 300 ? 9 : 0 });
    for (const p of world.particles) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) nan++;
      if (p.y + p.radius > GROUND + 4) buried++;
    }
  }
  const st = stretchReport(world);
  return {
    name: '3000-tick soak',
    ok: nan === 0 && buried === 0 && st.worstRod < 0.2,
    checks: [
      ['NaN events', nan],
      ['floor-penetration events', buried],
      ['worst flesh stretch %', (st.worstRod * 100).toFixed(2)],
      ['final KE', world.totalKineticEnergy().toFixed(4)],
    ],
  };
}

function probeRevive() {
  const { world, dino } = makeDino();
  for (let i = 0; i < 60; i++) dino.update(1, { speed: 7 });
  dino.die({ dir: -1, speed: 8, height: 0.3, x: dino.frontX() });
  for (let i = 0; i < 200; i++) dino.update(1, { speed: 0 });
  dino.revive(130);
  for (let i = 0; i < 60; i++) dino.update(1, { speed: 7 });
  const ext = bodyExtent(dino);
  const err = poseError(dino);
  return {
    name: 'revive after death',
    ok: dino.alive && err.avg < 14 && ext.bottom > GROUND - 6,
    checks: [
      ['alive', String(dino.alive)],
      ['muscle', dino.muscle.toFixed(2)],
      ['pose err avg (deg)', err.avg.toFixed(1)],
      ['bottom vs ground', (GROUND - ext.bottom).toFixed(1)],
      ['pelvis pinned', String(dino.pelvis().invMass === 0)],
    ],
  };
}

function probeCactusShove() {
  // A moving collider must shove the corpse, not just stop it.
  const { world, dino } = makeDino();
  for (let i = 0; i < 60; i++) dino.update(1, { speed: 8 });
  dino.die({ dir: -1, speed: 0.001, height: 0.5, x: dino.frontX() });
  const col = world.addCollider({
    x: dino.particle('chest').x + 20,
    y: GROUND - 30,
    vx: -6,
    segments: [{ x1: 0, y1: -30, x2: 0, y2: 30, r: 8 }],
  });
  const before = world.centerOfMass().x;
  for (let i = 0; i < 40; i++) {
    col.x += col.vx;
    dino.update(1, { speed: 0 });
  }
  const after = world.centerOfMass().x;
  return {
    name: 'moving cactus shoves corpse',
    ok: after - before < -12,
    checks: [
      ['com x before', before.toFixed(1)],
      ['com x after', after.toFixed(1)],
      ['shoved (px)', (after - before).toFixed(1)],
    ],
  };
}

function probeNeutralSanity() {
  // The authored rest skeleton must sit at 0 relative offset for every joint,
  // or the body snaps on the very first frame after a spawn.
  const { dino } = makeDino();
  const rows = [];
  let worst = 0;
  for (const [name, ang] of Object.entries(dino.joints)) {
    const off = (jointValue(dino, ang) * 180) / Math.PI;
    worst = Math.max(worst, Math.abs(off));
    rows.push([`${name}`, `${off.toFixed(1)}deg`]);
  }
  return {
    name: 'rest pose sits at joint zero',
    ok: worst < 1,
    checks: rows,
  };
}

// ---------------------------------------------------------------------------

const PROBES = [
  probeNeutralSanity,
  probeStand,
  probeRun,
  probeJump,
  probeDuck,
  probeDeathTumble,
  probeHeadHit,
  probeCactusShove,
  probeDeterminism,
  probeRevive,
  probeStability,
];

export function runProbes(filter) {
  const out = [];
  for (const probe of PROBES) {
    if (filter && !probe.name.includes(filter)) continue;
    out.push(probe());
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('physics-check.mjs')) {
  const wantFrames = process.argv.includes('--frames');
  const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));

  if (wantFrames) {
    const { dino } = makeDino();
    const draw = (label) => {
      const ext = bodyExtent(dino);
      const cols = 62;
      const rows = 22;
      const x0 = ext.left - 4;
      const y0 = ext.top - 4;
      const sx = (ext.width + 8) / cols;
      const sy = (ext.height + 8) / rows;
      const grid = Array.from({ length: rows }, () => Array(cols).fill(' '));
      for (const rod of dino.world.rods) {
        if (rod.group !== 'flesh') continue;
        const a = dino.world.particles[rod.a];
        const b = dino.world.particles[rod.b];
        const steps = 30;
        for (let i = 0; i <= steps; i++) {
          const x = a.x + ((b.x - a.x) * i) / steps;
          const y = a.y + ((b.y - a.y) * i) / steps;
          const cx = Math.round((x - x0) / sx);
          const cy = Math.round((y - y0) / sy);
          if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) grid[cy][cx] = '#';
        }
      }
      console.log(`\n--- ${label} ---`);
      for (const row of grid) console.log('|' + row.join('') + '|');
    };
    for (let i = 0; i < 30; i++) dino.update(1, { speed: 0 });
    draw('standing');
    for (let i = 0; i < 24; i++) dino.update(1, { speed: 7 });
    draw('running a');
    for (let i = 0; i < 19; i++) dino.update(1, { speed: 7 });
    draw('running b');
    dino.setDuck(true);
    for (let i = 0; i < 40; i++) dino.update(1, { speed: 7, ducking: true });
    draw('ducking');
    dino.setDuck(false);
    dino.jump();
    for (let i = 0; i < 11; i++) dino.update(1, { speed: 7, jumpHeld: true });
    draw('airborne');
    for (let i = 0; i < 40; i++) dino.update(1, { speed: 7 });
    dino.die({ dir: -1, speed: 8, height: 0.2, x: dino.frontX() });
    for (let i = 0; i < 24; i++) dino.update(1, { speed: 0 });
    draw('tumbling');
    for (let i = 0; i < 200; i++) dino.update(1, { speed: 0 });
    draw('settled corpse');
  }

  let failed = 0;
  for (const res of runProbes(filter)) {
    const flag = res.ok ? 'PASS' : 'FAIL';
    if (!res.ok) failed++;
    console.log(`\n[${flag}] ${res.name}`);
    for (const [k, v] of res.checks) console.log(`    ${padR(k, 28)} ${pad(v, 10)}`);
  }
  console.log(`\n${PROBES.length - failed}/${PROBES.length} probes passing\n`);
  process.exitCode = failed ? 1 : 0;
}

export { makeWorld, makeDino, bodyExtent, poseError, stretchReport, limitReport, footStats, GROUND };
