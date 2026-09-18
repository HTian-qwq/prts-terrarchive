// TEMPORARY RHINE PROFILER: hooks exist only while a capture is running.
import type { WebGLRenderer } from 'three';
import type { FrameToken } from './temporary-performance';
export type DiagnosticPass = { name: string; pass: { render: (...args: any[]) => any } };

/** Source payload accounting only. Never inspect or retain pixels, text or handles. */
export function uploadSize(method: string, args: any[]) {
  let source: any, allocationBytes = 0;
  if (method === 'bufferData') {
    if (typeof args[1] === 'number') allocationBytes = args[1]; else source = args[1];
  } else if (method === 'bufferSubData') source = args[2];
  else if (method === 'texImage2D') source = args.length >= 9 ? args[8] : args[5];
  else if (method === 'texSubImage2D') source = args.length >= 9 ? args[8] : args[6];
  else if (method === 'texImage3D') source = args[9];
  else if (method === 'texSubImage3D') source = args[10];
  else if (method.startsWith('compressedTex')) source = args.slice().reverse().find(a => ArrayBuffer.isView(a));
  let sourceBytes = source instanceof ArrayBuffer || ArrayBuffer.isView(source) ? source.byteLength : 0;
  if (sourceBytes && method.startsWith('buffer') && ArrayBuffer.isView(source)) {
    const unit = (source as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT || 1;
    const offset = Number(args[3]) || 0, length = Number(args[4]) || 0;
    sourceBytes = Math.min(Math.max(0, sourceBytes - offset * unit), length > 0 ? length * unit : Infinity);
  }
  const sourcePixels = source && !sourceBytes && typeof source !== 'number'
    && Number.isFinite(source.width) && Number.isFinite(source.height) ? source.width * source.height : 0;
  return { sourceBytes, sourcePixels, allocationBytes };
}
const surfaceName = /^(?:Case_Engraving|Printed_Label|Frosted_Polymer|Ivory_Edges|Optical_|Subsurface_|Amber_|Champagne_|Moulded_|Titanium_|Index_|Internal_|Array_Interior|Shelf_Interior|Rhine_Archive_Label)[A-Za-z0-9_]*$/;

export function installRenderDiagnostics(renderer: WebGLRenderer, frame: () => FrameToken | undefined,
  stage: (name: string) => void, passes: DiagnosticPass[], now: () => number,
  outside: (detail: Record<string, unknown>) => void) {
  const restore: (() => void)[] = [];
  const replace = (owner: any, key: string, make: (original: (...args: any[]) => any) => (...args: any[]) => any) => {
    const original = owner[key]; if (typeof original !== 'function') return;
    const own = Object.getOwnPropertyDescriptor(owner, key), wrapper = make(original);
    owner[key] = wrapper;
    restore.push(() => { if (owner[key] !== wrapper) return; if (own) Object.defineProperty(owner, key, own); else delete owner[key]; });
  };
  for (const { name, pass } of passes) replace(pass, 'render', original => function(this: unknown, ...args: any[]) {
    const token = frame(); if (!token?.detailed) return original.apply(this, args);
    stage(name);
    const start = now(), beforeCalls = renderer.info.render.calls, beforeTriangles = renderer.info.render.triangles;
    try { return original.apply(this, args); }
    finally {
      const end = now(), row = token.sample.passWork![name] ||= { cpuMs: 0, calls: 0, triangles: 0 };
      row.cpuMs += end - start; row.calls += renderer.info.render.calls - beforeCalls;
      row.triangles += renderer.info.render.triangles - beforeTriangles;
      token.sample.detailProbeMs! += now() - end;
    }
  });
  let lastToken: FrameToken | undefined;
  let rows = new Map<string, NonNullable<FrameToken['sample']['drawFamilies']>[number]>();
  replace(renderer, 'renderBufferDirect', original => function(this: unknown, camera: any, scene: any, geometry: any, material: any, object: any, group: any) {
    const token = frame(); if (!token?.detailed) return original.call(this, camera, scene, geometry, material, object, group);
    const beforeCalls = renderer.info.render.calls, beforeTriangles = renderer.info.render.triangles;
    try { return original.call(this, camera, scene, geometry, material, object, group); }
    finally {
      const start = now();
      if (lastToken !== token) { rows = new Map(); lastToken = token; }
      let ancestor = object, family = 'other';
      if (family === 'other') while (ancestor) {
        const tag = ancestor.userData?.performanceFamily;
        if (['hero', 'shelf', 'moving', 'rack', 'board', 'array'].includes(tag)) { family = tag; break; }
        ancestor = ancestor.parent;
      }
      if (family === 'other' && object?.isInstancedMesh) family = 'array';
      const candidate = object?.userData?.surface || object?.name || '';
      const part = typeof candidate === 'string' && candidate.length < 100 && surfaceName.test(candidate) ? candidate : 'other';
      const phase = material?.isMeshDepthMaterial || material?.isMeshDistanceMaterial ? 'shadow' : token.gpuStage || 'unknown';
      const materialKind = material?.isMeshPhysicalMaterial ? 'physical' : material?.isMeshStandardMaterial ? 'standard'
        : material?.isMeshBasicMaterial ? 'basic' : material?.isShaderMaterial ? 'shader' : 'other';
      const key = [family, part, phase, materialKind].join(':');
      let row = rows.get(key);
      if (!row && rows.size < 96) {
        row = { family, part, material: materialKind, phase, calls: 0, triangles: 0 };
        rows.set(key, row); token.sample.drawFamilies!.push(row);
      }
      if (row) { row.calls += renderer.info.render.calls - beforeCalls; row.triangles += renderer.info.render.triangles - beforeTriangles; }
      else token.sample.counters.detailDrawGroupsDropped = (Number(token.sample.counters.detailDrawGroupsDropped) || 0) + 1;
      token.sample.detailProbeMs! += now() - start;
    }
  });
  const gl = renderer.getContext();
  for (const method of ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D', 'compressedTexImage2D',
    'compressedTexSubImage2D', 'generateMipmap', 'bufferData', 'bufferSubData']) {
    replace(gl, method, original => function(this: unknown, ...args: any[]) {
      const token = frame();
      if (method.startsWith('buffer') && !token?.detailed) return original.apply(this, args);
      const start = now();
      try { return original.apply(this, args); }
      finally {
        const end = now(), sizes = uploadSize(method, args);
        if (token) {
          token.sample.glWork ||= {};
          const key = (token.gpuStage || 'whole-frame') + ':' + method;
          const row = token.sample.glWork[key] ||= { calls: 0, cpuMs: 0, sourceBytes: 0, sourcePixels: 0, allocationBytes: 0 };
          row.calls++; row.cpuMs += end - start;
          row.sourceBytes += sizes.sourceBytes; row.sourcePixels += sizes.sourcePixels; row.allocationBytes += sizes.allocationBytes;
          token.sample.detailProbeMs = (token.sample.detailProbeMs || 0) + now() - end;
        } else outside({ kind: 'gl-upload-outside-frame', method, cpuMs: end - start, ...sizes });
      }
    });
  }
  return () => { for (const fn of restore.reverse()) fn(); rows.clear(); lastToken = undefined; };
}
