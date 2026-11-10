/**
 * Zero-dependency browser check.
 *
 * Drives a real headless Chrome over the DevTools protocol using only Node
 * built-ins, so verifying the game in a browser costs nothing to install. It
 * exists because the renderer had never once been executed: unit tests cover the
 * simulation, but nothing short of a real canvas can catch a bad ctx call.
 *
 *   node test/browser-check.mjs [--shots]
 *
 * Reports console errors, uncaught exceptions, and a handful of assertions run
 * inside the page against window.ragdoll.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectCdp } from './cdp.mjs';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  process.env.CHROME,
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error('No Chrome found. Set CHROME=/path/to/chrome');
  process.exit(2);
}

const PORT = Number(process.env.DEBUG_PORT ?? 9333);
const URL = process.env.GAME_URL ?? 'http://127.0.0.1:8788/';
const wantShots = process.argv.includes('--shots');
const shotDir = join(process.cwd(), 'shots');
if (wantShots && !existsSync(shotDir)) mkdirSync(shotDir, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), 'ragdoll-chrome-'));
const proc = spawn(
  chrome,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] }
);

const cleanup = () => {
  try {
    proc.kill('SIGKILL');
  } catch {
    /* already gone */
  }
};
process.on('exit', cleanup);

async function waitForDevTools(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Chrome devtools endpoint never came up');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
}

try {
  await waitForDevTools();
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page') ?? list[0];
  const cdp = await connectCdp(page.webSocketDebuggerUrl);

  const consoleErrors = [];
  const pageErrors = [];
  cdp.on('Runtime.consoleAPICalled', (e) => {
    if (e.type === 'error' || e.type === 'warning') {
      consoleErrors.push(`${e.type}: ${(e.args ?? []).map((a) => a.description ?? a.value).join(' ')}`);
    }
  });
  cdp.on('Runtime.exceptionThrown', (e) => {
    pageErrors.push(e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text ?? 'unknown');
  });
  cdp.on('Log.entryAdded', (e) => {
    if (e.entry.level === 'error') consoleErrors.push(`log: ${e.entry.text}`);
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.navigate', { url: URL });
  await sleep(1800);

  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result?.value;
  };

  // The HUD, the canvas and the night class are all written by the animation
  // frame callback, so anything that asserts on them has to wait for one. A
  // synchronous eval that steps the game two hundred times blocks the main
  // thread the whole time, and every pixel or label read straight afterwards is
  // simply stale. This yields back to the browser for n real frames.
  const renderFrames = async (frames = 3) => {
    await evalJs(
      `new Promise((res) => {
        let drawn = 0;
        const tick = () => (++drawn >= ${frames} ? res(true) : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      })`
    );
  };

  const boot = await evalJs(`(() => ({
    hasGame: !!window.ragdoll,
    hasController: !!(window.ragdoll && window.ragdoll.controller),
    hasCanvas: !!document.getElementById('game'),
    hud: document.getElementById('hud-score') && document.getElementById('hud-score').textContent,
    mode: document.getElementById('hud-mode') && document.getElementById('hud-mode').textContent,
    state: window.ragdoll && window.ragdoll.game.state,
  }))()`);
  check('page boots and exposes window.ragdoll', boot.hasGame && boot.hasController, JSON.stringify(boot));
  check('canvas present', boot.hasCanvas);
  check('HUD is being written', boot.hud === '00000', `hud=${boot.hud} mode=${boot.mode}`);

  // The renderer must have actually painted something, not just constructed.
  const painted = await evalJs(`(() => {
    const c = document.getElementById('game');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let nonBg = 0;
    for (let i = 0; i < d.length; i += 4 * 97) {
      const r = d[i], gg = d[i+1], b = d[i+2];
      if (!(r > 245 && gg > 245 && b > 245)) nonBg++;
    }
    return { nonBg, samples: Math.floor(d.length / (4 * 97)) };
  })()`);
  check(
    'renderer paints a silhouette',
    painted.nonBg > 4,
    `${painted.nonBg} non-background samples of ${painted.samples}`
  );

  // Drive the game through the documented controller API, exactly as a script
  // or an LLM would, and confirm the whole loop responds.
  const apiRun = await evalJs(`(async () => {
    const { game, controller } = window.ragdoll;
    controller.reset(4242);
    controller.setAuto(true);
    const s = await controller.step(900);
    return { state: s.state, score: s.score, tick: s.tick, muscle: s.dino.muscle, auto: controller.auto };
  })()`);
  check(
    'controller.step runs a scripted autopilot run',
    apiRun.state === 'running' && apiRun.score > 5,
    JSON.stringify(apiRun)
  );

  const jumpRun = await evalJs(`(async () => {
    const { game, controller } = window.ragdoll;
    controller.reset(7);
    game.start();
    await controller.step(30);
    controller.press('jump');
    await controller.step(6);
    const airborne = !game.dino.isGrounded();
    await controller.step(60);
    return { airborne, grounded: game.dino.isGrounded() };
  })()`);
  check('press("jump") leaves the deck and lands', jumpRun.airborne && jumpRun.grounded, JSON.stringify(jumpRun));

  const duckRun = await evalJs(`(async () => {
    const { game, controller } = window.ragdoll;
    controller.reset(7);
    game.start();
    controller.press('duck');
    await controller.step(90);
    const gy = window.ragdoll.game.cfg.groundY;
    const top = Math.min(...game.dino.hitParticles().map(p => p.y - p.radius));
    return { ducking: game.dino.ducking, height: gy - top };
  })()`);
  check('press("duck") crouches the body', duckRun.ducking && duckRun.height < 60, JSON.stringify(duckRun));

  // Kill it and make sure the corpse is a solver-driven tumble, live in the page.
  await renderFrames(2);
  const deathRun = await evalJs(`(async () => {
    const { game, controller, renderer } = window.ragdoll;
    controller.reset(5);
    game.start();
    let guard = 0;
    while (game.state === 'running' && guard++ < 2000) game.step(1);
    const alive = game.dino.alive;
    const cause = game.cause();
    for (let i = 0; i < 200; i++) game.step(1);
    return { alive, cause: cause && cause.text, settled: game.dino.settled,
             ke: game.world.totalKineticEnergy(), state: game.state,
             dust: renderer.dust.length };
  })()`);
  await renderFrames(6);
  const deathView = await evalJs(`(() => {
    const c = document.getElementById('game');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let nonBg = 0;
    for (let i = 0; i < d.length; i += 4 * 97) {
      if (!(d[i] > 245 && d[i+1] > 245 && d[i+2] > 245)) nonBg++;
    }
    return { nonBg, mode: document.getElementById('hud-mode').textContent };
  })()`);
  check(
    'crash produces a settling ragdoll in the live page',
    deathRun.alive === false && deathRun.settled === true && deathRun.ke < 0.5,
    JSON.stringify(deathRun)
  );
  check('corpse is drawn on screen', deathView.nonBg > 4, `${deathView.nonBg} samples`);
  check('HUD reports the crash', /CRASH|STRUCK|PTERODACTYL|CACTUS/i.test(deathView.mode || ''), deathView.mode);

  // Night palette must actually flip, since the body is drawn from it.
  await renderFrames(2);
  const nightRun = await evalJs(`(async () => {
    const { game, controller } = window.ragdoll;
    controller.reset(3);
    game.cfg.nightEvery = 60; game.cfg.nightLength = 80;
    game.start();
    let sawNight = false;
    for (let i = 0; i < 400 && game.state === 'running'; i++) {
      game.auto = true; game.step(1);
      if (game.night) sawNight = true;
    }
    return { sawNight, night: game.night };
  })()`);
  await renderFrames(6);
  const nightView = await evalJs(`(() => {
    const c = document.getElementById('game');
    const g = c.getContext('2d');
    const px = g.getImageData(4, 4, 1, 1).data;
    return { bg: document.body.classList.contains('is-night'), dark: px[0] < 80, px: [px[0], px[1], px[2]] };
  })()`);
  check(
    'night mode repaints dark and toggles the page class',
    nightRun.sawNight && nightView.bg && nightView.dark,
    JSON.stringify({ ...nightRun, ...nightView })
  );

  // Keyboard path, which no unit test can reach.
  await evalJs(`(() => { window.ragdoll.controller.reset(9); window.ragdoll.game.start(); return true; })()`);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    code: 'Space',
    key: ' ',
    windowsVirtualKeyCode: 32,
    nativeVirtualKeyCode: 32,
  });
  await sleep(140);
  const kb = await evalJs(`(() => ({ airborne: !window.ragdoll.game.dino.isGrounded() }))()`);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    code: 'Space',
    key: ' ',
    windowsVirtualKeyCode: 32,
    nativeVirtualKeyCode: 32,
  });
  check('spacebar jumps', kb.airborne, JSON.stringify(kb));

  if (wantShots) {
    const { writeFileSync } = await import('node:fs');
    const shot = async (name, setup) => {
      if (setup) await evalJs(setup);
      await renderFrames(4);
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(r.data, 'base64');
      const file = join(shotDir, `${name}.png`);
      writeFileSync(file, buf);
      return file;
    };
    // Warm up the gait before capturing. A body released from a cold place()
    // spends its first frames falling into its own posture, and a screenshot of
    // that looks like a broken ragdoll rather than a run cycle. The warmup runs
    // on autopilot so the body is alive when the pose is taken.
    const warm = `(async () => { const {controller,game}=window.ragdoll; window.ragdoll.driver.debug = false; controller.reset(%SEED%); controller.setAuto(true); game.start(); await controller.step(%T%); return true; })()`;
    const seeded = (seed, t) => warm.replace('%SEED%', seed).replace('%T%', t);
    const pose = (seed, warmTicks, action, after) =>
      `(async () => { const {controller,game}=window.ragdoll; window.ragdoll.driver.debug = false; controller.reset(${seed}); controller.setAuto(true); game.start(); await controller.step(${warmTicks}); controller.setAuto(false); ${action} await controller.step(${after}); return true; })()`;
    await shot('01-running', seeded(42, 180));
    await shot('02-jump', pose(42, 120, "controller.press('jump');", 12));
    await shot('03-duck', pose(42, 120, "controller.press('duck');", 34));
    await shot('04-death', `(async () => { const {controller,game}=window.ragdoll; window.ragdoll.driver.debug = false; controller.reset(5); controller.setAuto(false); game.start(); let g=0; while(game.state==='running'&&g++<2000) game.step(1); for(let i=0;i<16;i++) game.step(1); return true; })()`);
    await shot('05-corpse', `(() => { const {game}=window.ragdoll; for(let i=0;i<240;i++) game.step(1); return true; })()`);
    await shot('06-debug', `(() => { window.ragdoll.driver.debug = true; return true; })()`);
    await shot('07-night', `(async () => { const {controller,game}=window.ragdoll; window.ragdoll.driver.debug = false; controller.reset(3); game.cfg.nightEvery=40; game.cfg.nightLength=400; controller.setAuto(true); game.start(); let g=0; while(!game.night&&g++<600) game.step(1); return true; })()`);
    await shot('08-obstacles', seeded(42, 240));
    console.log(`screenshots written to ${shotDir}`);
  }

  check('no uncaught page exceptions', pageErrors.length === 0, pageErrors.join(' | '));
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' | '));

  await cdp.close();
} catch (err) {
  check('browser check completed', false, err?.message ?? String(err));
} finally {
  cleanup();
}

let failed = 0;
const pad = (s, n) => String(s).padEnd(n);
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${pad(r.name, 46)} ${r.detail ?? ''}`);
}
console.log(`\n${results.length - failed}/${results.length} browser checks passing`);
process.exit(failed ? 1 : 0);
