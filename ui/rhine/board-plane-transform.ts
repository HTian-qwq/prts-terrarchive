type Point = { x: number; y: number };

/** Map a DOM rectangle exactly onto the projected corners of a planar label. */
export function boardPlaneTransform(points: readonly Point[], width: number, height: number): string | null {
  const [p0, p1, p2, p3] = points;
  if (points.length !== 4 || !p3 || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0
    || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  let orientation = 0;
  for (let index = 0; index < 4; index++) {
    const a = points[index], b = points[(index + 1) % 4], c = points[(index + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (!Number.isFinite(cross) || Math.abs(cross) < 1e-6 || orientation && Math.sign(cross) !== orientation) return null;
    orientation = Math.sign(cross);
  }
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  const determinant = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(determinant) < 1e-6) return null;
  const g = (dx3 * dy2 - dx2 * dy3) / determinant;
  const h = (dx1 * dy3 - dx3 * dy1) / determinant;
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + h * p3.x;
  const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + h * p3.y;
  return `matrix3d(${a / width},${d / width},0,${g / width},${b / height},${e / height},0,${h / height},0,0,1,0,${p0.x},${p0.y},0,1)`;
}
