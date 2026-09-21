import { evidenceCardAppearance } from './evidence-card-style';
import type { EvidenceCard } from './evidence-board-model';

const WIDTH = 768;
// Match the original archive: ivory polymer, warm silver trim and champagne accents.
// Palette sources: original/scene.ts materials and original-ui.css inspection marks.
const INK = '#24221f';
const MUTED = '#726f67';
const RED = '#a23b30';
type Context = CanvasRenderingContext2D;
type ArtCard = EvidenceCard & { visual?: 'observatory' | 'schematic' | 'signal' };

function font(context: Context, size: number, weight = 400) {
  context.font = `${weight} ${size}px MiSans, sans-serif`;
}

function fitted(context: Context, value: string, width: number) {
  if (context.measureText(value).width <= width) return value;
  const characters = Array.from(value);
  let low = 0, high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (context.measureText(characters.slice(0, middle).join('') + '…').width <= width) low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join('') + '…';
}

/** Preserve explicit line breaks and never paint beyond the available rows. */
function wrap(context: Context, value: string, width: number, maximum: number) {
  if (maximum < 1) return [];
  const characters = Array.from(value.replace(/\r/g, ''));
  const result: string[] = [];
  let line = '';
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];
    if (character === '\n' || context.measureText(line + character).width > width) {
      if (result.length === maximum - 1) {
        result.push(fitted(context, line + characters.slice(index).join('').replace(/\n/g, ' '), width));
        return result;
      }
      result.push(line);
      line = character === '\n' ? '' : character;
    } else line += character;
  }
  if (line) result.push(line);
  return result;
}

function paragraph(context: Context, value: string, x: number, y: number,
  width: number, size: number, leading: number, maximum: number, weight = 400) {
  font(context, size, weight);
  const rows = wrap(context, value, width, maximum);
  rows.forEach((row, index) => context.fillText(row, x, y + index * leading));
  return rows.length * leading;
}

function path(context: Context, points: number[][], color: string, width = 1.5, close = false) {
  if (!points.length) return;
  context.beginPath();
  points.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y));
  if (close) context.closePath();
  context.strokeStyle = color; context.lineWidth = width; context.stroke();
}

function circle(context: Context, x: number, y: number, radius: number, color: string, width = 1.5) {
  context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2);
  context.strokeStyle = color; context.lineWidth = width; context.stroke();
}

function randomFor(key: string) {
  let seed = 2166136261;
  for (let index = 0; index < key.length; index++) seed = Math.imul(seed ^ key.charCodeAt(index), 16777619);
  return () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function paper(context: Context, height: number, color: string, key: string) {
  context.fillStyle = color; context.fillRect(0, 0, WIDTH, height);
  const random = randomFor(key);
  context.fillStyle = 'rgba(98,89,80,.035)';
  // Fixed grain is drawn before the ink; it never flickers when a card is edited.
  for (let index = 0; index < 1050; index++) {
    context.fillRect(random() * WIDTH, random() * height, 0.45 + random() * 1.2, 0.3 + random() * 0.8);
  }
  const edge = context.createLinearGradient(0, 0, WIDTH, 0);
  edge.addColorStop(0, 'rgba(112,102,91,.055)'); edge.addColorStop(.016, 'rgba(112,102,91,0)');
  edge.addColorStop(.986, 'rgba(112,102,91,0)'); edge.addColorStop(1, 'rgba(112,102,91,.045)');
  context.fillStyle = edge; context.fillRect(0, 0, WIDTH, height);
  context.strokeStyle = 'rgba(112,102,91,.1)'; context.lineWidth = 1;
  for (let index = 0; index < 20; index++) {
    const x = random() * WIDTH, y = index % 2 ? 1.5 : height - 1.5;
    context.beginPath(); context.moveTo(x, y); context.lineTo(Math.min(WIDTH, x + 3 + random() * 13), y); context.stroke();
  }
}

function sample(context: Context, card: ArtCard, x: number, y: number, align: CanvasTextAlign = 'left') {
  if (!card.id.startsWith('preview:')) return;
  context.save(); context.textAlign = align; font(context, 18, 600);
  context.fillStyle = MUTED; context.fillText('LONE TRAIL / 示例', x, y); context.restore();
}

function imageSize(image: CanvasImageSource) {
  const source = image as unknown as Record<string, unknown>;
  const dimension = (...names: string[]) => {
    for (const name of names) {
      const value = source[name];
      if (typeof value === 'number' && value > 0) return value;
      if (value && typeof value === 'object' && 'baseVal' in value) {
        const length = (value as { baseVal: { value: number } }).baseVal.value;
        if (length > 0) return length;
      }
    }
    return 0;
  };
  return { width: dimension('naturalWidth', 'videoWidth', 'displayWidth', 'width'),
    height: dimension('naturalHeight', 'videoHeight', 'displayHeight', 'height') };
}

function photoCard(context: Context, card: ArtCard, height: number, image: CanvasImageSource) {
  const dimensions = imageSize(image);
  if (!dimensions.width || !dimensions.height) return false;
  paper(context, height, '#fffdfa', card.id);
  const margin = 27, imageWidth = WIDTH - margin * 2;
  const imageHeight = Math.max(80, height - 144);
  const scale = Math.max(imageWidth / dimensions.width, imageHeight / dimensions.height);
  const cropWidth = imageWidth / scale, cropHeight = imageHeight / scale;
  // Only supplied pixels are used. A missing photograph falls back to a text document.
  context.drawImage(image, (dimensions.width - cropWidth) / 2, (dimensions.height - cropHeight) / 2,
    cropWidth, cropHeight, margin, margin, imageWidth, imageHeight);
  context.fillStyle = INK; font(context, 48, 600);
  context.fillText(fitted(context, card.title || '未命名线索', WIDTH - 82), 40, height - 94);
  context.fillStyle = MUTED; font(context, 22);
  const caption = `主题意象 · ${card.sourceTitle || card.body.replace(/\s+/g, ' ').trim()}`;
  context.fillText(fitted(context, caption, WIDTH - (card.id.startsWith('preview:') ? 285 : 84)), 42, height - 35);
  sample(context, card, WIDTH - 37, height - 34, 'right');
  return true;
}

function diagram(context: Context, top: number, height: number, loneTrail: boolean) {
  const scale = Math.min(680 / 680, height / 380);
  if (scale <= 0) return;
  context.save(); context.translate((WIDTH - 680 * scale) / 2, top + (height - 380 * scale) / 2);
  context.scale(scale, scale);
  const line = '#57524d', pale = '#aaa49a', faint = 'rgba(126,118,107,.13)';
  for (let x = 20; x < 680; x += 30) path(context, [[x, 0], [x, 380]], faint, .8);
  for (let y = 20; y < 380; y += 30) path(context, [[0, y], [680, y]], faint, .8);
  path(context, [[4, 340], [659, 340], [651, 334]], pale);
  path(context, [[42, 373], [42, 5], [36, 13]], pale);
  context.fillStyle = MUTED; font(context, 18, 600);
  context.fillText('X', 659, 347); context.fillText('Y', 17, 5);
  for (let x = 90; x < 650; x += 60) path(context, [[x, 336], [x, 344]], pale);
  // Circular test chamber, service rings and a cutaway hatch, all illustrative.
  const cx = 252, cy = 190;
  context.fillStyle = '#e2dad4'; context.beginPath(); context.arc(cx, cy, 102, 0, Math.PI * 2); context.fill();
  circle(context, cx, cy, 102, line, 2.8); circle(context, cx, cy, 92, line, 1.8);
  circle(context, cx, cy, 63, pale, 1.5); circle(context, cx, cy, 38, line, 2.2);
  circle(context, cx, cy, 17, line, 1.6);
  context.setLineDash([5, 6]); circle(context, cx, cy, 77, pale, 1.3); context.setLineDash([]);
  for (let index = 0; index < 12; index++) {
    const angle = index * Math.PI / 6;
    const polar = (radius: number) => [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];
    path(context, [polar(94), polar(101)], line, 2);
    if (index % 3 === 0) path(context, [polar(40), polar(61)], line, 2);
  }
  path(context, [[cx - 114, cy], [cx + 114, cy]], pale, .9);
  path(context, [[cx, cy - 113], [cx, cy + 113]], pale, .9);
  // Rectangular service modules with double walls and internal cells.
  for (const [x, y, w, h] of [[458, 55, 142, 91], [468, 245, 144, 74], [78, 108, 64, 126]]) {
    context.fillStyle = '#f7f4ef'; context.fillRect(x, y, w, h);
    context.strokeStyle = line; context.lineWidth = 2; context.strokeRect(x, y, w, h);
    context.strokeStyle = pale; context.lineWidth = 1; context.strokeRect(x + 6, y + 6, w - 12, h - 12);
    for (let offset = 22; offset < w - 12; offset += 22) path(context, [[x + offset, y + 12], [x + offset, y + h - 12]], pale);
  }
  path(context, [[342, 150], [402, 150], [402, 101], [458, 101]], line, 2.5);
  path(context, [[347, 157], [410, 157], [410, 109], [458, 109]], pale, 1.4);
  path(context, [[337, 248], [402, 248], [402, 281], [468, 281]], line, 2.5);
  path(context, [[332, 257], [394, 257], [394, 289], [468, 289]], pale, 1.4);
  path(context, [[142, 157], [159, 157]], line, 2); path(context, [[142, 220], [159, 220]], line, 2);
  path(context, [[252, 87], [252, 34], [387, 34], [387, 71]], line, 1.6);
  circle(context, 387, 82, 11, line, 1.8);
  for (let index = 0; index < 6; index++) path(context, [[194 + index * 12, 265], [207 + index * 12, 279]], pale, 1);
  // Dotted travel path and dimension brackets, not fictitious measured values.
  context.setLineDash([7, 5]);
  context.beginPath(); context.moveTo(100, 300); context.bezierCurveTo(140, 345, 380, 368, 548, 184);
  context.strokeStyle = line; context.lineWidth = 1.8; context.stroke(); context.setLineDash([]);
  path(context, [[538, 187], [548, 184], [546, 196]], line, 1.8);
  path(context, [[154, 70], [154, 53], [354, 53], [354, 70]], pale);
  path(context, [[151, 50], [158, 57]], pale); path(context, [[350, 50], [357, 57]], pale);
  context.fillStyle = line; font(context, 22, 600);
  context.fillText(loneTrail ? '万星园' : 'A', loneTrail ? 219 : 244, 156);
  context.fillText(loneTrail ? '星荚' : 'B', loneTrail ? 503 : 514, 20);
  context.fillText(loneTrail ? '能量井' : 'C', loneTrail ? 511 : 538, 326);
  context.fillStyle = MUTED; font(context, 18); context.fillText(loneTrail ? 'RHINE / 计划关联' : 'PLAN / 01', 47, 356);
  // A restrained pencil-red circle and one short handwritten-looking mark.
  context.beginPath(); context.ellipse(527, 102, 87, 57, -.09, -.12, Math.PI * 2 + .12);
  context.strokeStyle = RED; context.lineWidth = 3.3; context.stroke();
  context.beginPath(); context.moveTo(575, 174); context.quadraticCurveTo(591, 180, 611, 174);
  context.strokeStyle = RED; context.lineWidth = 2.5; context.stroke();
  context.restore();
}

function schematicCard(context: Context, card: ArtCard, height: number) {
  paper(context, height, '#eeeae3', card.id);
  // Fold shadows belong to the paper and remain quiet behind the dark drafting ink.
  for (const x of [WIDTH * .34, WIDTH * .68]) {
    const crease = context.createLinearGradient(x - 8, 0, x + 9, 0);
    crease.addColorStop(0, 'rgba(112,102,91,0)'); crease.addColorStop(.43, 'rgba(112,102,91,.055)');
    crease.addColorStop(.52, 'rgba(255,253,250,.55)'); crease.addColorStop(1, 'rgba(255,253,250,0)');
    context.fillStyle = crease; context.fillRect(x - 8, 0, 17, height);
  }
  path(context, [[0, height * .56], [WIDTH, height * .56]], 'rgba(126,118,107,.08)', 1);
  context.fillStyle = MUTED; font(context, 22, 600); context.fillText('关系示意', 43, 20);
  sample(context, card, WIDTH - 40, 21, 'right');
  context.fillStyle = INK;
  const titleHeight = paragraph(context, card.title || '未命名线索', 40, 58, WIDTH - 80, 48, 59, 2, 600);
  const top = 58 + titleHeight + 18;
  const hasBody = Boolean(card.body.trim());
  diagram(context, top, Math.max(0, height - top - (hasBody ? 120 : 30)), Boolean(card.sourceTitle?.startsWith('《孤星》')));
  if (hasBody) {
    context.fillStyle = INK;
    paragraph(context, card.body, 43, height - 100, WIDTH - 86, 32, 42, 2);
  }
}

function signalCard(context: Context, card: ArtCard, height: number, index: number) {
  paper(context, height, '#e2dad4', card.id);
  context.fillStyle = '#726f67'; font(context, 22, 600);
  context.fillText(`OBS. ${String(index + 1).padStart(2, '0')} / 示意`, 39, 22);
  sample(context, card, WIDTH - 39, 22, 'right');
  context.fillStyle = '#24221f'; font(context, 48, 600);
  context.fillText(fitted(context, card.title || '未命名线索', WIDTH - 80), 39, 63);
  const top = 128, bottom = Math.max(top + 42, height - 122), center = (top + bottom) / 2;
  for (let x = 42; x <= WIDTH - 36; x += 28) path(context, [[x, top], [x, bottom]], 'rgba(100,93,85,.14)', .9);
  for (let y = top; y <= bottom; y += 25) path(context, [[38, y], [WIDTH - 37, y]], 'rgba(100,93,85,.12)', .9);
  path(context, [[38, center], [WIDTH - 38, center]], '#a2998c', 1.3);
  const amplitude = (bottom - top) * .4;
  const waveform = (offset: number, color: string, weight: number) => {
    const points = [];
    for (let step = 0; step <= 260; step++) {
      const t = step / 260;
      const envelope = .19 + .58 * Math.exp(-(((t - .39) * 8) ** 2)) + .36 * Math.exp(-(((t - .78) * 12) ** 2));
      const value = (Math.sin(t * 88 + offset) + .28 * Math.sin(t * 193 + offset)) * envelope;
      points.push([39 + t * (WIDTH - 78), center - value * amplitude]);
    }
    path(context, points, color, weight);
  };
  waveform(.6, 'rgba(128,114,97,.35)', 1.3); waveform(0, '#504b41', 3);
  const marker = WIDTH * .39;
  path(context, [[marker, top - 8], [marker, bottom + 5]], RED, 2);
  context.fillStyle = RED; context.beginPath(); context.moveTo(marker - 6, top - 12);
  context.lineTo(marker + 6, top - 12); context.lineTo(marker, top - 3); context.closePath(); context.fill();
  context.fillStyle = '#24221f';
  paragraph(context, card.body, 40, height - 100, WIDTH - 80, 32, 42, 2);
}

function sourceCard(context: Context, card: ArtCard, height: number, index: number) {
  paper(context, height, '#fffdfa', card.id);
  context.fillStyle = '#c4baae'; context.fillRect(0, 0, 65, height);
  context.save(); context.translate(23, height - 33); context.rotate(-Math.PI / 2);
  context.fillStyle = '#504b41'; font(context, 23, 600);
  context.fillText(`SOURCE  /  ${String(index + 1).padStart(2, '0')}`, 0, 0); context.restore();
  const left = 103, width = WIDTH - left - 38;
  context.fillStyle = MUTED; font(context, 22, 600); context.fillText('ARCHIVE / EXTRACT', left, 31);
  sample(context, card, WIDTH - 37, 31, 'right');
  context.fillStyle = INK;
  const titleHeight = paragraph(context, card.title || '未命名线索', left, 86, width, 48, 60,
    height < 550 ? 2 : 3, 600);
  const top = 86 + titleHeight + 30;
  const leading = 44;
  const bottom = height - (card.sourceTitle ? 95 : 44);
  const rows = Math.max(0, Math.min(12, Math.floor((bottom - top) / leading)));
  const gutter = 29, column = (width - gutter) / 2;
  font(context, 34); context.fillStyle = INK;
  const text = wrap(context, card.body, column, rows * 2);
  let split = Math.min(rows, Math.ceil(text.length / 2));
  // Keep short supplied paragraphs together where both columns can fit them.
  const paragraphs = card.body.replace(/\r/g, '').split('\n');
  if (paragraphs.length > 1 && paragraphs.every(value => value.trim())) {
    let boundary = 0, distance = Infinity;
    for (const value of paragraphs.slice(0, -1)) {
      boundary += wrap(context, value, column, rows * 2).length;
      if (boundary > 0 && boundary <= rows && text.length - boundary > 0 && text.length - boundary <= rows
        && Math.abs(text.length / 2 - boundary) < distance) {
        split = boundary; distance = Math.abs(text.length / 2 - boundary);
      }
    }
  }
  text.forEach((line, at) => {
    const second = at >= split;
    context.fillText(line, left + (second ? column + gutter : 0), top + (second ? at - split : at) * leading);
  });
  if (text.length > split && split > 0) path(context,
    [[left + column + gutter / 2, top + 4], [left + column + gutter / 2, top + split * leading - 12]], '#c7beb6', 1);
  if (card.sourceTitle) {
    context.fillStyle = MUTED; font(context, 23, 600);
    context.fillText(fitted(context, card.sourceTitle, width), left, height - 58);
  }
  // A small folded corner changes the document silhouette without ornamental facts.
  context.fillStyle = '#e2dad4'; context.beginPath(); context.moveTo(WIDTH - 34, height);
  context.lineTo(WIDTH - 34, height - 32); context.lineTo(WIDTH, height - 32); context.closePath(); context.fill();
  path(context, [[WIDTH - 34, height], [WIDTH - 34, height - 32], [WIDTH, height - 32]], '#c4baae', 1);
}

function noteCard(context: Context, card: ArtCard, height: number, index: number) {
  paper(context, height, '#f0e7df', card.id);
  context.fillStyle = MUTED; font(context, 22, 600);
  context.fillText(String(index + 1).padStart(2, '0'), 43, 24);
  sample(context, card, WIDTH - 41, 24, 'right');
  font(context, 48, 600);
  const title = wrap(context, card.title || '未命名线索', WIDTH - 89, 2);
  const top = 65;
  const titleLeading = 58;
  const highlightWidth = Math.min(380, context.measureText(title[0] || '').width + 8);
  context.fillStyle = 'rgba(203,179,151,.3)'; context.fillRect(39, top + 34, highlightWidth, 14);
  context.fillStyle = INK; title.forEach((line, at) => context.fillText(line, 43, top + at * titleLeading));
  const bodyTop = top + title.length * titleLeading + 33;
  context.fillStyle = INK;
  paragraph(context, card.body, 44, bodyTop, WIDTH - 88, 34, 45,
    Math.max(0, Math.min(8, Math.floor((height - 50 - bodyTop) / 45))));
  context.beginPath(); context.moveTo(42, top + title.length * titleLeading + 4);
  context.bezierCurveTo(105, top + title.length * titleLeading, 191, top + title.length * titleLeading + 8,
    Math.min(230, 43 + highlightWidth), top + title.length * titleLeading + 2);
  context.strokeStyle = RED; context.lineWidth = 2.4; context.stroke();
  // A faint crease and a short rough edge are paper details, not another footer.
  path(context, [[16, 0], [22, height]], 'rgba(112,102,91,.07)', 1);
  path(context, [[WIDTH - 30, height - 5], [WIDTH - 23, height - 9], [WIDTH - 17, height - 5]], 'rgba(112,102,91,.17)', 1.3);
}

function questionCard(context: Context, card: ArtCard, height: number) {
  paper(context, height, '#e4d5c1', card.id);
  const glue = context.createLinearGradient(0, 0, 0, 39);
  glue.addColorStop(0, 'rgba(166,125,72,.09)'); glue.addColorStop(1, 'rgba(166,125,72,0)');
  context.fillStyle = glue; context.fillRect(0, 0, WIDTH, 39);
  context.fillStyle = RED; font(context, 34, 600); context.fillText('?', WIDTH - 66, 21);
  context.fillStyle = '#24221f';
  const titleRows = height < 400 ? 1 : height < 560 ? 2 : 3;
  const titleHeight = paragraph(context, card.title || '未命名线索', 45, 66, WIDTH - 103, 48, 60, titleRows, 600);
  const bodyTop = 66 + titleHeight + 26;
  paragraph(context, card.body, 47, bodyTop, WIDTH - 99, 34, 45,
    Math.max(0, Math.min(3, Math.floor((height - 51 - bodyTop) / 45))));
  sample(context, card, 45, height - 34);
}

function compactCard(context: Context, card: ArtCard, height: number, index: number) {
  const question = card.kind === 'question';
  paper(context, height, question ? '#e4d5c1' : '#f0e7df', card.id);
  context.fillStyle = MUTED; font(context, 20, 600);
  context.fillText(`${question ? 'QUESTION' : 'OBSERVATION'} / ${String(index + 1).padStart(2, '0')}`, 43, 22);
  if (question) { context.fillStyle = RED; font(context, 30, 600); context.fillText('?', WIDTH - 59, 19); }
  context.fillStyle = INK;
  const titleHeight = paragraph(context, card.title || '未命名线索', 43, 67, WIDTH - 87, 48, 59, 2, 600);
  const bodyTop = 67 + titleHeight + 21, footer = card.sourceTitle ? 57 : 29;
  paragraph(context, card.body, 44, bodyTop, WIDTH - 88, 33, 43,
    Math.max(0, Math.min(3, Math.floor((height - footer - bodyTop) / 43))));
  if (card.sourceTitle) {
    context.fillStyle = MUTED; font(context, 19);
    context.fillText(fitted(context, card.sourceTitle, WIDTH - 88), 44, height - 36);
  }
  path(context, [[42, 55], [WIDTH - 42, 55]], 'rgba(126,118,107,.15)', 1);
}

function tagCard(context: Context, card: ArtCard, height: number) {
  paper(context, height, '#eee8dd', card.id);
  context.fillStyle = '#c4b297'; context.fillRect(0, 0, 9, height);
  context.fillStyle = INK; font(context, 62, 600);
  context.fillText(fitted(context, card.title || '关键词', WIDTH - 118), 78, (height - 66) / 2);
  // Labels deliberately show only their title; full content remains in the editor.
}

/** A board exposes one takeaway; the drawer retains the original title and complete text. */
function takeaway(value: string) {
  const text=value.replace(/\s+/g,' ').trim(), sentence=text.match(/^.{12,}?[。！？](?:[”」』])?/u)?.[0];
  return sentence && sentence.length < text.length ? sentence : text;
}
function boardHeading(context:Context, title:string, x:number, y:number, width:number, rows:number, size=55) {
  let fittedSize=size;
  while(fittedSize>44){font(context,fittedSize,550);if(wrap(context,title,width,20).length<=rows)break;fittedSize-=2;}
  context.fillStyle=INK;
  return paragraph(context,title,x,y,width,fittedSize,fittedSize*1.25,rows,550);
}
function investigationCard(context: Context, card: ArtCard, height: number) {
  const kind=card.clueKind!, report=kind==='report';
  const appearance = evidenceCardAppearance(card);
  const accent=appearance.accent, left=report?66:44, right=report?66:44;
  paper(context,height,appearance.paper,card.id);
  context.fillStyle=accent;
  // Real differences in document format: source slips, observation cards, labels and taped questions.
  if(report){
    context.fillStyle='#d6ddc9';context.fillRect(0,0,15,height);
    path(context,[[27,0],[27,height]],'#d5d8c7',1);
    context.fillStyle=accent;context.fillRect(left,37,86,4);
    font(context,22,500);context.fillText('RESEARCH REPORT',left,60);
    context.textAlign='right';font(context,20);context.fillText(card.evidenceLabel?.replace('REPORT / ','')||'IN PROGRESS',WIDTH-right,62);context.textAlign='left';
  }else if(kind==='excerpt'){
    context.fillStyle='#e0e5d9';context.fillRect(0,0,17,height);
    path(context,[[left,73],[WIDTH-right,73]],'#bcc5b6',1.5);
  }else if(kind==='finding'){
    context.fillRect(0,0,WIDTH,8);context.fillRect(left,78,38,4);
  }else if(kind==='time'){
    context.fillStyle='#ded1b9';context.fillRect(0,0,18,height);
    circle(context,WIDTH-67,43,14,accent,2);path(context,[[WIDTH-67,34],[WIDTH-67,43],[WIDTH-59,48]],accent,2);
  }else if(kind==='relation'){
    path(context,[[WIDTH-163,44],[WIDTH-74,44]],accent,2);
    for(const x of [WIDTH-163,WIDTH-74]){circle(context,x,44,10,accent,2);}
  }else if(kind==='question'){
    const glue=context.createLinearGradient(0,0,0,75);glue.addColorStop(0,'#cdbc9866');glue.addColorStop(1,'#cdbc9800');
    context.fillStyle=glue;context.fillRect(0,0,WIDTH,75);context.fillStyle=accent;context.globalAlpha=.16;
    font(context,142,300);context.fillText('?',WIDTH-143,69);context.globalAlpha=1;
  }else if(kind==='contrast'){
    context.fillStyle='#aa9081';context.fillRect(0,0,WIDTH/2,7);context.fillStyle='#849380';context.fillRect(WIDTH/2,0,WIDTH/2,7);
    path(context,[[left,79],[WIDTH-right,79]],'#c8bbae',1);
  }
  if(!report){
    context.fillStyle=accent;font(context,23,500);context.fillText(appearance.name,left,32);
    if(kind!=='time'&&kind!=='relation'){context.textAlign='right';font(context,22);context.fillText(card.id,WIDTH-right,34);context.textAlign='left';}
  }
  const titleY=report?116:kind==='question'?104:kind==='finding'?107:kind==='time'?84:98;
  const titleWidth=WIDTH-left-right-(kind==='question'?30:0);
  const used=boardHeading(context,card.title,left,titleY,titleWidth,report||kind==='question'||kind==='finding'?3:2,report?55:54);
  const bodyTop=titleY+used+(report?26:22), footerTop=height-(report?101:80);
  const leading=report?42:40;
  const bodyRows=Math.max(0,Math.min(kind==='time'||kind==='relation'?1:2,Math.floor((footerTop-bodyTop)/leading)));
  context.fillStyle=MUTED;
  paragraph(context,takeaway(card.summary||card.body),left,bodyTop,WIDTH-left-right,report?31:32,leading,bodyRows);
  const footerY=height-49;
  path(context,[[left,height-69],[WIDTH-right,height-69]],report?'#b5bea6':'#a7ad993f',1);
  context.fillStyle=accent;font(context,report?21:23,500);
  if(report){
    context.fillText('打开调查报告',left,footerY);context.textAlign='right';font(context,20);
    context.fillText(card.sourceLabel||'',WIDTH-right-40,footerY+1);font(context,36);context.fillText('↗',WIDTH-right,footerY-10);context.textAlign='left';
  }else{
    context.fillText(fitted(context,card.sourceLabel||card.id,350),left,footerY);
    context.textAlign='right';font(context,22);context.fillText(card.evidenceLabel||'待核验',WIDTH-right,footerY);context.textAlign='left';
  }
}

/** Draw one card at its supplied resolution; no scene, network or animation state. */
export function drawEvidenceCard(canvas: HTMLCanvasElement, card: EvidenceCard, index: number, photo?: CanvasImageSource): void {
  const context = canvas.getContext('2d');
  if (!context || canvas.width < 1 || canvas.height < 1) return;
  const height = canvas.height / canvas.width * WIDTH;
  const art = card as ArtCard;
  context.save();
  try {
    context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, canvas.width, canvas.height);
    context.scale(canvas.width / WIDTH, canvas.width / WIDTH);
    context.globalAlpha = 1; context.globalCompositeOperation = 'source-over';
    context.filter = 'none'; context.shadowColor = 'transparent'; context.shadowBlur = 0;
    context.shadowOffsetX = 0; context.shadowOffsetY = 0;
    context.textAlign = 'left'; context.textBaseline = 'top'; context.lineCap = 'round'; context.lineJoin = 'round'; context.setLineDash([]);
    context.beginPath(); context.rect(0, 0, WIDTH, height); context.clip();
    if (art.clueKind) investigationCard(context, art, height);
    else if (art.presentation === 'tag') tagCard(context, art, height);
    else if (art.presentation === 'compact') compactCard(context, art, height, index);
    else if (art.visual === 'observatory' && photo && photoCard(context, art, height, photo)) return;
    else if (art.visual === 'schematic') schematicCard(context, art, height);
    else if (art.visual === 'signal') signalCard(context, art, height, index);
    else if (art.kind === 'source' || art.visual === 'observatory') sourceCard(context, art, height, index);
    else if (art.kind === 'question') questionCard(context, art, height);
    else noteCard(context, art, height, index);
  } finally {
    context.restore();
  }
}
