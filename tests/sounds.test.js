import test from 'node:test';
import assert from 'node:assert/strict';
import {AlertPlayer,SOUND_PRESETS,soundPreferences,validateAudioFile,MAX_AUDIO_BYTES} from '../public/sounds.js';

test('invalid stored sound preferences fall back to a safe audible default',()=>{
 for(const alertTone of ['unknown','__proto__',['chime'],null])assert.equal(soundPreferences({alertTone}).tone,'chime');
 for(const alertVolume of [-1,2,NaN,Infinity,true,'0.5'])assert.equal(soundPreferences({alertVolume}).volume,.35);
 assert.deepEqual(soundPreferences({alertTone:'custom',alertVolume:0}),{tone:'custom',volume:0});
});
test('empty, oversized and non-audio uploads are rejected before decoding',()=>{
 for(const file of [null,{size:0},{size:MAX_AUDIO_BYTES+1,type:'audio/wav',name:'sound.wav'},{size:100,type:'text/plain',name:'notes.txt'}])assert.throws(()=>validateAudioFile(file));
 assert.doesNotThrow(()=>validateAudioFile({size:2048,type:'',name:'Alert.WAV'}));
});
test('failed or long custom audio never replaces a saved sound',async()=>{
 const player=new AlertPlayer();player.custom={duration:1};player.customName='Existing.wav';
 player.context=()=>({decodeAudioData:async()=>({duration:11})});
 await assert.rejects(player.decode({arrayBuffer:async()=>new ArrayBuffer(1)}),/10 seconds/);
 assert.equal(player.customName,'Existing.wav');assert.equal(player.custom.duration,1);
 player.context=()=>({decodeAudioData:async()=>{throw new Error('codec')}});
 await assert.rejects(player.decode({arrayBuffer:async()=>new ArrayBuffer(1)}),/cannot be decoded/);
});
test('stop cancels active audio and invalidates pending playback',()=>{
 const playing=[];const player=new AlertPlayer(value=>playing.push(value));let stopped=0;
 player.nodes=[{stop:()=>stopped++,disconnect:()=>{}}];const before=player.version;player.stop();
 assert.equal(stopped,1);assert.deepEqual(player.nodes,[]);assert.equal(player.version,before+1);assert.equal(playing.at(-1),false);
});
test('built-in alerts finish quickly and use valid audio note envelopes',()=>{
 for(const {notes} of Object.values(SOUND_PRESETS)){
  assert.ok(notes.length);
  for(const [frequency,start,length] of notes){assert.ok(frequency>0);assert.ok(start>=0);assert.ok(length>.012);assert.ok(start+length<2);}
 }
});
