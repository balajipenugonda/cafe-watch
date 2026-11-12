import test from 'node:test';
import assert from 'node:assert/strict';
import {observe, invalidate} from '../public/state.js';

test('dirty alerts require two successive confident observations',()=>{
 const table=invalidate({id:'1'});
 assert.equal(observe(table,'dirty',.91,100),false);
 assert.equal(table.status,'unknown');
 assert.equal(observe(table,'dirty',.92,200),true);
 assert.equal(table.status,'dirty');assert.equal(table.since,200);
 assert.equal(observe(table,'dirty',.95,300),false);
 assert.equal(table.since,200);
});
test('low confidence interrupts a candidate without erasing a confirmed state',()=>{
 const table=invalidate({id:'1'});table.status='occupied';
 observe(table,'dirty',.9,100);observe(table,'dirty',.4,200);
 assert.equal(observe(table,'dirty',.9,300),false);
 assert.equal(table.status,'occupied');
 assert.equal(observe(table,'dirty',.9,400),true);
});
test('different labels and invalid scores never form a streak',()=>{
 const table=invalidate({id:'1'});
 observe(table,'dirty',.9);observe(table,'occupied',.9);
 assert.equal(observe(table,'dirty',.9),false);
 for(const confidence of [NaN,Infinity,1.5,-1])assert.equal(observe(table,'dirty',confidence),false);
 assert.equal(observe(table,'banana',.9),false);assert.equal(table.status,'unknown');
});
test('a source change clears all prior observations',()=>{
 const t=invalidate({id:'1',status:'dirty',confidence:.9,lastSeen:123,candidate:'dirty',streak:8,objects:[{key:'dishes'}],objectScores:{dishes:.99},inference:{model:'old'}});
 assert.equal(t.status,'unknown');assert.equal(t.confidence,null);assert.equal(t.lastSeen,null);assert.equal(t.streak,0);
 assert.deepEqual(t.objects,[]);assert.deepEqual(t.objectScores,{});assert.equal(t.inference,null);
});
test('two uncertain observations revoke a previously ready table',()=>{
 const t=invalidate({id:'1'});t.status='free';
 assert.equal(observe(t,'unknown',0,100),false);
 assert.equal(observe(t,'unknown',0,200),true);
 assert.equal(t.status,'unknown');assert.equal(t.confidence,null);
});
test('a confirmed observation interrupts uncertainty before revoking a state',()=>{
 const t=invalidate({id:'1'});t.status='free';
 observe(t,'unknown',0,100);observe(t,'free',.9,200);observe(t,'unknown',0,300);
 assert.equal(t.status,'free');
});
test('persistent low confidence cannot leave a table falsely ready',()=>{
 const t=invalidate({id:'1'});t.status='free';
 observe(t,'dirty',.4,100);observe(t,'dirty',.4,200);
 assert.equal(t.status,'unknown');
});
