// Gait report. Not an assertion file, a tuning instrument: it prints the posture
// numbers that decide whether the run reads as a run. Screenshots tell you
// something looks wrong; this tells you which target to move.
//
//   node test/gait-report.mjs [ticks] [seed]

import { Game } from '../src/game.js';

const ticks = Number(process.argv[2] ?? 300);
const seed = Number(process.argv[3] ?? 42);

const game = new Game({ seed });
game.auto = true;
game.start();
// Warm up out of the release transient before measuring.
for (let i = 0; i < 120; i++) game.step(1);

// Track the limbs over a window so stride comes from motion, not one frame.
const track = new Map();
for (let i = 0; i < ticks; i++) {
  game.step(1);
  for (const q of game.world.particles) {
    if (!q.id.startsWith('dino:')) continue;
    const rec = track.get(q.id) ?? { min: Infinity, max: -Infinity, high: -Infinity };
    rec.min = Math.min(rec.min, q.x);
    rec.max = Math.max(rec.max, q.x);
    rec.high = Math.max(rec.high, game.cfg.groundY - q.y);
    track.set(q.id, rec);
  }
}

const P = {};
for (const q of game.world.particles) {
  if (q.id.startsWith('dino:')) P[q.id.slice(5)] = q;
}
const G = game.cfg.groundY;
const h = (id) => (G - P[id].y).toFixed(1);
const travel = (id) => {
  const t = track.get(`dino:${id}`);
  return t ? (t.max - t.min).toFixed(1) : 'n/a';
};
// Signed angle of the a->b segment, so a limb pointing forward-and-down is
// readable at a glance without cross-referencing the skeleton layout.
const limb = (a, b) => {
  const ang = Math.atan2(P[b].y - P[a].y, P[b].x - P[a].x) * (180 / Math.PI);
  return ang.toFixed(0).padStart(4) + ' deg';
};

const rows = [
  ['state', `${game.state} alive=${game.dino.alive} grounded=${game.dino.grounded}`],
  ['speed px/tick', game.speed.toFixed(2)],
  ['run phase', game.dino.phase.toFixed(2)],
  ['pelvis height', h('pelvis')],
  ['chest height', h('chest')],
  ['head height', h('head')],
  ['snout height', h('snout')],
  ['tail tip height', h('tail3')],
  ['arm height', h('armL')],
  ['hand height', h('handL')],
  ['knee height', h('kneeL')],
  ['foot height (0=deck)', `${h('footL')} / ${h('footR')}`],
  ['foot travel (stride)', `${travel('footL')} / ${travel('footR')} px`],
  ['foot peak lift', `${track.get('dino:footL')?.high.toFixed(1)} px`],
  ['hand travel', `${travel('handL')} / ${travel('handR')} px`],
  ['head bob', `${travel('head')} px`],
  ['pelvis bob', `${travel('pelvis')} px`],
  ['thigh L / R', `${limb('pelvis', 'kneeL')} / ${limb('pelvis', 'kneeR')}`],
  ['shin L / R', `${limb('kneeL', 'footL')} / ${limb('kneeR', 'footR')}`],
  ['arm L / R', `${limb('chest', 'armL')} / ${limb('chest', 'armR')}`],
  ['hand L / R', `${limb('armL', 'handL')} / ${limb('armR', 'handR')}`],
  ['spine', limb('pelvis', 'chest')],
  ['neck', limb('chest', 'neck')],
  ['head', limb('neck', 'head')],
  ['snout', limb('head', 'snout')],
  ['tail', `${limb('pelvis', 'tail1')} ${limb('tail1', 'tail2')} ${limb('tail2', 'tail3')}`],
  ['body height', game.dino.bodyHeight().toFixed(1)],
];

for (const [k, v] of rows) console.log(`${k.padEnd(20)} ${v}`);

console.log('\nheight profile (px above deck):');
const sorted = Object.entries(P)
  .map(([id, q]) => ({ id, y: G - q.y }))
  .sort((a, b) => b.y - a.y);
for (const s of sorted) {
  console.log(`  ${s.id.padEnd(8)} ${s.y.toFixed(1).padStart(6)}  ${'#'.repeat(Math.max(1, Math.round(s.y / 2)))}`);
}
