import * as THREE from "three";

export type ProgramPreparationStatus = "pending" | "compiling" | "ready" | "unsupported" | "cancelled" | "failed";
type PreparedProgram = { program: WebGLProgram; getUniforms(): unknown; getAttributes(): unknown };
type Prepared = { objects: THREE.Group[]; materials: Set<THREE.Material> };

/** Keep warm material references alive so Three does not release their programs. */
export class ProgramPreparation {
  private readonly retained: Prepared[] = [];
  private generation = 0;
  private disposed = false;
  private readonly records = new Map<string, { status: ProgramPreparationStatus; materials: number; programs: number; durationMs: number; compileMs: number; reflectionMs: number }>();

  stats() { return Object.fromEntries([...this.records].map(([key, value]) => [key, { ...value }])); }

  async prepare(kind: string, sources: readonly THREE.Object3D[], renderer: THREE.WebGLRenderer,
    camera: THREE.Camera, scene: THREE.Scene, colorTarget: THREE.WebGLRenderTarget) {
    if (this.disposed) return;
    const generation = this.generation, began = performance.now();
    const record = { status: "compiling" as ProgramPreparationStatus, materials: 0, programs: 0, durationMs: 0, compileMs: 0, reflectionMs: 0 };
    this.records.set(kind, record);
    const prepared: Prepared = { objects: [new THREE.Group(), new THREE.Group()], materials: new Set() };
    this.retained.push(prepared);
    const copies = new Map<THREE.Material, THREE.Material[]>();
    for (const source of sources) source.traverse(object => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points || object instanceof THREE.Sprite)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        let variants = copies.get(material);
        if (!variants) {
          const sides = material.transparent && material.side === THREE.DoubleSide && !material.forceSinglePass
            ? [THREE.BackSide, THREE.FrontSide] : [material.side];
          variants = sides.map(side => {
            const copy = material.clone();
            copy.onBeforeCompile = material.onBeforeCompile;
            copy.customProgramCacheKey = material.customProgramCacheKey;
            copy.side = side; copy.forceSinglePass = true;
            prepared.materials.add(copy);
            return copy;
          });
          copies.set(material, variants);
        }
        for (const material of variants) {
          const copy = object.clone(false) as THREE.Mesh;
          copy.material = material;
          prepared.objects[object.layers.isEnabled(1) ? 1 : 0].add(copy);
        }
      }
    });
    record.materials = prepared.materials.size;
    const cancelled = () => this.disposed || generation !== this.generation || renderer.getContext().isContextLost();
    try {
      const compiled = new Set<PreparedProgram>();
      // Compile under the same output target as each real pass. Restore it before
      // yielding: the visible renderer keeps running while the driver compiles.
      for (let pass = 0; pass < prepared.objects.length; pass++) {
        if (cancelled()) { record.status = "cancelled"; return; }
        const target = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
        try {
          renderer.setRenderTarget(pass === 0 ? colorTarget : null);
          const compileCamera = camera.clone();
          if (pass === 1) compileCamera.layers.set(1);
          const materials = renderer.compile(prepared.objects[pass], compileCamera, scene);
          for (const material of materials) {
            const program = (renderer.properties.get(material) as { currentProgram?: PreparedProgram }).currentProgram;
            if (program) compiled.add(program);
          }
        } finally { renderer.setRenderTarget(target, face, mip); }
      }
      record.compileMs = performance.now() - began;
      const gl = renderer.getContext();
      const extension = renderer.extensions.get("KHR_parallel_shader_compile") as KHR_parallel_shader_compile | null;
      if (!extension) { record.status = "unsupported"; return; }
      // Snapshot program handles, not material.currentProgram: animation may
      // select another variant while this task waits. Polling completion is the
      // nonblocking KHR operation; never query LINK_STATUS or info logs early.
      const programs = [...compiled].map(program => program.program);
      record.programs = programs.length;
      while (!cancelled()) {
        if (performance.now() - began > 30000) throw new Error("Archive program preparation timed out.");
        if (programs.every(program => gl.getProgramParameter(program, extension.COMPLETION_STATUS_KHR))) {
          if (programs.some(program => !gl.getProgramParameter(program, gl.LINK_STATUS)))
            throw new Error("Archive program preparation failed to link a material.");
          // Three's first-use reflection performs synchronous info-log and
          // uniform queries even after linking. Finish that once here, outside
          // the visible draw, yielding between programs to bound each task.
          for (const program of compiled) {
            if (cancelled()) { record.status = "cancelled"; return; }
            const start = performance.now();
            program.getUniforms(); program.getAttributes();
            record.reflectionMs += performance.now() - start;
            await new Promise<void>(resolve => setTimeout(resolve, 0));
          }
          record.status = cancelled() ? "cancelled" : "ready"; return;
        }
        await new Promise<void>(resolve => setTimeout(resolve, 10));
      }
      record.status = "cancelled";
    } catch (error) {
      record.status = "failed"; throw error;
    } finally { record.durationMs = performance.now() - began; }
  }

  invalidate() {
    this.generation++;
    this.records.clear();
    for (const prepared of this.retained) for (const material of prepared.materials) material.dispose();
    this.retained.length = 0;
  }
  dispose() { this.disposed = true; this.invalidate(); }
}
