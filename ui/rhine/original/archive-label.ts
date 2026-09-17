import type * as THREE from 'three';

export interface ArchiveLabel {
  code: string;
  title?: string;
  sourceId?: string;
}

export const ARCHIVE_LABEL_NAME = 'Rhine_Archive_Label';
export const ARCHIVE_LABEL_WIDTH = 1536;
export const ARCHIVE_LABEL_HEIGHT = 714;
export const ARCHIVE_LABEL_SIZE = { width: 0.99, height: 0.46 };
const FONT = 'MiSans, "PingFang SC", "Microsoft YaHei", sans-serif';

export function archiveLabelKey(label: ArchiveLabel) {
  return JSON.stringify([label.code, label.title || '', label.sourceId || '']);
}

/** Match the authored cover plate in every view; only the cassette itself moves. */
export function positionArchiveLabel(label: THREE.Object3D) {
  label.rotation.set(0, 0, 0);
  label.position.set(-1.36, 3.04, 0.255);
}

/** The array exposes one strip of the plate. Keep text there at a fixed size. */
export function archiveTitleLine(title: string, measure: (text: string) => number, width: number): string {
  const chars = Array.from(title.replace(/\s+/gu, ' ').trim());
  const bounded = chars.slice(0, 1024).join('');
  if (chars.length <= 1024 && measure(bounded) <= width) return bounded;
  if (measure('…') > width) return '';
  let low = 0, high = Math.min(chars.length, 1024);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(chars.slice(0, mid).join('') + '…') <= width) low = mid;
    else high = mid - 1;
  }
  return chars.slice(0, low).join('').trimEnd() + '…';
}

/** Repaint only when content changes; no HTML, glyph meshes or per-frame uploads. */
export function paintArchiveLabel(canvas: HTMLCanvasElement, mark: CanvasImageSource, label: ArchiveLabel) {
  const c = canvas.getContext('2d')!;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, canvas.width, canvas.height);
  c.setTransform(canvas.width / 1536, 0, 0, canvas.height / 714, 0, 0);
  c.fillStyle = '#eeeae2';
  c.fillRect(0, 0, 1536, 714);
  c.fillStyle = '#9b9b8c';
  c.fillRect(62, 36, 1412, 4);
  const title = label.title?.trim() || (label.code === 'READING' ? '正在读取资料' : '莱茵生命 · 资料档案');
  const separator = title.indexOf(' / ');
  const name = separator > 0 ? title.slice(0, separator) : title;
  const type = separator > 0 ? title.slice(separator + 3).replace(/\s+/gu, ' ').trim() : '';
  c.font = `400 112px ${FONT}`;
  const slashWidth = c.measureText('/').width, gap = 40, width = 1384, x = 76, baseline = 216;
  c.font = `600 144px ${FONT}`;
  c.fillStyle = '#353931';
  const nameWidth = width - c.measureText(type).width - slashWidth - gap * 2;
  if (type && nameWidth >= c.measureText('…').width) {
    // Retain the document type even when a long entity name needs shortening.
    const line = archiveTitleLine(name, value => c.measureText(value).width, nameWidth);
    c.fillText(line, x, baseline);
    const slashX = x + c.measureText(line).width + gap;
    c.font = `400 112px ${FONT}`;
    c.fillStyle = '#8a8c7e';
    c.fillText('/', slashX, baseline);
    c.font = `600 144px ${FONT}`;
    c.fillStyle = '#353931';
    c.fillText(type, slashX + slashWidth + gap, baseline);
  } else {
    c.fillText(archiveTitleLine(title, value => c.measureText(value).width, width), x, baseline);
  }
  c.fillStyle = '#b7b5a8';
  c.fillRect(76, 404, 1384, 3);
  c.fillStyle = '#353931';
  c.font = `400 64px ${FONT}`;
  c.fillText(label.code, 76, 617);
  c.font = `400 51px ${FONT}`;
  c.fillText('RHINE LAB, LLC.', 414, 574);
  c.fillStyle = '#727568';
  c.font = `34px ${FONT}`;
  c.fillText('INTERNAL DATABASE / INFO', 414, 638);
  c.drawImage(mark, 1320, 570, 140, 65);
}
