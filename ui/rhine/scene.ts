import { visibleSceneHit } from './visible-scene-hit';
import { createEvidenceInboxScene } from './evidence-inbox-scene';
import { createReadingObject } from './reading-object';
import { INVESTIGATION_BOARD_PLANE } from './investigation-board-plane';
import { archiveLabelCandidates, archivePointerTarget, type LabelCandidate } from './label-prefetch';
import * as THREE from 'three';
import { ArchiveScene } from './original/scene';
import { archiveColumns, fileLocation } from './original/data';
import { wrap, type ArchiveNavigation, type ArchiveCell } from './original/archive-loop';
import { qualityPresets, type RenderQuality } from './original/render-quality';
import { setAssetBase } from './original/asset-url';
import { archiveLane, SHELF_PAGE_SIZE, sourceIdentity, sourceIndex } from './catalogue';
import { SHELF_LEVELS, SHELF_SLOTS_PER_LEVEL, SHELF_LEVEL_SPACING, SHELF_WIDTH as RACK_WIDTH,
  SHELF_DEPTH as RACK_DEPTH, SHELF_HEIGHT, SHELF_EXIT_DISTANCE, SHELF_READING_POSITION, shelfReadingPath, shelfSlot } from './shelf-layout';
import { DeferredPreparation } from './deferred-preparation';
import { operationSource } from './tool-activity';
import { beginWorkspaceTravel, advanceWorkspaceTravel, type WorkspaceTravel } from './workspace-travel';
import { ArchiveNavigationLimiter } from './archive-navigation-limit';
import { createEvidenceBoard } from './evidence-board-scene';
import { clampEvidencePosition, evidenceCardLayout, evidenceCardScale, EVIDENCE_SCALE_MIN, EVIDENCE_SCALE_MAX,
  EVIDENCE_WRITING_BOUNDS, type EvidenceCard, type EvidenceBoardTool } from './evidence-board-model';
import type { ArchiveOperation, ArchiveSource, InvestigationSnapshot, RhineLocation, RhineScene, RhineSceneOptions, BoardAnchorFrame } from './types';

// The archive is the authored renderer: original camera, optics, lighting,
// continuous 288-file loop. Evidence occupies an adjoining
// part of this same world; camera travel never swaps or rebuilds the archive.
const SHELF_X = 35;
const BOARD_CENTER = new THREE.Vector3(29.7, 4.8, -8);
const BOARD_FOCUS = BOARD_CENTER.clone();
const BOARD_ZOOM_MIN = 1, BOARD_ZOOM_MAX = 3;
const SHELF_YAW = 0;
// One profile for the workbench and viewer. Keep native CSS resolution and
// SMAA for the cassette edges; the rack's full-resolution transmission remains
// a view-specific clarity adjustment below.
export const WORKBENCH_QUALITY: RenderQuality = { ...qualityPresets.performance };
// The original archive camera looks along a 59-degree horizontal bearing.
// Locate the small organizer in the right two thirds of its translated view.
const SHELF_RIGHT = new THREE.Vector3(Math.cos(THREE.MathUtils.degToRad(59)), 0, Math.sin(THREE.MathUtils.degToRad(59)));
const SHELF_CENTER = new THREE.Vector3(SHELF_X, -4.6, -2.17).addScaledVector(SHELF_RIGHT, 4.2);
const smooth = (value: number) => {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
interface CollectionFile { id: string; group: THREE.Group; marker: THREE.Mesh; saved: THREE.Mesh; progress: number; focus: number; arrival: number }
interface ActivityRequest { key: string; operationId?: string; source?: ArchiveSource; kind: 'arrival' | 'read'; age: number; labelWaitAt?: number }
interface ActivityFile extends ActivityRequest {
  group: THREE.Group; index: number; elapsed: number; lift: number;
  stage: 'lifting' | 'holding' | 'travelling' | 'returning';
  departure: THREE.Vector3; orientation: THREE.Quaternion; startLift: number; targetLift: number; released?: boolean;
}
const MAX_ACTIVITY_FILES = 2;
const MAX_ACTIVITY_QUEUE = 12;
const ARCHIVE_STEP_SECONDS = 2.8;
const ACTIVITY_LIFT_SECONDS = 1.35;

export async function createRhineScene(host: HTMLElement, options: RhineSceneOptions): Promise<RhineScene> {
  let activitySince = options.activitySince ?? Date.now();
  let quality: RenderQuality = { ...WORKBENCH_QUALITY };
  setAssetBase(options.assetBase);
  // A URL-only comparison switch keeps the previous geometry path available
  // for visual/performance review without changing the user's quality settings.
  const renderOptions = new URLSearchParams(globalThis.location.search);
  const arrayInterior = renderOptions.get('rhineArray') === 'geometry'
    ? 'geometry' : 'baked';
  const original = new ArchiveScene(host, undefined, undefined, undefined, arrayInterior,
    renderOptions.get('rhineCull') !== 'off', renderOptions.get('rhineLod') !== 'off',
    renderOptions.get('rhineOcclusion') !== 'off', renderOptions.get('rhineShell') !== 'off',
    renderOptions.get('rhineDetails') !== 'off');
  original.performanceProbe = options.performanceProbe;
  const load = <T>(kind: string, task: () => Promise<T>, detail: Record<string, unknown> = {}) =>
    options.performanceProbe ? options.performanceProbe.trackLoad(kind, task, detail) : task();
  try {
    await Promise.all([
      load('scene-setup', () => original.load(`${options.assetBase.replace(/\/$/, '')}/assets/archive-cassette.glb`)),
      load('font', () => document.fonts.load('400 20px MiSans'), { family: 'MiSans', weight: 400 }),
      load('font', () => document.fonts.load('600 20px MiSans'), { family: 'MiSans', weight: 600 }),
      load('font', () => document.fonts.load('700 20px MiSans'), { family: 'MiSans', weight: 700 }),
    ]);
    original.setQuality(quality);
  } catch (error) { original.dispose(); throw error; }
  original.setReduced(!!options.reducedMotion);
  original.setMode('archive');
  original.select(16);
  // TEMPORARY RHINE PROFILER
  const unregisterPerformance = options.performanceProbe?.register('scene', original.renderer, () => ({
    ...original.performanceState(), active, reducedMotion: reduced, location, detail, movingCamera: Boolean(cameraTravel),
    preparation: { ...preparation.stats(), pendingShelf: pendingShelf.size }, navigation: navigationLimiter.stats(),
    sourceCount: sourceList.length, archiveSourceCount: archiveSources.length, physicalFiles: files.size,
    activityFiles: activityFiles.length, activityQueue: activityQueue.length, pendingArrivals: waitingArrivals.size,
    activityStages: activityFiles.reduce<Record<string, number>>((counts, item) => { counts[item.stage] = (counts[item.stage] || 0) + 1; return counts; }, {}),
    boardCards: boardCards.length, scanSteps, renderedFrames, searching: scanningActive(),
  }), () => original.performancePasses());
  const navigationLimiter = options.navigationLimiter ?? new ArchiveNavigationLimiter();

  let disposed = false;
  let active = true;
  let reduced = !!options.reducedMotion;
  let contextLost = false;
  let raf = 0;
  let renderedFrames = 0;
  const readyWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  const rejectReady = (message: string) => {
    for (const waiter of readyWaiters) waiter.reject(new Error(message));
    readyWaiters.clear();
  };
  let lastFrame = 0;
  let archiveIndex = 16;
  let archiveLaneIndex = 2;
  let archiveSources: ArchiveSource[] = [];
  let lanes: ArchiveSource[][] = archiveColumns.map(() => []);
  const laneRows = archiveColumns.map(() => 0);
  const slotRows = archiveColumns.map(() => 0);
  let detail = false;
  let location: RhineLocation = 'archive';
  // Close inspection of clear covers needs a full-resolution refraction
  // capture and a sharp rack throughout its depth. Apply once per view/quality
  // change; interpolating these buffer sizes during camera travel reallocates
  // GPU targets every frame. Keep the user's archive settings separately.
  const effectiveQuality = (): RenderQuality => location === 'desk'
    ? { ...quality, transmission: 1, depthOfField: 0 }
    : { ...quality, ...(location === 'board' ? { depthOfField: 0 } : {}) };
  let searching = false;
  let userPriorityUntil = 0;
  let followAgent = true;
  const userOwnsView = () => !followAgent || performance.now() < userPriorityUntil;
  const prioritizeUser = () => { userPriorityUntil = performance.now() + 4000; scanElapsed = 0; };
  let scanElapsed = ARCHIVE_STEP_SECONDS - 0.35;
  let scanSteps = 0;
  let readingScanDirection = 1;
  let arrivalScanRemaining = 0;
  let deskAmount = 0;
  let boardAmount = 0;
  let boardZoom = BOARD_ZOOM_MIN;
  const boardZoomCenter = new THREE.Vector2();
  const boardFocus = BOARD_FOCUS.clone();
  let boardFullscreen = false;
  let boardEditorInset = 0;
  let appliedBoardEditorInset = 0;
  let boardOverview: { zoom: number; center: THREE.Vector2 } | null = null;
  const boardNormal = new THREE.Vector3();
  let cameraTravel: WorkspaceTravel | null = null;
  const workspaceFrameCenter = new THREE.Vector3();
  let sourceList: ArchiveSource[] = [];
  let sourceIds = new Set<string>();
  let selectedId: string | null = null;
  let focusedId: string | null = null;
  let shelfPage = 0;
  let visibleIds: string[] = [];
  let sessionId: string | null = null;
  let investigation: InvestigationSnapshot | null = null;
  const transferred = new Set<string>();
  const waitingArrivals = new Set<string>();
  const files = new Map<string, CollectionFile>();
  const preparation = new DeferredPreparation({ monitorTask: () => {
    const probe = options.performanceProbe;
    if (!probe?.running) return;
    const sync = probe.beginWork('archive-preparation-sync'), lifetime = probe.beginWork('archive-preparation-lifetime');
    return (stage, succeeded) => stage === 'sync' ? sync?.(succeeded) : lifetime?.(succeeded, true);
  } });
  if (renderOptions.get('rhineShelf') !== 'geometry') {
    preparation.enqueue('shelf-interior', () => original.prepareShelfInterior(), 20);
    for (let view = 0; view < 4; view++) preparation.enqueue(`shelf-view:${view}`, () => original.prepareShelfView(view), -1);
  }
  const pendingShelf = new Map<string, { settleWaiting: boolean; run?: () => void }>();
  // Build the small moving reserve between frames before a result needs it.
  for (let index = 0; index < 3; index++)
    preparation.enqueue(`moving:${index}`, () => original.prepareMovingFile(), 10);
  const activityFiles: ActivityFile[] = [];
  const activityQueue: ActivityRequest[] = [];
  const observedOperations = new Map<string, ArchiveOperation['state']>();
  const historicalOperations = new Set<string>();
  const scheduledReads = new Set<string>();
  let operations = new Map<string, ArchiveOperation>();
  let operationsInitialized = false;
  let activitySpacing = 0;
  const events = new AbortController();
  // The board shares the existing world's renderer, lighting and camera.
  const evidenceBoard = createEvidenceBoard(texture => original.createPrintMaterial(texture), { interactiveHeading: true });
  evidenceBoard.group.userData.performanceFamily = "board";
  const readingObject = createReadingObject(texture => original.createPrintMaterial(texture));
  original.scene.add(readingObject.group);
  let boardCards: EvidenceCard[] = [];
  let boardTool: EvidenceBoardTool = { mode: 'select' };
  const boardAnchors = evidenceBoard.getToolAnchors();
  // Same strip as the RHINE LAB nameplate, recessed inside the board rim.
  const controlCorners = [new THREE.Vector3(3.67, 4.32, 0.181), new THREE.Vector3(7.37, 4.32, 0.181),
    new THREE.Vector3(7.37, 3.80, 0.181), new THREE.Vector3(3.67, 3.80, 0.181)];
  const surface = INVESTIGATION_BOARD_PLANE;
  const surfaceCorners = [new THREE.Vector3(surface.left, surface.top, surface.z),
    new THREE.Vector3(surface.left + surface.width, surface.top, surface.z),
    new THREE.Vector3(surface.left + surface.width, surface.top - surface.height, surface.z),
    new THREE.Vector3(surface.left, surface.top - surface.height, surface.z)];
  const projectedAnchor = new THREE.Vector3();
  const boardAnchorFrame: BoardAnchorFrame = { corner: { x: 0, y: 0, visible: false },
    chalk: { x: 0, y: 0, visible: false },
    controls: [{ x: 0, y: 0, visible: false }, { x: 0, y: 0, visible: false },
      { x: 0, y: 0, visible: false }, { x: 0, y: 0, visible: false }],
    surface: [{ x: 0, y: 0, visible: false }, { x: 0, y: 0, visible: false },
      { x: 0, y: 0, visible: false }, { x: 0, y: 0, visible: false }],
    width: 0, height: 0, zoom: 1, visible: false };
  let anchorWidth = host.clientWidth, anchorHeight = host.clientHeight, anchorsDirty = true;
  function syncBoardAnchors() {
    if (!options.onBoardAnchors) return;
    const visible = location === 'board' && !detail && !cameraTravel && active && !contextLost;
    let dirty = anchorsDirty || boardAnchorFrame.visible !== visible || boardAnchorFrame.zoom !== boardZoom;
    boardAnchorFrame.visible = visible; boardAnchorFrame.zoom = boardZoom;
    boardAnchorFrame.width = anchorWidth; boardAnchorFrame.height = anchorHeight;
    if (visible) for (const name of ['corner', 'chalk'] as const) {
      evidenceBoard.group.localToWorld(projectedAnchor.copy(boardAnchors[name])).project(original.camera);
      const x = Math.round((projectedAnchor.x + 1) * anchorWidth) / 2;
      const y = Math.round((1 - projectedAnchor.y) * anchorHeight) / 2;
      const inView = projectedAnchor.z >= -1 && projectedAnchor.z <= 1
        && x >= 0 && x <= anchorWidth && y >= 0 && y <= anchorHeight;
      const previous = boardAnchorFrame[name];
      if (previous.x !== x || previous.y !== y || previous.visible !== inView) dirty = true;
      previous.x = x; previous.y = y; previous.visible = inView;
    }
    if (visible) for (let index = 0; index < 4; index++) {
      evidenceBoard.group.localToWorld(projectedAnchor.copy(controlCorners[index])).project(original.camera);
      // Subpixel precision keeps the narrow label's perspective stable during camera travel.
      const x = Math.round((projectedAnchor.x + 1) * anchorWidth * 50) / 100;
      const y = Math.round((1 - projectedAnchor.y) * anchorHeight * 50) / 100;
      const inView = projectedAnchor.z >= -1 && projectedAnchor.z <= 1
        && x >= 0 && x <= anchorWidth && y >= 0 && y <= anchorHeight;
      const previous = boardAnchorFrame.controls[index];
      if (previous.x !== x || previous.y !== y || previous.visible !== inView) dirty = true;
      previous.x = x; previous.y = y; previous.visible = inView;
    }
    if (visible) for (let index = 0; index < 4; index++) {
      evidenceBoard.group.localToWorld(projectedAnchor.copy(surfaceCorners[index])).project(original.camera);
      const x = Math.round((projectedAnchor.x + 1) * anchorWidth * 50) / 100;
      const y = Math.round((1 - projectedAnchor.y) * anchorHeight * 50) / 100;
      // Zoom and pan may put the rim outside the viewport; that must not hide visible board content.
      const inFront = projectedAnchor.z >= -1 && projectedAnchor.z <= 1;
      const previous = boardAnchorFrame.surface[index];
      if (previous.x !== x || previous.y !== y || previous.visible !== inFront) dirty = true;
      previous.x = x; previous.y = y; previous.visible = inFront;
    }
    if (dirty) { anchorsDirty = false; options.onBoardAnchors(boardAnchorFrame); }
  }
  evidenceBoard.group.position.copy(BOARD_CENTER);
  evidenceBoard.group.rotation.set(0, THREE.MathUtils.degToRad(-34), 0);
  original.scene.add(evidenceBoard.group);
  const evidenceInbox=createEvidenceInboxScene(texture=>original.createPrintMaterial(texture));
  // The board's matrices are not yet rendered at construction time.
  evidenceBoard.group.updateWorldMatrix(true,false);
  evidenceInbox.group.position.set(-10.7,-9.35,1.7).applyMatrix4(evidenceBoard.group.matrixWorld);
  evidenceInbox.group.quaternion.copy(evidenceBoard.group.quaternion);original.scene.add(evidenceInbox.group);
  let inboxOpen=false,inboxAmount=0;
  const inboxFocus=new THREE.Vector3();

  const currentArchiveSource = () => lanes[archiveLaneIndex][laneRows[archiveLaneIndex]] || null;
  const sourceNumber = (source: ArchiveSource) => {
    const archive = sourceIndex(archiveSources, source);
    if (archive >= 0) return archive;
    const shelfIndex = sourceIndex(sourceList, source);
    return shelfIndex >= 0 ? shelfIndex : sourceIndex(investigation?.sources || [], source);
  };
  const sourceSlot = (source: ArchiveSource) => {
    const lane = archiveLane(source);
    const position = Math.max(0, lanes[lane].findIndex(item => sourceIdentity(item) === sourceIdentity(source)));
    return lane * 8 + wrap(slotRows[lane] + position - laneRows[lane], 8);
  };
  const readingActive = () => [...operations.values()].some(item => item.kind === 'read' && item.state === 'active')
    || (!!investigation?.running && investigation.phase === 'reading');
  const scanningActive = () => searching || [...operations.values()].some(item => item.kind === 'search' && item.state === 'active')
    || (!!investigation?.searching && investigation.phase !== 'reading') || arrivalScanRemaining > 0;
  const archiveBusy = () => readingActive() || scanningActive();

  // Preserve the authored shell; resting files can share a captured interior.
  const rack = new THREE.Group();
  rack.userData.performanceFamily = "rack";
  rack.position.copy(SHELF_CENTER);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const rackMaterials = [
    new THREE.MeshStandardMaterial({ color: '#e4ddd2', roughness: 0.72 }),
    new THREE.MeshStandardMaterial({ color: '#eee8dd', roughness: 0.46 }),
    new THREE.MeshStandardMaterial({ color: '#cbbb8d', roughness: 0.55, metalness: 0.1 }),
  ];
  // Shared unit boxes reduce the complete two-tier frame to three draw batches.
  const rackMatrices: THREE.Matrix4[][] = rackMaterials.map(() => []);
  const partPose = new THREE.Object3D();
  const rackPart = (position: [number, number, number], size: [number, number, number], materialIndex = 0) => {
    partPose.position.set(...position); partPose.scale.set(...size); partPose.updateMatrix();
    rackMatrices[materialIndex].push(partPose.matrix.clone());
  };
  for (let level = 0; level < SHELF_LEVELS; level++) {
    const y = level * SHELF_LEVEL_SPACING;
    rackPart([0, y + 0.12, 0], [RACK_WIDTH, 0.24, RACK_DEPTH]);
    for (const z of [-RACK_DEPTH / 2, RACK_DEPTH / 2]) {
      rackPart([0, y + 0.4, z], [RACK_WIDTH, 0.55, 0.14], 1);
      rackPart([0, y + 0.69, z], [RACK_WIDTH, 0.025, 0.035], 2);
    }
    // Open front: the cassette slides out horizontally below the next tray.
    rackPart([-RACK_WIDTH / 2, y + 0.20, 0], [0.14, 0.12, RACK_DEPTH], 1);
    rackPart([RACK_WIDTH / 2, y + 0.7, 0], [0.14, 1.1, RACK_DEPTH], 1);
    for (let slot = 0; slot < SHELF_SLOTS_PER_LEVEL; slot++) {
      const { z } = shelfSlot(slot);
      rackPart([0, y + 0.25, z], [RACK_WIDTH - 0.3, 0.035, 0.026], 2);
      rackPart([-RACK_WIDTH / 2 - 0.075, y + 0.19, z], [0.018, 0.035, 0.14], 2);
    }
  }
  for (const x of [-RACK_WIDTH / 2 - 0.12, RACK_WIDTH / 2 + 0.12]) {
    for (const z of [-RACK_DEPTH / 2, RACK_DEPTH / 2])
      rackPart([x, SHELF_HEIGHT / 2, z], [0.16, SHELF_HEIGHT, 0.16], 1);
  }
  rackMatrices.forEach((matrices, materialIndex) => {
    const mesh = new THREE.InstancedMesh(box, rackMaterials[materialIndex], matrices.length);
    matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true; mesh.receiveShadow = true; rack.add(mesh);
  });
  rack.name = 'Rhine_Archive_Rack';
  rack.userData.workspaceLocation = 'desk';
  evidenceBoard.group.userData.workspaceLocation = 'board';
  original.scene.add(rack);
  preparation.enqueue("workspace-programs", () => original.preparePrograms("workspace", [rack, evidenceBoard.group, evidenceInbox.group]), 15);
  const collectionFocus = SHELF_CENTER.clone().add(new THREE.Vector3(0, SHELF_HEIGHT / 2, 0));
  const collectionCenter = collectionFocus.clone();
  const activityFrameCenter = new THREE.Vector3();
  let activityFrameAmount = 0;
  const readingPosition = SHELF_CENTER.clone().add(new THREE.Vector3(
    SHELF_READING_POSITION.x, SHELF_READING_POSITION.y, SHELF_READING_POSITION.z));
  const rackOrientation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, SHELF_YAW, 0));
  const deskPose = (id: string) => {
    const { x, y, z } = shelfSlot(Math.max(0, visibleIds.indexOf(id)));
    return SHELF_CENTER.clone().add(new THREE.Vector3(x, y, z));
  };
  const notifyShelf = () => options.onShelfSelect?.(focusedId, shelfPage);
  const updateShelfMetadata = (file: CollectionFile, source: ArchiveSource) => {
    original.setCollectionLabel(file.group, sourceNumber(source), { title: source.title, sourceId: source.id });
    (file.marker.material as THREE.MeshStandardMaterial).color.set(
      source.state === 'cited' ? '#b59958' : source.state === 'read' ? '#748465' : '#aaa89a',
    );
    file.saved.visible = !!source.saved;
  };
  const prepareShelfFile = (id: string) => {
    const existing = pendingShelf.get(id);
    if (existing) {
      if (id === selectedId && existing.run) preparation.enqueue(`shelf:${id}`, existing.run, 5);
      return;
    }
    const source = sourceList.find(item => item.id === id)!;
    // Capture the page-arrival decision before setSources queues this update's
    // new transfers. Deferred construction must not mark those as delivered.
    const pending: { settleWaiting: boolean; run?: () => void } = {
      settleWaiting: waitingArrivals.has(sourceIdentity(source)),
    };
    pendingShelf.set(id, pending);
    pending.run = () => {
      pendingShelf.delete(id);
      if (disposed || files.has(id) || !visibleIds.includes(id)) return;
      const source = sourceList.find(item => item.id === id);
      if (!source) return;
      const group = original.createCollectionFile(sourceList.indexOf(source), { shelf: true, label: { code: `NO.${String(sourceNumber(source) + 1).padStart(3, "0")}`, title: source.title, sourceId: source.id } });
      group.userData.sourceId = id; group.userData.workspaceLocation = 'desk';
      group.position.copy(deskPose(id)); group.quaternion.copy(rackOrientation);
      group.visible = !boardFullscreen;
      const marker = new THREE.Mesh(box, new THREE.MeshStandardMaterial({ roughness: 0.52 }));
      marker.position.set(-1.96, 3.45, 0.28); marker.scale.set(0.13, 0.33, 0.065);
      const saved = new THREE.Mesh(box, new THREE.MeshStandardMaterial({ color: '#25291f', roughness: 0.58 }));
      saved.position.set(-1.7, 3.61, 0.22); saved.scale.set(0.17, 0.10, 0.11);
      group.add(marker, saved); original.scene.add(group);
      const waiting = pending.settleWaiting && waitingArrivals.delete(sourceIdentity(source));
      if (waiting) transferred.add(sourceIdentity(source));
      const file = { id, group, marker, saved, progress: 0, focus: 0, arrival: waiting && !reduced ? 0 : 1 };
      files.set(id, file);
      updateShelfMetadata(file, source);
      // Allocate/upload the owned label here as well, not when the rack first
      // enters the camera and the page's textures would otherwise upload at once.
      original.prepareCollectionTexture(group);
      wake();
    };
    preparation.enqueue(`shelf:${id}`, pending.run, id === selectedId ? 5 : 0);
  };
  const syncCollection = () => {
    shelfPage = Math.max(0, Math.min(shelfPage, Math.ceil(sourceList.length / SHELF_PAGE_SIZE) - 1));
    visibleIds = sourceList.slice(shelfPage * SHELF_PAGE_SIZE, (shelfPage + 1) * SHELF_PAGE_SIZE).map(source => source.id);
    for (const id of pendingShelf.keys()) if (!visibleIds.includes(id)) {
      preparation.cancel(`shelf:${id}`); pendingShelf.delete(id);
    }
    for (const [id, file] of files) {
      if (!visibleIds.includes(id)) {
        original.disposeCollectionFile(file.group); files.delete(id);
      }
    }
    if (!focusedId || !visibleIds.includes(focusedId)) focusedId = visibleIds[0] || null;
    for (const id of visibleIds) {
      const source = sourceList.find(item => item.id === id)!;
      const file = files.get(id);
      if (!file) {
        prepareShelfFile(id);
        continue;
      }
      updateShelfMetadata(file, source);
    }
  };
  const showShelfPage = (page: number) => {
    if (disposed || (detail && selectedId)) return;
    const next = Math.max(0, Math.min(Math.floor(page), Math.ceil(sourceList.length / SHELF_PAGE_SIZE) - 1));
    if (next === shelfPage) return;
    prioritizeUser(); shelfPage = next; syncCollection(); notifyShelf(); wake();
  };
  const browseShelf = (direction: number) => {
    if (disposed || !sourceList.length || (detail && selectedId)) return;
    const delta = Math.trunc(direction);
    if (!Number.isFinite(delta) || delta === 0) return;
    const current = sourceList.findIndex(source => source.id === focusedId);
    const next = wrap(Math.max(0, current) + delta, sourceList.length);
    shelfPage = Math.floor(next / SHELF_PAGE_SIZE);
    focusedId = sourceList[next].id;
    syncCollection(); notifyShelf(); wake();
  };

  let labelPrefetchKey = '', labelPrefetchPlan = 0;
  let hoveredArchive: { index: number; cell?: ArchiveCell } | null = null;
  let activityLabelSource: ArchiveSource | null = null;
  const pendingLabelPrefetch = new Map<number, { plan: number; slot: number; intent: LabelCandidate<ArchiveSource>['axis'] }>();
  const pointerTarget = (index: number, cell?: ArchiveCell) => archivePointerTarget(
    lanes.map(items => items.length), laneRows, slotRows, archiveLaneIndex, original.selectedArchiveCell, index, cell);
  const archivePrint = (source: ArchiveSource, activity = false) => {
    const number = sourceNumber(source);
    return { code: activity && number < 0 ? 'READING' : `NO.${String(number + 1).padStart(3, '0')}`,
      title: source.title, sourceId: source.id };
  };
  const syncLabelPrefetch = () => {
    if (disposed) return;
    const preferred: LabelCandidate<ArchiveSource>[] = [];
    if (hoveredArchive && location === 'archive' && !detail && !cameraTravel && active && !contextLost) {
      const target = pointerTarget(hoveredArchive.index, hoveredArchive.cell);
      const item = target && lanes[target.lane]?.[target.row];
      if (target && item) preferred.push({ item, lane: target.lane, row: target.row, axis: 'pointer', offset: target.delta });
    }
    if (!reduced) {
      const upcoming = [activityLabelSource, ...activityQueue.filter(item => item.kind === 'read').map(item => item.source),
        ...activityQueue.filter(item => item.kind !== 'read').map(item => item.source)];
      let activityCount = 0;
      for (const source of upcoming) {
        if (!source) continue;
        const item = archiveSources.find(item => sourceIdentity(item) === sourceIdentity(source)) || source;
        if (preferred.some(candidate => candidate.item === item)) continue;
        const lane = archiveLane(item), row = lanes[lane].findIndex(source => source.id === item.id);
        preferred.push({ item, lane, row, axis: 'activity', offset: 0 });
        if (++activityCount === MAX_ACTIVITY_FILES) break;
      }
    }
    const targets = location === 'archive' ? archiveLabelCandidates(lanes, laneRows, archiveLaneIndex, 6, preferred) : preferred;
    const candidates = targets.map(target => archivePrint(target.item, target.axis === 'activity'));
    const prefetchKey = JSON.stringify([document.fonts?.status || 'loaded', targets.map(t => t.axis), candidates]);
    if (prefetchKey === labelPrefetchKey) return;
    labelPrefetchKey = prefetchKey;
    const plan = ++labelPrefetchPlan;
    original.setArchiveLabelCandidates(candidates);
    for (let n = 0; n < 6; n++) {
      const key = `label-prefetch:${n}`, old = pendingLabelPrefetch.get(n);
      preparation.cancel(key); pendingLabelPrefetch.delete(n);
      if (old) options.performanceProbe?.diagnostic('resourceUpdates', { kind: 'label-prefetch-state', state: 'cancelled', ...old });
      if (!candidates[n]) continue;
      const target = targets[n], context = { plan, slot: n, intent: target.axis }; pendingLabelPrefetch.set(n, context);
      options.performanceProbe?.diagnostic('resourceUpdates', { kind: 'label-prefetch-state', state: 'queued', ...context,
        lane: target.lane, row: target.row, axis: target.axis, offset: target.offset });
      preparation.enqueue(key, () => {
        pendingLabelPrefetch.delete(n);
        options.performanceProbe?.diagnostic('resourceUpdates', { kind: 'label-prefetch-state', state: 'started', ...context });
        try { original.prepareArchiveLabel(candidates[n], context); }
        catch (error) { options.performanceProbe?.diagnostic('resourceUpdates', { kind: 'label-prefetch-state', state: 'failed', ...context }); throw error; }
      }, target.axis === 'pointer' ? 5 : target.axis === 'activity' ? 4 : -2);
    }
  };
  const notifyArchive = () => {
    const source = currentArchiveSource();
    const inspected = location === 'desk' && selectedId ? sourceList.find(item => item.id === selectedId) : undefined;
    const labelSource = inspected || source;
    original.setArchiveLabel(labelSource ? archivePrint(labelSource) : null);
    syncLabelPrefetch();
    options.onArchiveSelect?.(archiveIndex);
    // Empty lanes still participate in the original mechanical loop. Keep
    // the last real UI selection, otherwise source synchronization repeatedly
    // falls back to the first result and pulls the moving track backwards.
    if (source || !archiveBusy()) options.onArchiveSourceSelect?.(source?.id || null, archiveLaneIndex, userOwnsView());
  };
  const chooseArchive = (index: number, navigation?: ArchiveNavigation) => {
    archiveIndex = wrap(index, 40);
    archiveLaneIndex = fileLocation(archiveIndex).lane;
    slotRows[archiveLaneIndex] = archiveIndex % 8;
    if (detail) { detail = false; original.setMode('archive'); }
    original.select(archiveIndex, navigation);
    notifyArchive(); wake();
  };
  const stepArchive = (axis: 'row' | 'lane', direction: number) => {
    if (disposed || location !== 'archive' || detail) return;
    const step = direction < 0 ? -1 : 1;
    if (axis === 'row') {
      const count = lanes[archiveLaneIndex].length;
      if (count) laneRows[archiveLaneIndex] = wrap(laneRows[archiveLaneIndex] + step, count);
      chooseArchive(archiveLaneIndex * 8 + wrap(slotRows[archiveLaneIndex] + step, 8), { axis: 'row', direction: step });
    } else {
      const next = wrap(archiveLaneIndex + step, archiveColumns.length);
      chooseArchive(next * 8 + slotRows[next], { axis: 'lane', direction: step });
    }
  };
  const acceptArchiveNavigation = (intent: Record<string, string | number> = {}) => {
    if (disposed || !active || contextLost || document.hidden || location !== 'archive' || detail) return false;
    prioritizeUser();
    if (!navigationLimiter.tryAccept(performance.now(), original.returningFileCount)) return false;
    hoveredArchive = null;
    options.performanceProbe?.mark('archive-navigation', { returningFiles: original.returningFileCount, fromLane: archiveLaneIndex, fromRow: laneRows[archiveLaneIndex], ...intent });
    return true;
  };
  const navigate = (axis: 'row' | 'lane', direction: number) => {
    const step = direction < 0 ? -1 : 1, targetLane = axis === 'lane' ? wrap(archiveLaneIndex + step, lanes.length) : archiveLaneIndex;
    const count = lanes[targetLane].length, targetRow = count ? wrap(laneRows[targetLane] + (axis === 'row' ? step : 0), count) : 0;
    if (!direction || !acceptArchiveNavigation({ method: 'step', axis, direction: step, targetLane, targetRow })) return false;
    stepArchive(axis, direction);
    return true;
  };
  const focusArchiveSource = (id: string) => {
    const source = archiveSources.find(item => item.id === id);
    if (!source || disposed) return;
    const lane = archiveLane(source);
    const index = sourceSlot(source);
    laneRows[lane] = lanes[lane].indexOf(source);
    // Preserve the current physical occurrence in the infinite track when
    // incoming source metadata reselects a document already under the cursor.
    chooseArchive(index);
  };
  const selectArchiveSource = (id: string, userInitiated = true) => {
    if (userInitiated) prioritizeUser();
    focusArchiveSource(id);
  };
  // Browsing ticks are rate limited; explicit Open and data synchronization
  // continue to select their requested source immediately and accurately.
  const browseArchiveSource = (id: string) => {
    const source = archiveSources.find(item => item.id === id);
    if (!source || id === currentArchiveSource()?.id) return false;
    const lane = archiveLane(source);
    if (!acceptArchiveNavigation({ method: 'source', targetLane: lane, targetRow: lanes[lane].indexOf(source) })) return false;
    focusArchiveSource(id); return true;
  };
  const setArchiveSources = (next: ArchiveSource[]) => {
    if (disposed) return;
    const previous = currentArchiveSource();
    const previousLaneIds = lanes.map((sources, lane) => sources[laneRows[lane]]?.id);
    archiveSources = [...new Map(next.map(source => [sourceIdentity(source), source])).values()];
    lanes = archiveColumns.map((_, lane) => archiveSources.filter(source => archiveLane(source) === lane));
    lanes.forEach((sources, lane) => {
      const old = sources.findIndex(source => source.id === previousLaneIds[lane]);
      laneRows[lane] = old >= 0 ? old : Math.min(laneRows[lane], Math.max(0, sources.length - 1));
    });
    if (!previous && archiveSources.length && !currentArchiveSource() && location === 'archive' && !detail && !archiveBusy()) {
      const first = archiveSources[0];
      archiveLaneIndex = archiveLane(first);
      laneRows[archiveLaneIndex] = lanes[archiveLaneIndex].indexOf(first);
      chooseArchive(archiveLaneIndex * 8 + slotRows[archiveLaneIndex]);
    } else notifyArchive();
    for (const [id, file] of files) {
      const source = sourceList.find(item => item.id === id);
      if (source) updateShelfMetadata(file, source);
    }
    wake();
  };
  original.onLabelOpen = id => {
    if (!disposed && active && location === 'archive' && !detail && archiveSources.some(source => source.id === id)) {
      prioritizeUser(); options.onArchiveSourceOpen?.(id);
    }
  };
  let arrayPointerAccepted = true;
  original.onHover = (index, cell) => {
    const next = index !== null && active && !contextLost && location === 'archive' && !detail && !cameraTravel
      ? { index, cell } : null;
    if (next?.index === hoveredArchive?.index && next?.cell?.lane === hoveredArchive?.cell?.lane
      && next?.cell?.row === hoveredArchive?.cell?.row) return;
    hoveredArchive = next; syncLabelPrefetch();
  };
  original.onSelect = (index, cell) => {
    if (location !== 'archive' || detail) return;
    const target = pointerTarget(index, cell);
    // The selected cell opens the reader; it does not step again.
    if (!target) { arrayPointerAccepted = true; return; }
    const { lane, row, delta } = target;
    arrayPointerAccepted = acceptArchiveNavigation({ method: 'scene-pick', targetLane: lane, targetRow: row, rowDelta: delta });
    if (!arrayPointerAccepted) return;
    if (lanes[lane].length) laneRows[lane] = row;
    chooseArchive(index, cell ? { cell } : undefined);
  };
  original.onNavigate = (axis, direction) => {
    if (location === 'desk') browseShelf(direction);
    else navigate(axis, direction);
  };

  const setSources = (next: ArchiveSource[], animate = true) => {
    options.performanceProbe?.mark('sources-update', { count: next.length, animate });
    if (disposed) return;
    const unique = [...new Map(next.map(source => [sourceIdentity(source), source])).values()];
    const priorIdentities = new Set(sourceList.map(sourceIdentity));
    const byIdentity = new Map(unique.map(source => [sourceIdentity(source), source]));
    // Incoming results may be re-sorted by relevance. Shelf placement remains
    // the user's arrival order, including unchanged identities with new labels.
    sourceList = [
      ...sourceList.flatMap(old => {
        const source = byIdentity.get(sourceIdentity(old));
        if (!source) return [];
        byIdentity.delete(sourceIdentity(old));
        return [{ ...source, id: old.id }];
      }),
      ...byIdentity.values(),
    ];
    sourceIds = new Set(sourceList.map(source => source.id));
    if (selectedId && !sourceIds.has(selectedId)) selectedId = null;
    const priorFocus = focusedId;
    const priorPage = shelfPage;
    syncCollection();
    for (const item of [...activityQueue, ...activityFiles]) {
      const source = item.source && sourceList.find(source => sourceIdentity(source) === sourceIdentity(item.source!));
      if (!source) continue;
      item.source = source;
      if ('group' in item) original.setCollectionLabel((item as ActivityFile).group, sourceNumber(source), { title: source.title, sourceId: source.id });
    }
    const arrivals = sourceList.filter(source => !priorIdentities.has(sourceIdentity(source))
      && (!source.callId || !historicalOperations.has(source.callId)
        && (investigation?.operations === undefined || operations.has(source.callId))));
    if (animate && arrivals.length) arrivalScanRemaining = Math.max(arrivalScanRemaining, 2.8);
    // Every result is available immediately. A large batch uses up to three
    // actual documents to show its arrival, without minutes of obsolete motion.
    for (const source of arrivals) {
      if (!animate || reduced) transferred.add(sourceIdentity(source));
      else waitingArrivals.add(sourceIdentity(source));
    }
    if (animate && !reduced && active && !document.hidden) {
      const candidates = arrivals.filter(source => !hasReadActivity(source));
      for (const source of candidates.slice(0, 3)) enqueueActivity({
        key: `arrival:${sourceIdentity(source)}`, source, kind: 'arrival', age: 0,
      });
    }
    if (priorFocus !== focusedId || priorPage !== shelfPage) notifyShelf();
    wake();
  };
  const hasReadActivity = (source: ArchiveSource) => [...activityQueue, ...activityFiles].some(item =>
    item.kind === 'read' && item.source && sourceIdentity(item.source) === sourceIdentity(source));
  const enqueueActivity = (request: ActivityRequest) => {
    if (activityQueue.some(item => item.key === request.key) || activityFiles.some(item => item.key === request.key)) return;
    if (request.kind === 'read' && request.source) {
      // A returned document and its read receipt can arrive in the same frame.
      // Give that single document a reading sequence instead of a second copy.
      const arrival = activityQueue.findIndex(item => item.kind === 'arrival' && item.source
        && sourceIdentity(item.source) === sourceIdentity(request.source!));
      if (arrival >= 0) activityQueue.splice(arrival, 1);
      const extracting = activityFiles.find(item => item.kind === 'arrival' && item.stage !== 'travelling'
        && item.source && sourceIdentity(item.source) === sourceIdentity(request.source!));
      if (extracting) {
        Object.assign(extracting, request);
        original.setCollectionLabel(extracting.group, sourceNumber(request.source), { title: request.source.title, sourceId: request.source.id });
        return;
      }
    }
    activityQueue.push(request);
    while (activityQueue.length > MAX_ACTIVITY_QUEUE) {
      const disposable = activityQueue.findIndex(item => item.kind === 'arrival');
      activityQueue.splice(disposable >= 0 ? disposable : 0, 1);
    }
    syncLabelPrefetch();
  };
  const clearActivities = () => {
    for (const item of activityFiles) original.disposeCollectionFile(item.group);
    activityFiles.length = 0; activityQueue.length = 0; activityLabelSource = null;
    syncLabelPrefetch();
    original.setInvestigationSlots([]);
  };
  const operationSources = (operation: ArchiveOperation): ArchiveSource[] => {
    const available = [...new Map([...(investigation?.sources || []), ...archiveSources, ...sourceList]
      .map(source => [sourceIdentity(source), source])).values()];
    const returned = operation.sourceIds.flatMap(id => {
      const receipt = investigation?.sources.find(source => source.id === id);
      const source = available.find(source => source.id === id || receipt && sourceIdentity(source) === sourceIdentity(receipt));
      return source ? [source] : [];
    });
    if (returned.length) return returned;
    if (operation.state !== 'active') return [];
    if (operation.tool === 'web_fetch') {
      const source = operationSource(operation, available);
      return source ? [source] : [];
    }
    const matches = available.filter(source => (!operation.dataVersion || source.dataVersion === operation.dataVersion)
      && (operation.documentId ? source.documentId === operation.documentId
        : operation.documentUid ? source.documentUid === operation.documentUid
          : operation.sourceRef ? source.sourceRef === operation.sourceRef : false));
    return matches.length === 1 ? matches : [];
  };
  const observeOperations = () => {
    const snapshot = investigation;
    if (!snapshot) return;
    // Legacy hosts still get an honest unnumbered mechanism for an active read.
    const current: ArchiveOperation[] = snapshot.operations || (snapshot.running && snapshot.phase === 'reading' ? [{
      id: `legacy:${snapshot.investigationId || ''}:${snapshot.tool}:${snapshot.activeDocumentId || snapshot.activeSourceRef || ''}`,
      tool: snapshot.tool, kind: 'read', state: 'active', sourceIds: [],
      documentId: snapshot.activeDocumentId, sourceRef: snapshot.activeSourceRef, dataVersion: snapshot.activeDataVersion,
    }] : []);
    const priorOperations = operations;
    operations = new Map(current.map(operation => [operation.id, operation]));
    for (const activity of [...activityQueue, ...activityFiles]) {
      const prior = activity.operationId && priorOperations.get(activity.operationId);
      // Sending the next question must not cancel an already confirmed receipt
      // while its visual lift is still playing. Missing active calls do retire.
      if (prior && prior.state === 'complete' && !operations.has(prior.id)) operations.set(prior.id, prior);
    }
    for (const operation of current) {
      const previous = observedOperations.get(operation.id);
      observedOperations.set(operation.id, operation.state);
      // Opening an old conversation establishes a baseline, never a replay.
      const historical = operation.state !== 'active' && (!operationsInitialized
        || previous === undefined && (Number.isFinite(operation.completedAt)
          ? operation.completedAt! < activitySince : snapshot.loadingHistory));
      if (historical) historicalOperations.add(operation.id);
      if (operation.kind !== 'read' || operation.state === 'error' || historical
        || previous === 'complete' && !scheduledReads.has(`${operation.id}:0`)) continue;
      const returned = operationSources(operation);
      const targets: (ArchiveSource | undefined)[] = returned.length ? returned : [undefined];
      targets.forEach((source, index) => {
        const key = `${operation.id}:${index}`;
        const existing = [...activityQueue, ...activityFiles].find(item => item.key === key);
        if (existing && source) {
          existing.source = source;
          if ('group' in existing) {
            const actor = existing as ActivityFile;
            const number = sourceNumber(source);
            original.setCollectionLabel(actor.group, number >= 0 ? number : null, { title: source.title, sourceId: source.id });
          }
        }
        if (scheduledReads.has(key) || !active || document.hidden || reduced) return;
        scheduledReads.add(key);
        enqueueActivity({ key, operationId: operation.id, source, kind: 'read', age: 0 });
      });
    }
    operationsInitialized = true;
    // The snapshot only contains this turn. Bound retained IDs across long chats.
    if (observedOperations.size > 2048) {
      for (const id of observedOperations.keys()) if (!operations.has(id)) observedOperations.delete(id);
      for (const id of historicalOperations) if (!operations.has(id)) historicalOperations.delete(id);
      for (const key of scheduledReads) if (!current.some(item => key.startsWith(`${item.id}:`))) scheduledReads.delete(key);
    }
  };
  const setInvestigation = (snapshot: InvestigationSnapshot) => {
    if (disposed) return;
    investigation = snapshot;
    if (sessionId !== null && sessionId !== snapshot.sessionId) {
      setBoardTool({ mode: 'select' });
      clearActivities(); transferred.clear(); waitingArrivals.clear();
      observedOperations.clear(); historicalOperations.clear(); scheduledReads.clear(); operations.clear(); operationsInitialized = false;
      activitySince = Date.now();
      userPriorityUntil = 0; searching = false; arrivalScanRemaining = 0;
      scanElapsed = ARCHIVE_STEP_SECONDS - 0.35; scanSteps = 0;
      selectedId = null; focusedId = null; shelfPage = 0;
      setSources([], false); setArchiveSources([]);
    }
    sessionId = snapshot.sessionId;
    // Local directory loading and host investigation state have independent
    // lifetimes. Streaming snapshots must not reset the mechanical scan timer.
    observeOperations(); wake();
  };

  const occupyingArray = (actor: ActivityFile) => actor.stage !== 'travelling' || actor.elapsed < 2.4 * 0.28;
  const releaseActivitySlot = (actor: ActivityFile) => {
    if (actor.released) return;
    original.departInvestigationSlot(actor.index);
    actor.released = true;
  };
  const syncActivitySlots = () => {
    for (const actor of activityFiles) if (!occupyingArray(actor)) releaseActivitySlot(actor);
    original.setInvestigationSlots(activityFiles.filter(occupyingArray).map(item => item.index));
  };
  const finishActivity = (actor: ActivityFile) => {
    if (actor.stage === 'travelling') releaseActivitySlot(actor);
    if (actor.source && actor.stage === 'travelling') {
      const identity = sourceIdentity(actor.source);
      transferred.add(identity);
      if (!visibleIds.some(id => sourceList.find(source => source.id === id && sourceIdentity(source) === identity))) waitingArrivals.add(identity);
      else waitingArrivals.delete(identity);
      const file = [...files.values()].find(file => {
        const source = sourceList.find(source => source.id === file.id);
        return source && sourceIdentity(source) === identity;
      });
      if (file) file.arrival = 0;
    }
    original.disposeCollectionFile(actor.group);
    activityFiles.splice(activityFiles.indexOf(actor), 1);
  };
  const activityDestination = (actor: ActivityFile) => {
    const source = actor.source;
    const canonical = source && sourceList.find(item => sourceIdentity(item) === sourceIdentity(source));
    if (canonical && visibleIds.includes(canonical.id)) return deskPose(canonical.id);
    // Other pages continue beyond the view's right edge. Never land a second
    // document on an occupied visible slot or switch the user's current page.
    return SHELF_CENTER.clone().addScaledVector(SHELF_RIGHT, 24).add(new THREE.Vector3(0, 0.28, 0));
  };
  const beginReturn = (actor: ActivityFile) => {
    if (actor.stage === 'returning') return;
    actor.departure.copy(actor.group.position); actor.orientation.copy(actor.group.quaternion);
    actor.startLift = actor.lift; actor.elapsed = 0; actor.stage = 'returning';
  };
  const updateActivities = (dt: number) => {
    activitySpacing = Math.max(0, activitySpacing - dt);
    for (const request of activityQueue) request.age += dt;
    const queuedBefore = activityQueue.length;
    for (let index = activityQueue.length - 1; index >= 0; index--) {
      const request = activityQueue[index];
      const operation = request.operationId ? operations.get(request.operationId) : undefined;
      if (operation?.state === 'error' || request.age > 9 && operation?.state !== 'active') activityQueue.splice(index, 1);
    }
    if (activityQueue.length !== queuedBefore) { activityLabelSource = null; syncLabelPrefetch(); }
    // Explicit browsing owns the view. Pointer hover does not cancel a running
    // lift, and a finished fast tool still receives its full minimum sequence.
    if (!reduced && !detail && !cameraTravel && !userOwnsView()
      && activityFiles.length < MAX_ACTIVITY_FILES && activityQueue.length && activitySpacing === 0) {
      const requestSlot = (request: ActivityRequest) => request.source ? sourceSlot(request.source)
        : Array.from({ length: MAX_ACTIVITY_FILES + 1 }, (_, offset) => archiveLaneIndex * 8 + wrap(slotRows[archiveLaneIndex] + offset, 8))
          .find(index => !activityFiles.some(actor => occupyingArray(actor) && actor.index === index)) ?? archiveIndex;
      const available = (request: ActivityRequest) => {
        const index = requestSlot(request);
        return original.canExtractArchive(index)
          && !activityFiles.some(actor => occupyingArray(actor) && actor.index === index);
      };
      let next = activityQueue.findIndex(request => request.kind === 'read' && available(request));
      if (next < 0) next = activityQueue.findIndex(available);
      if (next >= 0 && activityQueue[next].source) {
        const request = activityQueue[next], source = request.source!;
        if (!original.archiveLabelPrepared(archivePrint(source, true))) {
          if (activityLabelSource !== source) { activityLabelSource = source; syncLabelPrefetch(); }
          request.labelWaitAt ??= performance.now();
          // Do not put synchronous upload work back in the animation callback.
          // A failed preparation cannot indefinitely prevent the visible activity.
          if (performance.now() - request.labelWaitAt < 500) next = -1;
          else options.performanceProbe?.diagnostic('resourceUpdates', { kind: 'label-prefetch-fallback', intent: 'activity', reason: 'deadline' });
        }
      }
      if (next >= 0) {
        const request = activityQueue.splice(next, 1)[0];
        const focusSource = location === 'archive' && !activityFiles.some(occupyingArray) && request.source;
        if (focusSource) focusArchiveSource(focusSource.id);
        const index = requestSlot(request);
        const number = request.source ? sourceNumber(request.source) : -1;
        const group = original.createCollectionFile(number >= 0 ? number : null, request.source ? {
          label: { code: number >= 0 ? `NO.${String(number + 1).padStart(3, '0')}` : 'READING', title: request.source.title, sourceId: request.source.id },
        } : {});
        group.visible = true;
        const pose = original.archiveSourcePose(index);
        group.position.copy(pose.position); group.quaternion.copy(pose.quaternion);
        original.scene.add(group);
        activityFiles.push({ ...request, group, index, elapsed: 0, lift: 0, stage: 'lifting',
          departure: pose.position.clone(), orientation: pose.quaternion.clone(),
          startLift: original.archiveSourceLift(index), targetLift: original.archiveReadingLift(index) });
        activitySpacing = 0.6;
        scanElapsed = 0;
        // Authored signed pulse, fired once at extraction, not every snapshot.
        if (!focusSource) original.pulseInvestigation(index);
        syncActivitySlots();
        activityLabelSource = null; syncLabelPrefetch();
      }
    }
    for (const actor of [...activityFiles]) {
      actor.elapsed += dt;
      const operation = actor.operationId ? operations.get(actor.operationId) : undefined;
      const reading = actor.kind === 'read' && operation?.state === 'active' && investigation?.running;
      const failed = operation?.state === 'error' || actor.operationId && !operation;
      if (reduced) { finishActivity(actor); continue; }
      if (actor.stage !== 'travelling' && (detail || failed)) beginReturn(actor);
      if (actor.stage === 'lifting') {
        if (actor.elapsed >= ACTIVITY_LIFT_SECONDS) { actor.stage = 'holding'; actor.elapsed = 0; }
      } else if (actor.stage === 'holding') {
        if (!reading && actor.elapsed >= (actor.kind === 'read' ? 0.75 : 0.25)) {
          const delivered = actor.kind === 'arrival' || Boolean(operation?.sourceIds.length);
          if (actor.source && delivered && !failed && !transferred.has(sourceIdentity(actor.source))) {
            actor.departure.copy(actor.group.position); actor.orientation.copy(actor.group.quaternion);
            actor.stage = 'travelling'; actor.elapsed = 0;
          } else beginReturn(actor);
        }
      } else if (actor.stage === 'returning') {
        actor.lift = THREE.MathUtils.lerp(actor.startLift, original.archiveSourceLift(actor.index), smooth(actor.elapsed / 0.65));
        if (actor.elapsed >= 0.65) { finishActivity(actor); continue; }
      } else {
        const t = Math.min(1, actor.elapsed / 2.4);
        const destination = activityDestination(actor);
        const entrance = destination.clone(); entrance.x -= SHELF_EXIT_DISTANCE;
        const clearance = Math.max(2.15, actor.departure.y, SHELF_CENTER.y + SHELF_HEIGHT + 1.2);
        // Approach outside the open front, descend to the correct tier, then
        // insert horizontally. Lower-tier arrivals never cross the upper tray.
        if (t < 0.28) {
          actor.group.position.copy(actor.departure);
          actor.group.position.y = THREE.MathUtils.lerp(actor.departure.y, clearance, smooth(t / 0.28));
        } else if (t < 0.60) {
          actor.group.position.lerpVectors(actor.departure, entrance, smooth((t - 0.28) / 0.32));
          actor.group.position.y = clearance;
        } else if (t < 0.80) {
          actor.group.position.copy(entrance);
          actor.group.position.y = THREE.MathUtils.lerp(clearance, destination.y, smooth((t - 0.60) / 0.20));
        } else actor.group.position.lerpVectors(entrance, destination, smooth((t - 0.80) / 0.20));
        actor.group.quaternion.copy(actor.orientation).slerp(rackOrientation, smooth(t / 0.60));
        if (t >= 1) { finishActivity(actor); continue; }
      }
    }
    syncActivitySlots();
  };

  const updateCollection = (dt: number) => {
    const inboxTarget=inboxOpen&&location==='board'&&!detail?1:0;inboxAmount=reduced?inboxTarget:THREE.MathUtils.lerp(inboxAmount,inboxTarget,1-Math.exp(-dt*7));if(Math.abs(inboxAmount-inboxTarget)<.001)inboxAmount=inboxTarget;evidenceInbox.update(inboxAmount);
    if (cameraTravel) {
      const pose = advanceWorkspaceTravel(cameraTravel, dt, reduced);
      boardAmount = pose.board; deskAmount = pose.desk;
      if (pose.complete) cameraTravel = null;
    }
    // Each navigation request blends its endpoints once. Rack ↔ array never
    // borrows the board's raised position, zoom or mid-route easing stop.
    const aspect = host.clientWidth / Math.max(1, host.clientHeight);
    const portrait = aspect < 1.05;
    original.collectionOffset.copy(BOARD_CENTER).multiplyScalar(boardAmount);
    original.collectionOffset.x += (SHELF_X - (portrait ? 2.5 : 0)) * deskAmount;
    original.collectionOffset.y -= 1.3 * deskAmount;
    // Fit both tiers, including the frame, into the right-hand
    // browsing area. Narrow screens use the upper half above the archive list.
    const yaw = THREE.MathUtils.degToRad(59), elevation = THREE.MathUtils.degToRad(19);
    const projectedWidth = RACK_WIDTH * Math.cos(yaw) + RACK_DEPTH * Math.sin(yaw);
    const projectedHeight = (SHELF_HEIGHT + 0.3) * Math.cos(elevation)
      + (RACK_WIDTH * Math.sin(yaw) + RACK_DEPTH * Math.cos(yaw)) * Math.sin(elevation);
    // Selecting a paper can open the mobile drawer during pointerdown. Keep the
    // camera's current drawing area until that gesture ends, then reframe it.
    if (!down) appliedBoardEditorInset = boardEditorInset;
    const boardVisibleFraction = portrait ? 1 - appliedBoardEditorInset : 1;
    const boardSpan = boardFullscreen
      ? Math.max(9.4 / (0.86 * boardVisibleFraction), 16.2 / (aspect * 0.90))
      : Math.max(11.2 / (portrait ? 0.47 : 0.72), 18.2 / (aspect * (portrait ? 0.91 : 0.80)));
    const rackSpan = Math.max(projectedHeight / (portrait ? 0.39 : 0.64),
      projectedWidth / (aspect * (portrait ? 0.9 : 0.61)));
    const frameAmount = boardAmount + deskAmount;
    if (frameAmount > 0) {
      const blend = deskAmount / frameAmount;
      evidenceBoard.group.localToWorld(boardFocus.set(boardZoomCenter.x, boardZoomCenter.y, 0));
      workspaceFrameCenter.lerpVectors(boardFocus, collectionCenter, blend);
      original.collectionFraming = {
        center: workspaceFrameCenter,
        span: THREE.MathUtils.lerp(boardSpan / boardZoom, rackSpan, blend),
        x: boardFullscreen ? 0.5 : portrait ? 0.5 : THREE.MathUtils.lerp(0.53, 0.67, blend),
        y: boardFullscreen ? boardVisibleFraction / 2 : portrait ? THREE.MathUtils.lerp(0.35, 0.30, blend) : THREE.MathUtils.lerp(0.48, 0.49, blend),
        distance: THREE.MathUtils.lerp(80, 140, blend), amount: frameAmount,
        direction: boardFullscreen ? boardNormal.set(0, 0, 1).applyQuaternion(evidenceBoard.group.quaternion) : undefined,
        parallax: location === 'board' ? false : undefined,
      };
      if(inboxAmount>0){
        evidenceInbox.group.localToWorld(inboxFocus.set(0,4.0,0));
        original.collectionFraming.center.lerp(inboxFocus,inboxAmount);
        original.collectionFraming.span=THREE.MathUtils.lerp(original.collectionFraming.span,portrait?18:12,inboxAmount);
        original.collectionFraming.x=THREE.MathUtils.lerp(original.collectionFraming.x,portrait?.5:.26,inboxAmount);
        original.collectionFraming.y=THREE.MathUtils.lerp(original.collectionFraming.y,portrait?.25:.60,inboxAmount);
      }
    } else original.collectionFraming = undefined;
    // Retain the authored focus anchor; the rack view itself uses a sharp image
    // across both tiers through effectiveQuality().
    original.collectionFocus = deskAmount > 0.7 ? collectionFocus : undefined;
    original.collectionDetailPosition = deskAmount > 0 ? readingPosition : undefined;
    // Keep neighbouring stations in the shared scene; the focused board view
    // temporarily hides them so a shelf cannot occlude the board when panning.
    original.collectionArrayVisible = (!boardFullscreen || detail) && inboxAmount < .05;
    const readingReveal=readingObject.group.visible?readingObject.boardReveal(reduced):1;
    evidenceBoard.setReveal(readingReveal*(1-inboxAmount*.94));
    evidenceInbox.setReveal(boardFullscreen&&!inboxOpen?0:readingReveal);
    rack.visible = !boardFullscreen && inboxAmount < .05;
    for (const file of files.values()) {
      // Extract the selected cassette from the same rack. Its neighbours stay
      // in place throughout the outward and return paths.
      file.group.visible = !boardFullscreen && inboxAmount < .05;
      const target = file.id === selectedId ? 1 : 0;
      file.progress = reduced ? target : THREE.MathUtils.lerp(file.progress, target, 1 - Math.exp(-dt * 7));
      const focusTarget = file.id === focusedId ? 1 : 0;
      file.focus = reduced ? focusTarget : THREE.MathUtils.lerp(file.focus, focusTarget, 1 - Math.exp(-dt * 10));
      if (Math.abs(file.progress - target) < 0.001) file.progress = target;
      file.group.position.copy(deskPose(file.id));
      file.arrival = reduced ? 1 : Math.min(1, file.arrival + dt / 0.5);
      file.group.position.x -= file.focus * 0.50 + (1 - smooth(file.arrival)) * 0.36;
      file.group.rotation.set(0, SHELF_YAW, 0);
    }
    updateActivities(dt);
    const readers = activityFiles.filter(actor => occupyingArray(actor) && actor.kind === 'read');
    const frameRead = location === 'archive' && !detail && !userOwnsView() && readers.length > 0;
    activityFrameAmount = THREE.MathUtils.lerp(activityFrameAmount, frameRead ? 1 : 0, 1 - Math.exp(-dt * 3.5));
    if (activityFrameAmount < 0.001) activityFrameAmount = 0;
    if (frameRead) {
      activityFrameCenter.set(0, 0, 0);
      for (const actor of readers) activityFrameCenter.add(actor.group.position);
      activityFrameCenter.multiplyScalar(1 / readers.length).y += 1.85;
    }
    if (frameAmount === 0 && activityFrameAmount > 0) original.collectionFraming = {
      center: activityFrameCenter, span: Math.max(10.5, 7.5 / aspect),
      x: portrait ? 0.5 : 0.32, y: portrait ? 0.28 : 0.42,
      amount: activityFrameAmount, distance: 140,
    };
    for (const actor of activityFiles) actor.group.visible = !boardFullscreen && inboxAmount < .05;
  };
  original.beforeRender = () => {
    readingObject.update(original.camera, host.clientWidth, host.clientHeight, reduced);
    const inboxAnchor=evidenceInbox.anchor(original.camera,host.clientWidth,host.clientHeight);
    options.onInboxAnchor?.({...inboxAnchor,visible:inboxAnchor.visible&&location==='board'&&!detail&&!cameraTravel&&!inboxOpen&&!readingObject.group.visible});
    for (const actor of activityFiles) {
      if (actor.stage === 'travelling') {
        if (occupyingArray(actor)) {
          const pose = original.archiveSourcePose(actor.index);
          actor.group.position.x = actor.departure.x = pose.position.x;
          actor.group.position.z = actor.departure.z = pose.position.z;
        }
        continue;
      }
      const pose = original.archiveReadingPose(actor.index);
      // Lift the entire body clear of neighbouring crests, independently of
      // the selected slot's 0.4 preview lift. A long tool call holds it here.
      actor.targetLift = Math.max(actor.targetLift, original.archiveReadingLift(actor.index));
      if (actor.stage !== 'returning') actor.lift = THREE.MathUtils.lerp(actor.startLift, actor.targetLift,
        actor.stage === 'holding' ? 1 : smooth(actor.elapsed / ACTIVITY_LIFT_SECONDS));
      actor.group.position.copy(pose.position);
      actor.group.position.y += actor.lift;
      actor.group.quaternion.copy(pose.quaternion);
      original.setCollectionAppearance(actor.group, actor.lift);
    }
    if (deskAmount <= 0) {
      // The rack is also visible beside the board; keep its angle-dependent
      // interior representation current while it is a neighbouring station.
      for (const file of files.values()) original.setShelfDetail(file.group,
        file.progress > 0 || file.focus > 0.001 || file.arrival < 1);
      return;
    }
    const targetOrientation = original.collectionOrientation;
    for (const file of files.values()) {
      const progress = file.progress;
      if (progress <= 0) continue;
      const pose = shelfReadingPath(visibleIds.indexOf(file.id), progress, file.focus);
      file.group.position.copy(SHELF_CENTER).add(new THREE.Vector3(pose.x, pose.y, pose.z));
      file.group.quaternion.copy(rackOrientation).slerp(targetOrientation, pose.turn);
    }
    const inspected = selectedId ? files.get(selectedId) : undefined;
    if (inspected && deskAmount > 0.7) original.collectionFocus = inspected.group.position.clone().add(new THREE.Vector3(0, 2, 0));
    for (const file of files.values()) original.setShelfDetail(file.group,
      file.id === selectedId || file.progress > 0 || file.focus > 0.001 || file.arrival < 1);
  };

  function wake() {
    if (disposed || !active || contextLost || document.hidden || raf) return;
    raf = requestAnimationFrame(frame);
  }
  function frame(ms: number) {
    raf = 0;
    if (disposed || !active || contextLost || document.hidden) { lastFrame = 0; return; }
    // TEMPORARY RHINE PROFILER: includes collection updates and every composer pass.
    const measured = options.performanceProbe?.running ? options.performanceProbe.begin(ms, original.renderer,
      `${detail ? 'detail' : cameraTravel ? 'travel' : location === 'desk' ? 'rack' : location === 'board' ? 'board' : 'array'}${scanningActive() ? ':search' : ''}${activityFiles.length ? ':activity' : ''}`) : undefined;
    let failed = true;
    try {
      const dt = lastFrame ? Math.min(0.05, (ms - lastFrame) / 1000) : 0.016;
      lastFrame = ms;
      const scanning = scanningActive() && location === 'archive' && !detail && !reduced && !userOwnsView();
      original.setInvestigationScanning(scanning);
      // Use precisely the original select path: track, shoulder, signed pulse and
      // preview lift. Allow its spring to settle before advancing to the next cell.
      if (scanning && !original.isArchiveRefilling && !activityFiles.some(item => item.stage === 'lifting' || item.stage === 'returning'
        || item.stage === 'travelling' && occupyingArray(item))) {
        scanElapsed += dt;
        if (scanElapsed >= ARCHIVE_STEP_SECONDS) {
          scanElapsed = 0;
          options.performanceProbe?.mark('automatic-scan-step', { activityFiles: activityFiles.length });
          if (activityFiles.some(item => item.stage === 'holding')) {
            // A parallel search can keep moving beside a long read without
            // carrying its pinned cassette all the way out of the composition.
            stepArchive('row', readingScanDirection);
            readingScanDirection *= -1;
          } else {
            readingScanDirection = 1;
            stepArchive(++scanSteps % 3 === 0 ? 'lane' : 'row', 1);
          }
        }
      }
      arrivalScanRemaining = Math.max(0, arrivalScanRemaining - dt);
      updateCollection(dt);
      evidenceBoard.update(dt);
      options.performanceProbe?.checkpoint(measured, 'collection');
      original.update(ms / 1000, undefined, measured ? stage => options.performanceProbe!.checkpoint(measured, stage) : undefined);
      syncBoardAnchors();
      options.onDetailFrame?.(original.detailVisibility);
      renderedFrames++;
      // A loaded GLB is not a ready frame: shelf geometry, label textures and
      // programs are prepared between frames. Reveal only after they settle.
      if (readyWaiters.size) {
        const pending = preparation.stats();
        if (!pending.pending && !pending.running && !pendingShelf.size && !original.isArchiveRefilling) {
          for (const waiter of readyWaiters) waiter.resolve();
          readyWaiters.clear();
        }
      }
      options.performanceProbe?.checkpoint(measured, 'uiSync');
      if (measured) measured.sample.counters = { ...measured.sample.counters, ...original.performanceCounters(),
        rackVisible: rack.visible, boardVisible: evidenceBoard.group.visible, boardCards: boardCards.length,
        shelfVisibleFiles: [...files.values()].reduce((n, file) => n + Number(file.group.visible), 0),
        activityLifting: activityFiles.filter(file => file.stage === 'lifting').length,
        activityTravelling: activityFiles.filter(file => file.stage === 'travelling').length,
        movingCamera: Boolean(cameraTravel), detailOpen: detail,
        activityFiles: activityFiles.length, queuedActivities: activityQueue.length, physicalFiles: files.size,
        preparationPending: preparation.stats().pending, sourceCount: sourceList.length, scanSteps };
      if (!raf) raf = requestAnimationFrame(frame);
      failed = false;
    } finally { options.performanceProbe?.end(measured, failed); }
  }
  const resize = () => { if (!disposed) { setBoardTool({ mode: 'select' }); original.resize();
    anchorWidth = host.clientWidth; anchorHeight = host.clientHeight; anchorsDirty = true; wake(); } };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  document.addEventListener('visibilitychange', () => {
    preparation.setActive(active && !contextLost && !document.hidden);
    if (document.hidden) { setBoardTool({ mode: 'select' }); boardPanKey = false; cancelAnimationFrame(raf); raf = 0; lastFrame = 0; }
    else wake();
  }, { signal: events.signal });

  let lastWheel = 0;
  let boardWheelAnchor: { x: number; y: number; screenX: number; screenY: number; time: number; direction: number } | null = null;
  original.renderer.domElement.addEventListener('wheel', event => {
    if (detail) return;
    if (location === 'board') {
      // Keep browser zoom/pinch available; overlay scroll never targets this canvas.
      if (event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      if (cameraTravel || down || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientHeight : 1;
      const delta = THREE.MathUtils.clamp(event.deltaY * unit, -240, 240);
      if (!Number.isFinite(delta) || delta === 0) return;
      const nextZoom = THREE.MathUtils.clamp(boardZoom * Math.exp(-delta * 0.0016), BOARD_ZOOM_MIN, BOARD_ZOOM_MAX);
      if (nextZoom === boardZoom) return;
      // A modest shift toward the pointer keeps outer papers accessible when
      // enlarged. Empty surrounding space zooms around the current board focus.
      // Hold the anchor through a wheel burst while the camera catches up.
      const now = performance.now(), direction = Math.sign(delta);
      if (!boardWheelAnchor || now - boardWheelAnchor.time > 200 || boardWheelAnchor.direction !== direction
        || Math.hypot(event.clientX - boardWheelAnchor.screenX, event.clientY - boardWheelAnchor.screenY) > 8) {
        pointRay(event);
        const point = evidenceBoard.boardPoint(raycaster);
        const anchor = point && Math.abs(point.x) <= 8.1 && Math.abs(point.y) <= 4.7 ? point : boardZoomCenter;
        boardWheelAnchor = { x: anchor.x, y: anchor.y, screenX: event.clientX, screenY: event.clientY, time: now, direction };
      }
      boardWheelAnchor.time = now;
      const ratio = boardZoom / nextZoom;
      boardZoomCenter.set(boardWheelAnchor.x + (boardZoomCenter.x - boardWheelAnchor.x) * ratio,
        boardWheelAnchor.y + (boardZoomCenter.y - boardWheelAnchor.y) * ratio);
      clampBoardCenter();
      boardZoom = nextZoom;
      evidenceBoard.setPlacementPreview(null); evidenceBoard.setConnectionPreview(boardTool.mode === 'connect' ? boardTool.fromId || null : null);
      prioritizeUser(); wake(); return;
    }
    event.preventDefault();
    if (Math.max(Math.abs(event.deltaX), Math.abs(event.deltaY)) < 3) return;
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const direction = (horizontal ? event.deltaX : event.deltaY) > 0 ? 1 : -1;
    if (location === 'desk') {
      const now = performance.now();
      if (now - lastWheel < 180) return;
      lastWheel = now;
      if (horizontal || event.shiftKey) showShelfPage(shelfPage + direction);
      else browseShelf(direction);
    } else navigate(horizontal || event.shiftKey ? 'lane' : 'row', direction);
  }, { passive: false, signal: events.signal });
  original.renderer.domElement.addEventListener('dblclick', event => {
    if (location === 'board' && !detail && !cameraTravel && !boardDrag && !boardResize && !boardPan && !boardPress && boardTool.mode === 'select') {
      pointRay(event);
      if (!evidenceBoard.pick(raycaster)) {
        resetBoardView();
      }
      return;
    }
    if (location === 'archive' && arrayPointerAccepted) {
      const source = currentArchiveSource();
      if (source) options.onArchiveSourceOpen?.(source.id);
      options.onArchiveOpen?.(archiveIndex);
    }
  }, { signal: events.signal });
  const pointer = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  raycaster.layers.enable(1); // Printed archive labels use the final-resolution layer.
  let down: { x: number; y: number } | null = null;
  let boardDrag: { id: string; pointerId: number; offsetX: number; offsetY: number; x: number; y: number;
    rect: DOMRect; camera: THREE.PerspectiveCamera; moved: boolean } | null = null;
  let boardResize: { id: string; pointerId: number; start: { x: number; y: number }; initialScale: number;
    anchorX: number; anchorY: number; diagonalX: number; diagonalY: number; maximum: number;
    scale: number; x: number; y: number; rect: DOMRect; camera: THREE.PerspectiveCamera; moved: boolean } | null = null;
  let boardPan: { pointerId: number; startX: number; startY: number; center: THREE.Vector2;
    rect: DOMRect; camera: THREE.PerspectiveCamera; moved: boolean; clearSelection: boolean } | null = null;
  let boardPanKey = false;
  let boardPress: { pointerId: number; kind: 'chalk' | 'tool'; cardId: string | null; moved: boolean } | null = null;
  const insideBoard = (point: { x: number; y: number } | null) => point
    && point.x >= EVIDENCE_WRITING_BOUNDS.left && point.x <= EVIDENCE_WRITING_BOUNDS.right
    && point.y >= EVIDENCE_WRITING_BOUNDS.bottom && point.y <= EVIDENCE_WRITING_BOUNDS.top;
  function updateToolPreview(event: { clientX: number; clientY: number }) {
    if (boardTool.mode === 'select') return;
    pointRay(event);
    const point = evidenceBoard.boardPoint(raycaster);
    const usable = insideBoard(point) ? point! : undefined;
    if (boardTool.mode === 'place') evidenceBoard.setPlacementPreview(boardTool.template,
      usable && !evidenceBoard.pick(raycaster) ? usable : undefined);
    else evidenceBoard.setConnectionPreview(boardTool.fromId || null, usable);
  }
  function setBoardTool(tool: EvidenceBoardTool) {
    if (disposed) return;
    cancelBoardDrag();
    evidenceBoard.setPlacementPreview(null); evidenceBoard.setConnectionPreview(null);
    const next: EvidenceBoardTool = tool.mode === 'select' || location !== 'board' || detail || !active || contextLost
      ? { mode: 'select' } : { ...tool };
    boardTool = next;
    evidenceBoard.setResizeEnabled(next.mode === 'select');
    if (next.mode === 'connect') evidenceBoard.setConnectionPreview(next.fromId || null);
    options.onBoardToolChange?.(next);
    original.renderer.domElement.style.cursor = location === 'board' ? next.mode === 'select' ? 'grab' : 'crosshair' : '';
    wake();
  }
  function zoomBoard(direction: -1 | 1) {
    if (disposed || location !== 'board' || detail || cameraTravel || down) return;
    boardWheelAnchor = null;
    boardZoom = THREE.MathUtils.clamp(boardZoom * (direction > 0 ? 1.2 : 1 / 1.2), BOARD_ZOOM_MIN, BOARD_ZOOM_MAX);
    evidenceBoard.setPlacementPreview(null); evidenceBoard.setConnectionPreview(boardTool.mode === 'connect' ? boardTool.fromId || null : null);
    prioritizeUser(); wake();
  }
  const clampBoardCenter = () => {
    boardZoomCenter.x = THREE.MathUtils.clamp(boardZoomCenter.x, -7.5, 7.5);
    boardZoomCenter.y = THREE.MathUtils.clamp(boardZoomCenter.y, -4.3, 4.3);
  };
  const pointRay = (event: { clientX: number; clientY: number }) => {
    const rect = original.renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, original.camera);
  };
  const pickResizeHandle = (event: { clientX: number; clientY: number; pointerType?: string }) => {
    // Use a screen-sized hit margin around the small physical corner mark.
    // Convert it through the board plane so both slanted and enlarged views work.
    const center = evidenceBoard.boardPoint(raycaster);
    if (!center) return null;
    const pixels = event.pointerType === 'touch' ? 18 : 11;
    pointRay({ clientX: event.clientX + pixels, clientY: event.clientY + pixels });
    const edge = evidenceBoard.boardPoint(raycaster);
    pointRay(event);
    const tolerance = edge ? Math.max(0.11, Math.hypot(edge.x - center.x, edge.y - center.y) / Math.SQRT2) : 0.22;
    return evidenceBoard.pickResizeHandle(raycaster, tolerance);
  };
  const cancelBoardDrag = () => {
    const drag = boardDrag, sizing = boardResize, pan = boardPan, press = boardPress;
    boardDrag = null; boardResize = null; boardPan = null; boardPress = null; down = null;
    if (drag || sizing) {
      evidenceBoard.setCards(boardCards);
      const pointerId = (drag || sizing)!.pointerId;
      if (original.renderer.domElement.hasPointerCapture(pointerId)) original.renderer.domElement.releasePointerCapture(pointerId);
    }
    if (press && original.renderer.domElement.hasPointerCapture(press.pointerId)) original.renderer.domElement.releasePointerCapture(press.pointerId);
    if (pan && original.renderer.domElement.hasPointerCapture(pan.pointerId)) original.renderer.domElement.releasePointerCapture(pan.pointerId);
    original.renderer.domElement.style.cursor = location === 'board' ? 'grab' : '';
  };
  function cancelBoardGesture() {
    if (!boardDrag && !boardResize && !boardPan && !boardPress) return false;
    setBoardTool({ mode: 'select' }); return true;
  }
  function resetBoardView() {
    if (disposed) return;
    setBoardTool({ mode: 'select' }); boardWheelAnchor = null;
    boardZoom = BOARD_ZOOM_MIN; boardZoomCenter.set(0, 0);
    prioritizeUser(); wake();
  }
  function setBoardFullscreen(value: boolean) {
    if (disposed || boardFullscreen === value || value && location !== 'board') return;
    setBoardTool({ mode: 'select' }); boardWheelAnchor = null; boardPanKey = false;
    if (value) {
      boardOverview = { zoom: boardZoom, center: boardZoomCenter.clone() };
      boardZoom = BOARD_ZOOM_MIN; boardZoomCenter.set(0, 0);
    } else if (boardOverview) {
      boardZoom = boardOverview.zoom; boardZoomCenter.copy(boardOverview.center); boardOverview = null;
    }
    boardFullscreen = value; options.performanceProbe?.mark('board-fullscreen', { open: value }); prioritizeUser(); wake();
  }
  function setBoardEditorInset(value: number) {
    const next = Number.isFinite(value) ? THREE.MathUtils.clamp(value, 0, 0.75) : 0;
    if (disposed || Math.abs(boardEditorInset - next) < 0.0001) return;
    boardEditorInset = next;
    if (boardFullscreen && host.clientWidth / Math.max(1, host.clientHeight) < 1.05) {
      cancelBoardGesture(); prioritizeUser(); wake();
    }
  }
  const editingTarget = (target: EventTarget | null) => target instanceof HTMLElement
    && (target.isContentEditable || Boolean(target.closest('input,textarea,select,[role="textbox"]')));
  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented
      || !active || disposed || location !== 'board' || detail || editingTarget(event.target)) return;
    // Let Space activate a focused toolbar button instead of taking its keyboard input.
    if (event.target instanceof HTMLElement && event.target.closest('button,a,summary')) return;
    event.preventDefault(); boardPanKey = true;
    if (!boardDrag && !boardResize && !boardPan) original.renderer.domElement.style.cursor = 'grab';
  }, { signal: events.signal });
  document.addEventListener('keyup', event => { if (event.code === 'Space') boardPanKey = false; }, { signal: events.signal });
  window.addEventListener('blur', () => { boardPanKey = false; setBoardTool({ mode: 'select' }); }, { signal: events.signal });
  // A neighbouring physical station is a navigation target. Capture only its clicks,
  // so a rack/array press cannot also start a board pan or open an archive document.
  const navigationCanvas=original.renderer.domElement;
  let stationPress: { pointerId:number; target:RhineLocation; x:number; y:number; moved:boolean } | null=null;
  let stationHover: RhineLocation | null=null, stationHoverAt=0;
  const stationNavigationAvailable=()=>active&&!disposed&&!detail&&!cameraTravel&&!boardFullscreen
    &&!inboxOpen&&!readingObject.group.visible&&!boardPanKey&&boardTool.mode==='select'
    &&!boardDrag&&!boardResize&&!boardPan&&!boardPress;
  function pickStation(event:{clientX:number;clientY:number}): RhineLocation | null {
    if(!stationNavigationAvailable())return null;
    pointRay(event);
    const objects=[rack,evidenceBoard.group,evidenceInbox.group,...[...files.values()].map(file=>file.group)];
    const station=visibleSceneHit(raycaster.intersectObjects(objects,true));
    const archive=original.pickArchiveSurface(raycaster);
    let target: RhineLocation | null=null;
    if(archive&&(!station||archive.distance<station.distance))target='archive';
    else for(let object:THREE.Object3D|null=station?.object||null;object;object=object.parent){
      if(object.userData.workspaceLocation){target=object.userData.workspaceLocation;break;}
    }
    return target===location?null:target;
  }
  function clearStationHover(){
    if(stationHover)navigationCanvas.style.cursor=location==='board'?'grab':'default';
    stationHover=null;delete navigationCanvas.dataset.workspaceTarget;navigationCanvas.removeAttribute('title');
  }
  navigationCanvas.addEventListener('pointerdown',event=>{
    if(stationPress){stationPress.moved=true;event.preventDefault();event.stopImmediatePropagation();return;}
    if(!event.isPrimary||event.button!==0)return;
    const target=pickStation(event);if(!target)return;
    stationPress={pointerId:event.pointerId,target,x:event.clientX,y:event.clientY,moved:false};
    down=null;event.preventDefault();event.stopImmediatePropagation();navigationCanvas.setPointerCapture(event.pointerId);
  },{capture:true,signal:events.signal});
  navigationCanvas.addEventListener('pointermove',event=>{
    if(!stationPress||stationPress.pointerId!==event.pointerId)return;
    if(Math.hypot(event.clientX-stationPress.x,event.clientY-stationPress.y)>8)stationPress.moved=true;
    event.preventDefault();event.stopImmediatePropagation();
  },{capture:true,signal:events.signal});
  navigationCanvas.addEventListener('pointerup',event=>{
    if(!stationPress||stationPress.pointerId!==event.pointerId)return;
    const press=stationPress;stationPress=null;
    event.preventDefault();event.stopImmediatePropagation();
    if(navigationCanvas.hasPointerCapture(event.pointerId))navigationCanvas.releasePointerCapture(event.pointerId);
    clearStationHover();
    if(press.moved||Math.hypot(event.clientX-press.x,event.clientY-press.y)>8||pickStation(event)!==press.target)return;
    prioritizeUser();options.onLocationRequest?.(press.target);
  },{capture:true,signal:events.signal});
  navigationCanvas.addEventListener('pointercancel',()=>{stationPress=null;clearStationHover();},{capture:true,signal:events.signal});
  navigationCanvas.addEventListener('lostpointercapture',()=>{stationPress=null;},{signal:events.signal});
  original.renderer.domElement.addEventListener('pointerdown', event => {
    const middlePan = event.button === 1 && location === 'board' && !detail;
    if (!event.isPrimary || event.button !== 0 && !middlePan) return;
    if (boardDrag || boardResize || boardPan || boardPress) return;
    boardWheelAnchor = null;
    prioritizeUser(); down = { x: event.clientX, y: event.clientY };
    if (location !== 'board' || detail || cameraTravel) return;
    pointRay(event);
    if(!boardPanKey&&!middlePan&&boardTool.mode==='select'&&evidenceInbox.pick(raycaster)){down=null;event.preventDefault();options.onInboxOpen?.();return;}
    let id = evidenceBoard.pick(raycaster);
    if (!boardPanKey && !middlePan && (evidenceBoard.pickTool(raycaster) || boardTool.mode !== 'select')) {
      boardPress = { pointerId: event.pointerId, kind: evidenceBoard.pickTool(raycaster) ? 'chalk' : 'tool', cardId: id, moved: false };
      event.preventDefault(); original.renderer.domElement.setPointerCapture(event.pointerId);
      updateToolPreview(event); return;
    }
    if (!boardPanKey && !middlePan && boardTool.mode === 'select') {
      let resizeId = pickResizeHandle(event);
      if (resizeId) {
        // Flush/promote an edited sample before freezing the resize reference.
        options.onBoardSelect?.(resizeId, false);
        resizeId = pickResizeHandle(event);
        const index = boardCards.findIndex(card => card.id === resizeId);
        const point = resizeId ? evidenceBoard.resizePoint(raycaster, resizeId) : null;
        if (!resizeId || index < 0 || !point) { down = null; return; }
        const card = boardCards[index], layout = evidenceCardLayout(card, index);
        const angle = layout.rotation * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
        const diagonalX = (layout.width * cosine + layout.height * sine) / layout.scale;
        const diagonalY = (layout.width * sine - layout.height * cosine) / layout.scale;
        boardResize = { id: resizeId, pointerId: event.pointerId, start: point, initialScale: layout.scale,
          anchorX: layout.x - diagonalX * layout.scale / 2, anchorY: layout.y - diagonalY * layout.scale / 2,
          diagonalX, diagonalY, maximum: evidenceCardScale({ ...card, scale: EVIDENCE_SCALE_MAX }, index),
          scale: layout.scale, x: layout.x, y: layout.y,
          rect: original.renderer.domElement.getBoundingClientRect(), camera: original.camera.clone(), moved: false };
        event.preventDefault(); original.renderer.domElement.setPointerCapture(event.pointerId);
        original.renderer.domElement.style.cursor = 'nwse-resize'; wake(); return;
      }
    }
    if (!id || boardPanKey || middlePan) {
      evidenceBoard.setPlacementPreview(null); evidenceBoard.setConnectionPreview(boardTool.mode === 'connect' ? boardTool.fromId || null : null);
      const point = evidenceBoard.boardPoint(raycaster);
      if (!point) { down = null; return; }
      event.preventDefault();
      // Freeze the projection for this gesture: using the damped live camera
      // would feed its own movement back into the next pointer delta.
      boardPan = { pointerId: event.pointerId, startX: point.x, startY: point.y, center: boardZoomCenter.clone(),
        rect: original.renderer.domElement.getBoundingClientRect(), camera: original.camera.clone(), moved: false,
        clearSelection: !id && !boardPanKey && !middlePan };
      original.renderer.domElement.setPointerCapture(event.pointerId);
      original.renderer.domElement.style.cursor = 'grabbing'; return;
    }
    if (id && boardCards.find(card => card.id === id)?.clueKind === 'report') { options.onBoardSelect?.(id, true); down = null; return; }
    // Flush the editor before a drag begins: saving an example can change its ID.
    options.onBoardSelect?.(id, false);
    id = evidenceBoard.pick(raycaster);
    const point = evidenceBoard.boardPoint(raycaster);
    const index = boardCards.findIndex(card => card.id === id);
    if (!id || !point || index < 0) return;
    const layout = evidenceCardLayout(boardCards[index], index);
    boardDrag = { id, pointerId: event.pointerId, offsetX: layout.x - point.x, offsetY: layout.y - point.y,
      x: layout.x, y: layout.y, rect: original.renderer.domElement.getBoundingClientRect(),
      camera: original.camera.clone(), moved: false };
    original.renderer.domElement.setPointerCapture(event.pointerId);
  }, { signal: events.signal });
  original.renderer.domElement.addEventListener('pointerup', event => {
    if (boardResize) {
      if (boardResize.pointerId !== event.pointerId) return;
      const sizing = boardResize; boardResize = null; down = null;
      if (original.renderer.domElement.hasPointerCapture(event.pointerId)) original.renderer.domElement.releasePointerCapture(event.pointerId);
      if (sizing.moved) options.onBoardResize?.(sizing.id, sizing.scale, sizing.x, sizing.y);
      else options.onBoardSelect?.(sizing.id);
      original.renderer.domElement.style.cursor = 'grab'; wake(); return;
    }
    if (boardPress) {
      if (boardPress.pointerId !== event.pointerId) return;
      const press = boardPress, start = down; boardPress = null; down = null;
      if (original.renderer.domElement.hasPointerCapture(event.pointerId)) original.renderer.domElement.releasePointerCapture(event.pointerId);
      if (!start || press.moved || Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 5) return;
      pointRay(event);
      if (press.kind === 'chalk') {
        if (evidenceBoard.pickTool(raycaster)) { setBoardTool({ mode: 'select' }); options.onBoardToolRequest?.(); }
        return;
      }
      const id = evidenceBoard.pick(raycaster), point = evidenceBoard.boardPoint(raycaster);
      if (boardTool.mode === 'place' && !id && insideBoard(point)) {
        const template = boardTool.template, position = { x: point!.x, y: point!.y };
        setBoardTool({ mode: 'select' }); options.onBoardPlace?.(template, position);
      } else if (boardTool.mode === 'connect' && id && id === press.cardId) {
        if (!boardTool.fromId) setBoardTool({ mode: 'connect', fromId: id });
        else if (boardTool.fromId !== id) {
          const fromId = boardTool.fromId; setBoardTool({ mode: 'select' }); options.onBoardConnect?.(fromId, id);
        }
      }
      wake(); return;
    }
    if (boardPan) {
      if (boardPan.pointerId !== event.pointerId) return;
      const pan = boardPan; boardPan = null; down = null;
      if (original.renderer.domElement.hasPointerCapture(pan.pointerId)) original.renderer.domElement.releasePointerCapture(pan.pointerId);
      if (!pan.moved && pan.clearSelection) { evidenceBoard.select(null); options.onBoardSelect?.(null); }
      original.renderer.domElement.style.cursor = 'grab'; wake(); return;
    }
    if (boardDrag && boardDrag.pointerId !== event.pointerId) return;
    if (boardDrag && boardDrag.pointerId === event.pointerId) {
      const drag = boardDrag; boardDrag = null; down = null;
      if (drag.moved) options.onBoardMove?.(drag.id, drag.x, drag.y);
      else { evidenceBoard.select(drag.id); options.onBoardSelect?.(drag.id); }
      original.renderer.domElement.style.cursor = 'grab'; wake(); return;
    }
    if (location === 'archive' || detail || !down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 8) { down = null; return; }
    down = null;
    const rect = original.renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, original.camera);
    if (location === 'board') {
      if (cameraTravel) return;
      const id = evidenceBoard.pick(raycaster);
      evidenceBoard.select(id); options.onBoardSelect?.(id); wake(); return;
    }
    const hit = raycaster.intersectObjects([...files.values()].map(file => file.group), true)[0];
    let object: THREE.Object3D | null = hit?.object || null;
    while (object && !object.userData.sourceId) object = object.parent;
    const id = object?.userData.sourceId as string | undefined;
    if (!id) return;
    if (id === focusedId) options.onSelect?.(id);
    else { focusedId = id; notifyShelf(); wake(); }
  }, { signal: events.signal });
  original.renderer.domElement.addEventListener('pointermove', event => {
    if (location !== 'board' || detail || cameraTravel) return;
    if (boardResize && boardResize.pointerId === event.pointerId && down) {
      const sizing = boardResize;
      if (!sizing.moved && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 4) return;
      pointer.set((event.clientX - sizing.rect.left) / sizing.rect.width * 2 - 1,
        -(event.clientY - sizing.rect.top) / sizing.rect.height * 2 + 1);
      raycaster.setFromCamera(pointer, sizing.camera);
      const point = evidenceBoard.resizePoint(raycaster, sizing.id), index = boardCards.findIndex(card => card.id === sizing.id);
      if (!point || index < 0) return;
      const delta = ((point.x - sizing.start.x) * sizing.diagonalX + (point.y - sizing.start.y) * sizing.diagonalY)
        / (sizing.diagonalX ** 2 + sizing.diagonalY ** 2);
      const scale = THREE.MathUtils.clamp(sizing.initialScale + delta, EVIDENCE_SCALE_MIN, sizing.maximum);
      const position = clampEvidencePosition({ ...boardCards[index], scale }, index,
        sizing.anchorX + sizing.diagonalX * scale / 2, sizing.anchorY + sizing.diagonalY * scale / 2);
      sizing.scale = scale; sizing.x = position.x; sizing.y = position.y; sizing.moved = true;
      evidenceBoard.resizeCard(sizing.id, scale, position.x, position.y);
      original.renderer.domElement.style.cursor = 'nwse-resize'; wake(); return;
    }
    if (boardPress?.pointerId === event.pointerId && down && Math.hypot(event.clientX - down.x, event.clientY - down.y) >= 5) boardPress.moved = true;
    if (boardPan && boardPan.pointerId === event.pointerId && down) {
      if (!boardPan.moved && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 5) return;
      const rect = boardPan.rect;
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(pointer, boardPan.camera);
      const point = evidenceBoard.boardPoint(raycaster);
      if (!point) return;
      boardZoomCenter.set(boardPan.center.x + boardPan.startX - point.x, boardPan.center.y + boardPan.startY - point.y);
      clampBoardCenter(); boardPan.moved = true;
      original.renderer.domElement.style.cursor = 'grabbing'; wake(); return;
    }
    pointRay(event);
    if (boardDrag && boardDrag.pointerId === event.pointerId && down) {
      if (!boardDrag.moved && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 5) return;
      const rect = boardDrag.rect;
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(pointer, boardDrag.camera);
      const point = evidenceBoard.boardPoint(raycaster), index = boardCards.findIndex(card => card.id === boardDrag!.id);
      if (!point || index < 0) return;
      const position = clampEvidencePosition(boardCards[index], index, point.x + boardDrag.offsetX, point.y + boardDrag.offsetY);
      boardDrag.x = position.x; boardDrag.y = position.y; boardDrag.moved = true;
      evidenceBoard.moveCard(boardDrag.id, position.x, position.y);
      original.renderer.domElement.style.cursor = 'grabbing'; wake(); return;
    }
    updateToolPreview(event);
    original.renderer.domElement.style.cursor = boardPanKey ? 'grab' : evidenceBoard.pickTool(raycaster) ? 'pointer'
      : boardTool.mode === 'select' ? pickResizeHandle(event) ? 'nwse-resize' : 'grab' : 'crosshair';
  }, { signal: events.signal });
  navigationCanvas.addEventListener('pointermove',event=>{
    if(stationPress||event.pointerType!=='mouse')return;
    if(!stationNavigationAvailable()){clearStationHover();return;}
    const now=performance.now();
    if(now-stationHoverAt<45){if(stationHover)navigationCanvas.style.cursor='pointer';return;}
    stationHoverAt=now;const target=pickStation(event);
    if(!target){clearStationHover();return;}
    stationHover=target;navigationCanvas.style.cursor='pointer';navigationCanvas.dataset.workspaceTarget=target;
    navigationCanvas.title=`点击进入${{archive:'检索阵列',board:'调查板',desk:'档案架'}[target]}`;
  },{signal:events.signal});
  original.renderer.domElement.addEventListener('pointerleave', () => {
    clearStationHover();
    if (!boardPan && !boardDrag && !boardResize && !boardPress) {
      evidenceBoard.setPlacementPreview(null); evidenceBoard.setConnectionPreview(boardTool.mode === 'connect' ? boardTool.fromId || null : null);
    }
  }, { signal: events.signal });
  original.renderer.domElement.addEventListener('pointercancel', event => {
    if (boardPan?.pointerId === event.pointerId || boardDrag?.pointerId === event.pointerId || boardResize?.pointerId === event.pointerId
      || boardPress?.pointerId === event.pointerId || !boardPan && !boardDrag && !boardResize && !boardPress) setBoardTool({ mode: 'select' });
  }, { signal: events.signal });
  original.renderer.domElement.addEventListener('lostpointercapture', event => {
    if (boardDrag?.pointerId === event.pointerId || boardResize?.pointerId === event.pointerId
      || boardPan?.pointerId === event.pointerId || boardPress?.pointerId === event.pointerId) setBoardTool({ mode: 'select' });
  }, { signal: events.signal });
  original.renderer.domElement.addEventListener('auxclick', event => {
    if (location === 'board' && event.button === 1) event.preventDefault();
  }, { signal: events.signal });
  original.renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault(); hoveredArchive = null; contextLost = true; setBoardTool({ mode: 'select' }); boardPanKey = false; cancelAnimationFrame(raf); raf = 0;
    preparation.setActive(false);
    rejectReady('三维画面暂时不可用');
    options.onError?.('三维画面暂时不可用，仍可通过资料目录阅读。');
  }, { signal: events.signal });
  original.renderer.domElement.addEventListener('webglcontextrestored', () => {
    contextLost = false; original.invalidatePrograms();
    labelPrefetchKey = ''; notifyArchive();
    if (renderOptions.get("rhineShelf") !== "geometry") {
      preparation.enqueue("shelf-interior", () => original.prepareShelfInterior(), 20);
      for (let view = 0; view < 4; view++) preparation.enqueue(`shelf-view:${view}`, () => original.prepareShelfView(view), -1);
    }
    preparation.enqueue("workspace-programs", () => original.preparePrograms("workspace", [rack, evidenceBoard.group, evidenceInbox.group, ...[...files.values()].map(file => file.group)]), 15);
    preparation.setActive(active && !document.hidden); wake();
  }, { signal: events.signal });
  preparation.setActive(active && !document.hidden);
  resize();

  return {
    whenReady() {
      if (disposed || contextLost) return Promise.reject(new Error('三维场景已关闭或不可用'));
      return new Promise<void>((resolve, reject) => { readyWaiters.add({ resolve, reject }); wake(); });
    },
    createAssemblyModel: () => load('assembly-clone-setup', () => original.createAssemblyModel(`${options.assetBase.replace(/\/$/, '')}/assets/archive-assembly.glb`)),
    finishDecryption: () => original.finishDecryption(),
    setFollowAgent(value: boolean) { followAgent = value; if(value) userPriorityUntil = 0; wake(); },
    navigate, selectArchiveSource, browseArchiveSource, setArchiveSources, setInvestigation, setSources,
    setShelfPage: showShelfPage, browseShelf, resize,
    setBoardFullscreen, setBoardEditorInset, resetBoardView, zoomBoard, setBoardTool, cancelBoardGesture,
    getBoardCardBounds(id) {
      const index = boardCards.findIndex(card => card.id === id);
      if (index < 0 || !active || location !== 'board' || detail || !evidenceBoard.group.visible) return null;
      const layout = evidenceCardLayout(boardCards[index], index);
      const angle = layout.rotation * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
      evidenceBoard.group.updateWorldMatrix(true, false);
      const points = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([dx, dy]) => {
        const x = dx * layout.width / 2, y = dy * layout.height / 2;
        const point = evidenceBoard.group.localToWorld(new THREE.Vector3(layout.x + x * cosine - y * sine, layout.y + x * sine + y * cosine, .2)).project(original.camera);
        return { x: (point.x + 1) * host.clientWidth / 2, y: (1 - point.y) * host.clientHeight / 2 };
      });
      return { left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)), top: Math.min(...points.map(p => p.y)), bottom: Math.max(...points.map(p => p.y)) };
    },
    setBoardCards(cards) {
      if (disposed) return;
      boardCards = cards;
      // An authoritative update (undo, delete, session or a text save) owns the
      // model again. A resize preview must never overwrite that newer snapshot.
      if (boardResize) cancelBoardDrag();
      if (boardTool.mode === 'connect' && boardTool.fromId && !cards.some(card => card.id === (boardTool as { fromId?: string }).fromId)) setBoardTool({ mode: 'select' });
      if (boardDrag && !cards.some(card => card.id === boardDrag!.id)) cancelBoardDrag();
      evidenceBoard.setCards(cards);
      if (boardDrag?.moved) evidenceBoard.moveCard(boardDrag.id, boardDrag.x, boardDrag.y);
      wake();
    },
    selectBoardCard(id) {
      if (disposed) return;
      if (boardResize && boardResize.id !== id) cancelBoardDrag();
      evidenceBoard.select(id); wake();
    },
    selectArchive(index) {
      const lane = fileLocation(wrap(index, 40)).lane;
      if (!acceptArchiveNavigation({ method: 'slot', targetLane: lane, targetRow: lanes[lane].length ? wrap(index % 8, lanes[lane].length) : 0 })) return;
      if (lanes[lane].length) laneRows[lane] = wrap(index % 8, lanes[lane].length);
      chooseArchive(index);
    },
    setEvidenceInbox(value,open){inboxOpen=open;evidenceInbox.set(value,open);if(open)cancelBoardGesture();wake();},
    setReadingObject(value) { readingObject.set(value, reduced); if(value) cancelBoardGesture(); wake(); },
    setDetail(open) {
      if (disposed) return;
      if (detail !== open) { setBoardTool({ mode: 'select' }); boardPanKey = false; boardWheelAnchor = null; }
      options.performanceProbe?.mark('detail', { open });
      hoveredArchive = null;
      detail = open; original.setMode(open ? 'detail' : 'archive'); syncLabelPrefetch(); wake();
    },
    setLocation(next) {
      if (disposed || location === next) return;
      stationPress=null;clearStationHover();
      if (boardFullscreen && next !== 'board') setBoardFullscreen(false);
      setBoardTool({ mode: 'select' });
      boardPanKey = false;
      boardWheelAnchor = null;
      options.performanceProbe?.mark('location', { from: location, to: next });
      hoveredArchive = null;
      location = next;
      original.setQuality(effectiveQuality());
      if (detail) { detail = false; original.setMode('archive'); }
      cameraTravel = beginWorkspaceTravel({ board: boardAmount, desk: deskAmount }, next);
      notifyArchive(); wake();
    },
    setSearching(value) { if (searching === value) return; searching = value; wake(); },
    select(id) {
      if (disposed) return;
      selectedId = id && sourceIds.has(id) ? id : null;
      if (selectedId) {
        shelfPage = Math.floor(sourceList.findIndex(source => source.id === selectedId) / SHELF_PAGE_SIZE);
        focusedId = selectedId;
      }
      syncCollection(); notifyShelf(); notifyArchive(); wake();
    },
    setActive(value) {
      if (active !== value) options.performanceProbe?.breakTimeline(value ? 'scene-active' : 'scene-inactive');
      if (!value) { boardPanKey = false; setBoardTool({ mode: 'select' }); }
      active = value; hoveredArchive = null; syncLabelPrefetch();
      preparation.setActive(active && !contextLost && !document.hidden);
      if (!active) { cancelAnimationFrame(raf); raf = 0; lastFrame = 0; }
      else { observeOperations(); wake(); }
    },
    setReducedMotion(value) { reduced = value; original.setReduced(value); wake(); },
    setQuality(value) {
      if (disposed) return;
      quality = { ...value };
      original.setQuality(effectiveQuality());
      wake();
    },
    stats() {
      const native = original.getStats();
      const inspected = selectedId ? files.get(selectedId) : undefined;
      return {
        ...native, heroLoaded: native.loaded, archiveInstances: native.archiveCount,
        renderedTriangles: native.triangles, engine: 'three/upstream-ArchiveScene', originalQuality: { ...qualityPresets.original },
        renderQuality: effectiveQuality(), requestedQuality: { ...quality },
        renderSurface: { width: original.renderer.domElement.width, height: original.renderer.domElement.height },
        archiveIndex, archiveColumn: archiveLaneIndex, archiveRow: laneRows[archiveLaneIndex],
        archiveSourceId: currentArchiveSource()?.id || null, archiveSourceCount: archiveSources.length,
        archiveLaneCounts: lanes.map(sources => sources.length), columnMemory: [...laneRows], physicalSlotRows: [...slotRows],
        evidenceInbox: evidenceInbox.stats(), readingObject: readingObject.stats(original.camera),
        cameraLocation: location, cameraX: original.collectionOffset.x, movingCamera: !!cameraTravel,
        cameraRoute: { board: boardAmount, desk: deskAmount, offset: original.collectionOffset.toArray(),
          position: original.camera.position.toArray(), quaternion: original.camera.quaternion.toArray(), fov: original.camera.fov },
        evidenceBoard: { ...evidenceBoard.stats(), visible: evidenceBoard.group.visible, sameScene: evidenceBoard.group.parent === original.scene,
          zoom: boardZoom, zoomCenter: { x: boardZoomCenter.x, y: boardZoomCenter.y }, zoomRange: [BOARD_ZOOM_MIN, BOARD_ZOOM_MAX],
          fullscreen: boardFullscreen, editorInset: boardEditorInset, appliedEditorInset: appliedBoardEditorInset,
          tool: { ...boardTool }, anchors: boardAnchorFrame, panning: Boolean(boardPan), draggingCard: Boolean(boardDrag),
          resize: boardResize ? { id: boardResize.id, scale: boardResize.scale, x: boardResize.x, y: boardResize.y, moved: boardResize.moved } : null },
        sourceCount: sourceList.length, selectedId, focusedId, shelfPage, shelfPageCount: Math.ceil(sourceList.length / SHELF_PAGE_SIZE),
        visibleIds: [...visibleIds], physicalFiles: files.size, physicalCapacity: SHELF_PAGE_SIZE,
        shelfLayout: { visible: rack.visible, levels: SHELF_LEVELS, slotsPerLevel: SHELF_SLOTS_PER_LEVEL, frameBatches: rack.children.length,
          files: [...files.values()].map(file => ({ id: file.id, level: shelfSlot(visibleIds.indexOf(file.id)).level,
            visible: file.group.visible, progress: file.progress, position: file.group.position.toArray(), quaternion: file.group.quaternion.toArray() })) },
        inspectedFile: inspected ? { id: inspected.id, visible: inspected.group.visible,
          progress: inspected.progress, representation: inspected.group.userData.shelfRepresentation,
          position: inspected.group.position.toArray() } : null,
        preparation: { ...preparation.stats(), pendingShelf: pendingShelf.size },
        navigation: navigationLimiter.stats(),
        transfers: activityFiles.filter(item => item.stage === 'travelling').length,
        transferQueue: activityQueue.length, transferredSourceCount: transferred.size,
        pendingShelfArrivals: waitingArrivals.size,
        activeReadingSourceId: activityFiles.find(item => item.kind === 'read')?.source?.id || null,
        readingMechanism: activityFiles.some(item => item.kind === 'read'),
        readingLift: Math.max(0, ...activityFiles.filter(item => item.kind === 'read').map(item => item.lift)),
        archiveActivities: activityFiles.map(item => ({ key: item.key, kind: item.kind, stage: item.stage, sourceId: item.source?.id || null, lift: item.lift,
          requiredLift: original.archiveReadingLift(item.index), position: item.group.position.toArray(),
          rest: original.archiveReadingPose(item.index).position.toArray(),
          screenCorners: [[-2.5,0,-0.13],[2.52,0,0.32],[-2.5,3.76,-0.13],[2.52,3.76,0.32]].map(point => {
            const p = new THREE.Vector3(...point).applyQuaternion(item.group.quaternion).add(item.group.position).project(original.camera);
            return [(p.x + 1) / 2, (1 - p.y) / 2];
          }) })),
        observedOperationCount: observedOperations.size, scanSteps,
        userOwnsView: userOwnsView(), renderedFrames, pendingRAF: !!raf, active,
        searching: scanningActive(),
        reducedMotion: reduced, hidden: document.hidden, disposed, originalAppearance: true,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      rejectReady('三维场景已关闭');
      preparation.dispose(); pendingShelf.clear();
      cancelAnimationFrame(raf); raf = 0;
      resizeObserver.disconnect(); events.abort(); clearActivities();
      for (const file of files.values()) original.disposeCollectionFile(file.group);
      files.clear();
      original.scene.remove(rack);
      rack.children.forEach(mesh => { if (mesh instanceof THREE.InstancedMesh) mesh.dispose(); });
      box.dispose(); rackMaterials.forEach(value => value.dispose());
      readingObject.dispose();evidenceInbox.dispose();
      evidenceBoard.dispose();
      unregisterPerformance?.();
      original.dispose();
    },
  };
}
