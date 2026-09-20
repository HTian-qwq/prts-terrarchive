import * as THREE from 'three';
import { ARCHIVE_LABEL_LAYER } from './original/label-renderer';
export const READING_ENTER_MS = 420;
export const READING_RETURN_MS = 360;
// Linear x control points make this curve match smoothstep in the scene.
export const READING_FADE_EASING = 'cubic-bezier(0.333333,0,0.666667,1)';
export function readingFrameTime() { return Number(document.timeline.currentTime ?? performance.now()); }
export interface ReadingObject { title: string; code: string; kind: 'report' | 'clue'; enterStartedAt?: number; returnStartedAt?: number }

/** A report folio in the existing renderer, distinct from the source cassettes. */
export function createReadingObject(printMaterial: (texture: THREE.Texture) => THREE.MeshBasicMaterial) {
  const group = new THREE.Group(); group.name = 'Rhine_Research_Folio'; group.visible = false;
  const folio = new THREE.Group(); group.add(folio); folio.rotation.set(.035, -.20, -.045);
  const geometry = new THREE.BoxGeometry(1, 1, 1), face = new THREE.PlaneGeometry(3.45, 4.98);
  const materials: THREE.Material[] = [];
  const material = (color: string, roughness = .8, metalness = 0) => {
    const value = new THREE.MeshStandardMaterial({color, roughness, metalness, fog: false}); materials.push(value); return value;
  };
  const ivory = material('#e8e1d4'), paper = material('#faf8ee'), spine = material('#9b9f89'), metal = material('#b8aa8d', .38, .65);
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material) => {
    const mesh = new THREE.Mesh(geometry, mat); mesh.scale.set(w, h, d); mesh.position.set(x, y, z); folio.add(mesh); return mesh;
  };
  box(3.95,5.55,.16,0,0,-.14,ivory);
  for(let i=0;i<7;i++) box(3.72,5.25,.025,.035+i*.006,-.015+i*.008,-.045+i*.032,paper);
  box(.22,5.52,.39,-1.84,0,.01,spine);
  box(3.86,5.45,.06,.055,.035,.22,ivory);
  box(.07,5.40,.022,-1.48,.035,.257,metal);
  for(let i=0;i<3;i++) box(.20,.44,.065,2.01,1.65-i*.65,.11,i===0?spine:ivory);
  box(1.00,.21,.12,.02,2.67,.30,metal);
  box(.70,.055,.16,.02,2.80,.27,metal);
  const canvas=document.createElement('canvas'); canvas.width=896; canvas.height=1296;
  const context=canvas.getContext('2d')!;
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  const ink=printMaterial(texture);materials.push(ink);
  const cover=new THREE.Mesh(face,ink);cover.layers.set(ARCHIVE_LABEL_LAYER);cover.position.set(.11,.015,.259);folio.add(cover);
  const materialState=materials.map(material=>({material,opacity:material.opacity,transparent:material.transparent,depthWrite:material.depthWrite}));
  let signature='', enterStartedAt=0, returnStartedAt:number|undefined, closingFrom=1, appliedOpacity=-1, reduced=false;
  const ease=(value:number)=>value*value*(3-2*value);
  const enterProgress=(now=readingFrameTime())=>reduced?1:THREE.MathUtils.clamp((now-enterStartedAt)/READING_ENTER_MS,0,1);
  const progress=(now=readingFrameTime())=>returnStartedAt===undefined?0:reduced?1:THREE.MathUtils.clamp((now-returnStartedAt)/READING_RETURN_MS,0,1);
  const opacity=(now=readingFrameTime())=>returnStartedAt===undefined?ease(enterProgress(now)):closingFrom*(1-ease(progress(now)));
  function applyOpacity(value:number){
    if(value===appliedOpacity)return;appliedOpacity=value;
    for(const state of materialState){
      const {material}=state, fading=value<1;
      material.opacity=state.opacity*value;material.depthWrite=fading?false:state.depthWrite;
      const transparent=fading||state.transparent;
      if(material.transparent!==transparent){material.transparent=transparent;material.needsUpdate=true;}
    }
  }
  const boardReveal=()=>group.visible?1-opacity():1;
  const local=new THREE.Vector3();
  function screenBounds(camera?:THREE.PerspectiveCamera){
    if(!camera)return undefined;
    cover.updateWorldMatrix(true,false);
    const corners=[[-1.725,-2.49],[1.725,-2.49],[1.725,2.49],[-1.725,2.49]].map(([x,y])=>new THREE.Vector3(x,y,0).applyMatrix4(cover.matrixWorld).project(camera));
    return [Math.min(...corners.map(p=>p.x)),Math.min(...corners.map(p=>p.y)),Math.max(...corners.map(p=>p.x)),Math.max(...corners.map(p=>p.y))];
  }
  return {group,
    set(value:ReadingObject|null,skipMotion=false){
      reduced=skipMotion;
      if(!value){group.visible=false;returnStartedAt=undefined;applyOpacity(1);return;}
      if(!group.visible||value.enterStartedAt!==undefined&&value.enterStartedAt!==enterStartedAt){
        enterStartedAt=value.enterStartedAt??readingFrameTime();returnStartedAt=undefined;
      }
      if(value.returnStartedAt!==undefined&&value.returnStartedAt!==returnStartedAt)closingFrom=opacity(value.returnStartedAt);
      returnStartedAt=value.returnStartedAt;group.visible=true;applyOpacity(opacity());
      const next=JSON.stringify([value.title,value.code,value.kind]);if(next===signature)return;signature=next;
      context.fillStyle='#e8e1d4';context.fillRect(0,0,896,1296);
      context.fillStyle='#343a30';context.font='600 52px MiSans, sans-serif';context.fillText('RHINE LAB',56,112);
      context.fillStyle='#7f826e';context.font='20px MiSans, sans-serif';context.fillText('RESEARCH / INFORMATION ANALYSIS',59,154);
      context.strokeStyle='#b2ad99';context.lineWidth=2;context.beginPath();context.moveTo(58,207);context.lineTo(826,207);context.stroke();
      context.font='22px MiSans, sans-serif';context.fillText(value.kind==='report'?'INVESTIGATION REPORT':'EVIDENCE / RESEARCH NOTE',58,295);
      context.fillStyle='#343a30';context.font='500 44px MiSans, sans-serif';
      let line='',row=0;for(const char of value.title){if(context.measureText(line+char).width>732){context.fillText(line,58,386+row*70);line='';row++;if(row===4)break;}line+=char;}
      if(row<4)context.fillText(line,58,386+row*70);
      context.fillStyle='#8a8e79';context.fillRect(58,840,62,5);context.font='27px MiSans, sans-serif';context.fillText(value.kind==='report'?'调查报告':'线索记录',58,900);
      context.font='18px MiSans, sans-serif';context.fillText('TERRARCHIVE / RESEARCH DIVISION',58,942);
      context.strokeStyle='#b2ad99';context.beginPath();context.moveTo(58,1110);context.lineTo(826,1110);context.stroke();
      context.fillStyle='#4f5943';context.font='32px MiSans, sans-serif';context.fillText(value.code,58,1180);
      context.font='16px MiSans, sans-serif';context.fillText('ARCHIVE COPY',665,1180);texture.needsUpdate=true;
    },
    update(camera:THREE.PerspectiveCamera,width:number,height:number,skipMotion=false){
      if(!group.visible)return;
      reduced=skipMotion;applyOpacity(opacity());
      const distance=14,span=2*Math.tan(THREE.MathUtils.degToRad(camera.fov/2))*distance,wide=span*camera.aspect;
      const portrait=width/height<.82;
      const scale=portrait?Math.min(span*.25/5.55,wide*.5/4.2):Math.min(span*.61/5.55,wide*.37/4.2);
      local.set(portrait?0:-wide*.245,portrait?span*.245:-span*.03,-distance).applyMatrix4(camera.matrixWorld);
      group.position.copy(local);group.quaternion.copy(camera.quaternion);group.scale.setScalar(scale);
    },
    boardReveal(skipMotion=false){reduced=skipMotion;return boardReveal();},
    stats(camera?:THREE.PerspectiveCamera){return {screenBounds:screenBounds(camera),visible:group.visible,kind:'research-folio',meshes:folio.children.length,enterProgress:enterProgress(),returnProgress:progress(),opacity:group.visible?appliedOpacity:0,boardReveal:boardReveal(),scale:group.scale.x,position:group.position.toArray(),rotation:folio.rotation.toArray(),materialsRestored:materialState.every(s=>s.material.transparent===s.transparent&&s.material.depthWrite===s.depthWrite&&s.material.opacity===s.opacity)};},
    dispose(){group.removeFromParent();geometry.dispose();face.dispose();texture.dispose();materials.forEach(m=>m.dispose());}
  };
}
