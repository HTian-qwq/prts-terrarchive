import { visibleSceneHit } from '../visible-scene-hit';
import * as THREE from "three";
import type { RenderPerformanceCapture } from "../temporary-performance";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createArchiveLighting, type LightingLook } from "./archive-lighting";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { normalizeQuality, type RenderQuality } from "./render-quality";
import { applyTextureQuality, resizeQuality } from "./quality-renderer";
import { CardAppearance } from "./appearance";
import { configureInternalOptics } from "./internal-optics";
import { ARRAY_INTERIOR_SURFACES, bakeArrayInterior, copyInteriorLights } from "./array-interior";
import { ArrayVisibility } from "./array-visibility";
import { enableOpaqueBackfaces } from "./opaque-backfaces";
import { ArchiveRefill } from "./archive-refill";
import { ShelfInterior, SHELF_INTERIOR_SURFACES } from "./shelf-interior";
import { ArchiveLabelTextures } from "./label-textures";
import { ProgramPreparation } from "./program-preparation";
import { SHELF_PAGE_SIZE } from "../shelf-layout";
import { createCassetteLOD, splitCassetteFasteners } from "./cassette-lod";
import { splitArrayShell } from "./array-shell";
import { createArrayDetail } from "./array-detail";
import { DecryptionController } from "./decryption";
import { CLEAR_ROUGHNESS } from "./glass-reveal";
import { fileAtSlot, fileLocation } from "./data";
import {
  cellKey,
  sameCell,
  selectionCell,
  fileAtCell,
  poolCell,
  visibleCell,
  wrap,
  LOOP_COLUMNS,
  LOOP_ROWS,
  COLUMN_SPACING,
  ROW_SPACING,
  type ArchiveCell,
  type ArchiveNavigation,
} from "./archive-loop";
import { ArchiveLabelRenderer, ARCHIVE_LABEL_LAYER } from "./label-renderer";
import { labelMarkSvg } from "./brand";
import { ARCHIVE_LABEL_NAME, ARCHIVE_LABEL_WIDTH, ARCHIVE_LABEL_HEIGHT, archiveLabelKey, paintArchiveLabel, positionArchiveLabel, ARCHIVE_LABEL_SIZE, type ArchiveLabel } from "./archive-label";
import { archiveFraming, swipeDirection } from "./viewport-layout";
import { assetUrl as publicAsset } from "./asset-url";
import {
  archiveWave,
  extraction,
  baselineSelectionWave,
  rippleEnvelope,
  settlingWave,
  damp,
  columnStrength,
  idleWave,
  cinematicField,
  INSPECTION_LIFT,
  returnStep,
} from "./motion";

const ease = (t: number) => {
  t = THREE.MathUtils.clamp(t, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
export class ArchiveScene {
  performanceProbe?: RenderPerformanceCapture;
  private loadModel(assetUrl: string, asset: string) {
    const task = () => new GLTFLoader().loadAsync(assetUrl);
    return this.performanceProbe ? this.performanceProbe.trackLoad("model-fetch-decode", task, { asset }) : task();
  }
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  // The reference uses a long lens 72–140 units from the cassette. A 0.1 near
  // plane quantizes adjacent optical layers to the same depth (visible shimmer).
  // All visible foreground geometry is beyond 5; retain the framing and lens.
  readonly camera = new THREE.PerspectiveCamera(34, 16 / 9, 5, 300);
  private composer: EffectComposer;
  private readonly labelRenderer = new ArchiveLabelRenderer();
  private scenePixelHeight = 1;
  private ao: SSAOPass;
  private bokeh: BokehPass;
  private instances: THREE.InstancedMesh[] = [];
  private readonly backfaceSurfaces = { full: [] as string[], array: [] as string[] };
  private arrayPickMeshes: THREE.InstancedMesh[] = [];
  private arrayStationPickMeshes: THREE.InstancedMesh[] = [];
  private readonly arrayVisibility = new ArrayVisibility(LOOP_COLUMNS * LOOP_ROWS);
  private arrayInteriorBake?: ReturnType<typeof bakeArrayInterior>;
  private arrayInteriorInstances: THREE.InstancedMesh[] = [];
  private arrayInteriorSources: THREE.Mesh[] = [];
  private arrayInteriorError?: string;
  private shelfInterior?: ShelfInterior;
  private readonly programPreparation = new ProgramPreparation();
  private shelfInteriorAttempted = false;
  private shelfInteriorError?: string;
  private readonly collectionPools = { moving: [] as THREE.Group[], shelf: [] as THREE.Group[] };
  private readonly collectionKinds = new WeakMap<THREE.Group, "moving" | "shelf">();
  private readonly pooledCollections = new Set<THREE.Group>();
  private collectionCreated = 0;
  private collectionReused = 0;
  private model = new THREE.Group();
  private appearance = new CardAppearance();
  private readonly decryption = new DecryptionController();
  private cursor = new THREE.Vector2();
  private raycaster = new THREE.Raycaster();
  private dummy = new THREE.Object3D();
  private positions: THREE.Vector3[] = [];
  private cells: ArchiveCell[] = [];
  private selectedCell: ArchiveCell = { lane: 2, row: 12 };
  private departedSelection = false;
  private readonly arrayRefill = new ArchiveRefill();
  private looping = false;
  private coordinateOrigin: ArchiveCell = { lane: 0, row: 0 };
  private lift = { value: 0, velocity: 0 };
  private rail = { value: 0, velocity: 0 };
  private shoulder = { value: 12, velocity: 0 };
  private laneFocus = { value: 2, velocity: 0 };
  private columnCamera = { value: 0, velocity: 0 };
  private returnY: number | null = null;
  private canInspect = false;
  private clearance = 0;
  private pulseGain = 1;
  private idleGain = 0;
  private lastInteraction = 0;
  private scanTime = 29.1;
  private scanBlend = 0;
  private investigationScanning = false;
  private investigationSlots = new Map<number, ArchiveCell>();
  private investigationPoses = new Map<number, { position: THREE.Vector3; quaternion: THREE.Quaternion }>();
  private cameraAim = new THREE.Vector3();
  private outgoing: {
    group: THREE.Group;
    slot: number;
    cell: ArchiveCell;
    lift: { value: number; velocity: number };
    returnY: number | null;
    clarity: number;
  }[] = [];
  private pulses: { row: number; lane: number; time: number }[] = [];
  private pendingPulse: ArchiveCell | null = null;
  private selectedSlot = 76;
  private detail = 0;
  private targetDetail = 0;
  private reveal = 0;
  private targetReveal = 0;
  private last = 0;
  private pointer = new THREE.Vector2();
  private dragging = false;
  private rotation = 0;
  private targetRotation = 0;
  private light: THREE.DirectionalLight;
  private clock = 0;
  private loaded = false;
  private labelCanvas = document.createElement("canvas");
  private labelTexture?: THREE.CanvasTexture;
  private labelMark = new Image();
  private archiveLabel: ArchiveLabel | null = null;
  private labelTextureCache?: ArchiveLabelTextures;
  private labels() {
    return this.labelTextureCache ??= new ArchiveLabelTextures(this.labelMark, Math.min(16, this.renderer.capabilities.getMaxAnisotropy()), () => this.performanceProbe);
  }
  setArchiveLabelCandidates(contents: readonly ArchiveLabel[]) { this.labels().setPrefetchCandidates(contents); }
  archiveLabelPrepared(content: ArchiveLabel) { return this.labels().isPrepared(content); }
  prepareArchiveLabel(content: ArchiveLabel, context?: { plan: number; slot: number; intent?: 'row' | 'lane' | 'pointer' | 'activity' }) {
    if (this.disposed) return;
    const finish = this.performanceProbe?.beginWork('label-prefetch');
    try { this.labels().prepare(content, this.renderer, context); finish?.(true); }
    catch (error) { finish?.(false); throw error; }
  }
  private reduced = false;
  private quality = normalizeQuality(undefined);
  private appliedQuality = "";
  private smaa = new SMAAPass();
  private aoKernelSize = 32;
  private displayHeight = 0;
  private layoutKind = "";
  // Plugin integration hooks. Zero offset and no hook preserve the upstream
  // archive renderer, camera, animation, quality and pointer behavior exactly.
  readonly collectionOffset = new THREE.Vector3();
  collectionOverviewScale = 1;
  collectionFraming?: { center: THREE.Vector3; span: number; x: number; y: number; amount: number; distance?: number;
    direction?: THREE.Vector3; parallax?: boolean };
  collectionDepthOfFieldScale = 1;
  collectionArrayVisible = true;
  collectionFocus?: THREE.Vector3;
  /** World-space reading station for a cassette extracted from the rack. */
  collectionDetailPosition?: THREE.Vector3;
  private investigationClearances = new Map<number, number>();
  beforeRender?: () => void;
  private appliedCollectionOffset = new THREE.Vector3();
  private appliedLightingOffset = new THREE.Vector3();
  private events = new AbortController();
  private disposed = false;
  onSelect?: (index: number, cell?: ArchiveCell) => void;
  onHover?: (index: number | null, cell?: ArchiveCell) => void;
  onLabelOpen?: (sourceId: string) => void;
  onNavigate?: (axis: "row" | "lane", direction: number) => void;
  constructor(
    private container: HTMLElement,
    private readonly selectionPulse = baselineSelectionWave,
    private readonly deferSelectionPulse = false,
    private readonly lightingLook: LightingLook = "baseline",
    private readonly arrayInteriorMode: "baked" | "geometry" = "baked",
    private readonly arrayCulling = true,
    private readonly arrayLOD = true,
    private readonly arrayOcclusion = true,
    private readonly arrayShell = true,
    private readonly arrayDetails = true,
  ) {
    // The archive always displays clear covers; no timed decryption or refrost.
    // Keep the completed frame for existing inspection/status consumers.
    this.decryption.finish();
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(
      Math.min(devicePixelRatio, 1.5) *
        Math.min(innerWidth / 1920, innerHeight / 1080),
    );
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = true;
    // RenderPass, SSAO and Bokeh render this scene separately. Refresh dynamic
    // shadows once after all motion updates, then reuse them for the other passes.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.setAttribute(
      "aria-label",
      "三维研究档案阵列，可点击选择档案",
    );
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color("#eae5e1");
    this.scene.fog = new THREE.Fog("#eae5e1", 22, 47);
    this.light = createArchiveLighting(this.renderer, this.scene, lightingLook);
    this.light.castShadow = true;
    Object.assign(this.light.shadow.camera, {
      left: -16,
      right: 16,
      top: 15,
      bottom: -15,
      near: 0.1,
      far: 45,
    });
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.normalBias = lightingLook === "refined" ? 0.018 : 0.035;
    this.light.shadow.bias = lightingLook === "refined" ? -0.00012 : -0.0003;
    this.light.shadow.radius = 4;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: "#d8c9b9", roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -4.63;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.camera.position.set(-62.26, 35.98, 43.28);
    this.cameraAim.set(-0.5, 1.1, 0.4);
    this.camera.fov = 6.15;
    this.camera.lookAt(this.cameraAim);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.ao = new SSAOPass(
      this.scene,
      this.camera,
      container.clientWidth,
      container.clientHeight,
    );
    this.ao.kernelRadius = lightingLook === "refined" ? 0.44 : 0.38;
    this.ao.minDistance = 0.001;
    this.ao.maxDistance = 0.09;
    this.composer.addPass(this.ao);
    this.bokeh = new BokehPass(this.scene, this.camera, {
      focus: 25,
      aperture: 0.0018,
      maxblur: 0.011,
    });
    this.composer.addPass(this.bokeh);
    this.smaa.enabled = false;
    this.composer.addPass(this.smaa);
    this.composer.addPass(new OutputPass());
    this.labelRenderer.attach(this.composer);
    this.raycaster.layers.enable(ARCHIVE_LABEL_LAYER);
    this.bindPointer();
  }
  async load(assetUrl = publicAsset("assets/archive-cassette.glb")) {
    this.labelMark.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(labelMarkSvg)}`;
    const [gltf] = await Promise.all([
      this.loadModel(assetUrl, "archive-cassette.glb"),
      this.labelMark.decode(),
      // Canvas text is rasterized once. Load both used weights before any bake
      // so fallback glyphs cannot remain frozen in an otherwise ready texture.
      document.fonts.load('400 112px MiSans').catch(() => []),
      document.fonts.load('600 144px MiSans').catch(() => []),
    ]);
    gltf.scene.updateMatrixWorld(true);
    this.model.userData.performanceFamily = "hero";
    const meshes: THREE.Mesh[] = [];
    gltf.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    const count = LOOP_COLUMNS * LOOP_ROWS;
    const addArrayInstance = (mesh: THREE.Mesh, castShadow = false) => {
      const name = mesh.name || mesh.userData.surface || "Archive_Array";
      const batch = (geometry: THREE.BufferGeometry, suffix = "", material = mesh.material) => {
        const inst = new THREE.InstancedMesh(geometry, material, count);
        inst.name = name + suffix;
        inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        inst.castShadow = castShadow; inst.receiveShadow = true; inst.frustumCulled = false;
        // Test every part, including upper fasteners/inlays that can leave
        // the screen while the lower half of their cassette is still visible.
        // Opaque substrates keep a separate light-frustum instance buffer.
        inst.userData.occlusionCull = this.arrayOcclusion;
        if (mesh.userData.surface === "Frosted_Polymer") this.arrayPickMeshes.push(inst);
        if (["Frosted_Polymer", "Ivory_Edges", "Optical_Diffuser"].includes(mesh.userData.surface)) {
          this.arrayStationPickMeshes.push(inst);
        }
        this.instances.push(inst); this.scene.add(inst);
        return inst;
      };
      const shell = this.arrayShell && this.arrayOcclusion && splitArrayShell(mesh.userData.surface, mesh.geometry);
      if (shell) return shell.map(part => batch(part.geometry, part.suffix))[0];
      const lettering = this.arrayDetails && this.arrayLOD && name === "Array_Interior_Lettering"
        ? createArrayDetail(name, mesh.geometry, mesh.material as THREE.Material) : undefined;
      if (lettering) {
        const high = batch(mesh.geometry), low = batch(lettering.geometry, "_LOD1", lettering.material);
        high.userData.lodLevel = 0; low.userData.lodLevel = 1;
        this.arrayVisibility.addDetailLOD(high, low, 0.43, 64, 72);
        return high;
      }
      const lod = this.arrayLOD && createCassetteLOD(mesh.userData.surface, mesh.geometry);
      const parts = this.arrayOcclusion && mesh.userData.surface === "Titanium_Fasteners"
        ? splitCassetteFasteners(mesh.geometry) : undefined;
      const lowParts = parts && lod ? splitCassetteFasteners(lod.geometry) : undefined;
      const high = (parts ?? [mesh.geometry]).map((geometry, index) => {
        const suffix = parts ? (index === 0 ? "_Top" : "_Bottom") : "";
        const inst = batch(geometry, suffix);
        const lowGeometry = parts ? lowParts?.[index] : lod ? lod.geometry : undefined;
        if (lod && lowGeometry) {
          const low = batch(lowGeometry, suffix + "_LOD1");
          inst.userData.lodLevel = 0; low.userData.lodLevel = 1;
          this.arrayVisibility.addDetailLOD(inst, low, lod.featureSize, lod.enterBelow, lod.leaveAbove);
        }
        return inst;
      });
      if (parts && lod) lod.geometry.dispose();
      return high[0];
    };
    for (let index = 0; index < count; index++) {
      const cell = poolCell(index);
      this.cells.push(cell);
      this.positions.push(this.cellPosition(cell));
    }
    for (const mesh of meshes) {
      const geom = mesh.geometry
        .clone()
        .applyMatrix4(mesh.matrixWorld)
        .scale(1, 1, 1);
      const source = mesh.material as THREE.MeshStandardMaterial;
      const name = source.name.replace(/\.\d+$/, "");
      const mat = source.clone() as THREE.MeshPhysicalMaterial;
      mat.envMapIntensity = 0.6;
      if (name === "Frosted_Polymer") {
        mat.color.set("#fffdfa");
        mat.transmission = 0.9;
        mat.thickness = 0.12;
        mat.roughness = CLEAR_ROUGHNESS;
        mat.ior = 1.46;
        mat.attenuationColor = new THREE.Color("#eee6df");
        mat.attenuationDistance = 2;
      }
      if (name === "Internal_Ceramic") {
        mat.color.set(this.lightingLook === "refined" ? "#c4baae" : "#c7beb6");
        mat.roughness = 0.6;
      }
      if (name === "Printed_Label") mat.color.set("#eae5dc");
      if (name === "Ivory_Edges") {
        mat.color.set("#f0e7df");
        mat.roughness = 0.31;
        mat.transmission = 0.65;
        mat.thickness = 0.04;
      }
      if (name === "Optical_Diffuser") {
        mat.color.set("#e2dad4");
        mat.transmission = 0;
        mat.roughness = 0.7;
      }
      if (name === "Subsurface_Optics") {
        mat.color.set(this.lightingLook === "refined" ? "#b9a796" : "#b9aba1");
        mat.roughness = 0.48;
        mat.metalness = 0.05;
      }
      if (name === "Optical_Edges") {
        // Internal refractive shoulders must be in the opaque capture: WebGL's
        // screen-space transmission cannot recursively sample another glass mesh.
        mat.transmission = 0;
        mat.color.set(this.lightingLook === "refined" ? "#d8c7b5" : "#d4c7be");
        mat.roughness = 0.26;
        mat.metalness = 0.08;
      }
      configureInternalOptics(name, mat);
      if (enableOpaqueBackfaces(name, geom, mat, "full")) this.backfaceSurfaces.full.push(name);
      if (name === "Carbon_Ink") continue;
      const selectedMesh = new THREE.Mesh(geom, mat);
      selectedMesh.userData.surface = name;
      selectedMesh.castShadow = name === "Optical_Diffuser";
      selectedMesh.receiveShadow = true;
      this.model.add(selectedMesh);
      // Keep the authored shell and the complete selected model. Packed cards
      // share a baked interior; extraction/return ownership below swaps the
      // entire array instance for the original model before it rises.
      const shellSurfaces = [
        "Frosted_Polymer",
        "Ivory_Edges",
        "Titanium_Fasteners",
        "Index_Inlay",
        "Optical_Diffuser",
      ];
      const isInterior = ARRAY_INTERIOR_SURFACES.has(name);
      if (
        !shellSurfaces.includes(name) &&
        !isInterior
      ) {
        this.appearance.register(name, mat);
        continue;
      }
      const arrayMat = mat.clone();
      // The array screw LOD has open edges; it retains the original sidedness.
      if (name === "Titanium_Fasteners") arrayMat.side = source.side;
      if (name === "Frosted_Polymer") {
        // A packed row keeps the authored clear cover, so every cassette reads
        // with the same body and interior as an extracted file.
        arrayMat.transmission = 0.985;
        arrayMat.thickness = 0.018;
        arrayMat.roughness = CLEAR_ROUGHNESS;
        arrayMat.attenuationDistance = 8;
        if (this.lightingLook === "refined") {
          // Longer oblique paths pick up the warm body tint, while the thin
          // edges and the extracted clear cover retain a brighter response.
          arrayMat.thickness = 0.28;
          arrayMat.attenuationColor.set("#d4c7b4");
          arrayMat.attenuationDistance = 1.2;
        }
        arrayMat.transparent = false;
        arrayMat.color.set("#fffdfa");
        arrayMat.onBeforeCompile = (shader) => {
          shader.vertexShader =
            "varying float vPanelHeight;\n" + shader.vertexShader;
          shader.vertexShader = shader.vertexShader.replace(
            "#include <begin_vertex>",
            "#include <begin_vertex>\nvPanelHeight = position.y / 3.7;",
          );
          shader.fragmentShader =
            "varying float vPanelHeight;\n" + shader.fragmentShader;
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <color_fragment>",
            "#include <color_fragment>\ndiffuseColor.rgb *= mix(vec3(0.40, 0.30, 0.20), vec3(1.0, 0.98, 0.94), smoothstep(0.1, 1.0, vPanelHeight));",
          );
        };
      }
      if (name === "Ivory_Edges") {
        // Opaque ribs keep a packed row readable; the clear cover above is what
        // carries the authored body and interior.
        arrayMat.transmission = 0;
        arrayMat.color.set(
          this.lightingLook === "refined" ? "#dcc9b0" : "#fff5e9",
        );
        arrayMat.roughness = 0.38;
      }
      if (name === "Index_Inlay") {
        arrayMat.color.set("#e4d6c5");
        arrayMat.metalness = 0.05;
      }
      if (enableOpaqueBackfaces(name, geom, arrayMat, "array")) this.backfaceSurfaces.array.push(name);
      this.appearance.register(name, mat, arrayMat);
      const arraySource = new THREE.Mesh(geom, arrayMat);
      arraySource.userData.surface = name;
      if (isInterior || name === "Optical_Diffuser") this.arrayInteriorSources.push(arraySource);
      if (this.arrayOcclusion && name === "Optical_Diffuser") this.arrayVisibility.setOpaqueSubstrate(geom);
      // Register both palettes even when the body is baked. The complete model
      // must retain the existing low-lift appearance rather than acquire the
      // detail-only dither used for surfaces without a low palette.
      if (!isInterior || this.arrayInteriorMode === "geometry")
        addArrayInstance(arraySource, name === "Optical_Diffuser");
    }
    if (this.arrayInteriorMode === "baked") {
      try {
        this.arrayInteriorBake = bakeArrayInterior(this.renderer, this.scene, this.arrayInteriorSources);
        for (const mesh of this.arrayInteriorBake.meshes)
          this.arrayInteriorInstances.push(addArrayInstance(mesh));
      } catch (error) {
        const failedInstances = new Set(this.arrayInteriorInstances);
        this.instances = this.instances.filter(inst => !failedInstances.has(inst));
        for (const inst of failedInstances) {
          this.scene.remove(inst);
          inst.dispose();
        }
        this.arrayInteriorInstances = [];
        this.arrayInteriorBake?.dispose();
        this.arrayInteriorBake = undefined;
        this.arrayInteriorError = error instanceof Error ? error.message : String(error);
        console.warn("Archive interior bake unavailable; retaining full geometry.", error);
        for (const mesh of this.arrayInteriorSources)
          if (ARRAY_INTERIOR_SURFACES.has(mesh.userData.surface)) addArrayInstance(mesh);
      }
    }
    this.arrayVisibility.prepare(this.instances);
    this.labelCanvas.width = ARCHIVE_LABEL_WIDTH;
    this.labelCanvas.height = ARCHIVE_LABEL_HEIGHT;
    this.labelTexture = new THREE.CanvasTexture(this.labelCanvas);
    this.labelTexture.colorSpace = THREE.SRGBColorSpace;
    this.labelTexture.userData.archivePrint = true;
    this.labelTexture.anisotropy =
      this.renderer.capabilities.getMaxAnisotropy();
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(ARCHIVE_LABEL_SIZE.width, ARCHIVE_LABEL_SIZE.height),
      this.labelRenderer.createMaterial(this.labelTexture),
    );
    label.name = ARCHIVE_LABEL_NAME;
    label.layers.set(ARCHIVE_LABEL_LAYER);
    positionArchiveLabel(label);
    this.model.add(label);
    this.appearance.prepare(this.model);
    this.appearance.apply(this.model, 0);
    this.appearance.setClarity(this.model, 1);
    const placeholder = this.labelTexture;
    this.drawLabel(0);
    placeholder.dispose();
    this.scene.add(this.model);
    this.model.position.copy(this.positions[this.selectedSlot]);
    this.loaded = true;
  }

  private assemblyTemplate?: Promise<THREE.Group>;
  async createAssemblyModel(assetUrl = publicAsset("assets/archive-assembly.glb")) {
    const archiveLabel = { ...(this.archiveLabel || { code: "ARCHIVE" }) };
    this.assemblyTemplate ??= this.loadModel(assetUrl, "archive-assembly.glb")
      .then((gltf) => {
        gltf.scene.updateMatrixWorld(true);
        return gltf.scene;
      })
      .catch((error) => {
        this.assemblyTemplate = undefined;
        throw error;
      });
    const template = await this.assemblyTemplate;
    const model = new THREE.Group();
    const meshes: THREE.Mesh[] = [];
    template.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const name = (object.material as THREE.Material).name.replace(
        /\.\d+$/,
        "",
      );
      const mesh = new THREE.Mesh(
        object.geometry.clone().applyMatrix4(object.matrixWorld),
        object.material,
      );
      mesh.userData.surface = name;
      mesh.userData.assemblyPart = object.userData.assemblyPart;
      model.add(mesh);
      meshes.push(mesh);
    });
    this.appearance.prepare(model);
    this.appearance.apply(model, 1);
    this.appearance.setClarity(model, this.decryption.clarity);
    const canvas = document.createElement("canvas");
    canvas.width = this.labelCanvas.width;
    canvas.height = this.labelCanvas.height;
    paintArchiveLabel(canvas, this.labelMark, archiveLabel);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.userData.archivePrint = true;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(ARCHIVE_LABEL_SIZE.width, ARCHIVE_LABEL_SIZE.height),
      new THREE.MeshBasicMaterial({
        map: texture,
        toneMapped: false,
        transparent: true,
        depthWrite: false,
      }),
    );
    positionArchiveLabel(label);
    label.name = ARCHIVE_LABEL_NAME;
    label.userData.archiveLabel = { ...archiveLabel };
    label.userData.assemblyPart = "cover";
    model.add(label);
    meshes.push(label);
    return {
      model,
      setClarity: (value: number) => this.appearance.setClarity(model, value),
      dispose: () => {
        for (const mesh of meshes) {
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
        texture.dispose();
      },
    };
  }
  setMode(mode: "hidden" | "archive" | "detail") {
    if (mode === "detail") this.departedSelection = false;
    if (mode !== "archive") this.pendingPulse = null;
    this.looping = mode !== "hidden";
    if (!this.looping) {
      this.arrayRefill.clear();
      const canonical = fileLocation(fileAtSlot(this.selectedSlot));
      this.selectedCell = { lane: canonical.lane, row: canonical.row };
      this.coordinateOrigin = { lane: 0, row: 0 };
      for (const old of this.outgoing) {
        this.disposeCollectionFile(old.group);
      }
      this.outgoing = [];
    }
    this.lastInteraction = this.clock;
    this.targetReveal = mode === "hidden" ? 0 : 1;
    this.targetDetail = mode === "detail" ? 1 : 0;
    this.dragging = false;
    if (mode !== "detail") {
      this.targetRotation = 0;
      if (this.rotation !== 0) this.returnY = this.model.position.y;
    } else this.returnY = null;
  }
  setReduced(value: boolean) {
    this.reduced = value;
  }
  /** Workspace paper uses the same final-resolution, depth-aware print pass as archive labels. */
  createPrintMaterial(map: THREE.Texture) {
    map.userData.archivePrint = true;
    map.anisotropy = Math.min(16, this.renderer.capabilities.getMaxAnisotropy());
    map.needsUpdate = true;
    return this.labelRenderer.createMaterial(map, { alignDepthSamples: true });
  }
  setQuality(value: RenderQuality | boolean) {
    const quality =
      typeof value === "boolean"
        ? normalizeQuality(undefined, value)
        : normalizeQuality(value);
    const key = JSON.stringify(quality);
    if (this.appliedQuality === key) return;
    this.appliedQuality = key;
    this.quality = quality;
    if (quality.aoSamples && quality.aoSamples !== this.aoKernelSize) {
      const old = this.ao;
      this.ao = new SSAOPass(this.scene, this.camera, 1, 1, quality.aoSamples);
      this.ao.kernelRadius = old.kernelRadius;
      this.ao.minDistance = old.minDistance;
      this.ao.maxDistance = old.maxDistance;
      const index = this.composer.passes.indexOf(old);
      this.composer.removePass(old);
      this.composer.insertPass(this.ao, index);
      old.dispose();
      this.aoKernelSize = quality.aoSamples;
    }
    this.ao.enabled = quality.aoSamples > 0;
    this.bokeh.enabled = quality.depthOfField > 0;
    this.smaa.enabled = quality.antialias === "smaa";
    this.renderer.shadowMap.enabled = quality.shadows > 0;
    const size = Math.min(
      quality.shadows || 1024,
      this.renderer.capabilities.maxTextureSize,
    );
    if (this.light.shadow.mapSize.x !== size) {
      this.light.shadow.map?.dispose();
      this.light.shadow.map = null;
      this.light.shadow.mapSize.set(size, size);
    }
    this.light.shadow.needsUpdate = true;
    applyTextureQuality(this.scene, this.renderer, quality);
    if (this.arrayInteriorBake) {
      const texture = this.arrayInteriorBake.texture;
      const anisotropy = Math.min(quality.anisotropy, this.renderer.capabilities.getMaxAnisotropy());
      if (texture.anisotropy !== anisotropy) {
        texture.anisotropy = anisotropy;
        texture.needsUpdate = true;
      }
    }
    this.resize();
  }
  private cellPosition(cell: ArchiveCell) {
    return new THREE.Vector3(
      (cell.lane - 2) * COLUMN_SPACING,
      -4.6,
      (cell.row - 15.5) * ROW_SPACING,
    );
  }
  private rebaseCoordinates() {
    // Periodically reduce the logical coordinates while preserving every
    // relative position, spring velocity, ripple and idle phase.
    const shift = {
      lane:
        Math.abs(this.selectedCell.lane) > 2048
          ? Math.round((this.selectedCell.lane - 2) / 5) * 5
          : 0,
      row:
        Math.abs(this.selectedCell.row) > 2048
          ? Math.floor((this.selectedCell.row - 12) / 8) * 8
          : 0,
    };
    if (!shift.lane && !shift.row) return;
    this.arrayRefill.rebase(shift);
    this.selectedCell.lane -= shift.lane;
    this.selectedCell.row -= shift.row;
    this.coordinateOrigin.lane += shift.lane;
    this.coordinateOrigin.row += shift.row;
    this.laneFocus.value -= shift.lane;
    this.shoulder.value -= shift.row;
    this.columnCamera.value -= shift.lane * COLUMN_SPACING;
    this.rail.value += shift.row * ROW_SPACING;
    for (const old of this.outgoing) {
      old.cell.lane -= shift.lane;
      old.cell.row -= shift.row;
    }
    for (const pulse of this.pulses) {
      pulse.lane -= shift.lane;
      pulse.row -= shift.row;
    }
    for (const cell of this.investigationSlots.values()) {
      cell.lane -= shift.lane;
      cell.row -= shift.row;
    }
    if (this.pendingPulse) {
      this.pendingPulse.lane -= shift.lane;
      this.pendingPulse.row -= shift.row;
    }
  }
  get returningFileCount() { return this.outgoing.length; }
  get selectedArchiveCell(): Readonly<ArchiveCell> { return this.selectedCell; }

  select(index: number, navigation?: ArchiveNavigation) {
    this.lastInteraction = this.clock;
    const next = fileLocation(index).slot;
    const canonical = fileLocation(index);
    const cell = this.looping
      ? selectionCell(index, this.selectedCell, navigation)
      : { lane: canonical.lane, row: canonical.row };
    const changed = !sameCell(cell, this.selectedCell);
    if (this.looping && changed && this.loaded && !this.departedSelection && this.lift.value > 0.0001) {
      const group = this.createCollectionFile(null, { returning: true });
      group.position.copy(this.model.position);
      group.quaternion.copy(this.model.quaternion);
      group.scale.copy(this.model.scale);
      this.appearance.apply(group, ease(this.lift.value / 0.4));
      this.appearance.setClarity(group, this.decryption.clarity);
      this.scene.add(group);
      this.outgoing.push({
        group,
        slot: this.selectedSlot,
        cell: { ...this.selectedCell },
        lift: { ...this.lift },
        returnY: group.rotation.y !== 0 ? group.position.y : null,
        clarity: this.decryption.clarity,
      });
      this.lift.value = 0;
      this.lift.velocity = 0;
    }
    this.selectedSlot = next;
    this.selectedCell = cell;
    if (changed) {
      this.departedSelection = false;
      this.rotation = 0;
      this.returnY = null;
    }
    const returning = this.outgoing.findIndex((o) => sameCell(o.cell, cell));
    if (returning >= 0) {
      const o = this.outgoing[returning];
      this.lift = { ...o.lift };
      this.rotation = o.group.rotation.y;
      this.returnY = o.returnY;
      this.disposeCollectionFile(o.group);
      this.outgoing.splice(returning, 1);
    }
    if (this.deferSelectionPulse) {
      this.pendingPulse = this.looping ? { ...cell } : null;
    } else this.emitPulse(cell);
    this.targetRotation = 0;
    this.drawLabel(index);
  }
  private emitPulse(cell: ArchiveCell) {
    this.pulses.push({ ...cell, time: this.clock });
    this.pulses = this.pulses.slice(-6);
  }
  setArchiveLabel(label: ArchiveLabel | string | null) {
    const content = typeof label === "string" ? { code: label } : label;
    if (archiveLabelKey(this.archiveLabel || { code: "ARCHIVE" })
      === archiveLabelKey(content || { code: "ARCHIVE" })) return;
    this.archiveLabel = content ? { ...content } : null;
    this.drawLabel();
  }
  /** Activity metadata only; select() owns the original rail and wave motion. */
  setInvestigationScanning(active: boolean) {
    this.investigationScanning = active;
  }
  /** Pin the physical occurrence until the actor releases it, even across wraps. */
  setInvestigationSlots(indices: number[]) {
    const next = new Set(indices.filter(Number.isFinite).map(index => wrap(Math.trunc(index), 40)));
    for (const index of this.investigationSlots.keys()) if (!next.has(index)) {
      this.investigationSlots.delete(index);
      this.investigationPoses.delete(index);
      this.investigationClearances.delete(index);
    }
    for (const index of next) if (!this.investigationSlots.has(index)) {
      this.investigationPoses.set(index, this.archiveSourcePose(index));
      const cell = selectionCell(index, this.selectedCell);
      this.investigationSlots.set(index, cell);
      if (sameCell(cell, this.selectedCell)) this.departedSelection = false;
    }
  }
  get isArchiveRefilling() { return this.arrayRefill.active; }
  canExtractArchive(index: number) {
    return !this.arrayRefill.blocks(selectionCell(index, this.selectedCell).lane);
  }
  /** Release the actor's vacancy, then slide the surviving rear row forward. */
  departInvestigationSlot(index: number) {
    const cell = this.investigationSlots.get(wrap(Math.trunc(index), 40));
    if (!cell) return;
    this.arrayRefill.remove(cell);
    if (sameCell(cell, this.selectedCell)) {
      this.departedSelection = true;
      this.pendingPulse = null;
      this.lift.value = 0; this.lift.velocity = 0;
      this.returnY = null;
      this.model.visible = false;
    }
    this.outgoing = this.outgoing.filter(item => {
      if (!sameCell(item.cell, cell)) return true;
      this.disposeCollectionFile(item.group);
      return false;
    });
  }
  setInvestigationReading(index: number | null) {
    this.setInvestigationSlots(index === null ? [] : [index]);
  }
  private drawLabel(_index?: number) {
    const label = this.model.getObjectByName(ARCHIVE_LABEL_NAME) as THREE.Mesh | undefined;
    if (!label) return;
    const content = this.archiveLabel || { code: "ARCHIVE" };
    this.labelTexture = this.labels().bind(label.material as THREE.MeshBasicMaterial, content, 'hero-label');
    this.labelCanvas = this.labelTexture.image as HTMLCanvasElement;
    label.userData.archiveLabel = { ...content };
  }
  resize() {
    const w = this.container.clientWidth,
      h = this.container.clientHeight;
    const kind = this.container.closest<HTMLElement>("[data-layout]")?.dataset.layout ?? "";
    const displayHeight = this.container.getBoundingClientRect().height;
    if (this.layoutKind === "cinematic" && kind !== "cinematic" && this.displayHeight > 0) {
      // Removing letterboxing starts from the same apparent model size. The
      // existing camera interpolation then carries it to the responsive anchor.
      this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(
        Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * displayHeight / this.displayHeight,
      ));
    }
    this.displayHeight = displayHeight;
    this.layoutKind = kind;
    const dimensions = resizeQuality(
      this.renderer,
      this.composer,
      this.container,
      this.quality,
      { sharpLabels: true },
    );
    this.scenePixelHeight = dimensions.height;
    this.ao.setSize(
      Math.max(1, Math.floor(dimensions.width * this.quality.aoResolution)),
      Math.max(1, Math.floor(dimensions.height * this.quality.aoResolution)),
    );
    this.container.dataset.renderQuality = JSON.stringify({
      ...JSON.parse(this.container.dataset.renderQuality!),
      aoSamples: this.ao.enabled ? this.aoKernelSize : 0,
      aoWidth: this.ao.width,
      aoHeight: this.ao.height,
      shadows: this.renderer.shadowMap.enabled
        ? this.light.shadow.mapSize.x
        : 0,
      depthOfField: this.bokeh.enabled ? this.quality.depthOfField : 0,
    });
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  /** Reuse the visible array instances for navigation from adjacent stations. */
  pickArchiveSurface(raycaster: THREE.Raycaster) {
    if (!this.loaded || !this.collectionArrayVisible || this.reveal < 0.8) return undefined;
    return visibleSceneHit(raycaster.intersectObjects([...this.arrayStationPickMeshes, this.model], true));
  }
  private cellForHit(hit: THREE.Intersection | undefined) {
    if (!hit) return null;
    if (hit.instanceId === undefined) return this.selectedCell;
    const index = this.arrayVisibility.logicalIndex(hit.object as THREE.InstancedMesh, hit.instanceId);
    return index === undefined ? null : this.cells[index];
  }
  private bindPointer() {
    const canvas = this.renderer.domElement;
    let startX = 0,
      startY = 0;
    let activePointer: number | null = null, previousX = 0, started = 0, cancelled = false;
    const pointers = new Set<number>();
    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pointers.add(e.pointerId);
      if (pointers.size > 1) { cancelled = true; this.dragging = false; return; }
      activePointer = e.pointerId;
      cancelled = false;
      previousX = e.clientX;
      started = performance.now();
      startX = e.clientX;
      startY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      if (this.canInspect) {
        this.dragging = true;
        canvas.setPointerCapture(e.pointerId);
      } else if (this.reveal >= 0.8 && this.detail <= 0.2 && this.loaded) {
        // Camera easing can change the cell beneath a stationary pointer.
        // Press also supplies advance intent for touch, which has no hover.
        const r = canvas.getBoundingClientRect();
        this.cursor.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
        this.raycaster.setFromCamera(this.cursor, this.camera);
        const pick = () => this.raycaster.intersectObjects([...this.arrayPickMeshes, this.model], true)[0];
        const hit = this.performanceProbe ? this.performanceProbe.measureWork('archive-pointer-press', pick) : pick();
        const cell = this.cellForHit(hit);
        this.onHover?.(cell ? fileAtCell(cell) : null, cell ? { ...cell } : undefined);
      }
    }, { signal: this.events.signal });
    canvas.addEventListener("pointermove", (e) => {
      if (activePointer !== null && e.pointerId !== activePointer) return;
      if (cancelled) return;
      const r = canvas.getBoundingClientRect();
      if (e.pointerType === "mouse") this.pointer.set(
        (e.clientX - r.left) / r.width - 0.5,
        (e.clientY - r.top) / r.height - 0.5,
      );
      if (this.dragging) {
        if (!this.canInspect) {
          this.dragging = false;
          return;
        }
        this.targetRotation = THREE.MathUtils.clamp(
          this.targetRotation + (e.clientX - previousX) * 0.004,
          -0.8,
          0.8,
        );
        previousX = e.clientX;
        return;
      }
      if (e.pointerType !== "mouse") return;
      if (this.reveal < 0.8 || this.detail > 0.2 || !this.loaded) return;
      this.cursor.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      );
      this.raycaster.setFromCamera(this.cursor, this.camera);
      const pick = () => this.raycaster.intersectObjects([...this.arrayPickMeshes, this.model], true)[0];
      const hit = this.performanceProbe ? this.performanceProbe.measureWork('archive-pointer-pick', pick) : pick();
      const cell = this.cellForHit(hit);
      canvas.style.cursor = cell ? "pointer" : "default";
      this.onHover?.(cell ? fileAtCell(cell) : null, cell ? { ...cell } : undefined);
    }, { signal: this.events.signal });
    canvas.addEventListener("pointerup", (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerId !== activePointer) return;
      activePointer = null;
      this.dragging = false;
      if (cancelled) return;
      if (e.pointerType !== "mouse" && this.detail < 0.2 && this.reveal >= 0.8 && this.loaded) {
        const swipe = swipeDirection(e.clientX - startX, e.clientY - startY, performance.now() - started);
        if (swipe) { this.onNavigate?.(swipe.axis, swipe.direction); return; }
      }
      if (
        Math.hypot(e.clientX - startX, e.clientY - startY) > 6 ||
        this.detail > 0.2 ||
        this.reveal < 0.8 ||
        !this.loaded
      )
        return;
      const r = canvas.getBoundingClientRect();
      this.cursor.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      );
      this.raycaster.setFromCamera(this.cursor, this.camera);
      const pick = () => this.raycaster.intersectObjects([...this.arrayPickMeshes, this.model], true)[0];
      const hit = this.performanceProbe ? this.performanceProbe.measureWork('archive-pointer-pick', pick) : pick();
      if (hit?.object.name === ARCHIVE_LABEL_NAME && hit.object.userData.archiveLabel?.sourceId) {
        this.onLabelOpen?.(hit.object.userData.archiveLabel.sourceId);
        return;
      }
      const cell = this.cellForHit(hit);
      if (cell) this.onSelect?.(fileAtCell(cell), { ...cell });
    }, { signal: this.events.signal });
    canvas.addEventListener("pointercancel", (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerId === activePointer) { activePointer = null; cancelled = true; this.dragging = false; this.onHover?.(null); }
    }, { signal: this.events.signal });
    canvas.addEventListener("lostpointercapture", (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerId === activePointer) { activePointer = null; this.dragging = false; }
    }, { signal: this.events.signal });
    canvas.addEventListener("pointerleave", () => {
      this.pointer.set(0, 0);
      this.onHover?.(null);
    }, { signal: this.events.signal });
  }
  update(
    time: number,
    cinematic?: { reveal: number; lift: number; zoom: number; time: number },
    checkpoint?: (stage: string) => void,
  ) {
    if (this.disposed) return;
    // Move the existing studio shadow coverage with a visit to the adjoining
    // shelf. Its direction, intensity, bounds and original endpoint stay exact.
    if (this.appliedLightingOffset.lengthSq() > 0) {
      this.light.position.sub(this.appliedLightingOffset);
      this.light.target.position.sub(this.appliedLightingOffset);
    }
    this.appliedLightingOffset.copy(this.collectionOffset);
    this.light.position.add(this.appliedLightingOffset);
    this.light.target.position.add(this.appliedLightingOffset);
    this.light.target.updateMatrixWorld();
    if (this.appliedCollectionOffset.lengthSq() > 0) {
      this.camera.position.sub(this.appliedCollectionOffset);
      this.cameraAim.sub(this.appliedCollectionOffset);
      this.appliedCollectionOffset.set(0, 0, 0);
    }
    const dt = Math.min(time - this.last || 0.016, 0.05);
    this.last = time;
    this.clock = time;
    if (!this.loaded) return;
    const blend = 1 - Math.exp(-dt * (this.reduced ? 35 : 2.8));
    this.reveal = cinematic
      ? cinematic.reveal
      : THREE.MathUtils.lerp(this.reveal, this.targetReveal, blend);
    this.rotation = this.targetDetail
      ? THREE.MathUtils.lerp(this.rotation, this.targetRotation, blend)
      : returnStep(this.rotation, dt, this.reduced);
    const shot = cinematic?.time ?? 29.1;
    if (cinematic) {
      this.scanTime = shot;
      this.scanBlend = 1;
    } else {
      this.scanTime += dt;
      this.scanBlend *= Math.exp(-dt * 3);
    }
    if (this.looping && !cinematic) this.rebaseCoordinates();
    this.arrayRefill.update(dt, [
      ...this.investigationSlots.values(), ...this.outgoing.map(item => item.cell),
    ], this.reduced || !!cinematic);
    const chosen = this.cellPosition(this.selectedCell);
    const selectedVisualRow = this.arrayRefill.row(this.selectedCell);
    const selectedRow = this.selectedCell.row;
    const selectedLane = this.selectedCell.lane;
    damp(this.shoulder, selectedRow, this.reduced ? 35 : 5, dt);
    damp(this.laneFocus, selectedLane, this.reduced ? 35 : 4, dt);
    damp(this.columnCamera, chosen.x, this.reduced ? 35 : 3.7, dt);
    damp(
      this.rail,
      cinematic ? 0 : -2.17 - chosen.z,
      this.reduced ? 35 : 3.7,
      dt,
    );
    if (cinematic) {
      this.rail.value = 0;
      this.rail.velocity = 0;
      this.lift.value = extraction(shot);
      this.lift.velocity = 0;
      this.shoulder.value = selectedRow;
      this.laneFocus.value = selectedLane;
      this.laneFocus.velocity = 0;
      this.columnCamera.value = chosen.x;
      this.columnCamera.velocity = 0;
    }
    // Keep the illuminated set near the origin. Lateral navigation is a track
    // movement of the whole array, just like the existing front/back rail.
    const trackX = cinematic ? 0 : this.columnCamera.value;
    const center = {
      lane: this.columnCamera.value / COLUMN_SPACING + 2,
      row: (-this.rail.value - 2.17) / ROW_SPACING + 15.5,
    };
    for (let i = 0; i < this.positions.length; i++) {
      this.cells[i] =
        cinematic || !this.looping ? poolCell(i) : visibleCell(i, center);
      this.positions[i].set(
        (this.cells[i].lane - 2) * COLUMN_SPACING,
        -4.6,
        (this.cells[i].row - 15.5) * ROW_SPACING,
      );
    }
    this.pulses = this.pulses.filter((p) => time - p.time < 3.2);
    const aligningCopy = this.outgoing.some((o) => o.returnY !== null);
    const idle =
      !cinematic &&
      !this.reduced &&
      this.targetReveal > 0 &&
      !this.targetDetail &&
      this.detail < 0.01 &&
      this.returnY === null &&
      !aligningCopy &&
      time - this.lastInteraction > 2.5;
    this.idleGain = cinematic
      ? 0
      : THREE.MathUtils.lerp(
          this.idleGain,
          idle ? 1 : 0,
          1 - Math.exp(-dt * (idle ? 0.8 : 4)),
        );
    this.pulseGain = THREE.MathUtils.lerp(
      this.pulseGain,
      this.targetDetail || this.returnY !== null || aligningCopy ? 0 : 1,
      1 - Math.exp(-dt * 8),
    );
    const field = (row: number, lane: number) => {
      if (cinematic)
        return cinematicField(
          row,
          lane,
          shot,
          this.shoulder.value,
          this.laneFocus.value,
        );
      let height =
        archiveWave(
          row + this.coordinateOrigin.row,
          lane + this.coordinateOrigin.lane,
          this.scanTime,
        ) *
          this.scanBlend +
        idleWave(
          row + this.coordinateOrigin.row,
          lane + this.coordinateOrigin.lane,
          time,
        ) *
          this.idleGain;
      if (!cinematic && !this.reduced) {
        let ripple = 0;
        for (const p of this.pulses) {
          const distance = Math.hypot(row - p.row, (lane - p.lane) * 2.2);
          const age = time - p.time;
          ripple +=
            this.selectionPulse(distance, age) *
            (this.deferSelectionPulse ? rippleEnvelope(distance, age) : 1);
        }
        height += THREE.MathUtils.clamp(ripple, -0.6, 0.6) * this.pulseGain;
      }
      const distance = row - this.shoulder.value;
      return (
        height +
        settlingWave(distance, 26.56) *
          columnStrength(lane, this.laneFocus.value)
      );
    };
    const selectedBase = chosen.y + field(selectedVisualRow, selectedLane);
    if (!cinematic) {
      if (this.returnY !== null && this.rotation !== 0) {
        this.lift.value = this.returnY - selectedBase;
        this.lift.velocity = 0;
      } else {
        this.returnY = null;
        damp(
          this.lift,
          this.targetDetail
            ? INSPECTION_LIFT
            : this.departedSelection ? 0 : this.outgoing.some(
                  (o) =>
                    o.returnY !== null &&
                    o.cell.lane === selectedLane &&
                    Math.abs(o.cell.row - selectedRow) < 5,
                )
              ? 0
              : 0.4 * this.targetReveal,
          this.reduced
            ? 35
            : this.deferSelectionPulse &&
                !this.targetDetail &&
                this.lift.value < 0.4
              ? 7.6
              : 4.2,
          dt,
        );
      }
    }
    const cameraTarget = this.targetDetail
      ? ease((this.lift.value - 0.8) / 2.4)
      : this.returnY !== null
        ? this.detail
        : ease((this.lift.value - 0.4) / (INSPECTION_LIFT - 0.4));
    this.detail = cinematic
      ? cinematic.zoom
      : THREE.MathUtils.lerp(this.detail, cameraTarget, blend);
    const detail = this.detail;
    this.appearance.apply(this.model, ease(this.lift.value / 0.4));
    this.appearance.setClarity(this.model, this.decryption.clarity);
    // Reference 26.92–27.76: the array travels horizontally into a white field.
    const entry = cinematic ? ease((shot - 21.9) / 0.86) : this.reveal;
    const entranceTime = THREE.MathUtils.clamp((shot - 21.92) / 0.75, 0, 1);
    const entryZ = cinematic
      ? -23 * (1 - entranceTime) ** 2
      : -28 * (1 - entry);
    for (let i = this.outgoing.length - 1; i >= 0; i--) {
      const o = this.outgoing[i];
      const p = this.cellPosition(o.cell);
      const visualRow = this.arrayRefill.row(o.cell);
      p.z += (visualRow - o.cell.row) * ROW_SPACING;
      const baseY = p.y + field(visualRow, o.cell.lane);
      o.group.rotation.y = returnStep(o.group.rotation.y, dt, this.reduced);
      if (o.returnY !== null) {
        o.lift.value = o.returnY - baseY;
        o.lift.velocity = 0;
        if (o.group.rotation.y === 0) o.returnY = null;
      } else damp(o.lift, 0, this.reduced ? 35 : 4.5, dt);
      o.group.position.set(
        p.x - trackX,
        baseY + o.lift.value,
        p.z + entryZ + this.rail.value,
      );
      const quality = ease(o.lift.value / 0.4);
      this.appearance.apply(o.group, quality);
      this.appearance.setClarity(o.group, o.clarity);
      const { lane } = o.cell;
      const row = visualRow;
      o.group.rotation.x =
        (field(row + 0.5, lane) - field(row - 0.5, lane)) *
        0.024 *
        (1 - detail) *
        (1 - quality);
      if (o.lift.value < 0.0001 && Math.abs(o.group.rotation.y) < 0.0001) {
        this.disposeCollectionFile(o.group);
        this.outgoing.splice(i, 1);
      }
    }
    if (
      this.pendingPulse &&
      !cinematic &&
      !this.targetDetail &&
      this.targetReveal
    ) {
      const selectedY = selectedBase + this.lift.value;
      const oldCardsLower = this.outgoing.every(
        (old) =>
          old.cell.lane !== selectedLane ||
          Math.abs(old.cell.row - selectedRow) > 4 ||
          old.group.position.y + 0.015 < selectedY,
      );
      // The new file causes the wave: finish most of its rise and let nearby
      // outgoing files get below it before starting the outward pulse.
      if (this.lift.value >= 0.35 && this.returnY === null && oldCardsLower) {
        if (!this.reduced) this.emitPulse(this.pendingPulse);
        this.pendingPulse = null;
      }
    }
    // Resolve returning copies before restoring their array instances, avoiding
    // a missing file for one frame at the ownership handoff.
    const hidden = new Set(this.outgoing.map((o) => cellKey(o.cell)));
    if (!this.departedSelection) hidden.add(cellKey(this.selectedCell));
    const occupied = new Set([...this.investigationSlots.values()].map(cellKey));
    for (const key of occupied) hidden.add(key);
    this.model.visible = this.collectionArrayVisible && !this.departedSelection
      && !this.arrayRefill.vacant(this.selectedCell) && !occupied.has(cellKey(this.selectedCell));
    // A manual selection can create a returning copy while an actor owns that
    // same physical cassette. Keep the return state but render a single owner.
    for (const outgoing of this.outgoing) outgoing.group.visible = this.collectionArrayVisible && !occupied.has(cellKey(outgoing.cell));
    for (let i = 0; i < this.positions.length; i++) {
      const p = this.positions[i];
      const { lane } = this.cells[i];
      const row = this.arrayRefill.row(this.cells[i]);
      const slope = field(row + 0.5, lane) - field(row - 0.5, lane);
      this.dummy.position.set(
        p.x - trackX,
        p.y + field(row, lane),
        (row - 15.5) * ROW_SPACING + entryZ + this.rail.value,
      );
      this.dummy.rotation.set(slope * 0.024 * (1 - detail), 0, 0);
      // Store the real pose even for a hidden or off-camera cell. Actors can
      // acquire it later, independently of the packed GPU instance index.
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.arrayVisibility.setSlot(i, this.dummy.matrix,
        !this.arrayRefill.vacant(this.cells[i]) && !hidden.has(cellKey(this.cells[i])) && !((cinematic || !this.looping) && i >= 160));
    }
    // Actor-owned physical cells still follow the authored field and rail even
    // when navigation moves them outside the reusable logical pool.
    for (const [index, cell] of this.investigationSlots) {
      const pose = this.investigationPoses.get(index)!;
      const p = this.cellPosition(cell);
      pose.position.set(p.x - trackX, p.y + field(cell.row, cell.lane), p.z + entryZ + this.rail.value);
      const slope = field(cell.row + 0.5, cell.lane) - field(cell.row - 0.5, cell.lane);
      this.dummy.rotation.set(slope * 0.024 * (1 - detail), 0, 0);
      pose.quaternion.copy(this.dummy.quaternion);
      let top = pose.position.y + 3.76;
      for (let row = cell.row - 5; row <= cell.row + 5; row++) {
        if (row !== cell.row) top = Math.max(top, -4.6 + field(row, cell.lane) + 3.76);
      }
      for (const outgoing of this.outgoing) if (outgoing.cell.lane === cell.lane && !sameCell(outgoing.cell, cell))
        top = Math.max(top, outgoing.group.position.y + 3.76);
      this.investigationClearances.set(index, Math.max(INSPECTION_LIFT, top + 0.35 - pose.position.y));
    }
    this.model.position.set(
      chosen.x - trackX,
      selectedBase + this.lift.value,
      (selectedVisualRow - 15.5) * ROW_SPACING + entryZ + this.rail.value,
    );
    // Extraction only changes elevation. Reframing belongs to the camera.
    this.model.rotation.set(
      (field(selectedVisualRow + 0.5, selectedLane) -
        field(selectedVisualRow - 0.5, selectedLane)) *
        0.024 *
        (1 - detail) *
        (1 - ease(this.lift.value / 0.4)),
      cinematic ? 0 : this.rotation,
      0,
    );
    // Measured from frame 787: X edge (382,-204), adjacent row (78,38).
    // The label vertical edge constrains height; the file base is occluded.
    // Do not calibrate field of view from the visible fragment of a file.
    const orbit = ease((shot - 22.6) / 1.6);
    const settle = ease((shot - 24.25) / 2.25);
    const yaw = THREE.MathUtils.degToRad(89 - 22 * orbit - 8 * settle);
    const elevation = THREE.MathUtils.degToRad(
      3 + 40 * ease((shot - 21.96) / 0.22) - 8 * orbit - 16 * settle,
    );
    const span = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(10.8, 10.3, orbit),
      7.33,
      settle,
    );
    let distance = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(28 + 7 * orbit, 140, settle),
      72,
      detail,
    );
    const arrayAim = new THREE.Vector3(
      -1.091,
      THREE.MathUtils.lerp(-2.55 + 0.4 * orbit, -0.045, settle),
      THREE.MathUtils.lerp(2.48, 0.481, settle),
    );
    const cameraAim = arrayAim.clone();
    const viewDirection = new THREE.Vector3(
      -Math.sin(yaw) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(yaw) * Math.cos(elevation),
    );
    if (cinematic) {
      const earlyTurn = ease((shot - 27.3) / 1.3);
      const finalTurn = ease((shot - 28.6) / 5.4);
      const shotYaw =
        yaw - THREE.MathUtils.degToRad(9 * earlyTurn + 32 * finalTurn);
      const shotElevation =
        elevation - THREE.MathUtils.degToRad(1.5 * earlyTurn + 3.7 * finalTurn);
      viewDirection.set(
        -Math.sin(shotYaw) * Math.cos(shotElevation),
        Math.sin(shotElevation),
        Math.cos(shotYaw) * Math.cos(shotElevation),
      );
    } else {
      viewDirection
        .lerp(new THREE.Vector3(-0.277, 0.238, 0.931), detail)
        .normalize();
    }
    if (cinematic) {
      const pan = ease((shot - 25.4) / 0.95);
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      cameraAim.addScaledVector(
        right,
        -2.05 * (1 - pan) * ease((shot - 24.2) / 0.8),
      );
    }
    if (cinematic && shot >= 25.05 && shot <= 27.3) {
      // Frames 760–785: the camera carries the same physical column from the
      // right into the selected position while the neighboring crests subside.
      const pan = ease((shot - 25.4) / 1.05);
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      const up = new THREE.Vector3()
        .crossVectors(viewDirection, right)
        .normalize();
      const pixelScale = 1080 / span;
      const anchorAim = this.model.position
        .clone()
        .add(new THREE.Vector3(-2.5, 3.7, 0));
      anchorAim.addScaledVector(
        right,
        -(THREE.MathUtils.lerp(840, 518, pan) - 960) / pixelScale,
      );
      anchorAim.addScaledVector(
        up,
        -(540 - THREE.MathUtils.lerp(340, 288, pan)) / pixelScale,
      );
      cameraAim.lerp(anchorAim, ease((shot - 25.05) / 0.35));
    }
    if (cinematic && shot > 27.3) {
      const close = ease((shot - 27.3) / 6.7);
      const extractionCamera = ease((shot - 27.3) / 1.25);
      const screenX = THREE.MathUtils.lerp(
        518 - 98 * extractionCamera,
        618,
        close,
      );
      const screenY = THREE.MathUtils.lerp(
        296 + 34 * extractionCamera,
        287,
        close,
      );
      const pixelScale = 1080 / THREE.MathUtils.lerp(span, 5.9, detail);
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      const up = new THREE.Vector3()
        .crossVectors(viewDirection, right)
        .normalize();
      const anchorAim = this.model.position
        .clone()
        .add(new THREE.Vector3(-2.5, 3.7, 0));
      anchorAim.addScaledVector(right, -(screenX - 960) / pixelScale);
      anchorAim.addScaledVector(up, -(540 - screenY) / pixelScale);
      cameraAim.lerp(anchorAim, ease((shot - 27.3) / 0.5));
    }
    const framing = archiveFraming(this.container.clientWidth, this.container.clientHeight, span, detail,
      this.container.closest<HTMLElement>("[data-layout]")?.dataset.layout === "compact");
    if (!cinematic) {
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      const up = new THREE.Vector3()
        .crossVectors(viewDirection, right)
        .normalize();
      const width = this.container.clientWidth, height = this.container.clientHeight;
      const pixelScale = height / framing.span;
      if (framing.portrait) {
        // Keep the preview camera independent of the live lift, wave and rail.
        // Following model.position here would visually cancel those motions.
        const previewAim = new THREE.Vector3(0, -4.6 + settlingWave(0, 26.56) + 0.4 + 1.85, -2.17);
        previewAim.addScaledVector(up, (framing.previewY - 0.5) * height / pixelScale);
        cameraAim.copy(previewAim);
      }
      const detailAim = (this.collectionDetailPosition
        ? this.collectionDetailPosition.clone().sub(this.collectionOffset)
        : this.model.position.clone()).add(new THREE.Vector3(0, 1.85, 0));
      detailAim.addScaledVector(right, (0.5 - framing.detailX) * width / pixelScale);
      detailAim.addScaledVector(up, (framing.detailY - 0.5) * height / pixelScale);
      cameraAim.lerp(detailAim, detail);
    }
    let overviewSpan = framing.span * (1 + (this.collectionOverviewScale - 1) * (1 - detail));
    if (!cinematic && this.collectionFraming && this.collectionFraming.amount > 0) {
      const frame = this.collectionFraming;
      const amount = frame.amount * (1 - detail);
      if (frame.direction) viewDirection.lerp(frame.direction, amount).normalize();
      const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), viewDirection).normalize();
      const up = new THREE.Vector3().crossVectors(viewDirection, right).normalize();
      // Offset is already interpolated by the adapter. Remove its complete
      // destination here so framing and physical travel share one easing.
      const aim = frame.center.clone().addScaledVector(this.collectionOffset, -1 / frame.amount)
        .addScaledVector(right, (0.5 - frame.x) * frame.span * this.camera.aspect)
        .addScaledVector(up, (frame.y - 0.5) * frame.span);
      cameraAim.lerp(aim, amount);
      overviewSpan = THREE.MathUtils.lerp(overviewSpan, frame.span, amount);
      if (frame.distance !== undefined) distance = THREE.MathUtils.lerp(distance, frame.distance, amount);
    }
    const cameraPosition = cameraAim
      .clone()
      .addScaledVector(viewDirection, distance);
    if (!cinematic && !this.reduced && this.collectionFraming?.parallax !== false) {
      cameraPosition.x += this.pointer.x * 0.12;
      cameraPosition.y -= this.pointer.y * 0.12;
    }
    const cameraBlend = cinematic ? 1 : 1 - Math.exp(-dt * 5);
    this.camera.position.lerp(cameraPosition, cameraBlend);
    this.cameraAim.lerp(cameraAim, cameraBlend);
    this.camera.lookAt(this.cameraAim);
    this.camera.fov = THREE.MathUtils.lerp(
      this.camera.fov,
      THREE.MathUtils.radToDeg(
        2 * Math.atan((cinematic ? THREE.MathUtils.lerp(span, 5.9, detail)
          : overviewSpan) / (2 * distance)),
      ),
      cameraBlend,
    );
    const fog = this.scene.fog as THREE.Fog;
    // The camera position is damped after its target distance changes. Anchor
    // fog to the rendered camera, or entry puts the array behind the far plane
    // until the camera catches up (a brief white wash that exit never showed).
    const renderedDistance = this.camera.position.distanceTo(this.cameraAim);
    fog.near = renderedDistance + THREE.MathUtils.lerp(5, -1, detail);
    fog.far = renderedDistance + THREE.MathUtils.lerp(25, 12, detail);

    if (this.collectionOffset.lengthSq() > 0) {
      this.camera.position.add(this.collectionOffset);
      this.cameraAim.add(this.collectionOffset);
      this.appliedCollectionOffset.copy(this.collectionOffset);
      this.camera.lookAt(this.cameraAim);
    }
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    let neighborTop = -Infinity;
    const lane = selectedLane,
      row = selectedRow;
    for (let r = row - 5; r <= row + 5; r++) {
      if (r !== row)
        neighborTop = Math.max(neighborTop, -4.6 + field(r, lane) + 3.76);
    }
    for (const o of this.outgoing) {
      if (o.cell.lane === lane && Math.abs(o.cell.row - row) <= 5) {
        neighborTop = Math.max(neighborTop, o.group.position.y + 3.76);
      }
    }
    this.clearance = this.model.position.y - neighborTop;
    this.canInspect =
      !cinematic &&
      Boolean(this.targetDetail) &&
      detail > 0.9 &&
      this.pulseGain < 0.01 &&
      this.clearance > 0.3;
    this.container.dataset.inspection =
      this.returnY !== null
        ? "aligning"
        : this.canInspect
          ? "ready"
          : this.targetDetail
            ? "lifting"
            : "preview";
    this.beforeRender?.();
    this.sampleCameraMotion();
    // Use this frame's final camera, including the translation to the rack.
    // The light follows collectionOffset, independently of the main camera.
    // Prepare its final projection before filtering instances, including frame 1.
    this.light.updateWorldMatrix(true, false);
    this.light.target.updateWorldMatrix(true, false);
    this.light.shadow.camera.updateProjectionMatrix();
    this.light.shadow.updateMatrices(this.light);
    this.arrayVisibility.submit(this.camera, this.instances, this.arrayCulling, this.scenePixelHeight,
      [this.light.shadow.getFrustum()]);
    for (const mesh of this.instances) mesh.visible = this.collectionArrayVisible;
    const focalPoint = (this.collectionFocus?.clone() ?? this.model.position
      .clone()
      .add(new THREE.Vector3(0, 2, 0)))
      .applyMatrix4(this.camera.matrixWorldInverse);
    const bokehUniforms = this.bokeh.uniforms as Record<
      string,
      { value: number }
    >;
    bokehUniforms.focus.value = -focalPoint.z;
    this.bokeh.enabled = this.quality.depthOfField > 0 && this.collectionDepthOfFieldScale > 0.001;
    bokehUniforms.aperture.value =
      (THREE.MathUtils.lerp(0.0003, 0.0008, detail) *
        this.quality.depthOfField * this.collectionDepthOfFieldScale) /
      100;
    checkpoint?.("sceneUpdate");
    this.renderer.info.reset();
    this.renderer.shadowMap.needsUpdate = this.renderer.shadowMap.enabled;
    this.labelRenderer.prepare(this.scene);
    checkpoint?.("labelPrepare");
    this.composer.render();
    checkpoint?.("composer");
    this.performanceProbe?.gpuStage(this.renderer, "label-overlay");
    this.labelRenderer.render(this.renderer, this.scene, this.camera);
    checkpoint?.("labelOverlay");
  }
  /** Clone the actual authored cassette, including its original optics. */
  createCollectionFile(index: number | null, options: { shelf?: boolean; returning?: boolean; label?: ArchiveLabel } = {}, fresh = false) {
    const kind = options.shelf ? "shelf" : "moving";
    let group = fresh ? undefined : this.collectionPools[kind].pop();
    if (group) {
      this.pooledCollections.delete(group);
      this.collectionReused++;
    } else {
      group = this.model.clone(true);
      if (options.shelf) {
        for (const mesh of group.children)
          if (mesh.userData.surface === "Ivory_Edges") mesh.userData.useArrayMaterial = true;
      }
      this.appearance.prepare(group);
      const label = group.getObjectByName(ARCHIVE_LABEL_NAME) as THREE.Mesh;
      label.material = this.labelRenderer.createMaterial(this.labelTexture!);
      label.layers.set(ARCHIVE_LABEL_LAYER);
      delete label.userData.archiveLabelKey;
      this.collectionKinds.set(group, kind);
      this.collectionCreated++;
    }
    const label = group.getObjectByName(ARCHIVE_LABEL_NAME) as THREE.Mesh;
    const content = options.label || (options.returning ? this.archiveLabel || { code: "ARCHIVE" }
      : { code: index === null ? "READING" : "NO." + String(index + 1).padStart(3, "0") });
    const visibleLabel = this.model.getObjectByName(ARCHIVE_LABEL_NAME) as THREE.Mesh;
    const retained = options.returning && !options.label
      && this.labels().share(visibleLabel.material as THREE.MeshBasicMaterial, label.material as THREE.MeshBasicMaterial);
    if (!retained) this.labels().bind(label.material as THREE.MeshBasicMaterial, content, options.shelf ? 'shelf-label' : 'moving-label');
    label.userData.archiveLabelKey = archiveLabelKey(content); label.userData.archiveLabel = { ...content };
    positionArchiveLabel(label);
    if (options.returning) {
      const previous = this.model.getObjectByName(ARCHIVE_LABEL_NAME)!;
      label.position.copy(previous.position); label.quaternion.copy(previous.quaternion);
    }
    group.userData.performanceFamily = options.shelf ? "shelf" : "moving";
    delete group.userData.sourceId;
    group.visible = true;
    group.position.set(0, 0, 0);
    group.scale.setScalar(1);
    this.appearance.apply(group, 1);
    this.appearance.setClarity(group, 1);
    group.rotation.set(0, 0, 0);
    if (options.shelf) this.shelfInterior?.attach(group);
    return group;
  }
  /** Prepared between animation frames, before the shelf needs its first image. */
  async prepareShelfInterior() {
    if (this.disposed || this.shelfInteriorAttempted) return;
    this.shelfInteriorAttempted = true;
    const template = this.createCollectionFile(null, { shelf: true });
    try {
      // The offline-style capture has different fog/shadow/tone-mapping defines.
      // Compile those before its synchronous render/readback, and retain them
      // while the extra views are prepared in separate background tasks.
      await this.prepareInteriorBakePrograms(template);
      if (this.disposed) return;
      if (this.renderer.getContext().isContextLost()) { this.shelfInteriorAttempted = false; return; }
      try {
        this.shelfInterior = new ShelfInterior(this.renderer, this.scene, template);
        this.shelfInterior.attach(template);
      } catch (error) {
        if (this.renderer.getContext().isContextLost()) this.shelfInteriorAttempted = false;
        this.shelfInteriorError = error instanceof Error ? error.message : String(error);
        console.warn("Shelf interior bake unavailable; retaining complete geometry.", error);
      }
      await this.preparePrograms("shelf", [template]);
    } finally { this.disposeCollectionFile(template); }
  }
  private async prepareInteriorBakePrograms(template: THREE.Group) {
    const scene = new THREE.Scene();
    scene.environment = this.scene.environment;
    scene.environmentIntensity = this.scene.environmentIntensity;
    scene.environmentRotation.copy(this.scene.environmentRotation);
    copyInteriorLights(this.scene, scene);
    const root = new THREE.Group(), materials: THREE.Material[] = [];
    for (const child of template.children) {
      if (!(child instanceof THREE.Mesh) || !(SHELF_INTERIOR_SURFACES.has(child.userData.surface) || child.userData.surface === "Optical_Diffuser")) continue;
      const material = (child.material as THREE.MeshPhysicalMaterial).clone();
      material.fog = false; material.toneMapped = false;
      if (material.isMeshPhysicalMaterial) material.transmission = 0;
      materials.push(material); root.add(new THREE.Mesh(child.geometry, material));
    }
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace });
    const shadows = this.renderer.shadowMap.enabled;
    let pending: Promise<void>;
    try {
      this.renderer.shadowMap.enabled = false;
      const task = () => this.programPreparation.prepare("shelf-bake", [root], this.renderer, this.camera, scene, target);
      pending = this.performanceProbe ? this.performanceProbe.trackLoad("shader-preparation", task, { family: "shelf-bake" }) : task();
    } finally { this.renderer.shadowMap.enabled = shadows; }
    try { await pending; }
    finally { target.dispose(); for (const material of materials) material.dispose(); }
  }
  async prepareShelfView(index: number) {
    if (this.disposed || !this.shelfInterior || this.shelfInterior.hasView(index + 1)) return;
    const directions = [[-2.15, 0.87, 1], [-2.5, 1, 1], [-2.85, 1.14, 1], [-0.30, 0.23, 1]];
    const direction = directions[index];
    if (!direction) return;
    const template = this.createCollectionFile(null, { shelf: true });
    const task = async () => {
      this.shelfInterior!.addView(this.renderer, this.scene, template, new THREE.Vector3(...direction));
    };
    try {
      if (this.performanceProbe) await this.performanceProbe.trackLoad("shelf-view-bake", task, { view: index + 1 });
      else await task();
    } finally { this.disposeCollectionFile(template); }
  }
  preparePrograms(kind: "shelf" | "workspace", sources: readonly THREE.Object3D[]) {
    const task = () => this.programPreparation.prepare(kind, sources, this.renderer, this.camera, this.scene, this.composer.readBuffer);
    return this.performanceProbe ? this.performanceProbe.trackLoad("shader-preparation", task, { family: kind }) : task();
  }
  invalidatePrograms() { this.programPreparation.invalidate(); this.labelTextureCache?.invalidateResidency(); }
  setShelfDetail(group: THREE.Group, moving: boolean) {
    this.shelfInterior?.update(group, moving, this.camera, this.scenePixelHeight);
  }
  /** Run outside the animation callback; keep a small ready-to-use reserve. */
  prepareMovingFile() {
    if (this.disposed || this.collectionPools.moving.length >= 3) return;
    const group = this.createCollectionFile(null, {}, true);
    try {
      this.prepareCollectionTexture(group);
    } finally {
      this.disposeCollectionFile(group);
    }
  }
  prepareCollectionTexture(group: THREE.Group) {
    if (this.disposed) return;
    const label = group.getObjectByName(ARCHIVE_LABEL_NAME) as THREE.Mesh;
    const map = (label.material as THREE.MeshBasicMaterial).map;
    if (map) this.renderer.initTexture(map);
  }
  /** Change the immutable print reference; other files keep their current text. */
  setCollectionLabel(group: THREE.Group, index: number | null, metadata?: Pick<ArchiveLabel, "title" | "sourceId">) {
    const content = { code: index === null ? "READING" : "NO." + String(index + 1).padStart(3, "0"), ...metadata };
    const label = group.getObjectByName(ARCHIVE_LABEL_NAME) as THREE.Mesh | undefined;
    if (!label) return;
    this.labels().bind(label.material as THREE.MeshBasicMaterial, content, this.collectionKinds.get(group) === 'shelf' ? 'shelf-label' : 'moving-label');
    label.userData.archiveLabelKey = archiveLabelKey(content); label.userData.archiveLabel = { ...content };
  }
  private releaseCollectionLabel(group: THREE.Group) {
    const label = group.getObjectByName(ARCHIVE_LABEL_NAME) as THREE.Mesh | undefined;
    if (label) this.labelTextureCache?.release(label.material as THREE.MeshBasicMaterial);
  }
  /** Latest authored pose, including wave slope and any in-progress return. */
  archiveSourcePose(index: number) {
    index = wrap(Math.trunc(index), 40);
    const cell = this.investigationSlots.get(index) || selectionCell(index, this.selectedCell);
    if (sameCell(cell, this.selectedCell)) return {
      position: this.model.position.clone(), quaternion: this.model.quaternion.clone(),
    };
    const returning = this.outgoing.find(item => sameCell(item.cell, cell));
    if (returning) return {
      position: returning.group.position.clone(), quaternion: returning.group.quaternion.clone(),
    };
    const retained = this.investigationPoses.get(index);
    if (retained) return { position: retained.position.clone(), quaternion: retained.quaternion.clone() };
    const instance = this.cells.findIndex(item => sameCell(item, cell));
    if (instance >= 0) {
      const matrix = this.arrayVisibility.matrixAt(instance);
      const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
      matrix.decompose(position, quaternion, scale);
      return { position, quaternion };
    }
    const position = this.cellPosition(cell);
    position.x -= this.columnCamera.value;
    position.z += this.rail.value;
    return { position, quaternion: new THREE.Quaternion() };
  }
  /** Position a real-source cassette without moving the user's camera. */
  archiveSourcePosition(index: number) {
    return this.archiveSourcePose(index).position;
  }
  /** True while the archive itself owns this cell's extraction and optics. */
  archiveSourceOwned(index: number) {
    const cell = this.investigationSlots.get(wrap(Math.trunc(index), 40))
      || selectionCell(index, this.selectedCell);
    return sameCell(cell, this.selectedCell);
  }
  /** Authored extraction height for a cell the archive itself has lifted. */
  archiveSourceLift(index: number) {
    const cell = this.investigationSlots.get(wrap(Math.trunc(index), 40)) || selectionCell(index, this.selectedCell);
    if (sameCell(cell, this.selectedCell)) return this.lift.value;
    return this.outgoing.find(item => sameCell(item.cell, cell))?.lift.value ?? 0;
  }
  /** Pinned rest pose: preview lifts and navigation never own an Agent's lift. */
  archiveReadingPose(index: number) {
    const rest = this.investigationPoses.get(wrap(Math.trunc(index), 40));
    if (rest) return { position: rest.position.clone(), quaternion: rest.quaternion.clone() };
    const pose = this.archiveSourcePose(index);
    pose.position.y -= this.archiveSourceLift(index);
    return pose;
  }
  archiveReadingLift(index: number) {
    return this.investigationClearances.get(wrap(Math.trunc(index), 40)) ?? INSPECTION_LIFT;
  }
  /** Carry a plugin-owned cassette through the authored surface transition. */
  setCollectionAppearance(group: THREE.Group, lift: number) {
    this.appearance.apply(group, ease(THREE.MathUtils.clamp(lift / 0.4, 0, 1)));
    this.appearance.setClarity(group, this.decryption.clarity);
  }
  pulseInvestigation(index: number) {
    this.emitPulse(selectionCell(index, this.selectedCell));
  }
  disposeCollectionFile(group: THREE.Group) {
    if (this.pooledCollections.has(group)) return;
    this.scene.remove(group);
    // Shelf status markers belong to its current source; only the authored
    // cassette and its independent label/materials are kept for reuse.
    for (const child of [...group.children]) {
      if (!(child instanceof THREE.Mesh) || child.userData.surface || child.userData.sharedShelfProxy || child.name === ARCHIVE_LABEL_NAME) continue;
      group.remove(child);
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) material.dispose();
    }
    delete group.userData.sourceId;
    group.visible = false;
    const kind = this.collectionKinds.get(group);
    if (!this.disposed && kind && this.collectionPools[kind].length < (kind === "shelf" ? SHELF_PAGE_SIZE : 4)) {
      this.collectionPools[kind].push(group);
      this.pooledCollections.add(group);
    } else {
      this.shelfInterior?.detach(group);
      this.releaseCollectionLabel(group);
      this.appearance.dispose(group);
      this.collectionKinds.delete(group);
    }
  }
  get collectionDeparture() { return this.model.position.clone(); }
  get collectionOrientation() { return this.model.quaternion.clone(); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.programPreparation?.dispose();
    this.shelfInterior?.dispose();
    this.shelfInterior = undefined;
    for (const group of this.pooledCollections) { this.releaseCollectionLabel(group); this.appearance.dispose(group); }
    this.pooledCollections.clear();
    this.collectionPools.moving.length = this.collectionPools.shelf.length = 0;
    this.events.abort();
    this.investigationSlots.clear(); this.investigationPoses.clear();
    this.arrayRefill.clear();
    this.beforeRender = undefined;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    // The bake owns its targets and derived meshes; the original palette and
    // geometry remain shared by selected/returning cards and are disposed below.
    for (const inst of this.arrayInteriorInstances) {
      this.scene.remove(inst);
      inst.dispose();
    }
    this.arrayInteriorInstances = [];
    this.arrayInteriorBake?.dispose();
    this.arrayInteriorBake = undefined;
    for (const mesh of this.arrayInteriorSources) {
      geometries.add(mesh.geometry);
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(mat);
    }
    this.arrayInteriorSources = [];
    this.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const mat of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(mat);
        for (const value of Object.values(mat)) if (value instanceof THREE.Texture && !value.userData.sharedArchiveLabel) textures.add(value);
      }
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
    geometries.forEach(value => value.dispose());
    materials.forEach(value => value.dispose());
    textures.forEach(value => value.dispose());
    this.scene.environment?.dispose();
    this.labelTextureCache?.dispose();
    this.light.shadow.map?.dispose();
    for (const pass of this.composer.passes) pass.dispose?.();
    this.composer.dispose();
    this.labelRenderer?.dispose();
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
  projectCard(x: number, y: number) {
    this.model.updateMatrixWorld(true);
    const p = this.model
      .localToWorld(new THREE.Vector3(x, y, 0.255))
      .project(this.camera);
    return [(p.x + 1) * this.container.clientWidth / 2, (1 - p.y) * this.container.clientHeight / 2];
  }
  get decryptionFrame() { return this.decryption.frame; }
  finishDecryption() { this.decryption.finish(); }
  get detailVisibility() {
    return ease((this.detail - 0.25) / 0.55);
  }
  private projectLabelPoint(x: number, y: number) {
    const label = this.model.getObjectByName(ARCHIVE_LABEL_NAME);
    if (!label) return [0, 0];
    label.updateWorldMatrix(true, false);
    const p = label.localToWorld(new THREE.Vector3(x * ARCHIVE_LABEL_SIZE.width, y * ARCHIVE_LABEL_SIZE.height, 0)).project(this.camera);
    return [Math.round((p.x * 0.5 + 0.5) * this.container.clientWidth),
      Math.round((-p.y * 0.5 + 0.5) * this.container.clientHeight)];
  }
  // TEMPORARY RHINE PROFILER: cheap, content-free snapshot; no matrix updates/traversals.
  performanceCounters() {
    let arrayPartInstances = 0, arrayBatches = 0;
    for (const mesh of this.instances) if (mesh.visible && mesh.count) { arrayPartInstances += mesh.count; arrayBatches++; }
    const triangles = this.arrayVisibility.triangleStats();
    const shelf = this.shelfInterior?.getStats();
    return { arrayPartInstances, arrayBatches,
      shelfGeometryFiles: shelf?.detailed ?? 0, shelfTextureFiles: shelf?.textured ?? 0,
      shelfMotionFiles: shelf?.reasons.motion ?? 0, shelfAngleFiles: shelf?.reasons.angle ?? 0,
      shelfPreparedViews: shelf?.views ?? 0, shelfAngleErrorMaxPixels: shelf?.angleErrorMaxPixels ?? 0, shelfBackFacing: shelf?.backFacing ?? 0,
      arrayCameraTrianglesPerPass: this.collectionArrayVisible ? triangles.cameraTrianglesPerPass : 0,
      arrayShadowTrianglesPerPass: this.collectionArrayVisible ? triangles.shadowTrianglesPerPass : 0,
      arrayShadowOnlyTrianglesPerPass: this.collectionArrayVisible ? triangles.shadowOnlyTrianglesPerPass : 0,
      arrayShadowCulledTrianglesPerPass: this.collectionArrayVisible ? triangles.shadowCulledTrianglesPerPass : 0,
      heroVisible: this.model.visible, arrayVisible: this.collectionArrayVisible,
      cameraDetailBlend: this.detail, cameraDetailTarget: this.targetDetail,
      cameraTranslation: this.cameraMotion?.translation || 0, cameraRotationRadians: this.cameraMotion?.rotationRadians || 0,
      cameraFovDelta: this.cameraMotion?.fovDegrees || 0, cameraActuallyMoving: this.cameraMotion?.actualMoving || false,
      returningFiles: this.outgoing.length, shadowEnabled: this.renderer.shadowMap.enabled,
      labelDepthEnabled: this.labelRenderer.capture.enabled, smaaEnabled: this.smaa.enabled,
      aoEnabled: this.ao.enabled, dofEnabled: this.bokeh.enabled };
  }
  performancePasses() {
    return this.composer.passes.map(pass => ({ name: pass instanceof RenderPass ? 'scene-color'
      : pass === this.labelRenderer.capture ? 'label-depth-copy' : pass === this.ao ? 'ssao'
      : pass === this.bokeh ? 'depth-of-field' : pass === this.smaa ? 'smaa' : pass instanceof OutputPass ? 'output' : 'other', pass }));
  }
  private readonly diagnosticCameraPosition = new THREE.Vector3();
  private readonly diagnosticCameraRotation = new THREE.Quaternion();
  private diagnosticCameraFov = 0;
  private diagnosticCameraInitialized = false;
  private cameraMotion = { translation: 0, rotationRadians: 0, fovDegrees: 0, actualMoving: false };
  private sampleCameraMotion() {
    if (!this.performanceProbe?.running) { this.diagnosticCameraInitialized = false; return; }
    const translation = this.diagnosticCameraInitialized ? this.camera.position.distanceTo(this.diagnosticCameraPosition) : 0;
    const rotationRadians = this.diagnosticCameraInitialized ? this.camera.quaternion.angleTo(this.diagnosticCameraRotation) : 0;
    const fovDegrees = this.diagnosticCameraInitialized ? Math.abs(this.camera.fov - this.diagnosticCameraFov) : 0;
    this.cameraMotion = { translation, rotationRadians, fovDegrees, actualMoving: translation > 0.00001 || rotationRadians > 0.000001 || fovDegrees > 0.00001 };
    this.diagnosticCameraPosition.copy(this.camera.position); this.diagnosticCameraRotation.copy(this.camera.quaternion);
    this.diagnosticCameraFov = this.camera.fov; this.diagnosticCameraInitialized = true;
  }
  private cameraDiagnostics() {
    return { position: this.camera.position.toArray(), quaternion: this.camera.quaternion.toArray(), fov: this.camera.fov,
      detailBlend: this.detail, detailTarget: this.targetDetail, lift: this.lift.value, ...this.cameraMotion };
  }
  performanceState() {
    const target = (value: { width: number; height: number } | null) => value ? { width: value.width, height: value.height } : null;
    return { loaded: this.loaded, returningFiles: this.outgoing.length, quality: { ...this.quality },
      buffers: { output: target(this.renderer.domElement), composer: target(this.composer.readBuffer),
        labelDepth: target(this.labelRenderer.capture.target), labelDepthEnabled: this.labelRenderer.capture.enabled,
        shadow: target(this.light.shadow.map), shadowEnabled: this.renderer.shadowMap.enabled,
        transmissionScale: this.renderer.transmissionResolutionScale, transmissionTarget: null },
      passes: this.composer.passes.map(pass => ({ name: pass instanceof RenderPass ? 'scene-color'
        : pass === this.labelRenderer.capture ? 'label-depth-copy' : pass === this.ao ? 'ssao'
        : pass === this.bokeh ? 'depth-of-field' : pass === this.smaa ? 'smaa' : pass instanceof OutputPass ? 'output' : 'other',
        enabled: pass.enabled })),
      content: { ...this.performanceCounters(), array: this.arrayVisibility.getStats(), backfaceCulling: this.backfaceSurfaces,
        interiorMode: this.arrayInteriorBake ? 'baked' : 'geometry' },
      camera: this.cameraDiagnostics(),
      programPreparation: this.programPreparation?.stats(),
      shelfInterior: this.shelfInterior?.getStats(true),
      labelCache: this.labelTextureCache?.stats(),
      collectionResources: { created: this.collectionCreated, reused: this.collectionReused,
        movingReserve: this.collectionPools.moving.length, shelfReserve: this.collectionPools.shelf.length },
    };
  }
  getStats() {
    this.model.updateMatrixWorld(true);
    const project = (x: number, y: number, z: number) => {
      const p = this.model
        .localToWorld(new THREE.Vector3(x, y, z))
        .project(this.camera);
      return [Math.round((p.x + 1) * this.container.clientWidth / 2), Math.round((1 - p.y) * this.container.clientHeight / 2)];
    };
    return {
      decryption: { ...this.decryption.frame, clarity: this.decryption.clarity },
      topLeft: project(-2.5, 3.7, 0),
      topRight: project(2.5, 3.7, 0),
      labelTopLeft: this.projectLabelPoint(-0.5, 0.5),
      labelBottomLeft: this.projectLabelPoint(-0.5, -0.5),
      archiveLabel: { ...this.archiveLabel },
      archiveLabelSize: [ARCHIVE_LABEL_WIDTH, ARCHIVE_LABEL_HEIGHT],
      labelCorners: [[-0.5, 0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]]
        .map(([x, y]) => this.projectLabelPoint(x, y)),
      modelPosition: this.model.position
        .toArray()
        .map((v) => Math.round(v * 10000) / 10000),
      cameraPosition: this.camera.position
        .toArray()
        .map((v) => Math.round(v * 10000) / 10000),
      fieldOfView: this.camera.fov,
      loaded: this.loaded,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      archiveCount: this.positions.length,
      arrayVisibility: this.arrayVisibility.getStats(), backfaceCulling: this.backfaceSurfaces,
      arrayDetails: this.instances.flatMap(inst => {
        const material = inst.material as THREE.MeshStandardMaterial;
        return material.userData.arrayDetail ? [{ ...material.userData.arrayDetail,
          name: inst.name, instances: inst.count,
          baseTextureBytes: (material.normalMap as THREE.DataTexture | null)?.image.data?.byteLength ?? 0,
        }] : [];
      }),
      camera: this.cameraDiagnostics(),
      programPreparation: this.programPreparation?.stats(),
      shelfInterior: {
        mode: this.shelfInterior ? "baked" : "geometry",
        ...this.shelfInterior?.getStats(true),
        ...(this.shelfInteriorError ? { error: this.shelfInteriorError } : {}),
      },
      labelCache: this.labelTextureCache?.stats(),
      collectionResources: {
        created: this.collectionCreated, reused: this.collectionReused,
        movingReserve: this.collectionPools.moving.length, shelfReserve: this.collectionPools.shelf.length,
      },
      arrayInterior: {
        mode: this.arrayInteriorBake ? "baked" : "geometry",
        requested: this.arrayInteriorMode,
        arrayGroups: this.instances.length,
        arrayTrianglesPerCassette: this.instances.filter(inst => inst.userData.lodLevel !== 1).reduce((sum, inst) =>
          sum + (inst.geometry.index?.count ?? inst.geometry.getAttribute("position").count) / 3, 0),
        arrayLowTrianglesPerCassette: this.instances.filter(inst => inst.userData.lodLevel !== 0).reduce((sum, inst) =>
          sum + (inst.geometry.index?.count ?? inst.geometry.getAttribute("position").count) / 3, 0),
        ...(this.arrayInteriorBake?.stats ?? {}),
        ...(this.arrayInteriorError ? { error: this.arrayInteriorError } : {}),
      },
      returningFiles: this.outgoing.length,
      selectionPhase: this.pendingPulse
        ? "lifting"
        : this.pulses.length
          ? "wave"
          : "settled",
      pendingPulse: this.pendingPulse ? { ...this.pendingPulse } : null,
      pulses: this.pulses.map((pulse) => ({ ...pulse })),
      referenceTime: Math.round((this.scanTime + 5) * 100) / 100,
      selectedSlot: this.selectedSlot,
      selectedLane: Math.floor(this.selectedSlot / 32),
      selectedCell: { ...this.selectedCell },
      departedSelection: this.departedSelection,
      arrayRefills: this.arrayRefill.stats().map(motion => ({ ...motion,
        cells: [Math.max(...motion.holes) + 1, ...motion.holes, Math.min(...motion.holes) - 1].map(row => {
          const index = this.cells.findIndex(cell => cell.lane === motion.lane && cell.row === row);
          const matrix = index >= 0 ? this.arrayVisibility.matrixAt(index) : null;
          return { row, visualRow: this.arrayRefill.row({ lane: motion.lane, row }),
            position: matrix ? [matrix.elements[12], matrix.elements[13], matrix.elements[14]] : null };
        }),
      })),
      selectedModelVisible: this.model.visible,
      coordinateOrigin: { ...this.coordinateOrigin },
      poolBounds: {
        minLane: Math.min(...this.cells.map((c) => c.lane)),
        maxLane: Math.max(...this.cells.map((c) => c.lane)),
        minRow: Math.min(...this.cells.map((c) => c.row)),
        maxRow: Math.max(...this.cells.map((c) => c.row)),
      },
      laneFocus: this.laneFocus.value,
      columnCamera: this.columnCamera.value,
      rotation: this.rotation,
      clearance: this.clearance,
      canInspect: this.canInspect,
      returnPhase: this.returnY !== null ? "aligning" : "lowering",
      extraction: Math.round(this.lift.value * 1000) / 1000,
      appearance: Math.round(ease(this.lift.value / 0.4) * 1000) / 1000,
      cameraDetail: Math.round(this.detail * 1000) / 1000,
      idleGain: this.idleGain,
      investigationWave: {
        active: this.investigationScanning, driver: "original-select",
      },
      investigationSlots: [...this.investigationSlots].map(([index, cell]) => ({ index, ...cell })),
      cameraDistance: this.camera.position.distanceTo(this.cameraAim),
      cameraNear: this.camera.near,
      cameraFar: this.camera.far,
      fogNear: (this.scene.fog as THREE.Fog).near,
      fogFar: (this.scene.fog as THREE.Fog).far,
      returningAppearance: this.outgoing.map((o) => ({
        slot: o.slot,
        cell: { ...o.cell },
        lift: o.lift.value,
        quality: ease(o.lift.value / 0.4),
        rotation: o.group.rotation.y,
        worldY: o.group.position.y,
        phase: o.returnY !== null ? "aligning" : "lowering",
      })),
      rail: Math.round(this.rail.value * 1000) / 1000,
    };
  }
}
