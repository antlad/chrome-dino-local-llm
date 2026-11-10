// Position-based dynamics (XPBD-flavoured, fixed-step) written from scratch.
//
// Design notes
// ------------
// * Particles are integrated with Verlet: velocity is implicit as
//   `pos - prev`. That keeps the solver simple and, importantly for a ragdoll,
//   it conserves angular momentum well enough that a corpse tumbles convincingly
//   instead of sagging like a wet towel.
// * Bones are distance constraints (rods). Joints are angular constraints with
//   both a motor target (two-sided) and hard-ish limits (one-sided), which is
//   what lets the same skeleton be "muscular" while alive and "limp" once dead:
//   you just fade the motor gains and keep the limits so nothing hyperextends.
// * Collision primitives are capsules (segment + radius) and a ground plane.
//   Capsules get a surface velocity so a moving cactus can shove the corpse,
//   which is what makes the death read as an impact rather than a state change.
// * The solver is Gauss-Seidel, `iterations` passes per substep. Deterministic:
//   no randomness, no time dependency, iteration order is fixed. Given the same
//   inputs, two runs produce identical float streams.

const TAU = Math.PI * 2;

export function wrapAngle(a) {
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  if (x < -Math.PI) x += TAU;
  return x;
}

/** Signed angle from (a-b) to (c-b), vertex at b. */
export function angleAt(ax, ay, bx, by, cx, cy) {
  const d1x = ax - bx;
  const d1y = ay - by;
  const d2x = cx - bx;
  const d2y = cy - by;
  return wrapAngle(Math.atan2(d1x * d2y - d1y * d2x, d1x * d2x + d1y * d2y));
}

function rotateAbout(px, py, bx, by, ang) {
  const dx = px - bx;
  const dy = py - by;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return [bx + dx * c - dy * s, by + dx * s + dy * c];
}

/** Closest point on segment ab to point p, plus squared distance. */
function closestOnSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 1e-9 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [ax + abx * t, ay + aby * t];
}

export class PhysicsWorld {
  constructor(options = {}) {
    this.gravity = options.gravity ?? 0.9;
    this.damping = options.damping ?? 0.992;
    this.iterations = options.iterations ?? 7;
    this.shapePasses = options.shapePasses ?? 4;
    this.substeps = options.substeps ?? 2;
    this.groundY = options.groundY ?? 372;
    // The deck is a treadmill, not a floor. A side-scroller holds the actor at a
    // fixed screen x and moves the world past it, so the surface under the body
    // is really travelling backwards at the scroll speed. Friction has to be
    // measured against that moving surface or a released body drops straight down
    // in place instead of being left behind, which is the single most visible
    // tell of a ragdoll that is not really coupled to its world. The game writes
    // this each tick; a bare world sits still.
    this.groundVx = options.groundVx ?? 0;
    this.restitution = options.restitution ?? 0.16;
    this.friction = options.friction ?? 0.42;
    this.airDrag = options.airDrag ?? 0.0015;

    // Soft side walls so a corpse never leaves the theatre.
    this.bounds = options.bounds ?? { left: -260, right: 1460 };

    /** @type {Array<object>} */
    this.particles = [];
    /** @type {Array<object>} */
    this.rods = [];
    /** @type {Array<object>} */
    this.angles = [];
    /** @type {Array<object>} */
    this.postures = [];
    /** @type {Array<object>} */
    this.colliders = [];

    this.stepIndex = 0;
    this.stats = { rodCorrections: 0, angleCorrections: 0, postureCorrections: 0, contacts: 0 };
  }

  addParticle(opts = {}) {
    const p = {
      id: opts.id ?? `p${this.particles.length}`,
      x: opts.x ?? 0,
      y: opts.y ?? 0,
      px: opts.x ?? 0,
      py: opts.y ?? 0,
      radius: opts.radius ?? 4,
      invMass: opts.pinned ? 0 : 1 / Math.max(opts.mass ?? 1, 1e-6),
      pinned: !!opts.pinned,
      mass: opts.mass ?? 1,
      layer: opts.layer ?? 0,
      resting: false,
      // Per-particle overrides that the character controller may animate.
      groundFriction: opts.groundFriction ?? this.friction,
      groundRestitution: opts.groundRestitution ?? this.restitution,
    };
    this.particles.push(p);
    return this.particles.length - 1;
  }

  addRod(a, b, opts = {}) {
    const pa = this.particles[a];
    const pb = this.particles[b];
    const rest =
      opts.rest ?? Math.hypot(pb.x - pa.x, pb.y - pa.y);
    const rod = {
      a,
      b,
      rest,
      rest0: rest,
      stiffness: opts.stiffness ?? 1,
      maxStretch: opts.maxStretch ?? Infinity,
      minCompress: opts.minCompress ?? 0,
      // band=true means "only correct outside [minCompress, maxStretch]",
      // so the constraint is a limit rather than a spring.
      band: opts.band ?? false,
      visible: opts.visible ?? true,
      width: opts.width ?? 6,
      group: opts.group ?? 'body',
    };
    this.rods.push(rod);
    return this.rods.length - 1;
  }

  addAngle(a, b, c, opts = {}) {
    const pa = this.particles[a];
    const pb = this.particles[b];
    const pc = this.particles[c];
    // Everything about an angle constraint is stored *relative to a neutral*
    // (rest) value. Absolute angles are a trap: a straight limb measures about
    // +/-PI, and a hair of noise makes wrapAngle() flip its sign between two
    // solver iterations, turning a joint limit into a 3.5 rad kick that hurls
    // the body across the screen. Relative angles put every rest pose at ~0,
    // where the wrap boundary never bites.
    const neutral = opts.neutral ?? angleAt(pa.x, pa.y, pb.x, pb.y, pc.x, pc.y);
    const ang = {
      a,
      b,
      c,
      neutral,
      target: opts.target ?? 0, // relative to neutral
      stiffness: opts.stiffness ?? 0,
      lo: opts.lo ?? -Infinity, // relative limits
      hi: opts.hi ?? Infinity,
      limitStiffness: opts.limitStiffness ?? 0.65,
      maxCorrection: opts.maxCorrection ?? 0.22,
      gain: opts.gain ?? 0,
      group: opts.group ?? 'body',
    };
    this.angles.push(ang);
    return this.angles.length - 1;
  }

  /** Relative (from neutral) value of an angle constraint, wrapped to (-PI, PI]. */
  angleValue(ang) {
    const pa = this.particles[ang.a];
    const pb = this.particles[ang.b];
    const pc = this.particles[ang.c];
    return wrapAngle(angleAt(pa.x, pa.y, pb.x, pb.y, pc.x, pc.y) - ang.neutral);
  }

  /**
   * Capsule collider in a moving group (an obstacle). Segments are given in
   * collider-local space; the group carries position + velocity.
   */
  addCollider(opts = {}) {
    const segments = (opts.segments ?? []).map((s) => ({
      x1: s.x1,
      y1: s.y1,
      x2: s.x2,
      y2: s.y2,
      r: s.r ?? 4,
    }));
    // A zero-length capsule is not a degenerate case to be tolerant about: the
    // collision code divides by the segment length, so one slipped into an
    // obstacle silently turns every particle that touches it into NaN and the
    // body vanishes off the screen several frames later, far from the cause.
    // Rejecting at the boundary puts the error where the bad data was made.
    for (const s of segments) {
      if (!Number.isFinite(s.x1) || !Number.isFinite(s.y1) || !Number.isFinite(s.x2) || !Number.isFinite(s.y2)) {
        throw new Error(`collider ${opts.id ?? '?'} has a non-finite segment`);
      }
      if (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 1e-4) {
        throw new Error(`collider ${opts.id ?? '?'} has a zero-length segment at ${s.x1},${s.y1}`);
      }
    }
    const col = {
      id: opts.id ?? `c${this.colliders.length}`,
      x: opts.x ?? 0,
      y: opts.y ?? 0,
      // Velocity is *measured* from the collider's own motion, not declared by
      // whoever moves it. See measureColliderVelocities().
      vx: 0,
      vy: 0,
      xPrev: opts.x ?? 0,
      yPrev: opts.y ?? 0,
      segments,
      enabled: opts.enabled ?? true,
      kind: opts.kind ?? 'obstacle',
      data: opts.data ?? null,
    };
    this.colliders.push(col);
    return col;
  }

  /**
   * Derive each collider's velocity from where it actually moved since the last
   * tick. Handing the solver a velocity that the mover merely *claims* it has is
   * a standing invitation to lie, and it did: once a run ended the world stopped
   * scrolling but every cactus kept the `vx` it had at the moment of death, so
   * stationary obstacles went on dragging the corpse across the deck and the
   * body never quite settled. Measuring displacement makes that class of bug
   * impossible: a collider that is not moving has no business shoving anything,
   * whatever its owner says.
   */
  measureColliderVelocities(dt = 1) {
    const h = dt > 0 ? dt : 1;
    for (const col of this.colliders) {
      col.vx = (col.x - col.xPrev) / h;
      col.vy = (col.y - col.yPrev) / h;
      col.xPrev = col.x;
      col.yPrev = col.y;
    }
  }

  removeCollider(col) {
    const i = this.colliders.indexOf(col);
    if (i >= 0) this.colliders.splice(i, 1);
  }

  particle(id) {
    return this.particles.find((p) => p.id === id);
  }

  indexOf(id) {
    return this.particles.findIndex((p) => p.id === id);
  }

  setVelocity(p, vx, vy) {
    p.px = p.x - vx;
    p.py = p.y - vy;
  }

  velocity(p) {
    return [p.x - p.px, p.y - p.py];
  }

  /** Add to a particle's implicit velocity. */
  addVelocity(p, dvx, dvy) {
    p.px -= dvx;
    p.py -= dvy;
  }

  /** Rigid-ish translation: move both current and previous position. */
  teleport(p, x, y) {
    const dx = x - p.x;
    const dy = y - p.y;
    p.x = x;
    p.y = y;
    p.px += dx;
    p.py += dy;
  }

  integrate(dt) {
    const g = this.gravity * dt * dt;
    const d = Math.pow(this.damping, dt);
    const restEps = this.gravity * dt * 2;
    for (const p of this.particles) {
      if (p.invMass === 0) continue; // kinematic: pinned roots and helpers
      const vx = (p.x - p.px) * d;
      const vy = (p.y - p.py) * d;
      // Normal force. A particle resting on the deck is held up by it, so
      // gravity must not be applied to it. Without this, plain Verlet adds
      // gravity every tick and collision deletes it again a moment later, so a
      // perfectly still corpse keeps measuring a full gravity step of velocity
      // on every other frame and never looks settled to anything watching the
      // energy. Launching clears the flag, so a hit sends it airborne again.
      let grav = g;
      if (p.resting) {
        if (vy <= -restEps) p.resting = false;
        else grav = 0;
      }
      p.vxArrive = vx;
      p.vyArrive = vy;
      p.px = p.x;
      p.py = p.y;
      p.x += vx;
      p.y += vy + grav;
    }
  }

  /**
   * Posture constraint: drives the *world-space* direction of a bone toward a
   * target angle. Relative angle motors alone cannot hold an animal upright:
   * they only say how limbs sit relative to each other, so a torso hanging off
   * a single pinned root is free to invert and dangle. Posture is what says
   * "spine stays level, head stays up" against gravity.
   *
   * Stored relative to a neutral direction so a straight bone does not sit on
   * the +/-PI wrap boundary, exactly as with angle constraints.
   */
  addPosture(pivot, tip, opts = {}) {
    const pp = this.particles[pivot];
    const pt = this.particles[tip];
    const neutral =
      opts.neutral ?? Math.atan2(pt.y - pp.y, pt.x - pp.x);
    const post = {
      pivot,
      tip,
      neutral,
      target: opts.target ?? 0, // relative to neutral
      stiffness: opts.stiffness ?? 0.2,
      lo: opts.lo ?? -Infinity,
      hi: opts.hi ?? Infinity,
      limitStiffness: opts.limitStiffness ?? 0.6,
      maxCorrection: opts.maxCorrection ?? 0.12,
      gain: opts.gain ?? 1,
      group: opts.group ?? 'posture',
    };
    this.postures.push(post);
    return this.postures.length - 1;
  }

  postureValue(post) {
    const pp = this.particles[post.pivot];
    const pt = this.particles[post.tip];
    return wrapAngle(Math.atan2(pt.y - pp.y, pt.x - pp.x) - post.neutral);
  }

  solvePosture(post) {
    const pp = this.particles[post.pivot];
    const pt = this.particles[post.tip];
    const wp = pp.invMass;
    const wt = pt.invMass;
    const w = wp + wt;
    if (w === 0) return;

    const cur = this.postureValue(post);
    let corr = 0;
    if ((post.gain ?? 1) > 0 && post.stiffness > 0) {
      corr += wrapAngle(post.target - cur) * post.stiffness * (post.gain ?? 1);
    }
    if (cur < post.lo) {
      const want = (post.lo - cur) * post.limitStiffness;
      if (want > corr) corr = want;
    } else if (cur > post.hi) {
      const want = (post.hi - cur) * post.limitStiffness;
      if (want < corr) corr = want;
    }
    if (Math.abs(corr) < 1e-6) return;
    const cap = post.maxCorrection;
    if (corr > cap) corr = cap;
    else if (corr < -cap) corr = -cap;

    // Rotating the tip about the pivot by +t raises the measured direction by
    // t; so does rotating the pivot about the tip by +t (the direction is
    // antiparallel, offset by PI, which wrapAngle keeps harmless). Splitting
    // the job by inverse-mass share means a light head swings and a heavy
    // torso barely moves.
    const ft = wt / w;
    const fp = wp / w;
    const [ntx, nty] = rotateAbout(pt.x, pt.y, pp.x, pp.y, corr * ft);
    const [npx, npy] = rotateAbout(pp.x, pp.y, pt.x, pt.y, corr * fp);
    pt.x = ntx;
    pt.y = nty;
    pp.x = npx;
    pp.y = npy;
    this.stats.postureCorrections += Math.abs(corr);
  }

  solveRod(rod) {
    const pa = this.particles[rod.a];
    const pb = this.particles[rod.b];
    const w = pa.invMass + pb.invMass;
    if (w === 0) return;
    let dx = pb.x - pa.x;
    let dy = pb.y - pa.y;
    let dist = Math.hypot(dx, dy);
    if (dist < 1e-9) {
      // Degenerate: nudge apart along a deterministic axis.
      dx = 0;
      dy = 1;
      dist = 1;
    }

    const lo = rod.rest0 * (rod.minCompress || 0);
    const hi = rod.rest0 * (rod.maxStretch === Infinity ? Infinity : rod.maxStretch);
    let target = rod.rest;
    if (rod.band) {
      // Shape limit: correct only outside the allowed band, and never inside
      // it. Braces use this so they can stop a limb collapsing through the
      // body without acting as a second spring that competes with the pose
      // motors. As full springs they were measurably fighting the tail motors
      // and leaving the tail permanently 25% too long.
      if (dist > hi) target = hi;
      else if (lo > 0 && dist < lo) target = lo;
      else return;
    } else {
      if (hi < Infinity && target > hi) target = hi;
      if (lo > 0 && target < lo) target = lo;
    }

    const diff = ((dist - target) / dist) * rod.stiffness;
    const ox = dx * diff;
    const oy = dy * diff;
    const fa = pa.invMass / w;
    const fb = pb.invMass / w;
    pa.x += ox * fa;
    pa.y += oy * fa;
    pb.x -= ox * fb;
    pb.y -= oy * fb;
    this.stats.rodCorrections += Math.abs(dist - target);
  }

  solveAngle(ang) {
    const pa = this.particles[ang.a];
    const pb = this.particles[ang.b];
    const pc = this.particles[ang.c];
    const wa = pa.invMass;
    const wc = pc.invMass;
    const w = wa + wc;
    if (w === 0) return;

    const cur = this.angleValue(ang);
    let corr = 0;

    const gain = ang.gain ?? 0;
    if (gain > 0 && ang.stiffness > 0) {
      const err = wrapAngle(ang.target - cur);
      corr += err * ang.stiffness * gain;
    }
    if (cur < ang.lo) {
      const want = (ang.lo - cur) * ang.limitStiffness;
      if (want > corr) corr = want;
    } else if (cur > ang.hi) {
      const want = (ang.hi - cur) * ang.limitStiffness;
      if (want < corr) corr = want;
    }
    if (Math.abs(corr) < 1e-6) return;

    // Cap the correction any single iteration may apply. Verlet turns a
    // position projection into velocity, so an unbounded motor that yanks a
    // joint two radians in one pass has just injected enough energy to fling
    // the whole body. Compliant-and-clipped beats stiff-and-explosive.
    const cap = ang.maxCorrection;
    if (corr > cap) corr = cap;
    else if (corr < -cap) corr = -cap;

    // Split the correction by inverse-mass share so a light vertex (a hand)
    // swings more than a heavy one (a pelvis). Rotating about the vertex
    // preserves both bone lengths exactly, so rods never fight the motor.
    //
    // Sign: angleAt() measures the turn from (a-b) to (c-b). Rotating a by +t
    // *subtracts* t from that measurement and rotating c by -t also subtracts,
    // so a +corr correction has to rotate a by -corr and c by +corr. Get this
    // backwards and the motor becomes positive feedback that tears the body
    // apart against its own rods.
    const fa = wa / w;
    const fc = wc / w;
    const [nax, nay] = rotateAbout(pa.x, pa.y, pb.x, pb.y, -corr * fa);
    const [ncx, ncy] = rotateAbout(pc.x, pc.y, pb.x, pb.y, corr * fc);
    pa.x = nax;
    pa.y = nay;
    pc.x = ncx;
    pc.y = ncy;
    this.stats.angleCorrections += Math.abs(corr);
  }

  collideGround(p) {
    const bottom = p.y + p.radius;
    // Sticky contact band. Anything further above the deck than this is simply
    // not touching it, and loses its resting flag so gravity takes over again.
    const contactTol = 0.45;
    if (bottom <= this.groundY - contactTol) {
      p.resting = false;
      // Leaving the deck ends the contact streak, so the next arrival is allowed to
      // be treated as an impact again.
      p.contactFrames = 0;
      return;
    }
    // In contact.
    //
    // The settle decision uses the *arrival* velocity captured in integrate, not
    // `p.x - p.px`. collideGround runs inside the constraint loop, up to
    // (iterations x shapePasses) times a tick, and every rod and angle pass that
    // touches this particle rewrites px on its way to holding a bone length.
    // Reading the difference mid-solve therefore measures solver chatter as if it
    // were motion: a knee pinned to the deck under a heavy torso gets a fresh rod
    // kick each iteration, never looks slow enough to be called settled, keeps
    // 58% of that kick as real velocity, and creeps along the deck forever. The
    // velocity the particle actually arrived at the deck with is the only honest
    // answer to "is this thing still moving".
    const vxArr = p.vxArrive ?? p.x - p.px;
    const vyArr = p.vyArrive ?? p.y - p.py;
    const restEps = this.gravity * (this.currentDt ?? 1) * 2;
    const pen = bottom - this.groundY;

    if (pen > 0) {
      p.y = this.groundY - p.radius;
      // Restitution only for a real downward hit. The threshold has to clear the
      // velocity gravity itself adds in one tick: at 0.9 px/tick, a fixed 0.55
      // cut-off meant every particle merely *resting* on the deck arrived each
      // frame at exactly 0.9, qualified as an impact, and bounced. That is the
      // limit cycle that kept a dead body buzzing at a constant energy forever.
      //
      // The second half of that rule matters just as much: a bounce is what happens
      // at an *impact*, not at a contact that has been held for fifty ticks. A
      // particle already in contact last tick is being pressed into the deck by
      // whatever is on top of it, and answering a press with a bounce turns a
      // settled elbow into a permanent pogo stick.
      const impact = p.contactFrames > 0 ? 0 : vyArr > restEps ? p.groundRestitution : 0;
      p.py = p.y + vyArr * impact;
      this.stats.contacts += 1;
    }
    p.contactFrames = (p.contactFrames ?? 0) + 1;

    // Tangential friction, expressed as a velocity multiplier, applied across the
    // whole contact band rather than only to penetration. It used to live in the
    // penetrating branch alone, so a limb that a bone constraint had lifted a
    // hair off the deck skipped friction completely and slid along it without
    // resistance. A particle that is essentially settled loses all tangential
    // drift too, which is what lets a corpse stay where it landed.
    //
    // Decide from the arrival velocity, but damp the *live* one. Those have to be
    // two different reads: re-applying px from the arrival figure on every
    // iteration would hand back the velocity the rods had just taken away,
    // eleven times a tick, turning friction into a motor.
    //
    // Friction is against the *deck*, and the deck moves. `rel` is the slip
    // speed at the contact, which is what friction opposes; damping it toward zero
    // means a body in contact is carried along with the surface until it matches,
    // exactly as a real body dropped onto a treadmill is carried along.
    const settled = Math.abs(vyArr) <= restEps && Math.abs(vxArr - this.groundVx) < 0.12;
    const vx = p.x - p.px;
    const keep = settled ? 0 : 1 - p.groundFriction;
    p.px = p.x - (this.groundVx + (vx - this.groundVx) * keep);
    p.resting = settled;
  }

  collideColliders(p) {
    for (const col of this.colliders) {
      if (!col.enabled) continue;
      for (const s of col.segments) {
        const ax = col.x + s.x1;
        const ay = col.y + s.y1;
        const bx = col.x + s.x2;
        const by = col.y + s.y2;
        const reach = p.radius + s.r;
        const [qx, qy] = closestOnSegment(p.x, p.y, ax, ay, bx, by);
        let dx = p.x - qx;
        let dy = p.y - qy;
        let d = Math.hypot(dx, dy);
        if (d >= reach) continue;
        if (d < 1e-6) {
          // Centre is exactly on the segment: eject along the segment normal.
          const sx = bx - ax;
          const sy = by - ay;
          const len = Math.hypot(sx, sy) || 1;
          dx = -sy / len;
          dy = sx / len;
          d = 1e-6;
        }
        const nx = dx / d;
        const ny = dy / d;
        const push = reach - d;
        p.x += nx * push;
        p.y += ny * push;

        // Friction against the surface's own velocity: a cactus moving left at
        // `vx` drags the corpse with it. That is the impact shove.
        const relVx = p.x - p.px - col.vx;
        const relVy = p.y - p.py - col.vy;
        const vn = relVx * nx + relVy * ny;
        if (vn < 0) {
          // Kill the approach velocity along the normal, plus a little bounce.
          const e = 0.12;
          p.px += nx * vn * (1 + e);
          p.py += ny * vn * (1 + e);
        }

        // Tangential drag against the surface. A cactus sweeping left at
        // `col.vx` grabs the limb and drags it, which is the impact shove that
        // makes a death read as a collision instead of a flag flip.
        const tx = -ny;
        const ty = nx;
        const relTx = p.x - p.px - col.vx;
        const relTy = p.y - p.py - col.vy;
        const tangent = relTx * tx + relTy * ty;
        const drag = p.groundFriction * 0.8;
        p.px += tx * tangent * drag;
        p.py += ty * tangent * drag;
        this.stats.contacts += 1;
      }
    }
  }

  collideBounds(p) {
    const { left, right } = this.bounds;
    if (p.x - p.radius < left) {
      p.x = left + p.radius;
      p.px = p.x + (p.x - p.px) * 0.2;
    } else if (p.x + p.radius > right) {
      p.x = right - p.radius;
      p.px = p.x + (p.x - p.px) * 0.2;
    }
    // Ceiling keeps a launched corpse from disappearing off the top.
    if (p.y + p.radius < -320) {
      p.y = -320 + p.radius;
      p.py = p.y + (p.y - p.py) * 0.2;
    }
  }

  /**
   * Limit-only pass over the angle constraints: no motors, no targets. Used to
   * close the loop after rod passes, which rotate joints as a side effect of
   * enforcing bone length and can push a knee a degree or two past the arc a
   * live animal's tendons would not allow.
   */
  solveAngleLimits() {
    for (const ang of this.angles) {
      const cur = this.angleValue(ang);
      let corr = 0;
      if (cur < ang.lo) corr = (ang.lo - cur) * ang.limitStiffness;
      else if (cur > ang.hi) corr = (ang.hi - cur) * ang.limitStiffness;
      if (corr === 0) continue;
      const cap = ang.maxCorrection;
      corr = Math.max(-cap, Math.min(cap, corr));

      const pa = this.particles[ang.a];
      const pb = this.particles[ang.b];
      const pc = this.particles[ang.c];
      const w = pa.invMass + pc.invMass;
      if (w === 0) continue;
      const fa = pa.invMass / w;
      const fc = pc.invMass / w;
      const [nax, nay] = rotateAbout(pa.x, pa.y, pb.x, pb.y, -corr * fa);
      const [ncx, ncy] = rotateAbout(pc.x, pc.y, pb.x, pb.y, corr * fc);
      pa.x = nax;
      pa.y = nay;
      pc.x = ncx;
      pc.y = ncy;
      this.stats.angleCorrections += Math.abs(corr);
    }
  }

  collide() {
    for (const p of this.particles) {
      if (p.invMass === 0) continue;
      // Obstacles first, deck second. The other order was a standing limit cycle:
      // a cactus base sits at ground level, so a foot wedged beside its bottom cap
      // got pushed *through* the deck, the deck shoved it back up next, and the two
      // traded blows eleven times a tick. A corpse buzzed at a constant energy
      // forever and never reported settled. Last word goes to the deck because the
      // deck is the one surface nothing may end a tick inside.
      this.collideColliders(p);
      this.collideGround(p);
      this.collideBounds(p);
    }
  }

  solve() {
    for (let i = 0; i < this.iterations; i++) {
      // Order matters. Posture rotates a tip about a pivot, which changes the
      // length of every *other* rod touching that tip, so it has to run before
      // the distance constraints, not after. Angle constraints rotate about the
      // vertex and therefore preserve both adjacent bones exactly, so they can
      // go anywhere. Running posture last left the tail permanently stretched
      // about 20% because nothing got to shorten it again.
      for (const post of this.postures) this.solvePosture(post);
      for (const ang of this.angles) this.solveAngle(ang);
      for (const rod of this.rods) this.solveRod(rod);
      this.collide();
    }
    // Settle the shape, alternating with collision. Running rod-only passes
    // after the last collision was the bug: the bones would push a knee back
    // through the deck, the deck would push it out again next frame, and the
    // pair formed a limit cycle that kept a supposedly dead body buzzing
    // forever. Each pass now closes the bone length and then re-respects the
    // deck, so both converge instead of trading blows.
    //
    // Limits come last because rod solving rotates joints as a side effect of
    // holding bone length. A corpse leaning on its elbow can end up a degree or
    // two past the arc its tendons should allow, which is exactly the kind of
    // detail that reads as wrong even when the overall motion is right.
    for (let i = 0; i < this.shapePasses; i++) {
      for (const rod of this.rods) this.solveRod(rod);
      this.solveAngleLimits();
      this.collide();
    }
  }

  /**
   * One fixed tick. `dt` is measured in ticks (1 = 1/60 s), which keeps every
   * constant in this file expressed in px-per-tick.
   */
  step(dt = 1) {
    const sub = Math.max(1, this.substeps | 0);
    const h = dt / sub;
    this.currentDt = h;
    // Once per tick, before any substep: the displacement a mover applied this
    // tick is the velocity its surfaces have for all of this tick.
    this.measureColliderVelocities(dt);
    for (let s = 0; s < sub; s++) {
      this.integrate(h);
      this.solve();
    }
    this.stepIndex++;
  }

  /** Kinematic drag toward a target position (used for muscle-driven roots). */
  pullTo(p, tx, ty, gain) {
    if (p.invMass === 0) {
      p.x = tx;
      p.y = ty;
      return;
    }
    p.x += (tx - p.x) * gain;
    p.y += (ty - p.y) * gain;
  }

  centerOfMass() {
    let m = 0;
    let x = 0;
    let y = 0;
    for (const p of this.particles) {
      if (p.invMass === 0) continue;
      m += p.mass;
      x += p.x * p.mass;
      y += p.y * p.mass;
    }
    if (m === 0) return { x: 0, y: 0, mass: 0 };
    return { x: x / m, y: y / m, mass: m };
  }

  /**
   * Total angular momentum. Pass an explicit origin (a corpse should be
   * measured about the centre of mass it had at the instant of death) or omit
   * it to use the current centre of mass.
   */
  angularMomentum(origin = null) {
    const com = origin ?? this.centerOfMass();
    let l = 0;
    for (const p of this.particles) {
      if (p.invMass === 0) continue;
      const rx = p.x - com.x;
      const ry = p.y - com.y;
      const vx = p.x - p.px;
      const vy = p.y - p.py;
      l += p.mass * (rx * vy - ry * vx);
    }
    return l;
  }

  /** Apply a linear velocity plus a spin about the centre of mass. */
  impulse(vx, vy, omega) {
    const com = this.centerOfMass();
    for (const p of this.particles) {
      if (p.invMass === 0) continue;
      const rx = p.x - com.x;
      const ry = p.y - com.y;
      this.addVelocity(p, vx + -omega * ry, vy + omega * rx);
    }
  }

  totalKineticEnergy() {
    let e = 0;
    for (const p of this.particles) {
      if (p.invMass === 0) continue;
      if (p.resting) continue; // held up by the deck, not actually moving
      const vx = p.x - p.px;
      const vy = p.y - p.py;
      e += 0.5 * p.mass * (vx * vx + vy * vy);
    }
    return e;
  }
}
