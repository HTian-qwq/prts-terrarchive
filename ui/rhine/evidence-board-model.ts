export type EvidenceTemplate = 'note' | 'question' | 'source' | 'tag';
export type EvidenceBoardTool = { mode: 'select' }
  | { mode: 'place'; template: EvidenceTemplate }
  | { mode: 'connect'; fromId?: string };

export type EvidenceCard = {
  id: string;
  title: string;
  body: string;
  stage: 0 | 1 | 2;
  kind: 'note' | 'source' | 'question';
  sourceTitle?: string;
  sourceId?: string;
  position?: { x: number; y: number };
  rotation?: number;
  scale?: number;
  links?: string[];
  visual?: 'observatory' | 'schematic' | 'signal';
  presentation?: 'compact' | 'tag';
};

export const EVIDENCE_STAGES = ['线索收集', '交叉核验', '阶段结论'] as const;
export const EVIDENCE_CARD_CAPACITY = 12;
export const EVIDENCE_TITLE_LIMIT = 120;
export const EVIDENCE_BODY_LIMIT = 4000;
export const EVIDENCE_STORAGE_LIMIT = 100000;
export const EVIDENCE_WRITING_BOUNDS = { left: -7.55, right: 7.55, bottom: -3.82, top: 3.9 } as const;
export const EVIDENCE_SCALE_MIN = 0.5;
export const EVIDENCE_SCALE_MAX = 2;

/** Do not coerce browser storage or form values into scene dimensions. */
export function normalizeEvidenceScale(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(EVIDENCE_SCALE_MIN, Math.min(EVIDENCE_SCALE_MAX, value)) : 1;
}

export function evidenceStorageKey(sessionId: string) {
  return `prts-rhine-evidence-board:v1:${encodeURIComponent(sessionId || 'default')}`;
}

export function createEvidenceId() {
  return `card:${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

/** Creating a template never stores a card; placement is confirmed by the caller. */
export function createEvidenceTemplate(template: EvidenceTemplate): EvidenceCard {
  const titles = { note: '新的观察', question: '待解的问题', source: '资料摘录', tag: '关键词' };
  return { id: createEvidenceId(), title: titles[template], body: '', stage: 0,
    kind: template === 'tag' ? 'note' : template, rotation: 0,
    ...(template === 'tag' ? { presentation: 'tag' as const }
      : template === 'source' ? {} : { presentation: 'compact' as const }) };
}

const POSITIONS = [
  [0, 2.5, -2], [-5.35, 2.15, 7], [5.25, 2.25, -6], [-2.8, -0.1, -4],
  [2.6, -0.35, 5], [-5.1, -2.2, -5], [-0.05, -2.2, 3], [5.1, -2.2, -4],
  [-2.7, 2.95, 2], [2.85, 2.95, -3], [-6, -0.35, 3], [6, -0.35, -2],
];

function basePaperSize(card: EvidenceCard) {
  const [width, height] = card.presentation === 'tag' ? [3, 0.7]
    : card.presentation === 'compact' ? card.kind === 'question' ? [3.25, 1.55] : [3.35, 1.7]
    : card.visual === 'observatory' ? [4.6, 3.25]
    : card.visual === 'schematic' ? [5.35, 3.65] : card.visual === 'signal' ? [4.2, 1.95]
    : card.kind === 'source' ? [3.4, 3.8] : card.kind === 'question' ? [3.8, 1.7] : [3.5, 2.25];
  return { width: width * 0.8, height: height * 0.8 };
}

/** The rotated sheet must fit on the writing surface even at maximum size. */
export function evidenceCardScale(card: EvidenceCard, index = 0): number {
  const { width, height } = basePaperSize(card);
  const rotation = card.rotation ?? POSITIONS[index % POSITIONS.length][2];
  const angle = rotation * Math.PI / 180;
  const cosine = Math.abs(Math.cos(angle)), sine = Math.abs(Math.sin(angle));
  const availableWidth = EVIDENCE_WRITING_BOUNDS.right - EVIDENCE_WRITING_BOUNDS.left;
  const availableHeight = EVIDENCE_WRITING_BOUNDS.top - EVIDENCE_WRITING_BOUNDS.bottom;
  return Math.min(normalizeEvidenceScale(card.scale),
    availableWidth / (width * cosine + height * sine),
    availableHeight / (width * sine + height * cosine));
}

export function evidenceCardLayout(card: EvidenceCard, index: number) {
  const [x, y, rotation] = POSITIONS[index % POSITIONS.length];
  const { width, height } = basePaperSize(card), scale = evidenceCardScale(card, index);
  const layout = { x: card.position?.x ?? x, y: card.position?.y ?? y,
    rotation: card.rotation ?? rotation, width: width * scale, height: height * scale, scale };
  return { ...layout, ...clampPaperPosition(layout, layout.x, layout.y) };
}

function clampPaperPosition(layout: { rotation: number; width: number; height: number }, x: number, y: number) {
  const angle = layout.rotation * Math.PI / 180;
  const halfWidth = (Math.abs(Math.cos(angle)) * layout.width + Math.abs(Math.sin(angle)) * layout.height) / 2;
  const halfHeight = (Math.abs(Math.sin(angle)) * layout.width + Math.abs(Math.cos(angle)) * layout.height) / 2;
  return { x: Math.max(EVIDENCE_WRITING_BOUNDS.left + halfWidth, Math.min(EVIDENCE_WRITING_BOUNDS.right - halfWidth, x)),
    y: Math.max(EVIDENCE_WRITING_BOUNDS.bottom + halfHeight, Math.min(EVIDENCE_WRITING_BOUNDS.top - halfHeight, y)) };
}

/** Keep all four paper corners inside the usable writing surface. */
export function clampEvidencePosition(card: EvidenceCard, index: number, x: number, y: number) {
  return clampPaperPosition(evidenceCardLayout(card, index), x, y);
}

/** Browser storage is untrusted; accept only bounded cards that fit the board. */
export function parseEvidenceCards(value: unknown): EvidenceCard[] {
  if (!Array.isArray(value)) return [];
  const cards: EvidenceCard[] = [], ids = new Set<string>();
  for (const raw of value.slice(0, 64)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const card = raw as Record<string, unknown>;
    if (typeof card.id !== 'string' || !card.id || card.id.length > 128 || ids.has(card.id)
      || typeof card.title !== 'string' || !card.title.trim() || typeof card.body !== 'string'
      || card.stage !== 0 && card.stage !== 1 && card.stage !== 2
      || card.kind !== 'note' && card.kind !== 'source' && card.kind !== 'question') continue;
    cards.push({ id: card.id, title: card.title.trim().slice(0, EVIDENCE_TITLE_LIMIT),
      body: card.body.slice(0, EVIDENCE_BODY_LIMIT), stage: card.stage, kind: card.kind,
      ...(card.visual === 'observatory' || card.visual === 'schematic' || card.visual === 'signal'
        ? { visual: card.visual as EvidenceCard['visual'] } : {}),
      ...(card.presentation === 'compact' || card.presentation === 'tag'
        ? { presentation: card.presentation } : {}),
      ...(typeof card.sourceTitle === 'string' && card.sourceTitle.trim()
        ? { sourceTitle: card.sourceTitle.trim().slice(0, 512) } : {}),
      ...(typeof card.sourceId === 'string' && card.sourceId
        ? { sourceId: card.sourceId.slice(0, 1024) } : {}),
      ...(typeof card.rotation === 'number' && Number.isFinite(card.rotation)
        ? { rotation: Math.max(-15, Math.min(15, card.rotation)) } : {}),
      ...(typeof card.scale === 'number' && Number.isFinite(card.scale)
        ? { scale: normalizeEvidenceScale(card.scale) } : {}),
      ...(Array.isArray(card.links) ? { links: [...new Set(card.links.slice(0, 64).filter((id): id is string =>
        typeof id === 'string' && id.length > 0 && id.length <= 128 && id !== card.id))] } : {}),
    });
    const position = card.position as { x?: unknown; y?: unknown } | undefined;
    if (position && typeof position.x === 'number' && Number.isFinite(position.x)
      && typeof position.y === 'number' && Number.isFinite(position.y)) {
      cards[cards.length - 1].position = clampEvidencePosition(cards[cards.length - 1], cards.length - 1, position.x, position.y);
    }
    ids.add(card.id);
    if (cards.length === EVIDENCE_CARD_CAPACITY) break;
  }
  return cards.map(card => card.links ? { ...card, links: card.links.filter(id => ids.has(id)).slice(0, EVIDENCE_CARD_CAPACITY - 1) } : card);
}

export function isPreviewCard(card: EvidenceCard) {
  return card.id.startsWith('preview:');
}

/** Reviewed story paraphrases for the scene preview, not Agent research records.
 * Corpus revision: e501261a50770f281a1cab5ed5a57d97c0d36ce73f7da768b27f592516117d33.
 * Sources: CW-10 before L70–89 / L94–118; CW-ST-4 L81–92 / L109–110 / L136–159;
 * CW-8 after L129–148; CW-7 before L158–167 and after L53. */
export function createPreviewCards(): EvidenceCard[] {
  return [
    { id: 'preview:question', title: '星荚之外有什么', stage: 0, kind: 'question',
      body: '克丽斯腾不愿止步于天空。阻隔层之外，泰拉又身处何方？',
      sourceTitle: '《孤星》CW-10 行动前 · 研究提问', position: { x: -0.35, y: 2.65 }, rotation: -3,
      links: ['preview:collect', 'preview:connect'] },
    { id: 'preview:collect', title: '克丽斯腾的群星', stage: 0, kind: 'source', visual: 'observatory',
      body: '万星园越过星荚。克丽斯腾留下观测记录，在群星之间准备进入休眠。',
      sourceTitle: '《孤星》CW-ST-4 · 剧情改写', position: { x: -4.7, y: 1 }, rotation: 4,
      links: ['preview:another'] },
    { id: 'preview:verify', title: '保存者最后的选择', stage: 1, kind: 'source',
      body: '保存者亲手关闭旧计划，将最后的能源交给克丽斯腾。\n他选择让年轻的文明迈出下一步。',
      sourceTitle: '《孤星》CW-8 行动后 · 剧情改写', position: { x: 4.65, y: 0.95 }, rotation: -3,
      links: ['preview:connect', 'preview:conclude'] },
    { id: 'preview:connect', title: '万星园的真正航向', stage: 0, kind: 'source', visual: 'schematic',
      body: '弧光一号是对军方的幌子。万星园的目标，在星荚之外。',
      sourceTitle: '《孤星》CW-10 行动前 · 剧情改写', position: { x: -0.05, y: -0.25 }, rotation: -2.2,
      links: ['preview:another', 'preview:conclude'] },
    { id: 'preview:another', title: '无法停止的蓄能', stage: 1, kind: 'note', visual: 'signal',
      body: '能量井读数持续升高，军方无法关闭。聚焦发生器已抵达上空。',
      sourceTitle: '《孤星》CW-7 行动前后 · 剧情改写', position: { x: -4.1, y: -2.05 }, rotation: -5 },
    { id: 'preview:conclude', title: '科学应当看向谁', stage: 2, kind: 'question',
      body: '赫默发起《特里蒙科学伦理联合宣言》。飞向天空，也要回应留在大地上的人。',
      sourceTitle: '《孤星》CW-ST-4 · 剧情改写', position: { x: 4.05, y: -2.15 }, rotation: 5 },
  ];
}
