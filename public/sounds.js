export const SOUND_PRESETS = {
  chime:{label:'Soft chime',notes:[[660,0,.2],[880,.16,.28]]},
  bell:{label:'Service bell',notes:[[1046,0,.65],[1568,0,.4]]},
  double:{label:'Double beep',notes:[[740,0,.14],[740,.24,.14]]},
  gentle:{label:'Gentle reminder',notes:[[440,0,.3],[554,.25,.4]]},
};
export const MAX_AUDIO_BYTES=5*1024*1024;
export const MAX_AUDIO_SECONDS=10;
export function soundPreferences(saved={}) {
  return {tone:typeof saved.alertTone==='string'&&(Object.hasOwn(SOUND_PRESETS,saved.alertTone)||saved.alertTone==='custom')?saved.alertTone:'chime',
    volume:typeof saved.alertVolume==='number'&&Number.isFinite(saved.alertVolume)&&saved.alertVolume>=0&&saved.alertVolume<=1?saved.alertVolume:.35};
}
export function validateAudioFile(file) {
  if(!file||!Number.isFinite(file.size)||file.size<=0)throw new Error('Choose a non-empty audio file.');
  if(file.size>MAX_AUDIO_BYTES)throw new Error('Audio must be 5 MB or smaller.');
  if(!String(file.type).startsWith('audio/')&&!/\.(mp3|wav|ogg|m4a|aac|webm|flac)$/i.test(file.name||''))throw new Error('Choose an MP3, WAV, OGG, or another supported audio file.');
}
function audioDB() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('cafewatch-alert-audio',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('sounds');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(new Error('Browser audio storage is unavailable.'));
    request.onblocked=()=>reject(new Error('Audio storage is busy. Close other Café Watch tabs and retry.'));
  });
}
async function audioRecord(action,value) {
  const db=await audioDB();
  try{return await new Promise((resolve,reject)=>{
    const transaction=db.transaction('sounds',action==='get'?'readonly':'readwrite');
    const store=transaction.objectStore('sounds');
    const request=action==='get'?store.get('custom'):action==='delete'?store.delete('custom'):store.put(value,'custom');
    transaction.oncomplete=()=>resolve(request.result);
    transaction.onerror=transaction.onabort=()=>reject(new Error('Could not save audio in this browser.'));
  });}finally{db.close();}
}
export class AlertPlayer {
  constructor(onPlayback=()=>{}){this.onPlayback=onPlayback;this.nodes=[];this.custom=null;this.customName='';this.version=0;}
  context(){
    if(!this.audio||this.audio.state==='closed'){const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)throw new Error('This browser does not support alert audio.');this.audio=new Audio();this.master=this.audio.createGain();this.master.connect(this.audio.destination);}
    return this.audio;
  }
  async unlock(){await this.context().resume();}
  setVolume(volume){if(this.master)this.master.gain.value=Math.max(0,Math.min(1,volume));}
  stop(){this.version++;clearTimeout(this.endTimer);for(const node of this.nodes){try{node.stop();}catch{}try{node.disconnect();}catch{}}this.nodes=[];this.onPlayback(false);}
  async decode(blob){let buffer;try{buffer=await this.context().decodeAudioData(await blob.arrayBuffer());}catch{throw new Error('This file cannot be decoded. Try an MP3 or WAV file.');}if(!Number.isFinite(buffer.duration)||buffer.duration<=0||buffer.duration>MAX_AUDIO_SECONDS)throw new Error('Choose an alert sound no longer than 10 seconds.');return buffer;}
  async loadCustom(){const record=await audioRecord('get');if(!record)return false;validateAudioFile(record.blob);this.custom=await this.decode(record.blob);this.customName=record.name;return true;}
  async upload(file){validateAudioFile(file);const buffer=await this.decode(file);await audioRecord('put',{blob:file,name:file.name});this.stop();this.custom=buffer;this.customName=file.name;}
  async removeCustom(){await audioRecord('delete');this.stop();this.custom=null;this.customName='';}
  async play(tone,volume){
    this.stop();const version=this.version;const context=this.context();await context.resume();
    if(version!==this.version)return;
    if(context.state!=='running')throw new Error('Audio is blocked. Click Preview sound to enable it.');
    if(volume<=0)throw new Error('Volume is muted. Increase it to hear alerts.');
    this.setVolume(volume);let duration;
    if(tone==='custom'){
      if(!this.custom)throw new Error('Upload a custom sound first.');
      const source=context.createBufferSource();source.buffer=this.custom;source.connect(this.master);this.nodes.push(source);source.start();duration=this.custom.duration;
    }else{
      const preset=SOUND_PRESETS[tone];if(!preset)throw new Error('Choose an available alert sound.');
      for(const [frequency,offset,length] of preset.notes){
        const oscillator=context.createOscillator(),envelope=context.createGain();oscillator.type='sine';oscillator.frequency.value=frequency;
        oscillator.connect(envelope);envelope.connect(this.master);const start=context.currentTime+offset;
        envelope.gain.setValueAtTime(0,start);envelope.gain.linearRampToValueAtTime(.18,start+.012);envelope.gain.exponentialRampToValueAtTime(.001,start+length);
        oscillator.start(start);oscillator.stop(start+length+.02);oscillator.onended=()=>envelope.disconnect();this.nodes.push(oscillator);
      }
      duration=Math.max(...preset.notes.map(([,offset,length])=>offset+length));
    }
    this.onPlayback(true);this.endTimer=setTimeout(()=>{if(version===this.version)this.stop();},duration*1000+70);
  }
  destroy(){this.stop();if(this.audio)void this.audio.close();}
}
