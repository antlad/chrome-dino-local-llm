/**
 * Game core: the state machine, the fixed-step loop, and the rules.
 *
 * Deliberately free of DOM and canvas references so the whole game can be driven
 * headless in Node. That is not a nicety: `controller.step(1200)` runs two
 * seconds of real gameplay with real collisions and no browser, which is how the
 * physics stays honest as the game grows.
 *
 * The dino stays at a fixed x and the world moves past it, as in the original.
 * That is also what the physics wants, because the obstacle colliders need a
 * velocity to shove the corpse with, and moving the world is what gives them one.
 */

import { PhysicsWorld } from './physics.js';
import { DinoRagdoll } from './ragdoll.js';
import { ObstacleField } from './obstacles.js';

export const TICK_MS = 1000 / 60;

export const CONFIG = {
  width: 1200,
  height: 432,
  groundY: 372,
  dinoX: 130,
  baseSpeed: 6.2,
  maxSpeed: 13.2,
  accel: 0.0022, // px/tick added to speed, per tick
  scorePer100px: 1,
  nightEvery: 1400, // ticks of running before the lights go down
  nightLength: 900,
  deathSettleTicks: 46, // how long the corpse tumbles before the game is over
  // The deck is a treadmill, so when the runner dies the ground does not carry on
  // beneath the body: it brakes, the way the original stops scrolling on a crash.
  // This is a deceleration in px/tick^2, tuned so the belt is still within about
  // 0.2s. A corpse is dragged by whatever the belt is doing, so the belt has to
  // stop, and the brief slide while it does is the skid you see on impact.
  deckBrake: 1.2,
};

export class Game {
  constructor(opts = {}) {
    this.cfg = { ...CONFIG, ...opts.config };
    this.seed = opts.seed ?? 1234;
    this.hooks = opts.hooks ?? {};
    this.reset();
  }

  reset(seed) {
    this.tick = 0;
    this.distance = 0;
    this.score = 0;
    this.highScore = this.highScore ?? 0;
    this.state = 'ready'; // ready | running | dead | over
    this.paused = false;
    this.speed = this.cfg.baseSpeed;
    this.night = false;
    this.nightPhase = 0;
    this.runTicks = 0;
    this.deathTick = -1;
    this.deathInfo = null;
    // The deck is its own physical thing: a belt whose speed the world friction
    // reads. It is owned here and nowhere else, and it is assigned on every branch
    // of step() so a stale value can never outlive the scrolling that set it.
    this.deckSpeed = 0;
    this.lastCause = null;
    this.obstaclesCleared = 0;
    this.input = { jump: false, duck: false, fastFall: false };
    // When on, autopilot() overrides the player's inputs each tick. Lives on the
    // game rather than the driver so headless `step()` and the browser loop
    // behave identically under the same flag.
    this.auto = false;
    // Edges, not levels. A jump is a decision with a single frame of authority:
    // the impulse is applied once, and holding the key afterwards only lengthens
    // the rise by softening gravity. Applying an impulse every frame a key is
    // held turns a jump into a rocket.
    this.pendingJump = false;
    this.pendingFastFall = false;

    if (seed !== undefined) this.seed = seed;

    this.world = new PhysicsWorld({
      gravity: 0.9,
      damping: 0.992,
      iterations: 7,
      shapePasses: 4,
      substeps: 1,
      groundY: this.cfg.groundY,
      bounds: { left: -300, right: this.cfg.width + 260 },
    });
    this.dino = new DinoRagdoll(this.world, {
      x: this.cfg.dinoX,
      groundY: this.cfg.groundY,
    });
    this.field = new ObstacleField(this.world, {
      groundY: this.cfg.groundY,
      seed: this.seed,
      spawnX: this.cfg.width + 90,
    });

    // Footfalls and landings are the only things that communicate the mass of
    // the body, so they are wired straight through to whoever is listening.
    this.dino.onLand = (e) => this.hooks.onLand?.(e, this);
    this.hooks.onReset?.(this);
    return this;
  }

  // -- state transitions ----------------------------------------------------

  start() {
    if (this.state === 'running') return this;
    if (this.state !== 'ready') this.reset();
    this.state = 'running';
    this.hooks.onStart?.(this);
    return this;
  }

  pause(on = !this.paused) {
    this.paused = !!on;
    return this;
  }

  /**
   * Kill the dino and hand the body to the solver.
   *
   * The whole point of the project lives in these few lines: the game stops
   * animating the character and stops touching it. Where the corpse goes from
   * here is decided by the contact point, its momentum and the deck.
   */
  crash(hit) {
    if (this.state !== 'running' || !this.dino.alive) return null;
    const o = hit.obstacle;
    const info = {
      kind: o.kind,
      band: o.band,
      particle: hit.particle.id.replace('dino:', ''),
      height: hit.height,
      x: hit.contactX,
      y: hit.contactY,
      tick: this.tick,
      score: this.score,
    };
    this.lastCause = info;
    this.dino.die({
      dir: -1,
      speed: this.speed,
      x: hit.contactX,
      y: hit.contactY,
      height: hit.height,
    });
    this.state = 'dead';
    this.deathTick = this.tick;
    this.deathInfo = info;
    if (this.score > this.highScore) this.highScore = this.score;
    this.hooks.onCrash?.(info, this);
    return info;
  }

  // -- the tick -------------------------------------------------------------

  /**
   * One fixed step of the simulation. Every input, obstacle, collision and score
   * change happens here and only here, which is what makes `step(n)` reproduce a
   * run exactly.
   */
  step(dt = 1) {
    if (this.paused) return this;
    if (this.auto && this.state === 'running') this.autopilot();

    const alive = this.state === 'running';
    // One owner for the deck's speed, set before anything can step the body.
    // This was previously implied by whichever call happened to move the
    // obstacles, and the first version of it leaked: scrolling stopped at game
    // over but the surface kept the speed it had at death, so a corpse slid
    // forever on a floor that had visibly stopped. Assigning it here, per branch,
    // means "not scrolling" and "scrolling at the old speed" cannot be confused.
    let scroll = 0;

    if (alive) {
      this.tick += dt;
      this.runTicks += dt;
      this.speed = Math.min(this.cfg.maxSpeed, this.speed + this.cfg.accel * dt);
      this.distance += this.speed * dt;
      this.score = Math.floor((this.distance / 100) * this.cfg.scorePer100px);

      this.updateNight();
      scroll = this.deckSpeed = this.speed;
      this.world.groundVx = -scroll;
      this.field.update(dt, scroll);

      const intent = {
        speed: this.speed,
        ducking: this.input.duck && this.dino.isGrounded(),
        jumpHeld: this.input.jump,
      };
      if (this.pendingJump) {
        this.dino.jump();
        this.pendingJump = false;
      }
      this.dino.update(dt, intent);
      if (this.pendingFastFall) {
        this.dino.fastFall();
        this.pendingFastFall = false;
      }

      // Collision last, after the solver has placed every particle, so the test
      // reads the same positions the renderer is about to draw. Testing before
      // the step meant the dino could visibly pass through a cactus for a frame
      // and then die.
      const hit = this.field.hitTest(this.dino.hitParticles());
      if (hit) this.crash(hit);
      else this.countCleared();
      return this;
    }

    if (this.state === 'dead') {
      // The belt brakes to a stop, the way the original freezes the world on a
      // crash. That is not decoration: friction pulls a body toward whatever the
      // surface under it is doing, so a belt that kept running would tow the corpse
      // off screen no matter how well the body itself settled. While the belt is
      // still moving the corpse skids backwards, which is the slide you want to
      // see, and then the belt is still and the body is free.
      this.tick += dt;
      this.deckSpeed = Math.max(0, this.deckSpeed - this.cfg.deckBrake * dt);
      scroll = this.deckSpeed;
      this.world.groundVx = -scroll;
      this.field.update(dt, scroll);
      this.dino.update(dt, { speed: 0 });
      const forTicks = this.tick - this.deathTick;
      if (forTicks > this.cfg.deathSettleTicks && (this.dino.settled || forTicks > 200)) {
        this.state = 'over';
        this.hooks.onGameOver?.(this.deathInfo, this);
      }
      return this;
    }

    // 'over' and 'ready'. Once the corpse has settled the world stops scrolling
    // but the body keeps being stepped: a body that stopped mid-fall because a
    // state flag flipped would be the one visible lie in the whole simulation.
    this.tick += dt;
    this.deckSpeed = 0;
    this.world.groundVx = -scroll;
    this.dino.update(dt, { speed: 0 });
    return this;
  }

  countCleared() {
    if (this.field.cleared > this.obstaclesCleared) {
      this.obstaclesCleared = this.field.cleared;
    }
  }

  updateNight() {
    // Cycled on run length, not score, so a good run visibly changes the world
    // and the player feels the phase shift rather than reading a number.
    const every = this.cfg.nightEvery;
    const len = this.cfg.nightLength;
    const cycle = this.runTicks % (every + len);
    this.night = cycle >= every;
    const within = this.night ? (cycle - every) / len : cycle / every;
    this.nightPhase = within < 0 ? 0 : within > 1 ? 1 : within;
  }

  // -- autopilot ------------------------------------------------------------

  /**
   * Measured body span, used for jump timing.
   *
   * The autopilot has to schedule around the *whole* body. Timing a jump on the
   * head is the classic failure of this kind of AI and shows up as dying to the
   * back foot: the animal clears the cactus with its face and then lands on it
   * with a leg. Reading the real extents also means the numbers follow the rig
   * when the skeleton is retuned instead of silently going stale.
   */
  bodySpan() {
    let front = -Infinity;
    let back = Infinity;
    for (const p of this.dino.hitParticles()) {
      if (p.x + p.radius > front) front = p.x + p.radius;
      if (p.x - p.radius < back) back = p.x - p.radius;
    }
    return { front, back, length: front - back };
  }

  /**
   * Decide the inputs for this tick.
   *
   * Works on time-to-contact rather than distance, because the only thing that
   * matters is whether the jump arc still reaches.
   *
   * The core insight for jumps: the body has to be airborne for the *entire*
   * interval during which the obstacle overlaps it, which is body-length plus
   * obstacle-width of travel. Launch is therefore scheduled as late as it safely
   * can be. Launching early is fatal, because the air time is fixed and a body
   * that lands while the cactus is still underneath it dies on the way down.
   *
   * The autopilot is also the test oracle. If it cannot survive, the obstacle
   * spacing is unfair, and that is a bug in the spawner rather than the AI.
   */
  autopilot() {
    if (!this.dino.alive) {
      this.input.jump = false;
      this.input.duck = false;
      this.pendingJump = false;
      this.pendingFastFall = false;
      return;
    }
    const dino = this.dino;
    const span = this.bodySpan();
    const threat = this.field.nextThreat(span.front, span.back);
    this.input.jump = false;
    this.input.duck = false;
    this.pendingJump = false;
    this.pendingFastFall = false;
    if (!threat) return;

    const pxPerTick = Math.max(0.1, this.speed);
    const arcTicks = 36; // full air time, measured by the jump probe

    // True edges of the obstacle in world space. The collider origin sits under
    // the middle of the bird, so using it as the leading edge makes every
    // decision a few tens of pixels early, which is exactly enough to duck too
    // soon and stand back up into a beak.
    const left = threat.x + (threat.spanLeft ?? 0);
    const right = threat.x + (threat.spanRight ?? threat.width);

    if (threat.kind === 'pterodactyl' && threat.band === 'high') {
      // Tall enough to walk under. Doing nothing is the correct play and any
      // input here would only risk a bad jump.
      return;
    }

    if (threat.kind === 'pterodactyl' && threat.band === 'middle') {
      // Duck through it. Same window logic as a jump: stay down from before the
      // head arrives until after the tail has gone.
      const untilEnter = (left - span.front) / pxPerTick;
      const untilExit = (right - span.back) / pxPerTick;
      if (untilEnter <= 10 && untilExit > -2) this.input.duck = true;
      return;
    }

    // Ground obstacles: airborne while the cactus passes under the whole body.
    const untilStart = (left - span.front) / pxPerTick;
    const untilEnd = (right - span.back) / pxPerTick;
    const overlapTicks = untilEnd - untilStart;

    if (!dino.isGrounded()) {
      // Already committed. Fast-fall only once the obstacle is behind us, which
      // stops a floaty descent landing on the next one.
      if (untilEnd < 0) this.pendingFastFall = true;
      return;
    }

    // Jump at the earliest moment that still works.
    //
    // Airborne from launch L until L + arcTicks, and the body has to be off the
    // deck for the whole overlap, so any L with untilStart(L) in
    // [0, arcTicks - overlap] clears it. The earliest of those is the right one,
    // for a reason that is easy to miss: `jump()` flips the airborne flag, but
    // the feet take four or five ticks to actually leave the deck, and the body
    // folds as it lands, so the usable air is shorter than the nominal arc.
    // Launching late spends that margin on the approach and then a trailing foot
    // catches the far side of the cactus on the way down.
    const usable = arcTicks - (this.autopilotTakeoffLoss ?? 6);
    const slack = usable - overlapTicks - (this.autopilotMargin ?? 5);
    if (slack < 0) {
      // Physically impossible at this speed. Jump at the last moment anyway so
      // the failure is at least an honest one rather than walking into it.
      if (untilStart <= 0) this.pendingJump = true;
      return;
    }
    if (untilStart <= slack) this.pendingJump = true;
  }

  /**
   * One step with the autopilot deciding the inputs. Returns whether it survived.
   */
  autopilotStep(dt = 1) {
    this.autopilot();
    this.step(dt);
    return this.state === 'running' || this.state === 'dead';
  }

  // -- controller-facing state ---------------------------------------------

  getState() {
    return {
      state: this.state,
      paused: this.paused,
      score: this.score,
      highScore: this.highScore,
      speed: +this.speed.toFixed(3),
      distance: +this.distance.toFixed(1),
      tick: this.tick,
      night: this.night,
      nightPhase: +this.nightPhase.toFixed(3),
      seed: this.seed,
      obstacles: this.field.list.length,
      spawned: this.field.spawned,
      cleared: this.obstaclesCleared,
      lastCause: this.lastCause,
      cause: this.cause(),
      dino: this.dino.getState(),
    };
  }

  /** Why the dino died, in plain words, for the HUD and for scripts. */
  cause() {
    const c = this.lastCause;
    if (!c) return null;
    return {
      ...c,
      text:
        c.kind === 'pterodactyl'
          ? `pterodactyl (${c.band}) struck the ${c.particle}`
          : `cactus struck the ${c.particle}`,
    };
  }

  /** Debug overlay data: the constraint skeleton, for the X key. */
  debugSkeleton() {
    return {
      particles: this.world.particles.map((p) => ({
        x: p.x,
        y: p.y,
        r: p.radius,
        id: p.id,
        resting: !!p.resting,
      })),
      rods: this.world.rods.map((r) => ({
        a: this.world.particles[r.a],
        b: this.world.particles[r.b],
        group: r.group,
        rest: r.rest,
      })),
    };
  }
}
