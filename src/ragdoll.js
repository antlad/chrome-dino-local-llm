// The ragdoll T-Rex.
//
// One skeleton, two modes of being:
//
//   alive  -> the pelvis is a kinematic root driven by a ballistic run/jump
//            model, and every joint runs a soft two-sided motor toward a pose
//            target. Soft (not rigid) on purpose: the torso sags off the root,
//            the head lags a frame behind the neck, the tail whips with real
//            momentum. It reads as an animal, not a sprite.
//
//   dead   -> motors fade to zero over a few frames and the pelvis is
//            un-pinned. From that instant the body is 100% the solver: gravity,
//            ground friction, capsule impacts, angular momentum from the
//            collision. Nothing scripted touches it again.
//
// Joint angles are measured at the vertex particle, from particle `a` to
// particle `c` (see physics.angleAt). All poses below are authored in that
// convention, with y pointing down the screen.

import { PhysicsWorld, angleAt, wrapAngle } from './physics.js';

/** Local-space rest skeleton, pelvis at origin, facing +x, y down. */
const SKELETON = {
  pelvis: { x: 0, y: 0, mass: 4.2, radius: 13, groundFriction: 0.5 },

  chest: { x: 25, y: -13, mass: 3.4, radius: 12 },
  neck: { x: 44, y: -30, mass: 1.2, radius: 7 },
  head: { x: 59, y: -49, mass: 2.2, radius: 11 },
  snout: { x: 84, y: -44, mass: 0.8, radius: 7 },

  tail1: { x: -27, y: -9, mass: 1.5, radius: 9 },
  tail2: { x: -51, y: -16, mass: 0.9, radius: 6.5 },
  tail3: { x: -72, y: -21, mass: 0.5, radius: 4.5 },

  armL: { x: 33, y: -1, mass: 0.5, radius: 4.5 },
  handL: { x: 42, y: 9, mass: 0.35, radius: 3.5 },
  armR: { x: 27, y: 1, mass: 0.5, radius: 4.5 },
  handR: { x: 34, y: 12, mass: 0.35, radius: 3.5 },

  kneeL: { x: 9, y: 31, mass: 1.1, radius: 7 },
  footL: { x: 14, y: 63, mass: 0.8, radius: 5.5, groundFriction: 0.72 },
  kneeR: { x: -7, y: 31, mass: 1.1, radius: 7 },
  footR: { x: -2, y: 63, mass: 0.8, radius: 5.5, groundFriction: 0.72 },
};

/** Bones drawn as flesh. `skin` entries are silhouette-only (no motor). */
const BONES = [
  // spine + head
  ['pelvis', 'chest', 26],
  ['chest', 'neck', 17],
  ['neck', 'head', 15],
  ['head', 'snout', 13],
  // tail, tapering
  ['pelvis', 'tail1', 19],
  ['tail1', 'tail2', 13],
  ['tail2', 'tail3', 8],
  // arms, tiny like the original
  ['chest', 'armL', 7],
  ['armL', 'handL', 5],
  ['chest', 'armR', 7],
  ['armR', 'handR', 5],
  // legs
  ['pelvis', 'kneeL', 15],
  ['kneeL', 'footL', 10],
  ['pelvis', 'kneeR', 15],
  ['kneeR', 'footR', 10],
];

/** Internal braces: invisible rods that stop the silhouette turning to soup. */
const BRACES = [
  ['pelvis', 'neck'],
  ['pelvis', 'head'],
  ['chest', 'tail1'],
  ['pelvis', 'tail2'],
  ['neck', 'tail1'],
  ['head', 'tail1'],
  ['neck', 'snout'],
  ['chest', 'snout'],
  ['chest', 'armL'],
  ['chest', 'armR'],
];

/**
 * Motors. Every joint is stored relative to its authored rest pose, so these
 * numbers are offsets in radians: `lo`/`hi` are how far past rest the joint may
 * travel, and `bias` is the standing offset the muscles hold when idle.
 *
 * Limits stay active even when the body is dead, so a corpse cannot hyperextend
 * its knees or fold its neck backwards, but nothing else touches it.
 */
const JOINTS = {
  spine: { a: 'tail1', b: 'pelvis', c: 'chest', stiffness: 0.3, lo: -0.9, hi: 0.9 },
  tailCarry: { a: 'chest', b: 'pelvis', c: 'tail1', stiffness: 0.22, lo: -1.3, hi: 1.3, bias: 0.1 },
  tail1: { a: 'pelvis', b: 'tail1', c: 'tail2', stiffness: 0.18, lo: -1.1, hi: 1.1 },
  tail2: { a: 'tail1', b: 'tail2', c: 'tail3', stiffness: 0.16, lo: -1.1, hi: 1.1 },
  neck: { a: 'chest', b: 'neck', c: 'head', stiffness: 0.34, lo: -1.0, hi: 1.0 },
  jaw: { a: 'neck', b: 'head', c: 'snout', stiffness: 0.3, lo: -0.8, hi: 0.8 },
  hipL: { a: 'chest', b: 'pelvis', c: 'kneeL', stiffness: 0.42, lo: -1.75, hi: 1.75, bias: 0.12 },
  kneeL: { a: 'pelvis', b: 'kneeL', c: 'footL', stiffness: 0.44, lo: -1.95, hi: 0.65, bias: 0.2 },
  hipR: { a: 'chest', b: 'pelvis', c: 'kneeR', stiffness: 0.42, lo: -1.75, hi: 1.75, bias: 0.12 },
  kneeR: { a: 'pelvis', b: 'kneeR', c: 'footR', stiffness: 0.44, lo: -1.95, hi: 0.65, bias: 0.2 },
  armL: { a: 'chest', b: 'armL', c: 'handL', stiffness: 0.3, lo: -1.7, hi: 1.2 },
  armR: { a: 'chest', b: 'armR', c: 'handR', stiffness: 0.3, lo: -1.7, hi: 1.2 },
  shoulderL: { a: 'neck', b: 'chest', c: 'armL', stiffness: 0.26, lo: -1.9, hi: 1.0 },
  shoulderR: { a: 'neck', b: 'chest', c: 'armR', stiffness: 0.26, lo: -1.9, hi: 1.0 },
};

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Standing offsets, in radians relative to the authored rest pose. Poses below
 * are additive on top of these, which keeps pose authoring readable: a pose
 * says "hip swings 30 degrees forward", not "hip sits at 1.047 rad".
 */
const NEUTRAL = Object.fromEntries(
  Object.entries(JOINTS).map(([name, spec]) => [name, spec.bias ?? 0])
);

/**
 * Absolute balance references. These are the constraints that keep the animal
 * upright: each pins the world-space direction of one bone against gravity,
 * relative to the direction authored in SKELETON. Without them a body hung
 * from a single pinned pelvis simply rotates and dangles upside down, because
 * relative joint motors have no opinion about which way is up.
 *
 * Stiffness is deliberately lower than the joint motors so gait still wins,
 * and `gain` is tied to `muscle` so a corpse loses its balance reflex too.
 */
const POSTURES = {
  torso: { pivot: 'pelvis', tip: 'chest', stiffness: 0.34, lo: -0.55, hi: 0.55 },
  // The neck is the free end of the spine, so it needs its own balance reflex.
  // Without it nothing at all opposes gravity on `chest -> neck`: the relative
  // neck motor is happy (it only measures the chest-neck-head bend, and a
  // dangling neck still bends correctly at its vertex), and `headUp` can only
  // rotate the head about the neck, which cannot lift a chain that has already
  // folded at the shoulder. The result was the whole skull hanging under the
  // chest, snout 11 px off the deck instead of 113 px, while every angle and
  // bone in the body reported itself perfectly satisfied.
  neckCarry: { pivot: 'chest', tip: 'neck', stiffness: 0.3, lo: -0.62, hi: 0.62 },
  headUp: { pivot: 'neck', tip: 'head', stiffness: 0.26, lo: -0.7, hi: 0.7 },
  tailCarry: { pivot: 'pelvis', tip: 'tail1', stiffness: 0.11, lo: -1.15, hi: 1.15 },
  legL: { pivot: 'pelvis', tip: 'kneeL', stiffness: 0.14, lo: -1.0, hi: 1.0 },
  legR: { pivot: 'pelvis', tip: 'kneeR', stiffness: 0.14, lo: -1.0, hi: 1.0 },
};

const DEG = Math.PI / 180;

export const RUN_CADEX = 0.0165; // run cycle speed: radians of phase per px travelled

/**
 * Run cycle.
 *
 * Each leg alternates a *stance* half-cycle (foot planted, hip sweeping back,
 * knee straightening to drive) and a *swing* half-cycle (knee tucked, hip
 * reaching forward). Getting that split right is what puts feet on the deck: an
 * earlier version bent both knees by a fixed amount all cycle, so neither foot
 * ever reached the ground and the dino ran on air. The legs sit 180 degrees out
 * of phase, arms counter-rotate against them, the tail carries the beat with a
 * delay, and the head counter-rolls the body bob so the eyes stay level, which
 * is the detail that sells an animal over a sprite.
 */
function runPose(phase, intensity) {
  const s = Math.sin(phase);
  const c = Math.cos(phase);

  // Stance while the leg's own sine is negative (behind the hip, pushing),
  // swing while positive. Clamped ramp rather than a snap between the two.
  const leg = (p) => {
    const sp = Math.sin(p);
    const cp = Math.cos(p);
    const stance = clamp(-sp * 1.7, 0, 1);
    const hip = lerp(30 * cp, -30, stance) * DEG; // reach forward, sweep back
    const knee = lerp(-62, 8, stance) * DEG; // tuck in swing, drive in stance
    return { hip, knee };
  };
  const a = leg(phase);
  const b = leg(phase + Math.PI);

  return {
    hipL: a.hip * intensity,
    kneeL: a.knee * intensity,
    hipR: b.hip * intensity,
    kneeR: b.knee * intensity,
    armL: (-s * 26) * DEG * intensity,
    armR: (s * 26) * DEG * intensity,
    shoulderL: (-s * 14) * DEG * intensity,
    shoulderR: (s * 14) * DEG * intensity,
    tailCarry: (c * 9) * DEG * intensity,
    tail1: (Math.sin(phase - 0.9) * 13) * DEG * intensity,
    tail2: (Math.sin(phase - 1.8) * 16) * DEG * intensity,
    spine: (Math.sin(phase * 2) * 2.5 - 1) * DEG * intensity,
    neck: (-Math.sin(phase * 2) * 3) * DEG * intensity,
    jaw: (Math.sin(phase) * 2) * DEG * intensity,
  };
}

/**
 * Crouched. The whole animal folds down between its own feet: spine rounds so the
 * chest drops, the neck reaches forward and down so the skull goes between the
 * knees, and the tail trails low behind it.
 *
 * Note the tail signs: in this rig a *negative* tail target drops the tail
 * toward the deck. The tail is the tallest thing about the body, so a crouch
 * that folds only the legs barely shortens the silhouette and the dino still
 * clips a low pterodactyl. Driving the tail down with the rest of the pose is
 * what takes it from 96 px to about 55 px; an earlier version had these signs
 * flipped and the duck was useless for its one job.
 */
function duckPose(t) {
  const wob = Math.sin(t * 0.35);
  return {
    spine: 26 * DEG,
    tailCarry: -25 * DEG,
    tail1: -20 * DEG + wob * 3 * DEG,
    tail2: -18 * DEG,
    neck: 34 * DEG,
    jaw: -4 * DEG,
    hipL: 62 * DEG + wob * 2 * DEG,
    kneeL: -74 * DEG,
    hipR: 54 * DEG - wob * 2 * DEG,
    kneeR: -66 * DEG,
    armL: 30 * DEG,
    armR: 24 * DEG,
    shoulderL: 16 * DEG,
    shoulderR: 12 * DEG,
  };
}

/** Airborne: legs recover and trail, arms flare, neck braces for landing. */
function airPose(vy) {
  const rising = vy < 0;
  return {
    hipL: (rising ? 46 : 16) * DEG,
    kneeL: (rising ? -58 : -22) * DEG,
    hipR: (rising ? 10 : 34) * DEG,
    kneeR: (rising ? -18 : -46) * DEG,
    armL: (rising ? -34 : -14) * DEG,
    armR: (rising ? -26 : -6) * DEG,
    shoulderL: (rising ? -22 : -6) * DEG,
    shoulderR: (rising ? -16 : 0) * DEG,
    tailCarry: (rising ? -16 : 12) * DEG,
    tail1: (rising ? -14 : 10) * DEG,
    tail2: (rising ? -10 : 14) * DEG,
    spine: (rising ? -6 : 4) * DEG,
    neck: (rising ? -12 : 8) * DEG,
    jaw: (rising ? -14 : 4) * DEG,
  };
}

/**
 * Post-mortem targets, as offsets from neutral: loose and slightly curled.
 * Gains fade to zero so these barely pull, but they stop a corpse from locking
 * fully rigid where a joint limit happens to catch it.
 */
const LIMP = {
  spine: -0.05,
  tailCarry: 0.2,
  tail1: 0.15,
  tail2: 0.2,
  neck: 0.25,
  jaw: 0.45, // beak falls open
  hipL: 0.55,
  kneeL: 0.9,
  hipR: 0.4,
  kneeR: 0.8,
  armL: 0.7,
  armR: 0.6,
  shoulderL: 0.5,
  shoulderR: 0.45,
};

/**
 * Extra arc each joint gains once the body is dead, in radians. Knees and hips
 * get the most because a sprawled carcass has straight legs splayed sideways,
 * which a live hip cannot do.
 */
const DEAD_SPLAY = {
  spine: 0.35,
  tailCarry: 0.5,
  tail1: 0.7,
  tail2: 0.7,
  neck: 0.6,
  jaw: 0.5,
  hipL: 0.85,
  kneeL: 1.1,
  hipR: 0.85,
  kneeR: 1.1,
  armL: 0.6,
  armR: 0.6,
  shoulderL: 0.5,
  shoulderR: 0.5,
};

/**
 * How much wider each balance reflex opens once the body is dead, in radians.
 *
 * These have to widen, not just lose their target. A posture constraint has two
 * half-engines: a motor toward `target` and a pair of limits that refuse to let
 * the bone leave [lo, hi]. Zeroing the gain only silences the motor, so a corpse
 * that rolled onto its back and pushed the spine 32 degrees off level was shoved
 * straight back by the limit, every tick, forever. That reads as a body doing
 * sit-ups, and it is also a permanent source of velocity: the limit pushed, the
 * deck's friction resisted, and the imbalance walked the carcass along the deck
 * at a third of a pixel per tick long after anything watching energy would call
 * it still. Muscles let go of both halves of the reflex, not just the one that
 * looks like a muscle.
 */
const POSTURE_SPLAY = {
  torso: 1.3,
  neckCarry: 1.3,
  headUp: 1.3,
  tailCarry: 1.4,
  legL: 1.2,
  legR: 1.2,
};

export class DinoRagdoll {
  /**
   * @param {PhysicsWorld} world
   * @param {object} opts { x, groundY, facing }
   */
  constructor(world, opts = {}) {
    this.world = world;
    this.groundY = opts.groundY ?? world.groundY;
    this.facing = opts.facing ?? 1;
    this.homeX = opts.x ?? 120;

    // Run/jump model for the kinematic root while alive.
    this.root = { y: 0, vy: 0, yPrev: 0 };
    this.grounded = true;
    this.airborne = false;
    this.groundFrames = 0;
    this.airFrames = 0;
    this.phase = 0;
    this.speed = 6;
    this.alive = true;
    this.deadFor = 0;
    this.muscle = 1; // 1 = full motors, 0 = pure ragdoll
    this.ducking = false;
    this.jumpHeld = false;
    this.squash = 0; // landing compression, decays; drives root dip
    this.lastImpact = 0;
    this.strideDistance = 0;

    this.JUMP_VELOCITY = opts.jumpVelocity ?? 15.4;
    this.GRAVITY = opts.gravity ?? 0.86;
    this.FALL_GRAVITY = opts.fallGravity ?? 1.02;
    this.STANCE_PRELOAD = opts.stancePreload ?? 3;
    this.DUCK_DEPTH = opts.duckDepth ?? 34;
    this.CROUCH_SPEED = opts.crouchSpeed ?? 2.4; // px/tick the pelvis sinks or rises

    this.ids = {};
    this.joints = {};
    this.postures = {};
    // Derived, not guessed: the longest distance the leg can reach downward.
    // Must exist before build(), which places every particle using standY().
    // Hand-picking a standing height previously left the feet permanently above
    // the deck, so the dino ran on air and never registered a single footfall.
    this.LEG_REACH = this.computeLegReach();
    this.build();
    this.place(this.homeX, this.standY());
  }

  /**
   * Standing height: deck to the top of the tallest particle. Derived from the
   * skeleton so impact-height fractions mean what they say (0.9 = near the
   * skull) instead of relying on a magic constant that drifts as the body is
   * retuned.
   */
  bodyHeight() {
    const stand = this.standY();
    let top = Infinity;
    for (const spec of Object.values(SKELETON)) {
      top = Math.min(top, stand + spec.y - spec.radius);
    }
    return Math.max(this.groundY - top, 1);
  }

  /** Longest downward reach of a leg, measured along the actual bone lengths. */
  computeLegReach() {
    this.thighLength = Math.hypot(
      SKELETON.kneeL.x - SKELETON.pelvis.x,
      SKELETON.kneeL.y - SKELETON.pelvis.y
    );
    this.shinLength = Math.hypot(
      SKELETON.footL.x - SKELETON.kneeL.x,
      SKELETON.footL.y - SKELETON.kneeL.y
    );
    return this.thighLength + this.shinLength;
  }

  /**
   * Y of the pelvis when standing on the ground. Set so a fully extended leg
   * just plants its foot, with a few pixels of preload so the stance leg is
   * actually loaded rather than grazing.
   */
  standY() {
    // A couple of pixels of preload so the stance leg is genuinely loaded
    // instead of grazing the deck, which is what makes feet register contact.
    return this.groundY - this.LEG_REACH - SKELETON.footL.radius + this.STANCE_PRELOAD;
  }

  build() {
    const w = this.world;
    for (const [name, spec] of Object.entries(SKELETON)) {
      this.ids[name] = w.addParticle({
        id: `dino:${name}`,
        x: this.homeX + spec.x * this.facing,
        y: this.standY() + spec.y,
        mass: spec.mass,
        radius: spec.radius,
        groundFriction: spec.groundFriction,
        pinned: name === 'pelvis', // alive: root is kinematic
      });
    }
    const P = (n) => this.ids[n];

    for (const [a, b, width] of BONES) {
      w.addRod(P(a), P(b), { visible: true, width, group: 'flesh', stiffness: 1 });
    }
    for (const [a, b] of BRACES) {
      w.addRod(P(a), P(b), {
        visible: false,
        group: 'brace',
        stiffness: 0.9,
        // A band, not a spring: braces only correct once a limb leaves the
        // allowed scale window. As full springs they fought the bone rods and
        // the pose motors over the same particles (the tail sat 25% too long
        // and never converged), because several braces anchoring one joint
        // cannot all be satisfied at once while that joint is being posed.
        band: true,
        maxStretch: 1.22,
        minCompress: 0.8,
      });
    }
    for (const [name, spec] of Object.entries(JOINTS)) {
      // neutral is auto-derived from the rest positions in SKELETON, so the
      // stance that gets drawn is exactly the stance the motors hold at rest.
      const idx = w.addAngle(P(spec.a), P(spec.b), P(spec.c), {
        stiffness: spec.stiffness,
        target: NEUTRAL[name] ?? 0,
        lo: spec.lo,
        hi: spec.hi,
        limitStiffness: 0.7,
        maxCorrection: 0.16,
        gain: 1,
        group: name,
      });
      const ang = w.angles[idx];
      // Keep the living range around so the dead state can widen it: a corpse
      // must be able to splay further than a live animal's tendons allow.
      ang.loLive = ang.lo;
      ang.hiLive = ang.hi;
      this.joints[name] = ang;
    }
    for (const [name, spec] of Object.entries(POSTURES)) {
      const idx = w.addPosture(P(spec.pivot), P(spec.tip), {
        stiffness: spec.stiffness,
        target: spec.target ?? 0,
        lo: spec.lo,
        hi: spec.hi,
        limitStiffness: 0.6,
        maxCorrection: 0.1,
        gain: 1,
        group: name,
      });
      const post = w.postures[idx];
      // Same reasoning as the joint arcs: a corpse must be able to leave the
      // living range of a balance reflex, and revive has to be able to put it
      // back. Kept on the constraint so one place owns the living limits.
      post.loLive = post.lo;
      post.hiLive = post.hi;
      post.loDead = post.lo - (POSTURE_SPLAY[name] ?? 1.2);
      post.hiDead = post.hi + (POSTURE_SPLAY[name] ?? 1.2);
      this.postures[name] = post;
    }
  }

  /** Reset the body to a standing pose at world x. */
  place(x, y) {
    this.homeX = x;
    const w = this.world;
    const baseY = y ?? this.standY();
    for (const [name, spec] of Object.entries(SKELETON)) {
      const p = w.particles[this.ids[name]];
      w.teleport(p, x + spec.x * this.facing, baseY + spec.y);
      w.setVelocity(p, 0, 0);
    }
    // Re-seat the neutral pose exactly, otherwise a stale pose from the last
    // life leaks into the new one.
    for (const ang of Object.values(this.joints)) {
      ang.target = NEUTRAL[ang.group] ?? 0;
    }
    for (const post of Object.values(this.postures)) {
      post.target = POSTURES[post.group]?.target ?? 0;
    }
    this.root.y = baseY;
    this.root.vy = 0;
    this.root.yPrev = baseY;
    this.grounded = true;
    this.airborne = false;
    this.airFrames = 0;
    this.groundFrames = 8;
    this.squash = 0;
    this.lastImpact = 0;
  }

  /** Full reset for a new run. */
  revive(x) {
    this.alive = true;
    this.muscle = 1;
    this.deadFor = 0;
    this.ducking = false;
    this.jumpHeld = false;
    this.phase = 0;
    this.strideDistance = 0;
    const p = this.world.particles[this.ids.pelvis];
    p.invMass = 0; // re-pin the root
    p.pinned = true;
    // Restore the living joint arc that death widened.
    for (const ang of Object.values(this.joints)) {
      ang.lo = ang.loLive;
      ang.hi = ang.hiLive;
      ang.gain = 1;
    }
    for (const post of Object.values(this.postures)) {
      post.gain = 1;
      post.lo = post.loLive;
      post.hi = post.hiLive;
    }
    this.bob = 0;
    this.settled = false;
    this.place(x ?? this.homeX, this.standY());
  }

  pelvis() {
    return this.world.particles[this.ids.pelvis];
  }

  particle(name) {
    return this.world.particles[this.ids[name]];
  }

  /** Lowest point of the body above ground, used for duck/overhead checks. */
  headTop() {
    let top = Infinity;
    for (const name of ['head', 'snout', 'neck', 'tail3', 'tail2', 'pelvis']) {
      const p = this.particle(name);
      top = Math.min(top, p.y - p.radius);
    }
    return top;
  }

  frontX() {
    let fx = -Infinity;
    for (const name of ['snout', 'head', 'handL', 'handR', 'footL', 'footR']) {
      const p = this.particle(name);
      fx = Math.max(fx, p.x + p.radius);
    }
    return fx;
  }

  /** Both feet off the deck? Used to distinguish "airborne" from "stumbling". */
  isGrounded() {
    return this.grounded;
  }

  jump() {
    if (!this.alive) return false;
    // Coyote time keeps a jump pressed a frame after leaving the lip feeling fair.
    if (this.airborne && this.airFrames > 5) return false;
    this.ducking = false;
    this.jumpHeld = true;
    this.airborne = true;
    this.grounded = false;
    this.airFrames = 0;
    this.root.vy = -this.JUMP_VELOCITY;
    this.squash = 0;
    // Kick the legs: the impulse propagates through the soft torso, which is
    // most of what makes the jump look like effort rather than a teleport.
    const kick = this.JUMP_VELOCITY * 0.28;
    for (const n of ['footL', 'footR', 'kneeL', 'kneeR', 'tail3', 'tail2']) {
      this.world.addVelocity(this.particle(n), 0, -kick * 0.5);
    }
    return true;
  }

  fastFall() {
    if (!this.alive || this.grounded) return;
    this.root.vy += 1.35;
    for (const n of ['head', 'snout', 'neck']) {
      this.world.addVelocity(this.particle(n), 0, 0.9);
    }
  }

  setDuck(on) {
    if (!this.alive) return;
    this.ducking = on;
  }

  /**
   * The moment of death. Motors fade out, the root is released, and a single
   * impulse (linear + angular) is the only scripted thing that ever touches the
   * body again. Everything after this frame is gravity, friction and momentum.
   *
   * The spin is derived, not hand-picked: the hit delivers a linear shove at a
   * contact point, and a shove applied above the centre of mass rotates one way
   * while a shove below it rotates the other. That is why clipping a cactus in
   * the shins somersaults the dino forward and catching it in the face throws
   * it backwards, with no branch deciding the direction.
   */
  die(cause = {}) {
    if (!this.alive) return null;
    this.alive = false;
    this.ducking = false;
    this.jumpHeld = false;
    this.deadFor = 0;
    this.settled = false;

    const dir = cause.dir ?? -1; // obstacles travel left, so the shove is leftward
    const speed = cause.speed ?? 6;

    const com = this.world.centerOfMass();
    const hitX = cause.x ?? this.frontX();
    // Where the impact landed, in world y. Callers may pass `y` directly (the
    // game does, from the actual contact particle) or a 0..1 `height` fraction,
    // which maps between the deck and the top of the head.
    const hitY =
      cause.y ?? this.groundY - clamp(cause.height ?? 0.5, 0, 1) * this.bodyHeight();

    const vx = dir * (1.4 + speed * 0.16);
    // Upward pop, scaled by how high the hit landed: a shin clip barely lifts,
    // a head-high hit launches.
    const heightFactor = cause.height ?? clamp((this.groundY - hitY) / Math.max(this.bodyHeight(), 1), 0, 1);
    const vy = -(2.4 + heightFactor * 2.0);

    const p = this.pelvis();
    p.invMass = 1 / SKELETON.pelvis.mass;
    p.pinned = false;
    // Seed the corpse with the run momentum it had, plus the hit.
    this.world.setVelocity(p, this.facing * speed * 0.18, this.root.vy * 0.5);

    // Torque comes from the horizontal shove applied at the contact point:
    // tau = -r.y * F.x. A shove above the centre of mass rotates one way, below
    // it the other, which is why clipping a cactus in the shins somersaults the
    // dino forward and catching it in the face throws it backwards, with no
    // branch deciding the direction. The upward pop is deliberately *not* in
    // here: that is the whole body leaving the deck, so it belongs at the
    // centre of mass as pure linear momentum, not as a rotation.
    //
    // Units matter. `vx` below is a velocity change, so the impulse it stands
    // for is total mass times that velocity change. Omitting the mass factor
    // made every death spin about 20x too slowly and left the flail shoves
    // dominating, so a shin hit and a face hit tumbled the same way.
    const ry = hitY - com.y;
    const totalMass = this.world.particles.reduce(
      (acc, q) => (q.invMass === 0 ? acc : acc + q.mass),
      0
    );
    const torque = -ry * vx * totalMass;
    const inertia = this.world.particles.reduce((acc, q) => {
      if (q.invMass === 0) return acc;
      const dx = q.x - com.x;
      const dy = q.y - com.y;
      return acc + q.mass * (dx * dx + dy * dy);
    }, 1e-6);
    const omega = clamp(torque / inertia, -0.14, 0.14);

    this.world.impulse(vx, vy, omega);

    // Frozen reference for angular-momentum bookkeeping. Once the corpse is
    // tumbling, recomputing the centre of mass each frame and taking moments
    // about *that* makes the spin look unstable: limbs folding in pull the com
    // around with them. Measuring about where the com was at the instant of
    // death is the physically meaningful number.
    this.comAtDeath = { x: com.x, y: com.y };

    // Local deformation: the struck side takes a harder hit than the far side,
    // so the body starts deforming on the first frame, not after a bounce.
    for (const name of Object.keys(SKELETON)) {
      const q = this.particle(name);
      const dx = q.x - hitX;
      const dy = q.y - hitY;
      const falloff = Math.exp(-(dx * dx + dy * dy) / (2 * 34 * 34));
      this.world.addVelocity(q, dir * 1.5 * falloff, -1.2 * falloff);
    }
    // Flail: every limb gets a phase-dependent shove, so two deaths never look
    // identical without needing an RNG (and determinism stays intact).
    //
    // Neutralised afterwards, because "limbs thrashing about" is internal motion
    // and must not move the centre of mass. Left raw, these eight shoves added a
    // net linear momentum whose sign depends on the run phase, which meant a
    // purely decorative effect decided whether the carcass ended up in front of
    // or behind the cactus that killed it. The hit direction already comes from
    // the impulse and the deformation above; this only redistributes limbs about
    // the body they are attached to.
    let k = 0;
    const flails = [];
    for (const name of ['armL', 'handL', 'armR', 'handR', 'footL', 'footR', 'tail3', 'snout']) {
      k++;
      const q = this.particle(name);
      flails.push([q, Math.sin(k * 1.7 + this.phase) * 1.1, Math.cos(k * 2.3) * 0.7]);
    }
    let px = 0;
    let py = 0;
    let mass = 0;
    for (const [q, ax, ay] of flails) {
      px += q.mass * ax;
      py += q.mass * ay;
      mass += q.mass;
    }
    if (mass > 0) {
      const ux = px / mass;
      const uy = py / mass;
      for (const [q, ax, ay] of flails) this.world.addVelocity(q, ax - ux, ay - uy);
    }
    this.lastImpact = Math.hypot(vx, vy);
    return { vx, vy, omega, heightFactor };
  }

  /**
   * Plant a foot. Joint motors alone cannot make a runner *run*: with the
   * pelvis on a kinematic path, hip and knee targets only decide where the
   * limbs hang, and the feet ended up hovering a few pixels off the deck for
   * most of the cycle. So the stance leg is solved in task space instead.
   *
   * Two-bone FABRIK with a pinned base converges exactly in one pass: put the
   * knee on the hip->foot line at thigh distance, then the foot at shin
   * distance from the knee. `bend` chooses which side the knee sits on so the
   * knee does not flip through the body.
   *
   * @param {'L'|'R'} side
   * @param {number} tx desired foot x in world space
   * @param {number} ty desired foot y in world space
   * @param {number} gain 0..1 how hard to pull (soft so it never snaps)
   */
  plantFoot(side, tx, ty, gain, bend = 1) {
    const w = this.world;
    const hip = w.particles[this.ids.pelvis];
    const knee = w.particles[this.ids[`knee${side}`]];
    const foot = w.particles[this.ids[`foot${side}`]];
    const thigh = this.thighLength;
    const shin = this.shinLength;

    // Ease the foot toward the target rather than teleporting it: Verlet turns
    // a hard placement into a huge velocity spike, and the whole body would
    // cartwheel every footfall.
    foot.x += (tx - foot.x) * gain;
    foot.y += (ty - foot.y) * gain;

    let dx = foot.x - hip.x;
    let dy = foot.y - hip.y;
    let dist = Math.hypot(dx, dy);
    if (dist < 1e-6) {
      dx = 1;
      dy = 0;
      dist = 1;
    }
    const ux = dx / dist;
    const uy = dy / dist;

    // Reach deficit: the chain cannot span more than thigh+shin, and this is
    // also what makes a stretched leg feel like it is straining for the deck.
    const span = clamp(dist, Math.abs(thigh - shin) + 0.5, thigh + shin - 0.001);
    const kx = hip.x + ux * thigh;
    const ky = hip.y + uy * thigh;
    // Knee offset perpendicular to the chain, so the joint bulges forward the
    // way a dino's does instead of collapsing onto the hip-foot line.
    const h = Math.sqrt(Math.max(thigh * thigh - (span * 0.5) * (span * 0.5), 1));
    const nx = -uy * bend;
    const ny = ux * bend;
    const bowGain = 0.35;
    knee.x = lerp(knee.x, kx + nx * h * bowGain, gain);
    knee.y = lerp(knee.y, ky + ny * h * bowGain, gain);

    // Close the shin from the knee so the bone length is respected.
    let sx = foot.x - knee.x;
    let sy = foot.y - knee.y;
    const sd = Math.hypot(sx, sy) || 1;
    foot.x = knee.x + (sx / sd) * shin;
    foot.y = knee.y + (sy / sd) * shin;
  }

  /**
   * Drive both legs for one tick. The leg in stance is planted (foot pinned to
   * a spot travelling backwards under the body, which is what a foot on the
   * ground actually does on a treadmill deck); the leg in swing follows a lift-
   * and-reach arc so the knee comes up and the heel kicks behind.
   */
  driveLegs(dt) {
    const deckY = this.groundY - SKELETON.footL.radius;

    if (this.ducking) {
      // A duck is a crouch, not a fast run: both feet stay planted, one slightly
      // ahead of the other, while the body sinks between them. Driving a gait
      // here left one foot mid-swing several pixels off the deck, so the dino
      // crouched on tip-toe and never actually got low.
      const stride = this.strideLength() * 0.5;
      this.plantFoot('L', this.homeX + stride * 0.55, deckY, clamp(0.5 * dt, 0, 0.7), 1);
      this.plantFoot('R', this.homeX - stride * 0.45, deckY, clamp(0.5 * dt, 0, 0.7), 1);
      return;
    }

    const stride = this.strideLength();
    for (const [side, offset] of [['L', 0], ['R', Math.PI]]) {
      const p = wrapAngle(this.phase + offset);
      const u = p < Math.PI ? p / Math.PI : (p - Math.PI) / Math.PI;
      const swinging = p >= Math.PI;

      if (!swinging) {
        // Stance: the foot is on the deck, and the deck is a treadmill moving
        // backwards under the body. So a foot that is genuinely planted has to
        // travel backwards at the scroll speed, which over a half stride is
        // exactly one stride length. It used to be written the other way round
        // (foot swept forwards through stance), which is the sign error that made
        // the dino skate: held in the air at a fixed screen x while the belt
        // slid out from under it, so every footfall was a ski jump.
        //
        // The hip is pinned at homeX in screen space, so the whole gait has to be
        // expressed as the foot moving relative to a fixed body. Take off behind
        // the hip, land ahead of it, and in between ride the deck backwards.
        const rel = (0.5 - u) * stride;
        const tx = this.homeX + rel;
        const sink = Math.sin(u * Math.PI) * 3;
        const ty = deckY + sink;
        this.plantFoot(side, tx, ty, clamp(0.55 * dt, 0, 0.8), 1);
      } else {
        // Swing: knee lifts, foot reaches forward for the next landing.
        const lift = Math.sin(u * Math.PI) * clamp(this.speed * 1.9, 10, 26);
        const reach = lerp(-stride * 0.35, stride * 0.52, u);
        const tx = this.homeX + reach;
        const ty = this.pelvis().y + this.LEG_REACH - lift;
        this.plantFoot(side, tx, ty, clamp(0.28 * dt, 0, 0.5), 1);
      }
    }
  }

  /** Distance the body covers in one half stride, used to place the feet. */
  strideLength() {
    // Guard the idle case: at speed 0 the cadence term divides by zero, and
    // 0 * Infinity is NaN, which propagated into every foot position.
    const cadence = Math.max(this.speed, 0.5) * RUN_CADEX;
    const stepsPerStride = Math.max(6, (TAU / cadence) * 0.5);
    return this.speed * stepsPerStride * 0.5;
  }

  /**
   * Advance one fixed tick.
   * @param {number} dt ticks (1 = 1/60s)
   * @param {object} intent { speed, ducking, jumping }
   */
  update(dt, intent = {}) {
    const w = this.world;
    this.speed = intent.speed ?? this.speed;
    if (intent.ducking !== undefined && this.alive) this.ducking = intent.ducking;
    this.jumpHeld = !!intent.jumpHeld;

    if (this.alive) {
      this.tickAlive(dt);
    } else {
      this.tickDead(dt);
    }
    w.step(dt);
    return this;
  }

  tickAlive(dt) {
    const w = this.world;
    const pelvis = this.pelvis();
    const stand = this.standY();

    // --- root: ballistic vertical, springy horizontal -------------------
    // Two separate things, deliberately not derived from each other. `airborne`
    // is set by a jump and cleared on landing. The floor is set by *intent*
    // (ducking asks for a lower pelvis). Deriving airborne from the height
    // clamp was the bug: the ducked floor sits below the standing one, so the
    // frame ducking began the root was above it, got called airborne, which
    // removed the duck offset, which put it back on the floor. It ping-ponged
    // every tick and the dino never crouched.
    const duckDepth = this.ducking ? this.DUCK_DEPTH : 0;
    const floor = stand + duckDepth + this.squash;

    this.root.yPrev = this.root.y;
    if (this.airborne) {
      const g = this.root.vy < 0 && this.jumpHeld ? this.GRAVITY * 0.78 : this.FALL_GRAVITY;
      this.root.vy += g * dt;
      this.root.y += this.root.vy * dt;
      if (this.root.y >= floor && this.root.vy >= 0) {
        if (this.root.vy > 4) {
          // Legs eat the landing as a squash that then rebounds through the
          // soft torso, instead of the body stopping dead like a sprite.
          this.squash = Math.min(16, this.root.vy * 0.75);
          this.onLand?.({ vy: this.root.vy });
        }
        this.root.y = floor;
        this.root.vy = 0;
        this.airborne = false;
        this.airFrames = 0;
      } else {
        this.airFrames += dt;
      }
    } else {
      // On the deck: the pelvis tracks the floor, but *travels* to it at a
      // finite speed so a crouch reads as legs folding under the body rather
      // than the whole dino dropping a foot in one frame.
      const rate = this.CROUCH_SPEED * dt;
      if (this.root.y < floor) this.root.y = Math.min(floor, this.root.y + rate);
      else if (this.root.y > floor) this.root.y = Math.max(floor, this.root.y - rate);
      this.root.vy = 0;
    }
    this.grounded = !this.airborne;
    this.groundFrames = this.grounded ? this.groundFrames + dt : 0;
    this.squash *= Math.pow(0.72, dt);
    if (this.squash < 0.05) this.squash = 0;

    // Write the root. teleport() keeps the velocity bookkeeping consistent so
    // hanging limbs inherit the root's motion instead of getting left behind.
    w.teleport(pelvis, this.homeX, this.root.y - this.squash + (this.bob ?? 0));
    w.setVelocity(pelvis, 0, this.root.vy * 0.35);

    // --- pose -------------------------------------------------------------
    if (this.grounded) {
      this.phase += this.speed * RUN_CADEX * dt;
      if (this.phase > TAU) this.phase -= TAU;
      this.strideDistance += this.speed * dt;
    }

    // Body bounce. A real gallop throws the torso up between stance phases; a
    // root glued to one height reads as a sprite sliding on a conveyor belt.
    // Half a stride per bounce, so each footfall lands on the down beat.
    const bobTarget =
      this.grounded && !this.ducking
        ? -Math.abs(Math.sin(this.phase)) * clamp(this.speed * 0.32, 1.2, 3.4)
        : 0;
    this.bob = lerp(this.bob ?? 0, bobTarget, 1 - Math.pow(0.25, dt));

    const intensity = this.ducking ? 0.55 : clamp(this.speed / 7, 0.35, 1.25);
    let pose;
    if (!this.grounded) {
      pose = airPose(this.root.vy);
    } else if (this.ducking) {
      pose = duckPose(this.phase * 4 + this.strideDistance * 0.02);
    } else {
      pose = runPose(this.phase, intensity);
    }

    for (const [name, offset] of Object.entries(pose)) {
      const ang = this.joints[name];
      if (!ang) continue;
      ang.target = (NEUTRAL[name] ?? 0) + offset;
    }

    // Feet: task-space placement while running or crouched on the deck. In the
    // air the legs are pose-driven only, so a jump keeps the tucked silhouette
    // instead of one foot reaching down for a deck that is not there.
    if (this.grounded) this.driveLegs(dt);
    // Balance reflexes: lean into the run, lift the head as speed builds.
    // The ducking tail target is the single most important number here. The
    // tail is the tallest thing about the body, so a crouch that only folds the
    // legs leaves the silhouette barely shorter and useless for sliding under a
    // pterodactyl; driving the tail down with the balance reflex is what turns
    // a 96 px dino into a 56 px one.
    this.postures.torso.target = this.ducking ? 0.3 : clamp(this.speed * 0.008, 0, 0.1);
    this.postures.headUp.target = this.ducking ? 0.28 : clamp(-this.speed * 0.006, -0.08, 0);
    this.postures.tailCarry.target = this.ducking ? -0.5 : -0.04;
    // A crouch has to fold the neck with everything else, or the skull stays up
    // at 118 px and the duck loses the only height reduction that matters.
    this.postures.neckCarry.target = this.ducking ? 0.5 : clamp(-this.speed * 0.004, -0.06, 0);
    this.postures.legL.target = 0;
    this.postures.legR.target = 0;

    for (const ang of Object.values(this.joints)) {
      ang.gain = lerp(ang.gain ?? 1, this.muscle, 0.5);
    }
    for (const post of Object.values(this.postures)) {
      post.gain = lerp(post.gain ?? 1, this.muscle, 0.35);
    }
  }

  tickDead(dt) {
    this.deadFor += dt;
    // Muscles cut over ~4 frames. Instantly cutting them makes the first frame
    // of death twitch; a short fade looks like the body deciding to give up.
    this.muscle = Math.max(0, 1 - this.deadFor / 4);

    // A corpse must be able to splay further than a living animal: tendons are
    // what hold a live dino's knees from bending backwards, and those are gone.
    // Limits stay in place (so limbs never invert through themselves) but the
    // usable arc opens up as the muscles go, which is what lets a body land
    // flat instead of folding upright like it is still standing.
    const splay = clamp(this.deadFor / 10, 0, 1);
    for (const ang of Object.values(this.joints)) {
      ang.gain = this.muscle;
      ang.target = lerp(ang.target, (NEUTRAL[ang.group] ?? 0) + (LIMP[ang.group] ?? 0), 0.12 * dt);
      const widen = DEAD_SPLAY[ang.group] ?? 0.5;
      ang.lo = ang.loLive - widen * splay;
      ang.hi = ang.hiLive + widen * splay;
    }
    // The balance reflex goes limp completely. Zeroing the gain alone is not
    // enough: see POSTURE_SPLAY for what the limits alone will do to a body that
    // is supposed to be dead.
    for (const post of Object.values(this.postures)) {
      post.gain = this.muscle;
      post.target = lerp(post.target, 0, 0.2 * dt);
      post.lo = post.loLive - (post.loLive - post.loDead) * splay;
      post.hi = post.hiLive + (post.hiDead - post.hiLive) * splay;
    }
    // Settle detection: once the whole body has been slow for a spell, the run
    // is properly over. Latched, because kinetic energy wobbles frame to frame
    // and an un-latched flag blinked true/false, which made the game re-check
    // for a death that had already happened.
    if (this.muscle === 0) {
      const ke = this.world.totalKineticEnergy();
      if (ke < 0.25) this.settleFrames = (this.settleFrames ?? 0) + dt;
      else this.settleFrames = 0;
      this.settled = this.deadFor > 40 && this.settleFrames > 25;
    }
  }

  /** Debug/telemetry snapshot. */
  getState() {
    const p = this.pelvis();
    const com = this.world.centerOfMass();
    const joints = {};
    for (const [name, ang] of Object.entries(this.joints)) {
      joints[name] = {
        // Both relative to rest, so these two numbers are directly comparable.
        current: +this.world.angleValue(ang).toFixed(3),
        target: +ang.target.toFixed(3),
        gain: +(ang.gain ?? 0).toFixed(3),
      };
    }
    return {
      alive: this.alive,
      grounded: this.grounded,
      ducking: this.ducking,
      muscle: +this.muscle.toFixed(3),
      deadFor: this.deadFor,
      settled: !!this.settled,
      phase: +this.phase.toFixed(3),
      rootY: +this.root.y.toFixed(2),
      rootVy: +this.root.vy.toFixed(3),
      pelvis: { x: +p.x.toFixed(2), y: +p.y.toFixed(2) },
      com: { x: +com.x.toFixed(2), y: +com.y.toFixed(2) },
      angularMomentum: +this.world.angularMomentum(this.comAtDeath).toFixed(2),
      kineticEnergy: +this.world.totalKineticEnergy().toFixed(3),
      joints,
    };
  }

  /** Bones to skin: the renderer unions these into the silhouette. */
  skin() {
    const w = this.world;
    return BONES.map(([a, b, width], i) => {
      const pa = w.particles[this.ids[a]];
      const pb = w.particles[this.ids[b]];
      return { a, b, x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, width, index: i };
    });
  }

  jointPositions() {
    const out = {};
    for (const name of Object.keys(SKELETON)) {
      const p = this.particle(name);
      out[name] = { x: p.x, y: p.y, radius: p.radius };
    }
    return out;
  }

  /**
   * Head frame: origin at the head particle, +x along neck->head, so the
   * renderer can stamp a skull that follows the neck without any IK.
   */
  headFrame() {
    const neck = this.particle('neck');
    const head = this.particle('head');
    const snout = this.particle('snout');
    const ang = Math.atan2(head.y - neck.y, head.x - neck.x);
    return { x: head.x, y: head.y, angle: ang, snoutX: snout.x, snoutY: snout.y };
  }

  /** Particles the game tests against obstacles for crash detection. */
  hitParticles() {
    const names = ['head', 'snout', 'neck', 'chest', 'pelvis', 'kneeL', 'footL', 'kneeR', 'footR', 'tail1', 'tail2', 'tail3'];
    return names.map((n) => this.particle(n));
  }

  count() {
    return {
      particles: this.world.particles.length,
      rods: this.world.rods.length,
      angles: this.world.angles.length,
      postures: this.world.postures.length,
      flesh: BONES.length,
      braces: BRACES.length,
      joints: Object.keys(JOINTS).length,
    };
  }
}

export { SKELETON, BONES, BRACES, JOINTS, NEUTRAL, POSTURES, POSTURE_SPLAY };
export { LIMP, DEAD_SPLAY };
export { PhysicsWorld };
