/**
 * Obstacles: cacti on the deck and pterodactyls at three heights.
 *
 * These are not sprites with a bounding box. Every obstacle registers real
 * capsule colliders with the physics world, which buys two things that a
 * rectangle test cannot:
 *
 *   1. A corpse hit by a cactus is shoved by it, because colliders carry a
 *      velocity and the solver applies friction against that velocity. The body
 *      is dragged along the deck by the thing that killed it.
 *   2. The crash test and the physical response are the same geometry, so the
 *      dino cannot die on a hit the body did not feel, nor survive one that
 *      visibly clipped it.
 *
 * Spawning uses a seeded PRNG rather than Math.random. Determinism is worth
 * paying for here: it turns "the ragdoll looked wrong" into a reproducible
 * tick range that a test can assert on.
 */

import { buildObstacle } from './shapes.js';

/** Small integer PRNG. Same seed, same run, every time. */
export function makeRng(seed = 0x9e3779b9) {
  let s = seed >>> 0;
  return function rng() {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Height bands for flyers, as the bottom of the occupied space above the deck.
 *
 * Tuned against the body, not by eye. The dino stands 96 px tall and crouches
 * to 51, so a flyer sitting at 100 px can be run under, one at 56 px has to be
 * ducked under, and one at the deck has to be jumped. Any narrower and a band
 * becomes a coin flip rather than a decision.
 */
export const BANDS = [
  { id: 'low', base: 0, height: 34, need: 'jump' },
  { id: 'middle', base: 56, height: 42, need: 'duck' },
  { id: 'high', base: 102, height: 40, need: 'run' },
];

export class ObstacleField {
  /**
   * @param {import('./physics.js').PhysicsWorld} world
   * @param {object} opts { groundY, seed, spawnX, speed }
   */
  constructor(world, opts = {}) {
    this.world = world;
    this.groundY = opts.groundY ?? world.groundY;
    this.spawnX = opts.spawnX ?? 1280;
    this.despawnX = opts.despawnX ?? -220;
    this.rng = makeRng(opts.seed ?? 1234);

    /** @type {Array<object>} */
    this.list = [];
    this.distanceSinceSpawn = 0;
    this.nextGap = 420;
    this.elapsed = 0;
    this.spawned = 0;
    this.cleared = 0;
  }

  reset(seed) {
    for (const o of this.list) this.world.removeCollider(o.collider);
    this.list.length = 0;
    this.distanceSinceSpawn = 0;
    this.nextGap = 420;
    this.elapsed = 0;
    this.spawned = 0;
    this.cleared = 0;
    if (seed !== undefined) this.rng = makeRng(seed);
  }

  /**
   * Pick the next obstacle. Early on this is cacti only, because a player
   * learning the jump should not be asked to duck and jump in the same second.
   * Flyers join in once the score is high enough to have earned them.
   */
  chooseKind() {
    const r = this.rng();
    const flyersUnlocked = this.elapsed > 260;
    if (!flyersUnlocked) return r < 0.7 ? 'cactus-small' : 'cactus-large';
    if (r < 0.3) return 'cactus-small';
    if (r < 0.56) return 'cactus-large';
    return 'pterodactyl';
  }

  spawn() {
    const kind = this.chooseKind();
    // One call builds geometry and extents together. Asking for the segments and
    // the bounding box separately meant drawing the same cactus twice with the
    // same rng and getting two different cacti, so the hitbox did not match the
    // pixels.
    const band = kind === 'pterodactyl' ? BANDS[Math.floor(this.rng() * BANDS.length)] : null;
    const shape = buildObstacle(kind, this.rng, band ? band.base : 0);

    const spec = {
      kind,
      band: band ? band.id : 'ground',
      need: band ? band.need : 'jump',
      width: shape.width,
      height: shape.height,
      base: band ? band.base : 0,
      segments: shape.segments,
      spanTop: shape.spanTop,
      spanBottom: shape.spanBottom,
      spanLeft: shape.spanLeft,
      spanRight: shape.spanRight,
      cols: shape.cols ?? 0,
      large: !!shape.large,
      flap: this.rng() * Math.PI * 2,
      bodyY: shape.bodyY ?? null,
      x: this.spawnX,
      y: this.groundY,
      vx: 0,
      vy: 0,
      seed: this.rng(),
    };

    spec.collider = this.world.addCollider({
      id: `o${this.spawned}`,
      x: spec.x,
      y: spec.y,
      segments: spec.segments,
      kind: spec.kind,
      data: spec,
    });
    this.list.push(spec);
    this.spawned++;
    return spec;
  }

  /**
   * Advance the field by one tick. `speed` is the world scroll in px/tick, and
   * it is handed to the colliders as their velocity so the solver can drag the
   * corpse with the obstacle that hit it.
   */
  update(dt, speed) {
    const move = speed * dt;
    this.elapsed += dt;
    this.distanceSinceSpawn += move;

    // Gaps shrink as the game speeds up, but never below what the jump arc can
    // actually cover, so a fast game is demanding rather than impossible. The
    // body clears roughly 150 px of air, so anything under about 260 px of gap
    // at speed is a guaranteed hit no matter how well it is played.
    if (this.distanceSinceSpawn >= this.nextGap) {
      this.spawn();
      this.distanceSinceSpawn = 0;
      const jitter = this.rng() * 180;
      const floor = 260 + speed * 12;
      this.nextGap = Math.max(floor, 470 - Math.min(160, this.elapsed * 0.16)) + jitter;
    }

    for (let i = this.list.length - 1; i >= 0; i--) {
      const o = this.list[i];
      o.x -= move;
      o.vx = -speed;
      o.collider.x = o.x;
      o.collider.vx = o.vx;
      if (o.kind === 'pterodactyl') o.flap += 0.32 * dt;
      if (o.x + o.width < this.despawnX) {
        this.world.removeCollider(o.collider);
        this.list.splice(i, 1);
        this.cleared++;
      }
    }
  }

  /**
   * The crash test. Returns the first obstacle whose capsules intersect a dino
   * particle, or null. `skin` shrinks the test slightly so a body merely
   * brushing the whiskery edge of a cactus is not a death.
   */
  hitTest(particles, skin = 0.55) {
    for (const o of this.list) {
      for (const s of o.segments) {
        const ax = o.x + s.x1;
        const ay = o.y + s.y1;
        const bx = o.x + s.x2;
        const by = o.y + s.y2;
        for (const p of particles) {
          const reach = p.radius * skin + s.r;
          const dx = bx - ax;
          const dy = by - ay;
          const len2 = dx * dx + dy * dy || 1;
          let t = ((p.x - ax) * dx + (p.y - ay) * dy) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = ax + dx * t;
          const qy = ay + dy * t;
          const d = Math.hypot(p.x - qx, p.y - qy);
          if (d < reach) {
            return {
              obstacle: o,
              particle: p,
              // Where on the obstacle it landed, 0 = deck, 1 = sky. Feeds the
              // death impulse: struck low the body trips, struck high it pitches.
              height: clamp01(1 - (p.y - (o.y + o.spanTop)) / Math.max(1, o.spanBottom - o.spanTop)),
              contactX: qx,
              contactY: qy,
            };
          }
        }
      }
    }
    return null;
  }

  /** Obstacles still on screen, for the renderer and for the autopilot. */
  visible(fromX = -100, toX = 1300) {
    return this.list.filter((o) => {
      const right = o.x + (o.spanRight ?? o.width);
      const left = o.x + (o.spanLeft ?? 0);
      return right > fromX && left < toX;
    });
  }

  /**
   * The obstacle the dino currently has to react to.
   *
   * Returns an obstacle while it is anywhere in the *body's* span, not merely
   * ahead of its face. The distinction matters for a duck: the instant the snout
   * passes the bird, a front-only test would drop the threat, the dino would
   * stand back up, and its own tail would still be under the beak.
   *
   * @param {number} front world x of the body's leading edge
   * @param {number} back  world x of the body's trailing edge (tail)
   */
  nextThreat(front, back = front - 160) {
    let best = null;
    let bestLead = Infinity;
    for (const o of this.visible(back - 60, 1400)) {
      const lead = o.x + (o.spanRight ?? o.width);
      if (lead <= back) continue; // fully behind the tail
      if (lead < bestLead) {
        best = o;
        bestLead = lead;
      }
    }
    return best;
  }
}
