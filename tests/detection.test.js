import test from 'node:test';
import assert from 'node:assert/strict';
import {overlap,stableLayout} from '../public/detection.js';

const a={x:.1,y:.1,w:.2,h:.2},b={x:.6,y:.6,w:.2,h:.2};
test('two empty views do not confirm a table layout',()=>{
 assert.equal(stableLayout([],[]),false);
 assert.equal(stableLayout([a],[]),false);
});
test('slightly shifted boxes can confirm even when detection order changes',()=>{
 assert.equal(stableLayout([a,b],[b,{...a,x:.11}]),true);
 assert.equal(overlap(a,a),1);
});
test('a changing camera angle or changing count requires another observation',()=>{
 assert.equal(stableLayout([a],[b]),false);
 assert.equal(stableLayout([a],[a,b]),false);
});
test('one candidate cannot confirm two overlapping detections',()=>{
 assert.equal(stableLayout([a,{...a,x:.11}],[a,b]),false);
});
