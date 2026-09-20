import {test} from 'node:test';
import assert from 'node:assert/strict';
import {investigationPositions} from '../ui/rhine/investigation-layout.ts';
import {evidenceCardLayout} from '../ui/rhine/evidence-board-model.ts';

test('nine to twelve clues keep their positions and leave the report clearing empty',()=>{
 const kinds=['excerpt','finding','time','relation','question','contrast','excerpt','finding','relation','question','time','finding'];
 const clues=kinds.map((kind,i)=>({id:`C${String(i+1).padStart(3,'0')}`,kind}));
 const before=investigationPositions(clues.slice(0,9)),after=investigationPositions(clues);
 for(const [id,point]of before)assert.deepEqual(after.get(id),point);
 const rectangles=clues.map((clue,i)=>{const c={id:clue.id,title:'检查',body:'',kind:'note',stage:0,clueKind:clue.kind,position:after.get(clue.id),rotation:[-1.6,.9,-.7][i%3]};const l=evidenceCardLayout(c,i),a=l.rotation*Math.PI/180;return {...l,hx:(Math.abs(Math.cos(a))*l.width+Math.abs(Math.sin(a))*l.height)/2,hy:(Math.abs(Math.sin(a))*l.width+Math.abs(Math.cos(a))*l.height)/2};});
 rectangles.push({x:0,y:0,hx:3.85/2,hy:2.75/2});
 for(let i=0;i<rectangles.length;i++)for(let j=i+1;j<rectangles.length;j++)assert(Math.abs(rectangles[i].x-rectangles[j].x)>=rectangles[i].hx+rectangles[j].hx||Math.abs(rectangles[i].y-rectangles[j].y)>=rectangles[i].hy+rectangles[j].hy,`papers ${i} and ${j} overlap`);
 // Withdrawn records keep their occupied slot; the controller only filters their visibility.
 const retired=investigationPositions(clues.map(c=>({...c,status:c.id==='C001'?'retracted':'active'})));
 assert.deepEqual(retired,after);
 const nextPage=investigationPositions([...clues,{id:'C013',kind:'excerpt'}]);assert.deepEqual(nextPage.get('C013'),after.get('C001'));
});
