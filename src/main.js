/**
 * Browser entry: wires the canvas, the HUD, the keyboard and the public API to
 * the game.
 *
 * The driver is a fixed-timestep accumulator. That is not a performance detail:
 * the physics is only deterministic if it always advances by exactly one tick, so
 * rendering as fast as the monitor asks and scaling the physics to match would
 * make the ragdoll behave differently on a 60 Hz laptop and a 120 Hz monitor. The
 * accumulator runs as many whole ticks as the elapsed time pays for and draws
 * once, so the simulation sees the same 60 Hz everywhere.
 */

import { Game, TICK_MS, CONFIG } from './game.js';
import { Renderer } from './render.js';
import { Controller } from './controller.js';

const HI_KEY = 'ragdoll-dino-hi';

function loadHigh() {
  try {
    return Number(localStorage.getItem(HI_KEY)) || 0;
  } catch {
    return 0;
  }
}

function saveHigh(v) {
  try {
    localStorage.setItem(HI_KEY, String(v));
  } catch {
    /* private mode: the score simply will not persist */
  }
}

function makeCanvas() {
  const el = document.getElementById('game');
  if (el) return el;
  // Headless or a stripped page: give the game an offscreen surface rather than
  // throwing, so `game.controller.step()` still works outside the real UI.
  const c = document.createElement('canvas');
  c.width = CONFIG.width;
  c.height = CONFIG.height;
  return c;
}

class Driver {
  constructor() {
    this.canvas = makeCanvas();
    this.dom = {
      mode: document.getElementById('hud-mode'),
      hi: document.getElementById('hud-hi'),
      score: document.getElementById('hud-score'),
      hint: document.getElementById('hint'),
      body: document.body,
    };

    this.game = new Game({
      seed: (Date.now() ^ 0x5eed) >>> 0,
      hooks: {
        onCrash: (info) => {
          this.renderer.impact(info.x, info.y, 1 + info.height);
          this.saveHi();
        },
        onLand: (e) => {
          const d = this.game.dino;
          const p = d.particle('footL');
          this.renderer.puff(p.x, this.game.cfg.groundY, Math.min(1.6, e.vy / 14), -1);
        },
      },
    });
    this.game.highScore = loadHigh();

    this.renderer = new Renderer(this.canvas, { groundY: this.game.cfg.groundY });
    this.controller = new Controller(this.game);

    this.debug = false;
    this.accumulator = 0;
    this.last = 0;
    this.running = false;
    this.hudClock = 0;
    this.footfallClock = 0;

    this.bindKeys();
    this.bindPointer();

    // Exposed for scripts, the console, and anything automating the page.
    window.game = this.game;
    window.controller = this.controller;
    window.game.controller = this.controller;
    window.ragdoll = {
      game: this.game,
      controller: this.controller,
      renderer: this.renderer,
      driver: this,
    };

    this.start();
  }

  saveHi() {
    if (this.game.highScore > loadHigh()) saveHigh(this.game.highScore);
  }

  // -- input ----------------------------------------------------------------

  bindKeys() {
    const keymap = {
      Space: 'jump',
      ArrowUp: 'jump',
      KeyW: 'jump',
      ArrowDown: 'duck',
      KeyS: 'duck',
    };

    window.addEventListener(
      'keydown',
      (e) => {
        const action = keymap[e.code];
        if (action) {
          e.preventDefault();
          if (this.game.state === 'ready') this.game.start();
          if (this.game.state === 'over') this.restart();
          if (action === 'jump') {
            if (!e.repeat) this.controller.press('jump');
          } else if (action === 'duck') {
            this.controller.press('duck');
          }
          this.game.auto = false;
          this.controller.auto = false;
          return;
        }
        switch (e.code) {
          case 'ArrowRight':
          case 'KeyF':
            e.preventDefault();
            this.controller.press('fastFall');
            break;
          case 'KeyR':
            e.preventDefault();
            this.restart();
            break;
          case 'KeyP':
            e.preventDefault();
            this.game.pause();
            break;
          case 'KeyT':
            e.preventDefault();
            this.controller.setAuto(!this.controller.auto);
            break;
          case 'KeyX':
            e.preventDefault();
            this.debug = !this.debug;
            break;
          default:
            break;
        }
      },
      { passive: false }
    );

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        this.controller.hold.jump = false;
      }
      if (e.code === 'ArrowDown' || e.code === 'KeyS') this.controller.press('unduck');
    });

    // Losing focus mid-run would otherwise leave keys stuck down and the dino
    // jumping forever the moment the tab came back.
    window.addEventListener('blur', () => {
      this.controller.hold.jump = false;
      this.controller.hold.duck = false;
      this.game.input.jump = false;
      this.game.input.duck = false;
      if (this.game.state === 'running') this.game.pause(true);
    });
  }

  bindPointer() {
    const hit = (e) => {
      e.preventDefault();
      if (this.game.state === 'ready') this.game.start();
      else if (this.game.state === 'over') this.restart();
      else this.controller.press('jump');
    };
    this.canvas.addEventListener('pointerdown', hit);
    this.canvas.addEventListener('pointerup', () => {
      this.controller.hold.jump = false;
    });
    this.canvas.tabIndex = 0;
  }

  restart() {
    this.controller.reset((Date.now() ^ 0x5eed) >>> 0);
    this.renderer.reset();
    this.game.start();
  }

  // -- loop -----------------------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const frame = (now) => {
      if (!this.running) return;
      this.tickFrame(now);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  tickFrame(now) {
    let elapsed = now - this.last;
    this.last = now;
    // A tab that was in the background comes back owing minutes of time. Clamping
    // means it resumes instead of simulating every missed frame in one go and
    // appearing to teleport the corpse across the screen.
    if (elapsed > 250) elapsed = TICK_MS;
    this.accumulator += elapsed;

    let steps = 0;
    while (this.accumulator >= TICK_MS && steps < 5) {
      this.controller.drain();
      this.game.step(1);
      this.accumulator -= TICK_MS;
      steps++;
      this.footfallClock++;

      // Footfalls kick up dust. Sampled rather than evented, because the solver
      // decides contact and the game should not have to ask permission to draw it.
      if (this.game.state === 'running' && this.footfallClock % 6 === 0) {
        const d = this.game.dino;
        const deck = this.game.cfg.groundY;
        for (const side of ['L', 'R']) {
          const f = d.particle('foot' + side);
          if (deck - (f.y + f.radius) < 1.2 && Math.abs(f.x - f.px) > 0.8) {
            this.renderer.puff(f.x, deck, 0.4, -1);
          }
        }
      }
    }
    if (steps >= 5) this.accumulator = 0;

    this.renderer.updateEffects(steps || 0, this.game.state === 'running' ? this.game.speed : 0);
    this.renderer.drawFrame(this.game);
    if (this.debug) this.drawDebug();

    this.hudClock += steps;
    if (this.hudClock >= 4) {
      this.hudClock = 0;
      this.updateHud();
    }
  }

  drawDebug() {
    const ctx = this.renderer.ctx;
    const { particles, rods } = this.game.debugSkeleton();
    ctx.save();
    ctx.lineWidth = 1;
    for (const r of rods) {
      const band = r.group === 'flesh';
      ctx.strokeStyle = band ? 'rgba(60,140,220,0.75)' : 'rgba(220,90,60,0.5)';
      ctx.beginPath();
      ctx.moveTo(r.a.x, r.a.y);
      ctx.lineTo(r.b.x, r.b.y);
      ctx.stroke();
    }
    for (const p of particles) {
      ctx.strokeStyle = p.resting ? 'rgba(60,190,110,0.95)' : 'rgba(230,180,50,0.9)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Obstacle colliders, so a suspicious hit can be checked against the truth.
    ctx.strokeStyle = 'rgba(220,60,140,0.8)';
    for (const o of this.game.field.list) {
      for (const s of o.segments) {
        ctx.beginPath();
        ctx.moveTo(o.x + s.x1, o.y + s.y1);
        ctx.lineTo(o.x + s.x2, o.y + s.y2);
        ctx.stroke();
      }
    }
    ctx.fillStyle = 'rgba(80,140,220,0.95)';
    ctx.font = '11px ui-monospace, Menlo, monospace';
    const g = this.game;
    const lines = [
      `tick ${g.tick}  score ${g.score}  speed ${g.speed.toFixed(2)}`,
      `state ${g.state}  muscle ${g.dino.muscle.toFixed(2)}  KE ${g.world.totalKineticEnergy().toFixed(2)}`,
      `contacts ${g.world.stats.contacts}  obstacles ${g.field.list.length}  seed ${g.seed}`,
    ];
    lines.forEach((t, i) => ctx.fillText(t, 10, 18 + i * 14));
    ctx.restore();
  }

  updateHud() {
    const g = this.game;
    const pad = (n) => String(Math.max(0, Math.floor(n))).padStart(5, '0');
    if (this.dom.score) this.dom.score.textContent = pad(g.score);
    if (this.dom.hi) this.dom.hi.textContent = `HI ${pad(Math.max(g.highScore, g.score))}`;

    let mode = 'READY';
    if (g.paused) mode = 'PAUSED';
    else if (g.state === 'running') mode = this.controller.auto ? 'AUTOPILOT' : 'RUNNING';
    else if (g.state === 'dead') mode = 'CRASHED';
    else if (g.state === 'over') mode = (g.cause()?.text ?? 'GAME OVER').slice(0, 34).toUpperCase();
    if (this.dom.mode) this.dom.mode.textContent = mode;

    if (this.dom.body) this.dom.body.classList.toggle('is-night', !!g.night);
  }
}

function boot() {
  try {
    window.driver = new Driver();
  } catch (err) {
    console.error('[ragdoll] failed to start', err);
    const hint = document.getElementById('hint');
    if (hint) hint.textContent = `Failed to start: ${err?.message ?? err}`;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

export { Driver };
