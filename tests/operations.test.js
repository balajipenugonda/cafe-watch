import test from 'node:test';
import assert from 'node:assert/strict';
import {displayStatus,staffAction,health} from '../public/operations.js';
import {invalidate} from '../public/state.js';

test('staff cleaning persists independently of AI and completion allows a recheck',()=>{
 const t={id:'1',status:'dirty',lastSeen:100,objects:[{key:'dishes'}]};
 const original=staffAction(t,'start',200);
 assert.equal(displayStatus(t),'cleaning');assert.equal(t.manualUntil,Infinity);
 assert.deepEqual(t.objects,[]);assert.equal(original.status,'dirty');
 t.status='free';assert.equal(displayStatus(t),'cleaning');
 staffAction(t,'complete',300);assert.equal(displayStatus(t),'free');assert.equal(t.manualUntil,15300);
});
test('undo snapshot restores all staff workflow fields, including a previous unset workflow',()=>{
 const t={id:'1',status:'dirty'};const previous=staffAction(t,'start',100);
 Object.assign(t,previous);assert.equal(displayStatus(t),'dirty');assert.equal(t.manualUntil,0);
});
test('disconnect revokes staff ready overrides and cleaning claims',()=>{
 const t={id:'1',status:'dirty'};staffAction(t,'start',100);
 const offline=invalidate(t);assert.equal(displayStatus(offline),'unknown');assert.equal(offline.manualUntil,0);
});
test('health distinguishes demo, offline, failed, paused, waiting, stale and live',()=>{
 const args={mode:'network',connected:true,running:true,lastCheck:1000,now:2000};
 assert.equal(health({...args,mode:'demo'}).state,'demo');
 assert.equal(health({...args,connected:false}).state,'offline');
 assert.equal(health({...args,failed:true}).title,'AI unavailable');
 assert.equal(health({...args,running:false}).state,'paused');
 assert.equal(health({...args,lastCheck:null}).state,'checking');
 assert.equal(health({...args,now:32000}).state,'stale');
 assert.equal(health(args).state,'live');
});

test('changing AI confidence preserves staff cleaning and temporary ready overrides',async()=>{
 const {recheckForConfidence}=await import('../public/operations.js');
 const cleaning={id:'1',status:'dirty'};staffAction(cleaning,'start',100);
 assert.equal(displayStatus(recheckForConfidence(cleaning,200)),'cleaning');
 const ready={id:'2',status:'dirty'};staffAction(ready,'complete',100);
 assert.equal(recheckForConfidence(ready,200).status,'free');
 assert.equal(recheckForConfidence(ready,16000).status,'unknown');
 const aiReady={id:'3',status:'free',confidence:.7,lastSeen:100};
 assert.equal(recheckForConfidence(aiReady,200).status,'unknown');
});
