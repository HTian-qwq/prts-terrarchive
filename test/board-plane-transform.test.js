import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardPlaneTransform } from '../ui/rhine/board-plane-transform.ts';

const width = 320, height = 45;
const corners = [{ x: 0, y: 0 }, { x: width, y: 0 },
  { x: width, y: height }, { x: 0, y: height }];

function cssProjection(transform) {
  assert.equal(typeof transform, 'string', 'a visible board plane has a CSS transform');
  assert.match(transform, /^matrix3d\([^)]+\)$/);
  const m = transform.slice(9, -1).split(',').map(Number);
  assert.equal(m.length, 16);
  assert(m.every(Number.isFinite), 'all CSS coefficients must be finite');
  // CSS matrix3d is column-major. Perspective division is applied after the
  // translation column, as the browser does for transform-origin: 0 0.
  return ({ x, y }) => {
    const w = m[3] * x + m[7] * y + m[15];
    return { x: (m[0] * x + m[4] * y + m[12]) / w,
      y: (m[1] * x + m[5] * y + m[13]) / w };
  };
}

function nearPoint(actual, expected, label) {
  for (const axis of ['x', 'y']) {
    assert(Number.isFinite(actual[axis]), `${label}: ${axis} remains finite`);
    assert(Math.abs(actual[axis] - expected[axis]) < 1e-8,
      `${label}: ${axis} was ${actual[axis]}, expected ${expected[axis]}`);
  }
}

// Independently project a physical rectangle with yaw, pitch, and pinhole
// perspective. This catches an affine-only fit that can match some corners
// while allowing controls inside the label to slide off the board plane.
function projectBoard({ x, y }) {
  const localX = (x - width / 2) * 0.012;
  const localY = (height / 2 - y) * 0.012;
  const yaw = -0.61, pitch = 0.11;
  const worldX = localX * Math.cos(yaw);
  const yawDepth = -localX * Math.sin(yaw);
  const worldY = localY * Math.cos(pitch) - yawDepth * Math.sin(pitch);
  const depth = 12 + localY * Math.sin(pitch) + yawDepth * Math.cos(pitch);
  return { x: 960 + 960 * worldX / depth, y: 540 - 960 * worldY / depth };
}

test('a board label maps all four clockwise corners to their exact projected positions', () => {
  const targets = [{ x: 240, y: 190 }, { x: 581, y: 141 },
    { x: 577, y: 201 }, { x: 248, y: 249 }];
  const before = structuredClone(targets);
  const project = cssProjection(boardPlaneTransform(targets, width, height));
  corners.forEach((point, index) => nearPoint(project(point), targets[index], `corner ${index}`));
  assert.deepEqual(targets, before, 'reused scene anchor records must not be mutated');
});

test('the entire label follows the same known perspective as the 3D board', () => {
  const project = cssProjection(boardPlaneTransform(corners.map(projectBoard), width, height));
  for (const x of [0, 17, 80, 160, 245, 301, width]) {
    for (const y of [0, 4, 17, 22.5, 33, height]) {
      const point = { x, y };
      nearPoint(project(point), projectBoard(point), `board coordinate ${x},${y}`);
    }
  }
});

test('front-facing and rotated affine boards preserve the label without perspective drift', () => {
  for (const angle of [0, -0.17, 0.64]) {
    const expected = ({ x, y }) => ({
      x: 37 + 1.8 * x * Math.cos(angle) - 0.7 * y * Math.sin(angle),
      y: -19 + 1.8 * x * Math.sin(angle) + 0.7 * y * Math.cos(angle),
    });
    const project = cssProjection(boardPlaneTransform(corners.map(expected), width, height));
    for (const point of [...corners, { x: 139, y: 23 }]) nearPoint(project(point), expected(point), `angle ${angle}`);
  }
});

test('screen translation and zoom are applied once to every point of the projected label', () => {
  for (const scale of [0.5, 1, 2.75]) {
    const translate = point => ({ x: point.x * scale - 253, y: point.y * scale + 71 });
    const expected = point => translate(projectBoard(point));
    const project = cssProjection(boardPlaneTransform(corners.map(expected), width, height));
    for (const point of [...corners, { x: 89, y: 12 }, { x: 287, y: 39 }]) {
      nearPoint(project(point), expected(point), `screen scale ${scale}`);
    }
  }
});

test('changing the DOM layout size preserves normalized positions on the physical label', () => {
  const targets = corners.map(projectBoard);
  for (const factor of [0.5, 2, 4]) {
    const project = cssProjection(boardPlaneTransform(targets, width * factor, height * factor));
    for (const point of [...corners, { x: 57, y: 31 }]) {
      nearPoint(project({ x: point.x * factor, y: point.y * factor }), projectBoard(point), `layout scale ${factor}`);
    }
  }
});

test('missing corners and nonpositive or nonfinite layout dimensions have no transform', () => {
  const targets = corners.map(projectBoard);
  for (let length = 0; length < 4; length++) assert.equal(boardPlaneTransform(targets.slice(0, length), width, height), null);
  for (const invalid of [0, -1, NaN, Infinity, -Infinity]) {
    assert.equal(boardPlaneTransform(targets, invalid, height), null, `width ${invalid}`);
    assert.equal(boardPlaneTransform(targets, width, invalid), null, `height ${invalid}`);
  }
});

test('nonfinite projected coordinates never leak invalid CSS transforms', () => {
  for (let index = 0; index < 4; index++) {
    for (const axis of ['x', 'y']) {
      for (const invalid of [NaN, Infinity, -Infinity]) {
        const targets = corners.map(projectBoard);
        targets[index][axis] = invalid;
        assert.equal(boardPlaneTransform(targets, width, height), null, `corner ${index}, ${axis}=${invalid}`);
      }
    }
  }
});

test('collapsed edges and collinear projections return null for recovery controls', () => {
  const degenerate = [
    Array.from({ length: 4 }, () => ({ x: 80, y: 90 })),
    [{ x: 0, y: 1 }, { x: 2, y: 3 }, { x: 4, y: 5 }, { x: 6, y: 7 }],
    ...corners.map((_, index) => corners.map((point, other) => other === index ? corners[(index + 1) % 4] : point)),
  ];
  for (const [index, points] of degenerate.entries()) {
    assert.equal(boardPlaneTransform(points, width, height), null, `degenerate projection ${index}`);
  }
});
