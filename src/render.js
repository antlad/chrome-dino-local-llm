/**
 * Renderer. Canvas 2D, no assets, no images, nothing to load.
 *
 * The dino is *skinned* rather than sprited: each bone becomes a capsule whose
 * width tapers along the skeleton, and the union of those capsules is the
 * silhouette. That is the only way to draw a body whose joints are decided by a
 * solver a few milliseconds earlier. A sprite sheet would need a frame for every
 * pose a ragdoll can reach, which is to say infinitely many.
 *
 * Everything the player sees as solid is drawn from the numbers the physics
 * solver used, so the hitbox can't quietly disagree with the picture.
 */

const PALETTE = {
  day: {
    sky: '#ffffff',
    ink: '#535353',
    inkSoft: '#9a9a9a',
    line: '#dedede',
    ground: '#535353',
    dust: '#c9c9c9',
    belly: '#f7f7f7',
    eye: '#ffffff',
  },
  night: {
    sky: '#1b1b1f',
    ink: '#dcdce0',
    inkSoft: '#6f6f78',
    line: '#2f2f36',
    ground: '#dcdce0',
    dust: '#4a4a52',
    belly: '#2a2a30',
    eye: '#1b1b1f',
  },
};

function capsule(ctx, x1, y1, x2, y2, r1, r2, begin = true) {
  // A capsule as a path: two arcs joined by their shared tangents. Passing
  // begin=false appends to the path already being built, which is how the body
  // gets filled as one shape. Filling each bone separately leaves a visible
  // seam where two capsules overlap, and a ragdoll covered in seams looks like
  // a pile of parts rather than an animal.
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ang = Math.atan2(dy, dx);
  if (begin) ctx.beginPath();
  ctx.moveTo(x1 + Math.cos(ang + Math.PI / 2) * r1, y1 + Math.sin(ang + Math.PI / 2) * r1);
  ctx.arc(x1, y1, r1, ang + Math.PI / 2, ang - Math.PI / 2);
  ctx.arc(x2, y2, r2, ang - Math.PI / 2, ang + Math.PI / 2);
  ctx.closePath();
}

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = canvas.width;
    this.height = canvas.height;
    this.groundY = opts.groundY ?? 372;
    this.dust = [];
    this.clouds = [];
    this.stars = [];
    this.shake = 0;
    this.flash = 0;

    for (let i = 0; i < 5; i++) {
      this.clouds.push({
        x: Math.random() * this.width,
        y: 40 + Math.random() * 120,
        w: 42 + Math.random() * 46,
        speed: 0.12 + Math.random() * 0.22,
      });
    }
    for (let i = 0; i < 26; i++) {
      this.stars.push({
        x: Math.random() * this.width,
        y: 20 + Math.random() * 190,
        r: Math.random() < 0.3 ? 2 : 1,
        tw: Math.random() * Math.PI * 2,
      });
    }
  }

  reset() {
    this.dust.length = 0;
    this.shake = 0;
    this.flash = 0;
  }

  /** Landing and footfall kicks. Dust is the only thing that says a foot hit. */
  puff(x, y, strength = 1, dir = 0) {
    const n = Math.round(3 + strength * 5);
    for (let i = 0; i < n; i++) {
      this.dust.push({
        x: x + (Math.random() - 0.5) * 10,
        y: y - Math.random() * 4,
        vx: -(0.6 + Math.random() * 1.9) * (1 + strength) + dir * 0.8,
        vy: -(0.4 + Math.random() * 2.1) * strength,
        life: 1,
        decay: 0.02 + Math.random() * 0.03,
        r: 1 + Math.random() * (1.6 + strength),
      });
    }
  }

  impact(x, y, strength = 1) {
    this.shake = Math.min(10, this.shake + 4 + strength * 5);
    this.flash = 1;
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 1 + Math.random() * 3.4 * strength;
      this.dust.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 1.4,
        life: 1,
        decay: 0.016 + Math.random() * 0.02,
        r: 1 + Math.random() * 2.6,
      });
    }
  }

  updateEffects(dt, speed) {
    for (let i = this.dust.length - 1; i >= 0; i--) {
      const d = this.dust[i];
      d.x += d.vx * dt - speed * 0.35 * dt;
      d.y += d.vy * dt;
      d.vy += 0.14 * dt;
      d.vx *= 0.98;
      d.life -= d.decay * dt;
      if (d.life <= 0) this.dust.splice(i, 1);
    }
    for (const c of this.clouds) {
      c.x -= (c.speed + speed * 0.05) * dt;
      if (c.x + c.w < -20) {
        c.x = this.width + 20 + Math.random() * 120;
        c.y = 40 + Math.random() * 120;
      }
    }
    this.shake *= Math.pow(0.86, dt);
    this.flash *= Math.pow(0.8, dt);
  }

  drawFrame(game) {
    const ctx = this.ctx;
    const night = game.night;
    const pal = night ? PALETTE.night : PALETTE.day;

    ctx.save();
    if (this.shake > 0.4) {
      // Camera kick on impact. Small and fast; a big shake hides the very thing
      // the player needs to see, which is how their body just died.
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }

    ctx.fillStyle = pal.sky;
    ctx.fillRect(-20, -20, this.width + 40, this.height + 40);

    this.drawBackdrop(game, pal);
    this.drawGround(game, pal);
    this.drawDust(pal);
    this.drawObstacles(game, pal);
    this.drawDino(game, pal);

    if (this.flash > 0.02) {
      ctx.fillStyle = night
        ? `rgba(255,255,255,${this.flash * 0.14})`
        : `rgba(83,83,83,${this.flash * 0.08})`;
      ctx.fillRect(-20, -20, this.width + 40, this.height + 40);
    }
    ctx.restore();
  }

  drawBackdrop(game, pal) {
    const ctx = this.ctx;
    if (game.night) {
      for (const s of this.stars) {
        const tw = 0.55 + 0.45 * Math.sin(game.tick * 0.03 + s.tw);
        ctx.fillStyle = `rgba(220,220,224,${tw})`;
        ctx.fillRect(Math.round(s.x), Math.round(s.y), s.r, s.r);
      }
      // Moon, phases over the night cycle rather than a fixed disc.
      const mx = this.width - 140;
      const my = 74;
      ctx.fillStyle = pal.ink;
      ctx.beginPath();
      ctx.arc(mx, my, 17, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = pal.sky;
      ctx.beginPath();
      ctx.arc(mx - 9 + Math.sin(game.nightPhase * Math.PI * 2) * 9, my - 3, 15, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = pal.line;
      for (const c of this.clouds) {
        const x = Math.round(c.x);
        const y = Math.round(c.y);
        const w = Math.round(c.w);
        ctx.fillRect(x, y, w, 6);
        ctx.fillRect(x + 8, y - 6, w - 18, 6);
        ctx.fillRect(x + 16, y + 6, w - 26, 5);
      }
    }
  }

  drawGround(game, pal) {
    const ctx = this.ctx;
    ctx.fillStyle = pal.ground;
    // The deck line: 2 px, solid, exactly where the solver puts the floor.
    ctx.fillRect(0, this.groundY, this.width, 2);

    // Pebble dashes, scrolling with the world so speed is legible even when the
    // dino is pinned at a fixed x.
    ctx.fillStyle = pal.dust;
    const period = 46;
    const off = -(game.distance % period);
    for (let x = off - period; x < this.width + period; x += period) {
      const k = Math.floor((x - off) / period);
      const jitter = ((k * 37) % 13) - 6;
      ctx.fillRect(Math.round(x + jitter), this.groundY + 10 + ((k * 7) % 9), 8 + ((k * 5) % 7), 2);
    }
  }

  drawDust(pal) {
    const ctx = this.ctx;
    ctx.fillStyle = pal.dust;
    for (const d of this.dust) {
      ctx.globalAlpha = Math.max(0, Math.min(1, d.life));
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawObstacles(game, pal) {
    const ctx = this.ctx;
    ctx.fillStyle = pal.ink;
    for (const o of game.field.list) {
      if (o.kind === 'pterodactyl') this.drawPterodactyl(o, pal);
      else this.drawCactus(o, pal);
    }
  }

  /**
   * Cacti are drawn from their own colliders. The loop that draws is handed the
   * exact segment list the hit test used, so a cactus cannot look solid where it
   * is not, or look thin where it would still kill you.
   */
  drawCactus(o, pal) {
    const ctx = this.ctx;
    ctx.fillStyle = pal.ink;
    for (const s of o.segments) {
      capsule(ctx, o.x + s.x1, o.y + s.y1, o.x + s.x2, o.y + s.y2, s.r, s.r);
      ctx.fill();
    }
    // Ribs, purely to sell it as a plant rather than a pile of sausages.
    ctx.fillStyle = pal.sky;
    for (const s of o.segments) {
      if (s.r < 6) continue;
      const x = o.x + s.x1;
      ctx.fillRect(Math.round(x - 1), Math.round(o.y + Math.max(s.y1, s.y2)), 2, Math.abs(s.y2 - s.y1) - s.r);
    }
  }

  drawPterodactyl(o, pal) {
    const ctx = this.ctx;
    ctx.fillStyle = pal.ink;
    for (const s of o.segments) {
      capsule(ctx, o.x + s.x1, o.y + s.y1, o.x + s.x2, o.y + s.y2, s.r, s.r);
      ctx.fill();
    }
    // Wings are animated here and deliberately absent from the collider. A
    // hitbox that flickered twice a second with the flap would be unfair.
    const y = o.y + (o.bodyY ?? -o.base - 20);
    const flap = Math.sin(o.flap) * 0.85;
    const span = 26;
    for (const side of [-1, 1]) {
      const tipX = o.x - 2 + flap * 5;
      ctx.beginPath();
      ctx.moveTo(o.x - 8, y);
      ctx.lineTo(tipX - 14, y + side * flap * span);
      ctx.lineTo(tipX + 12, y + side * flap * span * 0.7);
      ctx.closePath();
      ctx.fill();
    }
    // Beak tip.
    ctx.beginPath();
    ctx.moveTo(o.x + 34, y - 5);
    ctx.lineTo(o.x + 48, y - 2);
    ctx.lineTo(o.x + 34, y + 1);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * The dino. Bones are filled as one compound path so internal seams vanish,
   * then the belly and skull details go on top.
   */
  drawDino(game, pal) {
    const ctx = this.ctx;
    const dino = game.dino;
    if (!dino) return;
    const bones = dino.skin();
    const joints = dino.jointPositions();

    // Far limbs first, slightly lighter, so the near side reads as in front.
    ctx.fillStyle = pal.inkSoft;
    for (const b of bones) {
      if (!/L$/.test(b.a) && !/L$/.test(b.b)) continue;
      const w = b.width / 2;
      capsule(ctx, b.x1, b.y1, b.x2, b.y2, w * 0.95, w * 0.8);
      ctx.fill();
    }

    // Body, one fill so the union has no seams.
    ctx.fillStyle = pal.ink;
    ctx.beginPath();
    let drew = false;
    for (const b of bones) {
      if (/L$/.test(b.a) || /L$/.test(b.b)) continue;
      const w = b.width / 2;
      capsule(ctx, b.x1, b.y1, b.x2, b.y2, w, w * 0.86, false);
      drew = true;
    }
    if (drew) ctx.fill();

    // Belly highlight along the spine. Reads as volume without any shading.
    const pelvis = joints.pelvis;
    const chest = joints.chest;
    if (pelvis && chest) {
      ctx.strokeStyle = pal.belly;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(pelvis.x + 2, pelvis.y + 5);
      ctx.lineTo(chest.x - 2, chest.y + 5);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    this.drawHead(game, dino, pal);
    this.drawFeet(joints, pal);
  }

  drawHead(game, dino, pal) {
    const ctx = this.ctx;
    const f = dino.headFrame();
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.angle);
    ctx.fillStyle = pal.ink;
    // Skull: the bone is a round capsule, so square off the front of it here and
    // the head stops looking like a ball on a stick.
    ctx.beginPath();
    ctx.moveTo(-6, -12);
    ctx.lineTo(15, -11);
    ctx.lineTo(19, -3);
    ctx.lineTo(17, 8);
    ctx.lineTo(-4, 11);
    ctx.closePath();
    ctx.fill();

    // Eye. Looks forward while alive and rolls back when dead, which is the
    // clearest single cue that the muscles have let go.
    const alive = dino.alive;
    ctx.fillStyle = pal.eye;
    if (alive) {
      ctx.beginPath();
      ctx.arc(7, -4, 3.4, 0, Math.PI * 2);
      ctx.fill();
      const look = game.night ? 0.9 : 0.6;
      ctx.fillStyle = pal.ink;
      ctx.beginPath();
      ctx.arc(7 + look, -4, 1.7, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = pal.eye;
      ctx.lineWidth = 2;
      const cx = 7;
      const cy = -4;
      ctx.beginPath();
      ctx.moveTo(cx - 3.4, cy - 3.4);
      ctx.lineTo(cx + 3.4, cy + 3.4);
      ctx.moveTo(cx + 3.4, cy - 3.4);
      ctx.lineTo(cx - 3.4, cy + 3.4);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // Jaw line and nostril.
    ctx.strokeStyle = pal.sky;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(2, 4);
    ctx.lineTo(16, 2);
    ctx.stroke();
    ctx.fillStyle = pal.sky;
    ctx.fillRect(15, -7, 2, 2);
    ctx.lineWidth = 1;
    ctx.restore();
  }

  drawFeet(joints, pal) {
    const ctx = this.ctx;
    ctx.fillStyle = pal.ink;
    for (const side of ['L', 'R']) {
      const foot = joints['foot' + side];
      if (!foot) continue;
      // Flat foot on the deck, toe forward. A round particle reads as a ball, so
      // the contact patch is drawn as a wedge instead.
      ctx.beginPath();
      ctx.moveTo(foot.x - 5, foot.y + foot.radius - 1);
      ctx.lineTo(foot.x + 9, foot.y + foot.radius - 1);
      ctx.lineTo(foot.x + 7, foot.y + foot.radius - 6);
      ctx.lineTo(foot.x - 4, foot.y + foot.radius - 5);
      ctx.closePath();
      ctx.fill();
    }
  }
}

export { PALETTE };
