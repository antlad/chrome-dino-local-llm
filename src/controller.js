/**
 * Programmatic control surface.
 *
 * The game is built so that a script or an LLM can drive it as well as a person
 * with a keyboard can, and for a ragdoll that matters more than usual: the
 * interesting behaviour is emergent, so being able to replay an exact 200-tick
 * sequence and get the identical corpse is what makes it debuggable.
 *
 * Two rules make that work:
 *   - inputs are queued and drained inside step(), so a press() always lands on
 *     a tick boundary and never races the animation frame;
 *   - step() is the only place anything moves, so stepping N times from the same
 *     seed is the same run every time.
 */

export class Controller {
  /**
   * @param {import('./game.js').Game} game
   */
  constructor(game) {
    this.game = game;
    this.auto = false;
    this.queue = [];
    this.hold = { jump: false, duck: false };
    this.log = [];
    this.maxLog = 60;
  }

  _note(type, args) {
    this.log.push({ type, args, tick: this.game.tick });
    if (this.log.length > this.maxLog) this.log.shift();
  }

  /**
   * Queue a control. Accepted names: jump, duck, unduck, fastFall, start,
   * restart, pause, resume. `down: false` releases a held key.
   */
  press(name, opts = {}) {
    const down = opts.down !== false;
    this._note(name, opts);
    switch (name) {
      case 'jump':
        // Hold is tracked so an API-driven jump has the same variable height as
        // a key held by hand, instead of always being the shortest possible hop.
        this.queue.push({ type: 'jump' });
        if (down) this.hold.jump = true;
        break;
      case 'duck':
        this.queue.push({ type: 'duck', on: down });
        this.hold.duck = down;
        break;
      case 'unduck':
        this.queue.push({ type: 'duck', on: false });
        this.hold.duck = false;
        break;
      case 'fastFall':
        this.queue.push({ type: 'fastFall' });
        break;
      case 'start':
        this.queue.push({ type: 'start' });
        break;
      case 'restart':
      case 'reset':
        this.queue.push({ type: 'restart', seed: opts.seed });
        break;
      case 'pause':
        this.game.pause(true);
        break;
      case 'resume':
        this.game.pause(false);
        break;
      default:
        return false;
    }
    return true;
  }

  /** Drain queued controls. Called by the driver right before each tick. */
  drain() {
    const g = this.game;
    while (this.queue.length) {
      const c = this.queue.shift();
      switch (c.type) {
        case 'jump':
          if (g.state === 'ready' || g.state === 'over') g.start();
          g.input.jump = true;
          g.pendingJump = true;
          break;
        case 'duck':
          g.input.duck = !!c.on;
          break;
        case 'fastFall':
          g.pendingFastFall = true;
          break;
        case 'start':
          g.start();
          break;
        case 'restart':
          this.reset(c.seed);
          break;
      }
    }
    // A key released by the caller stops extending the jump arc.
    if (!this.hold.jump) g.input.jump = false;
    if (!this.hold.duck) g.input.duck = false;
  }

  setAuto(on = true) {
    this.auto = !!on;
    // The flag lives on the game so that a bare `game.step()` and a
    // `controller.step()` cannot drift apart on who is steering.
    this.game.auto = this.auto;
    this._note('auto', { on: this.auto });
    return this.auto;
  }

  reset(seed) {
    this.queue.length = 0;
    this.hold.jump = false;
    this.hold.duck = false;
    this.auto = false;
    this.game.auto = false;
    this.game.reset(seed);
    return this.game;
  }

  /**
   * Advance the simulation headlessly, in ticks. This is the entry point that
   * makes the game testable without a browser and replayable with one: the same
   * call drives both.
   */
  async step(ticks = 1, opts = {}) {
    const n = Math.max(0, Math.min(opts.limit ?? 200000, ticks | 0));
    for (let i = 0; i < n; i++) {
      // Drain first: a press() between frames still lands on a tick boundary,
      // which is what lets a recorded input sequence replay exactly.
      this.drain();
      this.game.step(1);
      if (opts.untilGameOver && this.game.state === 'over') break;
    }
    return this.game.getState();
  }

  /** Run until the dino dies. Handy for probing whether a seed is survivable. */
  async run(maxTicks = 40000) {
    return this.step(maxTicks, { untilGameOver: true });
  }

  getState() {
    return this.game.getState();
  }

  /** Why the dino died, in plain words, for the HUD and for scripts. */
  cause() {
    return this.game.cause();
  }
}
