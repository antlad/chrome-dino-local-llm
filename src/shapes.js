/**
 * Capsule geometry for obstacles, drawn and collided from the same numbers.
 *
 * Every offset is relative to the collider origin, which sits on the deck at the
 * obstacle's left edge: x grows to the right, y grows *down*, so anything above
 * the deck has a negative y. Keeping one coordinate convention across the
 * physics world, the hit test and the renderer is what lets a cactus be drawn
 * from exactly the geometry that killed you.
 */

/** A capsule: a line segment with a radius, i.e. the physics world's `segment`. */
function cap(x1, y1, x2, y2, r = 5) {
  return { x1, y1, x2, y2, r };
}

/**
 * One cactus column: a trunk with two arms, like the original sprite.
 *
 * The arms are the reason this is capsules rather than a box. A rectangular hit
 * box either includes the empty notch under an arm, which kills the player for
 * nothing, or excludes the arm itself, which lets them walk through a visibly
 * solid cactus. Two segments per arm gets both right.
 */
export function cactusColumn(height = 46, opts = {}) {
  const h = height;
  const trunkR = opts.trunkR ?? 7;
  const armR = opts.armR ?? 5;
  const armUp = opts.armUp ?? 0.5;
  const armOut = opts.armOut ?? 9;
  const segs = [cap(0, 0, 0, -h, trunkR)];

  // Left arm: out of the trunk, then up. Elbow at the corner.
  const laY = -h * (armUp - 0.06);
  segs.push(cap(0, laY, -armOut, laY, armR));
  segs.push(cap(-armOut, laY, -armOut, -h * (armUp + 0.3), armR));

  // Right arm, slightly higher than the left so the silhouette is not symmetric.
  const raY = -h * (armUp + 0.1);
  segs.push(cap(0, raY, armOut, raY, armR));
  segs.push(cap(armOut, raY, armOut, -h * (armUp + 0.42), armR));

  return segs;
}

/**
 * A cluster of cactus columns, the "large cactus" of the original game when it
 * has several. Returns the segments plus the extent the field needs for spawn
 * spacing, despawning and the hit-test height fraction.
 */
export function cactusCluster(cols = 1, large = false) {
  const segs = [];
  const spacing = 17;
  const baseH = large ? 50 : 38;
  let top = 0;
  for (let i = 0; i < cols; i++) {
    // Vary the heights a little so a cluster of three does not read as a wall.
    const h = baseH - (i % 2 === 1 ? 9 : 0) - (i % 3 === 2 ? 5 : 0);
    for (const s of cactusColumn(h, large ? { trunkR: 7.5 } : { trunkR: 6.5 })) {
      segs.push({ ...s, x1: s.x1 + i * spacing, x2: s.x2 + i * spacing });
    }
    top = Math.min(top, -h);
  }
  const left = -10;
  const right = (cols - 1) * spacing + 10;
  const span = segmentSpan(segs);
  return {
    segments: segs,
    width: right - left,
    height: -top,
    spanLeft: span.spanLeft,
    spanRight: span.spanRight,
    // Offsets above the deck (negative y) of the solid extremes. The hit test
    // uses these to say how high up the obstacle the dino was struck, so they
    // have to survive the copy into the obstacle spec.
    spanTop: top,
    spanBottom: 0,
  };
}

/**
 * A pterodactyl. Collision covers the body, skull, beak and tail only; the
 * wings are decoration drawn by the renderer.
 *
 * That split is deliberate. Wings flap, so if they were part of the collider the
 * hitbox would flicker in and out twice a second and the player would die to a
 * feather they could not have seen coming. Solid body, animated skin.
 */
export function pterodactylShape(base = 56, rng = null) {
  const cy = -base - 20; // body centre height above the deck
  const bob = rng ? (rng() - 0.5) * 6 : 0;
  const y = cy + bob;
  const segs = [
    // body, snout-first into the wind
    cap(-16, y, 14, y - 2, 9),
    // skull and beak
    cap(14, y - 2, 26, y - 6, 6),
    cap(26, y - 6, 40, y - 3, 3),
    // tail, sweeping back and up
    cap(-16, y, -34, y - 10, 5),
    // legs tucked under, they read as solid without being a large hitbox
    cap(-2, y + 6, 6, y + 13, 3),
  ];
  const top = y - 14;
  const bottom = y + 16;
  const span = segmentSpan(segs);
  return {
    segments: segs,
    width: 78,
    height: bottom - top,
    spanLeft: span.spanLeft,
    spanRight: span.spanRight,
    // Relative to the collider origin, which sits on the deck, so the hit test
    // can say how high up the bird the dino was struck.
    spanTop: top,
    spanBottom: bottom,
    bodyY: y,
  };
}

/**
 * True horizontal extents of a segment list, relative to the collider origin.
 *
 * The collider origin is *not* the left edge of the obstacle. A pterodactyl's
 * tail sticks out behind it and its beak well in front, so anything that times a
 * jump or a duck off `x` alone will misjudge the moment the body is actually
 * over the thing. Deriving the extents from the segments keeps the answer right
 * when the art changes.
 */
export function segmentSpan(segments) {
  let min = Infinity;
  let max = -Infinity;
  for (const s of segments) {
    min = Math.min(min, s.x1 - s.r, s.x2 - s.r);
    max = Math.max(max, s.x1 + s.r, s.x2 + s.r);
  }
  return { spanLeft: min, spanRight: max, width: max - min };
}

/**
 * Ground anchors a cactus to the deck: the collider origin is at ground level,
 * so anything with a positive y would be buried under it. Clamps the bottoms of
 * trunk segments to the deck so a solver never sees a solid below the floor.
 */
export function groundAnchored(segments) {
  return segments.map((s) => ({
    x1: s.x1,
    y1: Math.min(s.y1, s.r * 0.5),
    x2: s.x2,
    y2: Math.min(s.y2, s.r * 0.5),
    r: s.r,
  }));
}

/**
 * Shape lookup used by the obstacle field. Returns segments plus extents, all
 * computed once so a cluster never gets built twice with different results.
 */
export function buildObstacle(kind, rng, bandBase = 0) {
  if (kind === 'pterodactyl') {
    const s = pterodactylShape(bandBase, rng);
    return { ...s, animated: true };
  }
  const large = kind === 'cactus-large';
  const cols = large ? 1 + Math.floor(rng() * 3) : 1 + Math.floor(rng() * 2);
  const c = cactusCluster(cols, large);
  return { ...c, segments: groundAnchored(c.segments), cols, large, animated: false };
}
