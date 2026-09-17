"""Compare the recorded endpoints; requires Pillow and NumPy, no image rewriting."""
import json
from pathlib import Path

import numpy as np
from PIL import Image

root = Path(__file__).resolve().parent
before = json.loads((root / 'baseline/stats.json').read_text())
after = json.loads((root / 'after/stats.json').read_text())
comparison = {
    'baselineBundle': before['bundle'],
    'afterBundle': after['bundle'],
    'method': 'Matching virtual-time endpoints and actual camera/file poses. '
              'Triangle counts include all renderer passes. SwiftShader is not hardware GPU/FPS evidence. '
              'Desktop footer clock (x1500:1770, y1030:1050) excluded separately from full-page RGB differences. '
              'Central ROI is full width, y180:850; it does not cover the entire canvas.',
    'records': [],
}
for a, b in zip(before['records'], after['records'], strict=True):
    name = a['name']
    assert name == b['name']
    assert a['arrayCamera'] == b['arrayCamera'], name
    assert [(f['sourceId'], f['position']) for f in a['files']] == [
        (f['sourceId'], f['position']) for f in b['files']], name
    baseline = np.asarray(Image.open(root / 'baseline' / (name + '.png')), dtype=int)
    optimized = np.asarray(Image.open(root / 'after' / (name + '.png')), dtype=int)
    delta = np.abs(baseline - optimized)[:, :, :3]
    changed = delta.any(axis=2)
    ys, xs = np.where(changed)
    without_clock = delta.copy()
    if baseline.shape[:2] == (1080, 1920):
        without_clock[1030:1050, 1500:1770] = 0
    comparison['records'].append({
        'view': name,
        'cameraAndFilePosesEqual': True,
        'triangles': {'before': a['stats']['triangles'], 'after': b['stats']['triangles']},
        'triangleReductionPercent': 100 * (1 - b['stats']['triangles'] / a['stats']['triangles']),
        'drawCalls': {'before': a['stats']['drawCalls'], 'after': b['stats']['drawCalls']},
        'occlusion': b['stats']['arrayVisibility']['occlusion'],
        'rgbDiff': {
            'fullPageChangedPixels': int(changed.sum()),
            'fullPageBoundsInclusive': [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] if len(xs) else None,
            'centralRoiChangedPixels': int(changed[180:850].sum()),
            'excludingFooterClockChangedPixels': int(without_clock.any(axis=2).sum()),
            'excludingFooterClockMaxChannelDelta': int(without_clock.max()),
            'excludingFooterClockPixelsOver8': int((without_clock.max(axis=2) > 8).sum()),
            'excludingFooterClockMeanChannelDelta': float(without_clock.mean()),
        },
    })
(root / 'comparison.json').write_text(json.dumps(comparison, indent=2) + '\n')
print(json.dumps([{k: r[k] for k in ['view', 'triangleReductionPercent', 'rgbDiff']} for r in comparison['records']], indent=2))
