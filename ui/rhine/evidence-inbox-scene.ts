import * as THREE from 'three';
import { ARCHIVE_LABEL_LAYER } from './original/label-renderer';
import type { EvidenceInboxView } from './evidence-inbox';

/** A compact sorting table beside the board. Reuses the existing scene and label pass. */
export function createEvidenceInboxScene(print:(texture:THREE.Texture)=>THREE.MeshBasicMaterial){
  const group=new THREE.Group();group.name='Rhine_Priority_Evidence_Box';
  const cube=new THREE.BoxGeometry(1,1,1),labelGeometry=new THREE.PlaneGeometry(2.58,.68),materials:THREE.Material[]=[];
  const material=(color:string,metalness=0)=>{const m=new THREE.MeshStandardMaterial({color,roughness:.72,metalness,fog:false});materials.push(m);return m;};
  const shell=material('#e5dfd3'),rim=material('#b4ad9b',.25),feet=material('#929683',.25),paper=material('#f5efdf'),tab=material('#a7ad8d'),lining=material('#a6a391');
  const box=(parent:THREE.Group,size:number[],position:number[],m:THREE.Material)=>{const mesh=new THREE.Mesh(cube,m);mesh.scale.set(size[0],size[1],size[2]);mesh.position.set(position[0],position[1],position[2]);parent.add(mesh);return mesh;};
  // Slender enamel work table; the foot height matches the archive furniture.
  box(group,[4.3,.16,2.8],[0,4.92,0],shell);box(group,[4.12,.055,2.62],[0,5.025,0],rim);
  for(const x of [-1.8,1.8])for(const z of [-1,1]){box(group,[.10,4.8,.1],[x,2.47,z],rim);box(group,[.28,.1,.34],[x,.1,z],feet);}
  box(group,[3.7,.065,.065],[0,2.5,-1],rim);
  // Open, lined sorting box with an olive metal index rail, not an archive cassette.
  box(group,[3.48,.10,2.02],[0,5.14,0],shell);box(group,[3.25,.03,1.84],[0,5.20,0],lining);
  box(group,[3.48,.87,.085],[0,5.57,1.01],shell);box(group,[3.48,1.35,.085],[0,5.8,-1.01],shell);
  for(const x of [-1.70,1.70]){box(group,[.085,1.10,2.0],[x,5.68,0],shell);box(group,[.10,.05,2.02],[x,6.25,0],rim);}
  box(group,[3.45,.045,.12],[0,6.02,1.01],rim);box(group,[.85,.09,.025],[0,5.34,1.06],rim);
  const folders:THREE.Group[]=[];
  for(let i=0;i<6;i++){
    const folder=new THREE.Group();folder.name=`Priority_Folder_${i+1}`;folder.visible=false;folder.position.set((i%2)*.05,5.22,-.78+i*.28);group.add(folder);
    box(folder,[3.0,1.48,.065],[0,.74,0],i%3===1?shell:paper);
    box(folder,[.7,.2,.065],[-.98+(i%3)*.95,1.55,0],i%3===0?tab:paper);
    box(folder,[2.7,.012,.015],[0,1.19,.043],rim);folders.push(folder);
  }
  const canvas=document.createElement('canvas');canvas.width=896;canvas.height=236;const ctx=canvas.getContext('2d')!;
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;const ink=print(texture);materials.push(ink);
  const label=new THREE.Mesh(labelGeometry,ink);label.layers.set(ARCHIVE_LABEL_LAYER);label.position.set(0,5.62,1.058);group.add(label);
  const initial=materials.map(m=>({m,opacity:m.opacity,transparent:m.transparent,depthWrite:m.depthWrite}));let reveal=1,count=0,boardId='',title='',opened=false;
  function draw(){ctx.fillStyle='#e5dfd3';ctx.fillRect(0,0,896,236);ctx.fillStyle='#5b634c';ctx.font='500 38px MiSans, sans-serif';ctx.fillText('重点证据 / 待整理',36,73);ctx.textAlign='right';ctx.font='500 72px MiSans, sans-serif';ctx.fillText(String(count).padStart(2,'0'),855,97);ctx.textAlign='left';ctx.fillStyle='#858774';ctx.font='23px MiSans, sans-serif';ctx.fillText('RHINE LAB  /  EVIDENCE INBOX',38,133);ctx.font='22px MiSans, sans-serif';const text=title.length>30?title.slice(0,29)+'…':title||'选择调查后收集重点材料';ctx.fillText(text,38,195);texture.needsUpdate=true;}
  draw();
  return{group,
    pick(ray:THREE.Raycaster){return group.visible&&ray.intersectObject(group,true).length>0;},
    set(value:EvidenceInboxView,open:boolean){opened=open;if(boardId!==value.boardId||count!==value.count||title!==value.title){boardId=value.boardId;count=value.count;title=value.title;folders.forEach((folder,i)=>folder.visible=i<Math.min(6,count));draw();}},
    update(amount:number){folders.forEach((folder,i)=>{folder.position.y=5.22+amount*(i===Math.min(count,6)-1?.16:.04);});},
    setReveal(value:number){if(value===reveal)return;reveal=value;group.visible=value>0;for(const state of initial){state.m.opacity=state.opacity*value;state.m.depthWrite=value<1?false:state.depthWrite;const transparent=value<1||state.transparent;if(transparent!==state.m.transparent){state.m.transparent=transparent;state.m.needsUpdate=true;}}},
    anchor(camera:THREE.Camera,width:number,height:number){group.updateWorldMatrix(true,false);const p=new THREE.Vector3(0,7.95,1.1).applyMatrix4(group.matrixWorld).project(camera);const x=(p.x+1)*width/2,y=(1-p.y)*height/2;return{x,y,visible:group.visible&&p.z>-1&&p.z<1&&x>100&&x<width-100&&y>height*.2&&y<height*.85};},
    stats(){return{boardId,count,visible:group.visible,open:opened,folderCount:folders.filter(f=>f.visible).length,meshes:group.children.length,reveal};},
    dispose(){group.removeFromParent();cube.dispose();labelGeometry.dispose();texture.dispose();materials.forEach(m=>m.dispose());}
  };
}
