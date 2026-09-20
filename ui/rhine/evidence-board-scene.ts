import * as THREE from 'three';
import { clampEvidencePosition, evidenceCardLayout, EVIDENCE_CARD_CAPACITY, EVIDENCE_WRITING_BOUNDS,
  isPreviewCard, type EvidenceCard, type EvidenceTemplate } from './evidence-board-model';
import { drawEvidenceCard } from './evidence-card-art';
import { ARCHIVE_LABEL_LAYER } from './original/label-renderer';
import observatoryUrl from './assets/evidence-observatory.webp';

/** Local XY whiteboard, front +Z. Raised panel; feet meet the shared floor. */
const WIDTH = 16.2, HEIGHT = 9.4, SURFACE_Z = 0.163, PAPER_Z = 0.235, PRINT_Z = 0.042;
const INK = '#252724';
const PAPER_COLORS = { note: '#eee8dd', source: '#fffdfa', question: '#e4d5c1' } as const;
type CardVisual = {
  card: EvidenceCard; index: number; layout: ReturnType<typeof evidenceCardLayout>;
  group: THREE.Group; paper: THREE.Mesh;
  print: THREE.Mesh<THREE.ShapeGeometry, THREE.MeshBasicMaterial>;
  printBacking: THREE.Mesh<THREE.ShapeGeometry, THREE.MeshBasicMaterial>;
  highlight: THREE.LineSegments; resizeHandle: THREE.Group; shadow: THREE.Mesh; backing: THREE.Mesh; tape: THREE.Mesh;
  pin: THREE.Group; texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement; signature: string; arrival?: number;
};

/** Pinned papers and explicit strings in the existing scene, without a render loop. */
export function createEvidenceBoard(createPrintMaterial: (texture: THREE.Texture) => THREE.MeshBasicMaterial, options: { interactiveHeading?: boolean } = {}) {
  const group = new THREE.Group(); group.name = 'Rhine_Evidence_Board';
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  const cards = new Map<string, CardVisual>();
  const strings = new THREE.Group(); strings.name = 'Evidence_Red_Strings';
  const toolMeshes: THREE.Object3D[] = [], toolHits: THREE.Intersection[] = [];
  const toolAnchors = { corner: new THREE.Vector3(7.15, 4.055, 0.22), chalk: new THREE.Vector3(-3.8, -4.20, 0.48) };
  let selectedId: string | null = null;
  let resizeEnabled = true;
  let disposed = false, receivedCards = 0, cardTextureUpdates = 0, linkRebuilds = 0, linkSignature = '';
  const ownGeometry = <T extends THREE.BufferGeometry>(value: T): T => { geometries.add(value); return value; };
  const ownMaterial = <T extends THREE.Material>(value: T): T => { materials.add(value); return value; };
  const standard = (color: string, roughness = 0.76, metalness = 0) => ownMaterial(
    new THREE.MeshStandardMaterial({ color, roughness, metalness, fog: false }),
  );
  const metal = standard('#c4baae', 0.36, 0.45), white = standard('#eae5dc', 0.86);
  const shell = standard('#f0e7df', 0.43, 0.07);
  const brass = standard('#b9a796', 0.43, 0.45), charcoal = standard('#8d8880', 0.76);
  const redPin = standard('#a55e51', 0.38, 0.12), redString = standard('#97594f', 0.92);
  const paperMaterials = { note: standard(PAPER_COLORS.note, 0.97),
    source: standard(PAPER_COLORS.source, 0.97), question: standard(PAPER_COLORS.question, 0.97) };
  const cube = ownGeometry(new THREE.BoxGeometry(1, 1, 1));
  const sheetPlane = ownGeometry(new THREE.PlaneGeometry(1, 1));
  const pinHead = ownGeometry(new THREE.SphereGeometry(0.077, 16, 10));
  const pinStem = ownGeometry(new THREE.CylinderGeometry(0.014, 0.014, 0.11, 8));
  const pinWasher = ownGeometry(new THREE.CylinderGeometry(0.047, 0.047, 0.022, 12));
  const box = (parent: THREE.Group, size: [number, number, number],
    position: [number, number, number], material: THREE.Material, shadow = false) => {
    const mesh = new THREE.Mesh(cube, material); mesh.scale.set(...size); mesh.position.set(...position);
    mesh.castShadow = shadow; mesh.receiveShadow = true; parent.add(mesh); return mesh;
  };
  const canvas = (width: number, height: number) => {
    const value = document.createElement('canvas'); value.width = width; value.height = height;
    const context = value.getContext('2d');
    if (!context) throw new Error('证据板文字画布不可用。');
    context.textBaseline = 'top'; return { canvas: value, context };
  };
  const textureFor = (sheet: HTMLCanvasElement) => {
    const texture = new THREE.CanvasTexture(sheet); texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4; textures.add(texture); return texture;
  };
  // Reuse the existing sharp label pass. Paper solids still supply scene depth,
  // so pins, strings and overlapping sheets correctly occlude the print.
  const printed = (texture: THREE.CanvasTexture) => ownMaterial(createPrintMaterial(texture));
  const font = (context: CanvasRenderingContext2D, size: number, weight = 400) => {
    context.font = `${weight} ${size}px MiSans, sans-serif`;
  };
  // A purpose-built research fixture: enamel, recessed trim and machined corner blocks.
  const frameShape = new THREE.Shape();
  frameShape.moveTo(-8.1, -4.45); frameShape.lineTo(-7.86, -4.7);
  frameShape.lineTo(7.86, -4.7); frameShape.lineTo(8.1, -4.45);
  frameShape.lineTo(8.1, 4.45); frameShape.lineTo(7.86, 4.7);
  frameShape.lineTo(-7.86, 4.7); frameShape.lineTo(-8.1, 4.45); frameShape.closePath();
  const chassis = new THREE.Mesh(ownGeometry(new THREE.ExtrudeGeometry(frameShape,
    { depth: 0.18, bevelEnabled: true, bevelSegments: 1, bevelSize: 0.035, bevelThickness: 0.035 })), shell);
  chassis.position.z = -0.23; chassis.castShadow = true; group.add(chassis);
  box(group, [15.99, 9.13, 0.10], [0, 0, 0.077], metal);
  box(group, [15.76, 8.87, 0.053], [0, -0.03, 0.137], white);
  const corner = standard('#e2dad4', 0.39, 0.45);
  for (const x of [-7.87, 7.87]) for (const y of [-4.38, 4.38]) {
    box(group, [0.31, 0.41, 0.1], [x, y, 0.145], corner);
    const screw = new THREE.Mesh(pinWasher, charcoal); screw.rotation.x = Math.PI / 2;
    screw.position.set(x, y, 0.204); group.add(screw);
  }
  // The same warm printed label and champagne hardware as the original cassettes.
  const plate = canvas(1536, 108), context = plate.context;
  context.fillStyle = '#e4ddd3'; context.fillRect(0, 0, 1536, 108);
  if (!options.interactiveHeading) {
    context.fillStyle = '#35312c'; font(context, 37, 600); context.fillText('RHINE LAB', 35, 20);
    font(context, 20); context.fillStyle = '#817567'; context.fillText('RESEARCH / 调查与证据', 37, 70);
    context.textAlign = 'right'; font(context, 20, 600); context.fillText('EVIDENCE / LIVE', 1500, 28);
    font(context, 15); context.fillText('RESEARCH SYSTEMS · PRTS', 1500, 72);
  }
  // The interactive heading is projected onto this physical nameplate by the workbench.
  const plateMesh = new THREE.Mesh(ownGeometry(new THREE.PlaneGeometry(options.interactiveHeading ? 10.8 : 7.9, 0.556)), printed(textureFor(plate.canvas)));
  plateMesh.layers.set(ARCHIVE_LABEL_LAYER);
  plateMesh.position.set(options.interactiveHeading ? -2.05 : -3.5, 4.055, 0.18); group.add(plateMesh);
  // Fine measurement ticks occupy the rim, never turn the writing surface into a table.
  const ticks: number[] = [];
  for (let i = 0; i < 76; i++) {
    const x = -7.5 + i * 0.2; ticks.push(x, -4.15, 0.175, x, -4.15 + (i % 5 === 0 ? 0.10 : 0.04), 0.175);
  }
  const tickGeometry = ownGeometry(new THREE.BufferGeometry());
  tickGeometry.setAttribute('position', new THREE.Float32BufferAttribute(ticks, 3));
  group.add(new THREE.LineSegments(tickGeometry, ownMaterial(new THREE.LineBasicMaterial({ color: '#9d9185', transparent: true, opacity: 0.42, fog: false }))));
  for (const x of [-5.7, 5.7]) {
    box(group, [0.42, 4.735, 0.46], [x, -6.8675, -0.26], shell, true);
    box(group, [0.20, 4.46, 0.06], [x, -6.88, 0.015], metal);
    box(group, [1.75, 0.15, 1.6], [x, -9.31, -0.22], metal, true);
    box(group, [1.55, 0.05, 1.42], [x, -9.405, -0.22], charcoal);
  }
  box(group, [15.34, 0.10, 0.62], [0, -4.39, 0.43], shell, true);
  box(group, [15.34, 0.10, 0.055], [0, -4.37, 0.75], metal);
  box(group, [1.0, 0.12, 0.36], [5.7, -4.28, 0.46], charcoal, true);
  box(group, [0.89, 0.10, 0.34], [5.7, -4.17, 0.46], corner);
  // A small paper carton rests on the pen ledge. Short chalk sticks lie across its
  // depth, rather than reading as full-width marker pens. Every solid is pickable.
  const chalkBox = new THREE.Group(); chalkBox.name = 'Evidence_Chalk_Box';
  chalkBox.position.copy(toolAnchors.chalk); group.add(chalkBox);
  const carton = standard('#e5dccd', 0.98), cartonInside = standard('#d0c3ae', 1);
  const chalkWhite = standard('#f5f0e8', 1), chalkRed = standard('#b27969', 1);
  toolMeshes.push(box(chalkBox, [1.02, 0.022, 0.48], [0, -0.127, 0], cartonInside, true));
  for (const x of [-0.497, 0.497]) toolMeshes.push(box(chalkBox, [0.026, 0.11, 0.48], [x, -0.072, 0], carton, true));
  toolMeshes.push(box(chalkBox, [0.97, 0.15, 0.026], [0, -0.05, -0.227], carton, true));
  toolMeshes.push(box(chalkBox, [0.97, 0.075, 0.026], [0, -0.087, 0.227], carton, true));
  const chalkGeometry = ownGeometry(new THREE.CylinderGeometry(0.047, 0.049, 1, 10));
  const chalkPieces = [
    { x: -0.285, z: 0.012, length: 0.42, angle: -0.025, red: false },
    { x: -0.142, z: 0.006, length: 0.45, angle: 0.025, red: false },
    { x: 0, z: 0.024, length: 0.40, angle: -0.012, red: true },
    { x: 0.144, z: -0.003, length: 0.43, angle: 0.035, red: false },
    { x: 0.286, z: 0.015, length: 0.41, angle: -0.02, red: false },
  ];
  for (const piece of chalkPieces) {
    const chalk = new THREE.Mesh(chalkGeometry, piece.red ? chalkRed : chalkWhite);
    chalk.rotation.set(Math.PI / 2, 0, piece.angle); chalk.scale.y = piece.length;
    chalk.position.set(piece.x, -0.06, piece.z);
    chalk.castShadow = true; chalkBox.add(chalk); toolMeshes.push(chalk);
  }
  const chalkLid = new THREE.Group(); chalkLid.name = 'Evidence_Chalk_Lid';
  chalkLid.position.set(0, -0.05, -0.231); chalkLid.rotation.x = 0.4; chalkBox.add(chalkLid);
  toolMeshes.push(box(chalkLid, [1.02, 0.42, 0.018], [0, 0.21, 0], carton, true));
  const toolsLabel = canvas(512, 210);
  toolsLabel.context.fillStyle = '#e5dccd'; toolsLabel.context.fillRect(0, 0, 512, 210);
  toolsLabel.context.fillStyle = '#706657'; font(toolsLabel.context, 58, 600);
  toolsLabel.context.textAlign = 'center'; toolsLabel.context.fillText('RHINE', 256, 40);
  font(toolsLabel.context, 27, 500); toolsLabel.context.fillText('CHALK  /  05', 256, 119);
  toolsLabel.context.fillStyle = '#aa7869'; toolsLabel.context.fillRect(211, 169, 90, 3);
  const toolsPrint = new THREE.Mesh(ownGeometry(new THREE.PlaneGeometry(0.96, 0.394)), printed(textureFor(toolsLabel.canvas)));
  toolsPrint.name = 'Evidence_Chalk_Label'; toolsPrint.layers.set(ARCHIVE_LABEL_LAYER);
  toolsPrint.position.set(0, 0.21, 0.010); chalkLid.add(toolsPrint);
  const shadowCanvas = canvas(128, 128), shadowContext = shadowCanvas.context;
  for (let inset = 0; inset < 12; inset++) {
    shadowContext.fillStyle = `rgba(47,41,34,${0.013 + inset * 0.001})`;
    shadowContext.fillRect(inset + 1, inset + 1, 126 - inset * 2, 126 - inset * 2);
  }
  const shadowMaterial = ownMaterial(new THREE.MeshBasicMaterial({ map: textureFor(shadowCanvas.canvas),
    transparent: true, depthWrite: false, toneMapped: false, fog: false }));
  const tapeCanvas = canvas(256, 64), tapeContext = tapeCanvas.context;
  tapeContext.fillStyle = '#dfd4bf'; tapeContext.fillRect(0, 0, 256, 64);
  tapeContext.strokeStyle = '#c7bba8'; tapeContext.lineWidth = 1;
  for (let i = 5; i < 256; i += 7) { tapeContext.beginPath(); tapeContext.moveTo(i, 0); tapeContext.lineTo(i + 4, 64); tapeContext.stroke(); }
  const tapeMaterial = printed(textureFor(tapeCanvas.canvas)); tapeMaterial.opacity = 0.74;
  const cornerVertices: number[] = [];
  for (const x of [-0.515, 0.515]) for (const y of [-0.515, 0.515]) {
    cornerVertices.push(x, y - Math.sign(y) * 0.06, 0, x, y, 0, x, y, 0, x - Math.sign(x) * 0.055, y, 0);
  }
  const selectionGeometry = ownGeometry(new THREE.BufferGeometry());
  selectionGeometry.setAttribute('position', new THREE.Float32BufferAttribute(cornerVertices, 3));
  const selectionMaterial = ownMaterial(new THREE.LineBasicMaterial({ color: '#967b59', fog: false }));
  const resizeGeometry = ownGeometry(new THREE.BufferGeometry());
  resizeGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.085, 0.085, 0, 0.085, 0.085, 0, 0.085, 0.085, 0, 0.085, -0.085, 0,
    0.085, -0.085, 0, -0.085, -0.085, 0, -0.085, -0.085, 0, -0.085, 0.085, 0,
    -0.045, -0.04, 0, 0.04, 0.045, 0,
  ], 3));
  const resizeFill = ownMaterial(new THREE.MeshBasicMaterial({ color: '#f0e8db', fog: false, toneMapped: false }));
  const photo = new Image(); let photoReady = false;
  photo.onload = () => {
    if (disposed) return;
    photoReady = true;
    for (const visual of cards.values()) if (visual.card.visual === 'observatory') redraw(visual);
  };
  photo.src = observatoryUrl;

  const shapes = (['note', 'source', 'question', 'plain', 'tag'] as const).map(kind => {
    const shape = new THREE.Shape();
    if(kind==='tag'){
      shape.moveTo(-.44,-.5);shape.lineTo(.44,-.5);shape.lineTo(.5,-.33);shape.lineTo(.5,.33);
      shape.lineTo(.44,.5);shape.lineTo(-.44,.5);shape.lineTo(-.5,.33);shape.lineTo(-.5,-.33);shape.closePath();
    }else{
    shape.moveTo(-0.5, -0.5);
    if (kind === 'note') { shape.lineTo(0.43, -0.5); shape.lineTo(0.5, -0.43); }
    else shape.lineTo(0.5, -0.5);
    if (kind === 'source') { shape.lineTo(0.5, 0.415); shape.lineTo(0.42, 0.5); }
    else shape.lineTo(0.5, 0.5);
    shape.lineTo(-0.5, 0.5); shape.closePath();
    }
    const print = ownGeometry(new THREE.ShapeGeometry(shape));
    const uv = print.getAttribute('uv');
    for (let index = 0; index < uv.count; index++) uv.setXY(index, uv.getX(index) + 0.5, uv.getY(index) + 0.5);
    const paper = ownGeometry(new THREE.ExtrudeGeometry(shape, { depth: 0.04, bevelEnabled: false, steps: 1, curveSegments: 1 }));
    return [kind, { print, paper }] as const;
  });
  const paperShapes = Object.fromEntries(shapes) as Record<EvidenceCard['kind'] | 'plain' | 'tag', typeof shapes[number][1]>;
  const shapeFor=(card:EvidenceCard)=>paperShapes[card.clueKind==='report'||card.clueKind==='excerpt'||card.clueKind==='contrast'?'plain'
    :card.clueKind==='time'?'tag':card.clueKind==='question'||card.clueKind==='relation'?'source':card.kind];
  group.add(strings);

  // Both previews are created once. Pointer motion only changes transforms/buffer values.
  let placementTemplate: EvidenceTemplate | null = null, connectionFrom: string | null = null;
  let placementUpdates = 0, connectionUpdates = 0;
  let placementWidth = 0, placementHeight = 0;
  const placementMaterial = ownMaterial(new THREE.MeshBasicMaterial({ color: PAPER_COLORS.note,
    transparent: true, opacity: 0.58, depthWrite: false, toneMapped: false, fog: false }));
  const placement = new THREE.Mesh(paperShapes.note.print, placementMaterial);
  placement.name = 'Evidence_Placement_Preview'; placement.visible = false; placement.position.z = 0.74;
  const placementOutline = new THREE.LineSegments(selectionGeometry, selectionMaterial);
  placementOutline.position.z = 0.003; placement.add(placementOutline); group.add(placement);
  const previewTemplates: Record<EvidenceTemplate, EvidenceCard> = {
    note: { id: 'tool:note', title: '', body: '', stage: 0, kind: 'note', presentation: 'compact', rotation: 0 },
    question: { id: 'tool:question', title: '', body: '', stage: 0, kind: 'question', presentation: 'compact', rotation: 0 },
    source: { id: 'tool:source', title: '', body: '', stage: 0, kind: 'source', rotation: 0 },
    tag: { id: 'tool:tag', title: '', body: '', stage: 0, kind: 'note', presentation: 'tag', rotation: 0 },
  };
  const connectionPositions = new THREE.Float32BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage);
  const connectionDistances = new THREE.Float32BufferAttribute(new Float32Array(2), 1).setUsage(THREE.DynamicDrawUsage);
  const connectionGeometry = ownGeometry(new THREE.BufferGeometry());
  connectionGeometry.setAttribute('position', connectionPositions);
  connectionGeometry.setAttribute('lineDistance', connectionDistances);
  const connection = new THREE.Line(connectionGeometry, ownMaterial(new THREE.LineDashedMaterial({
    color: '#97594f', dashSize: 0.13, gapSize: 0.08, transparent: true, opacity: 0.9, depthWrite: true, fog: false,
  })));
  connection.name = 'Evidence_Connection_Preview'; connection.visible = false; connection.frustumCulled = false;
  group.add(connection);
  const connectionStart = new THREE.Vector3(), connectionEnd = new THREE.Vector3();
  const insideWritingSurface = (value?: { x: number; y: number }) => value !== undefined
    && Number.isFinite(value.x) && Number.isFinite(value.y)
    && value.x >= EVIDENCE_WRITING_BOUNDS.left && value.x <= EVIDENCE_WRITING_BOUNDS.right
    && value.y >= EVIDENCE_WRITING_BOUNDS.bottom && value.y <= EVIDENCE_WRITING_BOUNDS.top;

  function setPlacementPreview(template: EvidenceTemplate | null, at?: { x: number; y: number }) {
    if (disposed) return;
    if (template && template !== placementTemplate) {
      const card = previewTemplates[template], layout = evidenceCardLayout(card, 0);
      placementWidth = layout.width; placementHeight = layout.height;
      placement.geometry = shapeFor(card).print;
      placementMaterial.color.set(PAPER_COLORS[card.kind]);
      placement.scale.set(placementWidth, placementHeight, 1);
    }
    placementTemplate = template;
    placement.visible = Boolean(template && insideWritingSurface(at));
    if (!placement.visible || !at) return;
    const x = Math.max(EVIDENCE_WRITING_BOUNDS.left + placementWidth / 2,
      Math.min(EVIDENCE_WRITING_BOUNDS.right - placementWidth / 2, at.x));
    const y = Math.max(EVIDENCE_WRITING_BOUNDS.bottom + placementHeight / 2,
      Math.min(EVIDENCE_WRITING_BOUNDS.top - placementHeight / 2, at.y));
    if (placement.position.x !== x || placement.position.y !== y) {
      placement.position.x = x; placement.position.y = y; placementUpdates++;
    }
  }
  function setConnectionPreview(fromId: string | null, at?: { x: number; y: number }) {
    if (disposed) return;
    const from = fromId ? cards.get(fromId) : undefined, next = from?.card.id ?? null;
    if (connectionFrom !== next) {
      const previous = connectionFrom ? cards.get(connectionFrom) : undefined;
      connectionFrom = next;
      if (previous) positionVisual(previous);
      if (from) positionVisual(from);
    }
    connection.visible = Boolean(from && insideWritingSurface(at));
    if (!connection.visible || !from || !at) return;
    writePinPosition(from, connectionStart);
    connectionEnd.set(at.x, at.y, 0.74);
    if (connectionPositions.getX(0) === Math.fround(connectionStart.x)
      && connectionPositions.getY(0) === Math.fround(connectionStart.y)
      && connectionPositions.getZ(0) === Math.fround(connectionStart.z)
      && connectionPositions.getX(1) === Math.fround(connectionEnd.x)
      && connectionPositions.getY(1) === Math.fround(connectionEnd.y)) return;
    connectionPositions.setXYZ(0, connectionStart.x, connectionStart.y, connectionStart.z);
    connectionPositions.setXYZ(1, connectionEnd.x, connectionEnd.y, connectionEnd.z);
    connectionDistances.setX(1, connectionStart.distanceTo(connectionEnd));
    connectionPositions.needsUpdate = true; connectionDistances.needsUpdate = true; connectionUpdates++;
  }

  function redraw(visual: CardVisual) {
    drawEvidenceCard(visual.canvas, visual.card, visual.index, photoReady ? photo : undefined);
    visual.texture.needsUpdate = true; cardTextureUpdates++;
  }
  const revealMaterials = new Map<THREE.Material, { opacity: number; transparent: boolean; depthWrite: boolean }>();
  let reveal = 1;
  function setReveal(value:number) {
    const next=THREE.MathUtils.clamp(value,0,1);group.visible=next>0;
    if(next===reveal&&(next===0||next===1))return;reveal=next;
    if(next===1){
      for(const [material,state] of revealMaterials){material.opacity=state.opacity;material.depthWrite=state.depthWrite;if(material.transparent!==state.transparent){material.transparent=state.transparent;material.needsUpdate=true;}}
      revealMaterials.clear();return;
    }
    if(next===0)return;
    for(const material of materials){
      if(!revealMaterials.has(material))revealMaterials.set(material,{opacity:material.opacity,transparent:material.transparent,depthWrite:material.depthWrite});
      material.opacity=revealMaterials.get(material)!.opacity*next;material.depthWrite=false;if(!material.transparent){material.transparent=true;material.needsUpdate=true;}
    }
  }
  function clearStrings() {
    for (const child of [...strings.children]) {
      if (child instanceof THREE.Mesh) child.geometry.dispose(); strings.remove(child);
    }
  }
  function writePinPosition(visual: CardVisual, target: THREE.Vector3) {
    const { x, y } = visual.pin.position, angle = visual.group.rotation.z;
    return target.set(x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle), 0.102)
      .add(visual.group.position);
  }
  function refreshStrings() {
    const signature = JSON.stringify([...cards.values()].map(value => [
      value.card.id, value.group.position.toArray(), value.group.rotation.z,
      value.pin.position.toArray(), value.card.links]));
    if (signature === linkSignature) return;
    linkSignature = signature; clearStrings(); linkRebuilds++;
    const seen = new Set<string>();
    const front = Math.max(PAPER_Z, ...[...cards.values()].map(value => value.group.position.z + PRINT_Z)) + .044;
    for (const a of cards.values()) for (const id of a.card.links || []) {
      const b = cards.get(id); if (!b || b === a) continue;
      const key = JSON.stringify([a.card.id, b.card.id].sort());
      if (seen.has(key)) continue; seen.add(key);
      const start = writePinPosition(a, new THREE.Vector3()), end = writePinPosition(b, new THREE.Vector3());
      // A lightly tensioned red thread runs directly from pin to pin above the papers.
      const middle = new THREE.Vector3((start.x + end.x) / 2, (start.y + end.y) / 2 - .055, front);
      const geometry = new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(start, middle, end), 20, .022, 5, false);
      const string = new THREE.Mesh(geometry, redString); string.name = 'Explicit_Evidence_Link';
      string.userData.from = a.card.id; string.userData.to = b.card.id;
      string.castShadow = true; strings.add(string);
    }
  }
  function positionVisual(visual: CardVisual) {
    const { card, index } = visual, layout = evidenceCardLayout(card, index);
    const position = clampEvidencePosition(card, index, layout.x, layout.y);
    visual.layout = { ...layout, ...position };
    const remaining = 1 - Math.min(1, visual.arrival ?? 1);
    visual.group.position.set(position.x, position.y + remaining * remaining * .28, PAPER_Z + index * 0.016 + remaining * remaining * .5 + (selectedId === card.id ? 0.055 : 0));
    visual.group.rotation.z = THREE.MathUtils.degToRad(layout.rotation);
    visual.paper.scale.set(layout.width, layout.height, 1); visual.print.scale.set(layout.width, layout.height, 1);
    visual.printBacking.scale.set(layout.width, layout.height, 1);
    visual.highlight.scale.set(layout.width, layout.height, 1);
    visual.highlight.visible = selectedId === card.id || connectionFrom === card.id;
    visual.resizeHandle.visible = card.clueKind !== 'report' && resizeEnabled && selectedId === card.id;
    visual.resizeHandle.position.set(layout.width / 2, -layout.height / 2, 0.12);
    visual.shadow.scale.set(layout.width + 0.22 * layout.scale, layout.height + 0.24 * layout.scale, 1);
    visual.shadow.position.set(0.045 * layout.scale, -0.067 * layout.scale, -0.051);
    visual.backing.scale.set(layout.width, layout.height, 1); visual.backing.visible = card.clueKind ? ['report','excerpt','contrast'].includes(card.clueKind) : card.kind === 'source';
    visual.backing.position.set(0.043 * layout.scale, -0.038 * layout.scale, -0.01);
    visual.tape.visible = card.clueKind === 'question' || !card.presentation && (card.visual === 'observatory' || card.visual === 'schematic');
    visual.tape.scale.set(0.78 * layout.scale, 0.23 * layout.scale, 1);
    visual.tape.position.set(card.clueKind ? -.08 : -layout.width * 0.20, layout.height / 2 - 0.008 * layout.scale, 0.095);
    visual.pin.visible = card.clueKind !== 'report';
    visual.pin.position.set(card.clueKind ? -layout.width * .48 : card.presentation === 'tag' ? -layout.width * 0.44
      : card.visual === 'observatory' || card.visual === 'signal' ? layout.width * 0.37
      : card.visual === 'schematic' ? layout.width * 0.35 : -layout.width * 0.37,
      card.presentation === 'tag' ? 0 : layout.height / 2 - 0.11 * layout.scale, 0);
    const head = visual.pin.children[2] as THREE.Mesh;
    const pinScale = connectionFrom === card.id ? 1.3 : card.presentation === 'tag' ? 0.8 : 1;
    head.scale.set(pinScale, pinScale, pinScale * 0.72);
  }
  function remove(visual: CardVisual) {
    group.remove(visual.group); visual.texture.dispose(); textures.delete(visual.texture);
    visual.print.material.dispose(); materials.delete(visual.print.material);
    visual.printBacking.material.dispose(); materials.delete(visual.printBacking.material);
  }
  function setCards(next: EvidenceCard[]) {
    if (disposed) return;
    receivedCards = next.length;
    const unique = [...new Map(next.map(card => [card.id, card])).values()].slice(0, next.some(card => card.clueKind === 'report') ? EVIDENCE_CARD_CAPACITY + 1 : EVIDENCE_CARD_CAPACITY);
    const ids = new Set(unique.map(card => card.id));
    for (const [id, visual] of cards) if (!ids.has(id)) { remove(visual); cards.delete(id); }
    if (selectedId && !ids.has(selectedId)) selectedId = null;
    if (connectionFrom && !ids.has(connectionFrom)) setConnectionPreview(null);
    unique.forEach((card, index) => {
      // Scale changes only the physical sheet. Derive the canvas from its original
      // aspect ratio so floating-point rounding never reallocates or redraws ink.
      const unscaled = evidenceCardLayout({ ...card, scale: 1 }, index);
      const expectedWidth = card.presentation ? 512 : 768;
      const expectedHeight = Math.round(expectedWidth * unscaled.height / unscaled.width);
      let visual = cards.get(card.id);
      if (!visual) {
        const layout = evidenceCardLayout(card, index);
        const sheet = canvas(expectedWidth, expectedHeight).canvas, texture = textureFor(sheet);
        const material = printed(texture);
        const cardGroup = new THREE.Group(); cardGroup.name = 'Pinned_Evidence_Card';
        const shadow = new THREE.Mesh(sheetPlane, shadowMaterial); shadow.position.set(0.045, -0.067, -0.051); cardGroup.add(shadow);
        const backing = new THREE.Mesh(sheetPlane, paperMaterials.source); backing.position.set(0.043, -0.038, -0.01);
        backing.rotation.z = 0.018; cardGroup.add(backing);
        const highlight = new THREE.LineSegments(selectionGeometry, selectionMaterial); highlight.position.z = 0.10; cardGroup.add(highlight);
        const resizeHandle = new THREE.Group(); resizeHandle.name = 'Evidence_Paper_Resize_Handle';
        resizeHandle.userData.evidenceResizeCardId = card.id;
        const resizeFace = new THREE.Mesh(sheetPlane, resizeFill); resizeFace.scale.set(0.17, 0.17, 1);
        const resizeInk = new THREE.LineSegments(resizeGeometry, selectionMaterial); resizeInk.position.z = 0.003;
        resizeHandle.add(resizeFace, resizeInk); cardGroup.add(resizeHandle);
        const paper = new THREE.Mesh(shapeFor(card).paper, paperMaterials[card.kind]);
        paper.castShadow = true; paper.receiveShadow = true; cardGroup.add(paper);
        // Coarse scene depth can cover the edge of a pin or string. The sharp
        // layer then reveals printed pixels rather than a blank white fringe.
        // This backing shares its canvas texture and geometry with the sharp layer.
        const printBacking = new THREE.Mesh(shapeFor(card).print,
          ownMaterial(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, fog: false })));
        printBacking.position.z = PRINT_Z; cardGroup.add(printBacking);
        const print = new THREE.Mesh(shapeFor(card).print, material);
        print.layers.set(ARCHIVE_LABEL_LAYER);
        print.position.z = PRINT_Z; print.userData.evidenceCardId = card.id; cardGroup.add(print);
        const tape = new THREE.Mesh(sheetPlane, tapeMaterial); tape.scale.set(0.78, 0.23, 1);
        tape.layers.set(ARCHIVE_LABEL_LAYER); tape.renderOrder = 1;
        tape.rotation.z = -0.07; cardGroup.add(tape);
        const pin = new THREE.Group(); pin.name = 'Evidence_Pushpin';
        const stem = new THREE.Mesh(pinStem, brass); stem.rotation.x = Math.PI / 2; stem.position.z = 0.089; pin.add(stem);
        const washer = new THREE.Mesh(pinWasher, brass); washer.rotation.x = Math.PI / 2; washer.position.z = 0.074; pin.add(washer);
        const head = new THREE.Mesh(pinHead, card.kind === 'note' ? brass : redPin);
        head.scale.set(1, 1, 0.72); head.position.z = 0.155; head.castShadow = true; pin.add(head);
        cardGroup.add(pin); group.add(cardGroup);
        visual = { card, index, layout, group: cardGroup, paper, print, printBacking, highlight, resizeHandle, shadow, backing, tape, pin, texture, canvas: sheet, signature: '', arrival: card.clueKind && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1 };
        cards.set(card.id, visual);
      }
      visual.card = { ...card, ...(card.position ? { position: { ...card.position } } : {}) }; visual.index = index;
      visual.paper.geometry = shapeFor(card).paper; visual.paper.material = paperMaterials[card.kind];
      visual.print.geometry = shapeFor(card).print;
      visual.printBacking.geometry = visual.print.geometry;
      const head = visual.pin.children[2] as THREE.Mesh; head.material = card.kind === 'note' ? brass : redPin;
      positionVisual(visual);
      if (visual.canvas.width !== expectedWidth || visual.canvas.height !== expectedHeight) {
        // WebGL texture storage has immutable dimensions after its first upload.
        visual.texture.dispose(); textures.delete(visual.texture);
        visual.canvas.width = expectedWidth; visual.canvas.height = expectedHeight;
        visual.texture = textureFor(visual.canvas);
        visual.texture.userData.archivePrint = true;
        visual.texture.anisotropy = visual.print.material.map!.anisotropy;
        visual.print.material.map = visual.texture;
        visual.print.material.needsUpdate = true;
        visual.printBacking.material.map = visual.texture;
      }
      const signature = JSON.stringify([card.title, card.body, card.summary, card.clueKind, card.variant, card.evidenceLabel, card.kind, card.visual, card.presentation,
        card.sourceTitle, card.sourceLabel, isPreviewCard(card), index, expectedWidth, expectedHeight]);
      if (signature !== visual.signature) { visual.signature = signature; redraw(visual); }
    });
    refreshStrings();
  }
  function select(id: string | null) {
    if (disposed) return;
    const next = id && cards.has(id) ? id : null; if (selectedId === next) return;
    selectedId = next; for (const visual of cards.values()) positionVisual(visual); refreshStrings();
  }
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -SURFACE_Z);
  const inverse = new THREE.Matrix4(), localRay = new THREE.Ray(), point = new THREE.Vector3();
  const handlePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.12);
  const resizePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  return {
    group, setCards, select, setReveal, setPlacementPreview, setConnectionPreview,
    update(delta: number) { let arriving=false;for (const visual of cards.values()) if ((visual.arrival ?? 1) < 1) { visual.arrival = Math.min(1, (visual.arrival || 0) + delta / .38); positionVisual(visual); arriving=true; }if(arriving)refreshStrings(); },
    setResizeEnabled(value: boolean) {
      if (resizeEnabled === value) return;
      resizeEnabled = value;
      for (const visual of cards.values()) visual.resizeHandle.visible = visual.card.clueKind !== 'report' && value && selectedId === visual.card.id;
    },
    pickResizeHandle(raycaster: THREE.Raycaster, tolerance = 0.22): string | null {
      const visual = selectedId ? cards.get(selectedId) : undefined;
      if (disposed || !group.visible || !visual?.resizeHandle.visible) return null;
      visual.group.updateWorldMatrix(true, false); inverse.copy(visual.group.matrixWorld).invert();
      localRay.copy(raycaster.ray).applyMatrix4(inverse);
      if (!localRay.intersectPlane(handlePlane, point)) return null;
      return Math.hypot(point.x - visual.resizeHandle.position.x, point.y - visual.resizeHandle.position.y)
        <= tolerance ? visual.card.id : null;
    },
    /** Stable board-local anchors; callers must copy before world/screen projection. */
    getToolAnchors() { return toolAnchors; },
    pickTool(raycaster: THREE.Raycaster): boolean {
      if (disposed || !group.visible) return false;
      group.updateWorldMatrix(true, true); toolHits.length = 0;
      raycaster.intersectObjects(toolMeshes, false, toolHits);
      return toolHits.length > 0;
    },
    boardPoint(raycaster: THREE.Raycaster): { x: number; y: number } | null {
      if (disposed || !group.visible) return null;
      group.updateWorldMatrix(true, false); inverse.copy(group.matrixWorld).invert();
      localRay.copy(raycaster.ray).applyMatrix4(inverse);
      if (!localRay.intersectPlane(plane, point)) return null;
      // Beyond-edge coordinates let moveCard clamp a dragged paper to the surface.
      return { x: point.x, y: point.y };
    },
    resizePoint(raycaster: THREE.Raycaster, id: string): { x: number; y: number } | null {
      const visual = cards.get(id);
      if (disposed || !group.visible || !visual) return null;
      group.updateWorldMatrix(true, false); inverse.copy(group.matrixWorld).invert();
      localRay.copy(raycaster.ray).applyMatrix4(inverse);
      // Intersect the selected sheet's grip plane, not the recessed whiteboard:
      // otherwise oblique views introduce a small perspective scaling error.
      resizePlane.constant = -(visual.group.position.z + visual.resizeHandle.position.z);
      if (!localRay.intersectPlane(resizePlane, point)) return null;
      return { x: point.x, y: point.y };
    },
    moveCard(id: string, x: number, y: number) {
      if (disposed || !Number.isFinite(x) || !Number.isFinite(y)) return;
      const visual = cards.get(id); if (!visual) return;
      const position = clampEvidencePosition(visual.card, visual.index, x, y);
      if (position.x === visual.group.position.x && position.y === visual.group.position.y) return;
      visual.card = { ...visual.card, position }; positionVisual(visual); refreshStrings();
    },
    resizeCard(id: string, scale: number, x: number, y: number) {
      if (disposed || ![scale, x, y].every(Number.isFinite)) return;
      const visual = cards.get(id); if (!visual) return;
      const next = { ...visual.card, scale }, position = clampEvidencePosition(next, visual.index, x, y);
      if (scale === visual.card.scale && position.x === visual.layout.x && position.y === visual.layout.y) return;
      // Resizing reuses the sheet, print texture and furniture geometry.
      visual.card = { ...next, position }; positionVisual(visual); refreshStrings();
    },
    pick(raycaster: THREE.Raycaster): string | null {
      if (disposed || !group.visible) return null;
      group.updateWorldMatrix(true, true);
      const hit = raycaster.intersectObjects([...cards.values()].map(visual => visual.print), false)[0];
      return hit ? String(hit.object.userData.evidenceCardId) : null;
    },
    stats(): Record<string, unknown> {
      return { cards: cards.size, receivedCards, reveal, capacity: EVIDENCE_CARD_CAPACITY, selectedId,
        cardTextureUpdates, textureCount: textures.size, geometryCount: geometries.size,
        linkRoutes: strings.children.map(line => {
          const mesh = line as THREE.Mesh<THREE.TubeGeometry, THREE.MeshStandardMaterial>;
          return { ...line.userData, color: `#${mesh.material.color.getHexString()}`, opacity: mesh.material.opacity,
            radius: mesh.geometry.parameters.radius, visible: mesh.visible };
        }),
        links: strings.children.length, connections: strings.children.length, linkRebuilds, width: WIDTH, height: HEIGHT,
        placementPreview: placement.visible, placementTemplate, placementUpdates,
        connectionPreview: connection.visible, connectionFrom, connectionUpdates,
        chalkMeshes: toolMeshes.length,
        resizeHandle: selectedId && resizeEnabled ? selectedId : null,
        cardTexturePixels: [...cards.values()].reduce((total, value) => total + value.canvas.width * value.canvas.height, 0),
        illustrationReady: photoReady,
        layout: [...cards.values()].map(value => ({ id: value.card.id, ...value.layout,
          presentation: value.card.presentation, textureWidth: value.canvas.width, textureHeight: value.canvas.height })) };
    },
    dispose() {
      if (disposed) return;
      disposed = true; photo.onload = null; clearStrings(); group.removeFromParent(); group.clear(); cards.clear();
      toolMeshes.length = 0; toolHits.length = 0;
      textures.forEach(texture => texture.dispose()); textures.clear();
      materials.forEach(material => material.dispose()); materials.clear();
      geometries.forEach(geometry => geometry.dispose()); geometries.clear();
    },
  };
}
