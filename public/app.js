import {AlertPlayer, soundPreferences} from './sounds.js';
import {displayStatus, staleAfter, health, staffAction, recheckForConfidence} from './operations.js';
import {labels, observe, invalidate} from './state.js';
import {stableLayout, overlap} from './detection.js';

const $ = id => document.getElementById(id);
const colors = {free:'#62a68c',occupied:'#819fc2',dirty:'#d3a34e',unknown:'#a34236',cleaning:'#7452a3'};
const tints = {free:'#eaf4eb',occupied:'#edf1f7',dirty:'#fcf5e6',unknown:'#fff1ed',cleaning:'#f2ecfc'};
const defaults = [
  {id:'1',name:'Table 01',x:.08,y:.62,w:.31,h:.29,status:'dirty',fx:27,fy:70},
  {id:'2',name:'Table 02',x:.64,y:.60,w:.31,h:.35,status:'free',fx:71,fy:70},
  {id:'3',name:'Table 03',x:.18,y:.25,w:.23,h:.35,status:'occupied',fx:27,fy:41},
  {id:'4',name:'Table 04',x:.60,y:.31,w:.23,h:.26,status:'free',fx:72,fy:41},
  {id:'5',name:'Table 05',x:.42,y:.16,w:.15,h:.23,status:'occupied',fx:50,fy:35},
];
let saved = {};
try { saved = JSON.parse(localStorage.getItem('cafewatch-preferences') || '{}'); } catch {}
if(!saved||typeof saved!=='object'||Array.isArray(saved))saved={};
let tables = [];
let lastSuccessfulCheck=null, aiFailed=false, cameraFailed=false, areaFilter='', pendingUndo=null;
const statusIcons={free:'✓',occupied:'●',dirty:'!',unknown:'⚠',cleaning:'◷'};
const tableArea=t=>t.area||'Main dining room';
const scopedTables=()=>tables.filter(t=>!areaFilter||tableArea(t)===areaFilter);
let mode='offline', running=false, editing=false, busy=false, generation=0, selected=null, fileUrl=null, timer=null, stream=null;
let networkSession=null, networkTimer=null, networkObjectUrl=null, networkLastFrame=0, networkDetected=false, sourceRequest=0;
let detecting=false;
let interval=[2000,5000,10000].includes(saved.interval)?saved.interval:2000;
let threshold=[.65,.75,.85].includes(saved.threshold)?saved.threshold:.65;
const audioPreferences=soundPreferences(saved);
let alertTone=audioPreferences.tone,alertVolume=audioPreferences.volume,lastAlertAt=0,lastAudioErrorAt=0;
const alertPlayer=new AlertPlayer(playing=>{$('preview-sound').textContent=playing?'■ Stop sound':'▷ Preview sound';$('preview-sound').dataset.playing=String(playing);if(!playing&&$('sound-status').textContent.startsWith('Preview playing.'))$('sound-status').textContent='Preview finished.';});
let sound=!!saved.sound, events=[], demoTick=0, elapsedMs=null, sourceName='Café floor';
const video=$('video'), stage=$('stage');

function persist(){try{localStorage.setItem('cafewatch-preferences',JSON.stringify({interval,threshold,sound,alertTone,alertVolume}));$('preferences-status').textContent='Saved in this browser.';}catch{$('preferences-status').textContent='Could not save in this browser. Changes apply for this session only.';}}
function saveRegions(){if(mode==='demo')return;try{localStorage.setItem(`cafewatch-regions:${mode}:${sourceName}`,JSON.stringify(tables.map(({id,name,x,y,w,h,fx,fy,area})=>({id,name,x,y,w,h,fx,fy,area}))));}catch{}}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toast.timeout);toast.timeout=setTimeout(()=>$('toast').hidden=true,7000);}
function duration(ms){const secs=Math.max(0,Math.floor(ms/1000));return `${Math.floor(secs/60)}:${String(secs%60).padStart(2,'0')}`;}
function element(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function addEvent(message,source=mode==='demo'?'Demo':'Local AI'){
  events.unshift({time:new Date().toISOString(),message,source});events=events.slice(0,500);
  $('activity-count').textContent=events.length;renderActivity();
}
function renderActivity(){
  const list=$('activity-list');list.replaceChildren();
  if(!events.length){list.append(element('div','log-empty','No changes yet. Table activity will appear here.'));return;}
  for(const event of events){const row=element('div','log-row');const time=element('time','',new Date(event.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}));row.append(time,element('span','',event.message),element('span','log-source',event.source));list.append(row);}
}
function beep(){
  if(!sound||alertVolume===0||Date.now()-lastAlertAt<3000)return;
  lastAlertAt=Date.now();
  void alertPlayer.play(alertTone,alertVolume).catch(error=>{
    $('sound-status').textContent=error.message;
    if(Date.now()-lastAudioErrorAt>60000){lastAudioErrorAt=Date.now();toast(error.message);}
  });
}
function applyObservation(t,status,confidence,reason=null,signals=null,objects=[],objectScores={},inference=null){
  if(displayStatus(t)==='cleaning')return;
  t.reason=status!=='unknown'&&confidence<threshold?`Low confidence; review this table. ${reason||''}`:reason;t.signals=signals;
  t.objects=objects;t.objectScores=objectScores;t.inference=inference;
  if(observe(t,status,confidence,Date.now(),threshold)){
    addEvent(`${t.name} → ${labels[displayStatus(t)]}`);if(displayStatus(t)==='dirty')beep();
  }
}
function clearUndo(){pendingUndo=null;$('staff-undo').hidden=true;}
function actOnTable(t,action){
  const previous=staffAction(t,action);
  pendingUndo={table:t,previous,epoch:generation,expires:Date.now()+12000};
  $('staff-action-message').textContent=`${t.name}: ${action==='start'?'cleaning started':'marked ready by staff'}.`;
  $('staff-undo').hidden=false;
  addEvent(`${t.name} · ${action==='start'?'Cleaning started':'Marked ready'}`,'Staff');render();
}
function updateHealth(){
  const connected=mode==='network'?networkFresh():mode==='camera'?!!stream?.active&&!cameraFailed:mode==='video'?video.readyState>=2&&!cameraFailed:false;
  const info=health({mode,connected,running,detecting,failed:aiFailed,lastCheck:lastSuccessfulCheck,interval});
  $('monitor-health').dataset.state=info.state;$('health-title').textContent=info.title;$('health-detail').textContent=info.detail;
  $('last-check').textContent=lastSuccessfulCheck?`Last successful AI check: ${new Date(lastSuccessfulCheck).toLocaleTimeString()} · ${duration(Date.now()-lastSuccessfulCheck)} ago`:'Last successful AI check: Never';
  const list=scopedTables();$('review-count').textContent=`⚠ ${list.filter(t=>displayStatus(t)==='unknown').length} uncertain · ◷ ${list.filter(t=>displayStatus(t)==='cleaning').length} cleaning`;
  $('last-update').textContent=mode==='demo'?'SIMULATED':lastSuccessfulCheck?`${duration(Date.now()-lastSuccessfulCheck)} AGO`:'NOT CHECKED';
}
function updateAreas(){
  const areas=[...new Set(tables.map(tableArea))].sort();
  if(areaFilter&&!areas.includes(areaFilter))areaFilter='';
  const select=$('area-filter');if(JSON.stringify([...select.options].map(option=>option.value))===JSON.stringify(['',...areas])){select.value=areaFilter;return;}const all=element('option','','All areas');all.value='';select.replaceChildren(all,...areas.map(area=>{const option=element('option','',area);option.value=area;return option;}));select.value=areaFilter;
}
function openTable(id){
  selected=id;const t=tables.find(t=>t.id===id);if(!t)return;
  $('table-name').value=t.name;$('table-area').value=tableArea(t);$('table-detail').replaceChildren(element('div','detail-line',`Status: ${statusIcons[displayStatus(t)]} ${labels[displayStatus(t)]}`),element('div','detail-line',`Source: ${mode==='demo'?'Simulated demo':sourceName}`));
  if(t.reason)$('table-detail').append(element('div','detail-line',t.reason));
  if(t.signals)$('table-detail').append(element('div','detail-line',`Table visibility: ${Math.round(t.signals.table_visible*100)}% · Guest present: ${Math.round(t.signals.guest_present*100)}% · Surface: ${t.signals.surface}`));
  if(mode!=='demo'&&t.inference){
    $('table-detail').append(element('div','detail-line',`LiquidAI object evidence: ${(t.objects||[]).map(o=>`${o.label} (${Math.round(o.confidence*100)}%)`).join(', ')||'No confident object labels'}. Scores indicate model confidence.`));
    $('table-detail').append(element('div','detail-line',`${t.inference.model} · ${t.inference.api} · ${t.inference.output_tokens??'Unknown'} output tokens`));
  }
  const actions=$('table-staff-actions');actions.replaceChildren();
  if(['dirty','cleaning'].includes(displayStatus(t))){const action=element('button','primary',displayStatus(t)==='cleaning'?'✓ Mark ready':'◷ Start cleaning');action.onclick=()=>{actOnTable(t,displayStatus(t)==='cleaning'?'complete':'start');$('table-dialog').close();};actions.append(action);}
  $('remove-table').hidden=!editing;$('table-dialog').showModal();
}
function render(){
  updateAreas();const visible=scopedTables();const count=s=>visible.filter(t=>displayStatus(t)===s).length;
  $('free-count').textContent=count('free');$('occupied-count').textContent=count('occupied');$('dirty-count').textContent=count('dirty');$('queue-count').textContent=count('dirty')+count('cleaning');
  const occupied=visible.length?Math.round(count('occupied')/visible.length*100):0;
  $('occupancy-detail').textContent=`${occupied}% of selected area`;$('occupancy-bar').style.width=`${occupied}%`;
  $('tracked-count').textContent=`${tables.length} table${tables.length===1?'':'s'} mapped`;
  $('dirty-detail').textContent=count('dirty')?'Tables waiting for staff to start cleaning.':count('cleaning')?'Cleaning in progress.':!visible.length?'No confirmed table availability.':count('unknown')?'Review uncertain tables.':'No tables are waiting for cleaning.';
  const overlays=$('overlays'),floor=$('floor-tables'),queue=$('queue'),observations=$('observations');
  overlays.replaceChildren();floor.replaceChildren();queue.replaceChildren();observations.replaceChildren();
  for(const t of visible){
    const status=displayStatus(t);
    const region=element('button','region');region.dataset.id=t.id;region.setAttribute('aria-label',`${t.name}, ${labels[displayStatus(t)]}. Open table details`);
    Object.assign(region.style,{left:`${t.x*100}%`,top:`${t.y*100}%`,width:`${t.w*100}%`,height:`${t.h*100}%`});region.style.setProperty('--region',colors[status]);
    const label=element('span','region-label',t.name);label.append(element('span','region-status',`${statusIcons[status]} ${labels[status]}`));region.append(label,element('i','corner'));region.onclick=()=>openTable(t.id);overlays.append(region);
    const ft=element('button',`floor-table ${Number(t.id)%2?'round':''}`,`${statusIcons[status]} ${t.name.replace(/^Table /,'')}`);ft.setAttribute('aria-label',`${t.name}: ${labels[displayStatus(t)]}`);
    ft.style.setProperty('--region',colors[status]);ft.style.setProperty('--tint',tints[status]);ft.style.left=`${t.fx ?? (t.x+t.w/2)*100}%`;ft.style.top=`${t.fy ?? (t.y+t.h/2)*75+10}%`;ft.onclick=()=>openTable(t.id);floor.append(ft);
    const row=element('div','observation');const dot=element('i','dot');dot.style.background=colors[status];const info=element('div');info.append(element('strong','',t.name),element('p','',mode==='demo'?`${labels[displayStatus(t)]} · simulated`:t.reason||labels[displayStatus(t)]));
    if(mode!=='demo'&&t.inference){
      const chips=element('div','object-evidence');chips.setAttribute('aria-label','LiquidAI object evidence');
      for(const object of t.objects||[]){const chip=element('span','object-chip',`${object.label} ${Math.round(object.confidence*100)}%`);chip.title='LiquidAI model confidence, not measured accuracy';chips.append(chip);}
      if(!chips.childElementCount)chips.append(element('span','object-empty','No confident object labels'));
      info.append(chips);
    }
    row.append(dot,info,element('span','confidence',t.confidence===null||t.confidence===undefined?'—':`${Math.round(t.confidence*100)}%`));observations.append(row);
  }
  const dirty=visible.filter(t=>['dirty','cleaning'].includes(displayStatus(t))).sort((a,b)=>(displayStatus(a)==='cleaning')-(displayStatus(b)==='cleaning')||a.since-b.since);
  for(const t of dirty){
    const card=element('div','queue-card');const heading=element('div','queue-card-header');const wait=element('span','waiting',duration(Date.now()-t.since));wait.dataset.since=t.since;
    heading.append(element('strong','',`${displayStatus(t)==='cleaning'?'◷':'!'} ${t.name}`),wait);const clean=element('button','clean-button',displayStatus(t)==='cleaning'?'✓ Mark ready':'◷ Start cleaning');clean.onclick=()=>actOnTable(t,displayStatus(t)==='cleaning'?'complete':'start');card.dataset.status=displayStatus(t);
    card.append(heading,element('p','',displayStatus(t)==='cleaning'?'Staff are cleaning this table.':mode==='demo'?'Simulated: used dishes left on the table.':t.reason||'Unoccupied table flagged by AI.'),clean);queue.append(card);
  }
  if(!dirty.length)queue.append(element('div','queue-empty',mode==='offline'?'Camera offline. Connect a source to monitor tables.':!visible.length?'No tables mapped in this area.':visible.some(t=>t.status==='unknown')?'⚠ Review uncertain tables before seating guests.':'✓ No tables are waiting for cleaning.'));
  updateWait();updateHealth();
}
function updateWait(){
  for(const e of document.querySelectorAll('[data-since]'))e.textContent=duration(Date.now()-Number(e.dataset.since));
  const dirty=scopedTables().filter(t=>displayStatus(t)==='dirty');$('wait-stat').textContent=duration(dirty.length?dirty.reduce((n,t)=>n+Date.now()-t.since,0)/dirty.length:0);
}
function setModeUi(){
  if(mode!=='offline')$('stream-message').hidden=true;
  $('mode-badge').textContent=mode==='demo'?'● DEMO':'● LIVE SOURCE';
  $('mode-badge').classList.remove('error-badge');$('demo-image').hidden=mode!=='demo';video.hidden=mode!=='camera'&&mode!=='video';$('network-image').hidden=mode!=='network';$('network-controls').hidden=mode!=='network';
  $('detect-tables').hidden=mode==='demo'||mode==='offline';$('play-button').disabled=mode==='offline';$('edit-regions').disabled=mode==='offline';$('video-controls').hidden=mode!=='video';
  $('camera-controls').hidden=mode!=='camera';
  $('scene-note').textContent=mode==='demo'?'GENERATED SAMPLE STILL · SIMULATED STATES':'PROCESSED BY YOUR RESTAURANT SERVER';
  $('camera-title').textContent=`Camera 01 · ${sourceName}`;
  $('camera-subtitle').textContent=mode==='demo'?'Generated sample still · simulated table states':mode==='camera'?'Local webcam · automatic table detection':mode==='network'?'Live CCTV · automatic table detection':'Local video · automatic table detection';
  $('engine-status').textContent=mode==='demo'?'Demo simulation · AI is off':'Local AI ready to start';
  $('insight-subtitle').textContent=mode==='demo'?'Simulated observations, clearly labeled.':'Two confident scans confirm each state change.';
  $('privacy-note').textContent=mode==='demo'?'Training demo only. Counts, tasks, and AI scores are simulated.':'Frames are processed by the application server. No external AI API.';
  if(mode==='offline'){$('camera-title').textContent='Camera offline';$('camera-subtitle').textContent='Connect a camera, CCTV stream, or test video';$('mode-badge').textContent='⚠ OFFLINE';$('scene-note').textContent='NO LIVE SOURCE';$('engine-status').textContent='Monitoring not started';$('stream-message').hidden=false;$('stream-message').textContent='Camera offline · Connect a source to begin. No table availability is confirmed.';}
  updatePlayback();
}
function updatePlayback(){
  $('play-button').textContent=running?'Ⅱ':'▷';$('play-button').setAttribute('aria-label',running?'Pause monitoring':mode==='demo'?'Resume demo':'Start local AI');
  $('feed-state').textContent=editing?'Editing table regions':running?(mode==='demo'?'Demo running':busy?'Analyzing locally…':'Local AI running'):(mode==='demo'?'Demo paused':'Start local AI');
  if(mode==='network'&&!networkFresh())$('feed-state').textContent='Waiting for live CCTV';
  if(detecting)$('feed-state').textContent='Checking table layout…';
  $('cycle-text').textContent=mode==='demo'?`Simulated · ${interval/1000}s cycle`:elapsedMs!==null?`${(elapsedMs/1000).toFixed(1)}s last scan`:'AI not started';
  if(mode==='offline')$('feed-state').textContent='Camera offline';
  stage.classList.toggle('paused',!running||editing);updateHealth();
}
function schedule(){clearTimeout(timer);if(running&&!editing)timer=setTimeout(scan,interval);}
function captureFrame(){
  if(mode==='network'){
    const image=$('network-image');if(!networkFresh()||!image.naturalWidth)throw new Error('Waiting for a fresh CCTV frame. The stream reconnects automatically.');
    const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;canvas.getContext('2d').drawImage(image,0,0);return canvas.toDataURL('image/jpeg',.8);
  }
  if(video.readyState<2||!video.videoWidth)throw new Error('Waiting for a camera or video frame. Try Detect tables in a moment.');
  const canvas=document.createElement('canvas');const scale=Math.min(1,1600/video.videoWidth);canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);
  canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/jpeg',.8);
}
async function detectTables(){
  if(mode==='demo')return;
  running=false;aiFailed=false;clearTimeout(timer);clearUndo();tables=tables.map(invalidate);render();setEditing(false);const epoch=++generation;
  detecting=true;updatePlayback();
  $('detect-tables').disabled=true;$('detect-tables').textContent='Detecting…';$('play-button').disabled=true;
  $('feed-state').textContent='Finding tables locally…';$('engine-status').textContent='Locating and verifying tables…';
  $('detection-hint').hidden=false;$('detection-hint').textContent='Aim the camera at the tables and hold it steady. Show the whole tabletop and nearby seats. Checking several frames…';
  try{
    let previous=[],confirmed=null,sawCandidates=false;
    for(let attempt=0;attempt<10;attempt++){
      await new Promise(resolve=>setTimeout(resolve,attempt===0?1800:2200));
      if(epoch!==generation)return;
      if(mode==='network'&&!networkFresh())continue;
      const response=await fetch('/api/detect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({frame:captureFrame()})});
      const data=await response.json();if(epoch!==generation)return;
      if(!response.ok)throw new Error(data.error||'Table detection failed.');
      const candidates=data.regions;
      if(stableLayout(previous,candidates)){confirmed=candidates;break;}
      sawCandidates ||= candidates.length>0;previous=candidates;
      $('engine-status').textContent=candidates.length?`Confirming ${candidates.length} table regions · hold the camera steady`:`No tables visible yet · checking again (${attempt+1}/10)`;
    }
    if(!confirmed){
      tables=[];render();
      $('engine-status').textContent=sawCandidates?'Table layout did not stay stable':'No tables recognized in this view';
      $('detection-hint').textContent=sawCandidates?'The detected boxes changed between frames. Hold the camera steady, then press Detect tables again, or draw the regions with Edit tables.':'No tables were recognized after several checks. Choose the camera aimed at the tables, move back to show whole tabletops, then press Detect tables. You can also map tables manually with Edit tables.';
      return;
    }
    const available=new Set(tables);
    tables=confirmed.map(t=>{const match=[...available].find(old=>overlap(t,old)>=.45);if(match)available.delete(match);return invalidate({...t,name:match?.name||t.name,area:match?.area||'Main dining room',fx:(t.x+t.w/2)*100,fy:Math.min(83,Math.max(35,(t.y+t.h/2)*75+10))});});saveRegions();render();
    addEvent(`Automatically detected ${tables.length} tables`,'Local AI');
    $('engine-status').textContent=`${tables.length} tables detected · starting monitoring`;
    $('detection-hint').textContent=`${tables.length} table regions confirmed across two frames. Review the boxes; use Edit tables to correct any missed or overlapping tables.`;
    toast(`Detected ${tables.length} tables. Monitoring automatically. Use Edit tables to correct any regions.`);
    running=true;updatePlayback();schedule();
  }catch(error){
    if(epoch!==generation)return;
    aiFailed=true;$('engine-status').textContent='Automatic detection unavailable';$('mode-badge').textContent='AI OFFLINE';$('mode-badge').classList.add('error-badge');toast(error.message);addEvent(`Detection unavailable: ${error.message}`,'System');setEditing(true);
  }finally{
    if(epoch===generation){detecting=false;$('detect-tables').disabled=false;$('detect-tables').textContent='✧ Detect tables';$('play-button').disabled=false;}
    if(epoch===generation)updatePlayback();
  }
}
async function scan(){
  if(!running||editing||busy)return;
  const epoch=generation;
  if(mode==='demo'){
    demoTick++;
    const states=demoTick%18<9?['dirty','free','occupied','free','occupied']:['free','occupied','dirty','free','occupied'];
    tables.forEach((t,i)=>{if(Date.now()>(t.manualUntil||0))applyObservation(t,states[i%states.length],.92+(i%3)*.02);});
    $('last-update').textContent='JUST NOW';render();schedule();return;
  }
  if((mode==='network'?!networkFresh():video.readyState<2||!video.videoWidth)||!tables.length){schedule();return;}
  busy=true;updatePlayback();
  try{
    const response=await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({frame:captureFrame(),regions:tables.map(({id,x,y,w,h})=>({id,x,y,w,h}))})});
    const data=await response.json();if(epoch!==generation||(mode==='network'&&!networkFresh()))return;
    if(!response.ok)throw new Error(data.error||'Could not analyze this frame.');
    elapsedMs=data.elapsed_ms;lastSuccessfulCheck=Date.now();aiFailed=false;
    $('mode-badge').textContent='● LIVE SOURCE';$('mode-badge').classList.remove('error-badge');
    for(const result of data.results){const t=tables.find(t=>t.id===result.id);if(t&&Date.now()>(t.manualUntil||0))applyObservation(t,result.status,result.confidence,result.reason,result.signals,result.objects,result.object_scores,result.inference);}
    $('engine-status').textContent=`d1-2B · ${(elapsedMs/1000).toFixed(1)}s per scan · local`;$('last-update').textContent='JUST NOW';render();
  }catch(error){
    if(epoch!==generation)return;
    running=false;aiFailed=true;clearUndo();tables=tables.map(invalidate);render();$('engine-status').textContent='Local AI unavailable';$('mode-badge').textContent='AI OFFLINE';$('mode-badge').classList.add('error-badge');
    toast(error.message);addEvent(`Monitoring stopped: ${error.message}`,'System');
  }finally{busy=false;updatePlayback();schedule();}
}
function stopSource(){
  clearUndo();lastSuccessfulCheck=null;elapsedMs=null;aiFailed=false;cameraFailed=false;areaFilter='';
  detecting=false;$('detection-hint').hidden=true;
  sourceRequest++;clearTimeout(networkTimer);networkTimer=null;
  if(networkSession)releaseNetwork(networkSession);networkSession=null;networkLastFrame=0;networkDetected=false;
  $('network-image').removeAttribute('src');if(networkObjectUrl){URL.revokeObjectURL(networkObjectUrl);networkObjectUrl=null;}
  $('stream-message').hidden=true;stage.classList.remove('network-stale');
  generation++;running=false;editing=false;stage.classList.remove('editing');$('editor-bar').hidden=true;clearTimeout(timer);
  video.pause();video.removeAttribute('src');video.load();if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}video.srcObject=null;
  if(fileUrl){URL.revokeObjectURL(fileUrl);fileUrl=null;}
  mode='offline';tables=tables.map(invalidate);setModeUi();render();
}
function restoreRegions(){
  try{const r=JSON.parse(localStorage.getItem(`cafewatch-regions:${mode}:${sourceName}`)||'[]');const ids=new Set();tables=Array.isArray(r)?r.filter(t=>{
    const ok=t&&typeof t.id==='string'&&!ids.has(t.id)&&typeof t.name==='string'&&t.name.length<=40&&['x','y','w','h'].every(k=>Number.isFinite(t[k])&&t[k]>=0&&t[k]<=1)&&t.w>=.01&&t.h>=.01&&t.x+t.w<=1.001&&t.y+t.h<=1.001;ids.add(t?.id);return ok;
  }).slice(0,20).map(t=>invalidate({...t,fx:(t.x+t.w/2)*100,fy:Math.min(83,Math.max(35,(t.y+t.h/2)*75+10))})):[];}catch{tables=[];}
}
function setEditing(value){editing=value;generation++;if(value){detecting=false;$('detect-tables').disabled=false;$('detect-tables').textContent='✧ Detect tables';$('play-button').disabled=false;}stage.classList.toggle('editing',value);$('editor-bar').hidden=!value;$('edit-regions').textContent=value?'⌗ Editing tables':'⌗ Edit tables';if(value){clearTimeout(timer);}else{saveRegions();schedule();}updatePlayback();}
function loadDemo(){stopSource();mode='demo';sourceName='Café floor';running=true;demoTick=0;elapsedMs=null;tables=defaults.map(t=>({...t,since:Date.now(),confidence:.94,lastSeen:Date.now()}));setModeUi();render();schedule();}

function networkFresh(){return networkLastFrame>0&&Date.now()-networkLastFrame<5000;}
function releaseNetwork(id){fetch('/api/streams/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id}),keepalive:true}).catch(()=>{});}
function showNetworkWaiting(message){
  const hadFrame=networkLastFrame>0;networkLastFrame=0;
  clearUndo();tables=tables.map(invalidate);render();
  if(hadFrame){generation++;detecting=false;$('detect-tables').disabled=false;$('detect-tables').textContent='✧ Detect tables';$('play-button').disabled=false;tables=tables.map(invalidate);if(!tables.length)networkDetected=false;render();}
  $('stream-message').textContent=message;$('stream-message').hidden=false;stage.classList.add('network-stale');$('network-status').textContent='Connecting / retrying automatically';updatePlayback();
  $('last-update').textContent='FEED UNAVAILABLE';
}
async function pollNetwork(id){
  if(networkSession!==id)return;
  try{
    const response=await fetch(`/api/streams/${encodeURIComponent(id)}/frame`,{cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(networkSession!==id)return;
    if(response.status===202){const data=await response.json();if(networkSession===id)showNetworkWaiting(data.message||'Waiting for live CCTV. Retrying automatically.');}
    else if(response.status===404){showNetworkWaiting('CCTV session expired. Connect the camera again.');networkSession=null;running=false;updatePlayback();return;}
    else if(!response.ok)throw new Error('Stream unavailable.');
    else {
      const blob=await response.blob();if(networkSession!==id)return;
      const next=URL.createObjectURL(blob),image=$('network-image');
      try{await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=next;});}catch{URL.revokeObjectURL(next);throw new Error('Could not decode preview.');}
      if(networkSession!==id){URL.revokeObjectURL(next);return;}
      if(networkObjectUrl)URL.revokeObjectURL(networkObjectUrl);networkObjectUrl=next;networkLastFrame=Date.now();
      $('stream-message').hidden=true;stage.classList.remove('network-stale');$('network-status').textContent='● Live CCTV · preview 2 fps · AI scans independently';updatePlayback();
      if(!networkDetected){networkDetected=true;void detectTables();}
    }
  }catch{
    if(networkSession===id)showNetworkWaiting('CCTV connection interrupted. Retrying automatically…');
  }finally{if(networkSession===id)networkTimer=setTimeout(()=>pollNetwork(id),500);}
}

$('source-button').onclick=()=>$('source-dialog').showModal();
$('choose-file').onclick=()=>$('file-input').click();
$('choose-cctv').onclick=()=>{$('source-dialog').close();$('cctv-error').hidden=true;$('cctv-dialog').showModal();};
$('cancel-cctv').onclick=()=>$('cctv-dialog').close();
$('reveal-cctv-url').onchange=e=>$('cctv-url').type=e.target.checked?'text':'password';
$('cctv-dialog').addEventListener('close',()=>{if($('connect-cctv').disabled&&!networkSession)sourceRequest++;$('cctv-url').value='';$('cctv-url').type='password';$('reveal-cctv-url').checked=false;});
$('cctv-form').onsubmit=async event=>{
  event.preventDefault();const url=$('cctv-url').value.trim(),name=$('cctv-name').value.trim()||'Café floor CCTV';
  $('connect-cctv').disabled=true;$('cctv-error').hidden=true;
  stopSource();const request=sourceRequest;
  try{
    const response=await fetch('/api/streams',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});const data=await response.json();
    if(request!==sourceRequest){if(data.id)releaseNetwork(data.id);return;}
    if(!response.ok)throw new Error(data.error||'Could not connect CCTV.');
    mode='network';sourceName=name;networkSession=data.id;restoreRegions();elapsedMs=null;setModeUi();render();$('cctv-dialog').close();
    showNetworkWaiting('Connecting to your CCTV camera… Tables will be detected when the first frame arrives.');
    addEvent('Connected a live CCTV source','System');pollNetwork(data.id);
  }catch(error){$('cctv-error').textContent=error.message;$('cctv-error').hidden=false;updatePlayback();}
  finally{$('connect-cctv').disabled=false;}
};
$('disconnect-stream').onclick=()=>{stopSource();addEvent('Disconnected CCTV','System');toast('CCTV disconnected. Monitoring is offline.');};
$('file-input').onchange=async event=>{
  const file=event.target.files[0];if(!file)return;
  stopSource();mode='video';sourceName=file.name;restoreRegions();setModeUi();render();
  fileUrl=URL.createObjectURL(file);video.src=fileUrl;video.loop=true;
  $('source-dialog').close();
  try{await video.play();addEvent(`Opened local video: ${file.name}`,'System');await detectTables();}catch{toast('This video could not be played. Try an MP4 encoded with H.264.');}
  event.target.value='';
};
async function refreshCameras(){
  const devices=await navigator.mediaDevices.enumerateDevices();const current=stream?.getVideoTracks()[0]?.getSettings().deviceId;
  $('camera-select').replaceChildren(...devices.filter(d=>d.kind==='videoinput').map((device,i)=>{const option=element('option','',device.label||`Camera ${i+1}`);option.value=device.deviceId;return option;}));
  if(current)$('camera-select').value=current;
}
async function openCamera(deviceId){
  let nextStream;
  const request=++sourceRequest;
  try{nextStream=await navigator.mediaDevices.getUserMedia({video:{...(deviceId?{deviceId:{exact:deviceId}}:{facingMode:{ideal:'environment'}}),width:{ideal:1920},height:{ideal:1080}},audio:false});}catch(error){toast(`Camera unavailable: ${error.message}`);return;}
  if(request!==sourceRequest){nextStream.getTracks().forEach(t=>t.stop());return;}
  stopSource();const activeRequest=sourceRequest;mode='camera';sourceName=nextStream.getVideoTracks()[0]?.label||'Webcam';stream=nextStream;video.srcObject=stream;restoreRegions();setModeUi();render();$('source-dialog').close();
  nextStream.getVideoTracks()[0].onended=()=>{if(stream!==nextStream)return;cameraFailed=true;clearUndo();running=false;generation++;detecting=false;clearTimeout(timer);tables=tables.map(invalidate);render();updatePlayback();$('detection-hint').hidden=false;$('detection-hint').textContent='The camera disconnected. Choose an available camera or reconnect it using Connect a source.';$('detect-tables').disabled=false;$('play-button').disabled=false;};
  try{await video.play();if(activeRequest!==sourceRequest)return;await refreshCameras();if(activeRequest!==sourceRequest)return;addEvent('Connected local webcam','System');await detectTables();}catch{if(activeRequest===sourceRequest){stopSource();toast('Camera playback failed. Try connecting again.');}}
}
$('choose-camera').onclick=()=>openCamera();
$('camera-select').onchange=e=>openCamera(e.target.value);
$('refresh-cameras').onclick=()=>refreshCameras().catch(()=>toast('Could not refresh the camera list. Reconnect your camera.'));
$('choose-demo').onclick=()=>{$('source-dialog').close();loadDemo();addEvent('Started simulated demo','Demo');};
$('play-button').onclick=async()=>{
  if(editing){toast('Finish editing your table regions first.');return;}
  if(mode!=='demo'&&!tables.length){toast('Draw at least one table region before starting local AI.');setEditing(true);return;}
  running=!running;updatePlayback();
  if(mode==='video'){if(running){try{await video.play();}catch{running=false;updatePlayback();toast('Video playback is unavailable. Open a supported video.');return;}}else video.pause();}
  if(running)scan();else clearTimeout(timer);
};
$('edit-regions').onclick=()=>setEditing(!editing);$('done-editing').onclick=()=>setEditing(false);
$('detect-tables').onclick=detectTables;
$('video-speed').onchange=e=>video.playbackRate=Number(e.target.value);
$('video-seek').oninput=e=>{video.currentTime=Number(e.target.value);generation++;tables=tables.map(invalidate);render();};
video.addEventListener('timeupdate',()=>{if(!Number.isFinite(video.duration))return;$('video-seek').max=video.duration;$('video-seek').value=video.currentTime;$('video-position').textContent=duration(video.currentTime*1000);$('video-duration').textContent=duration(video.duration*1000);});
let drag=null;
function point(event){const rect=stage.getBoundingClientRect();return{x:Math.min(1,Math.max(0,(event.clientX-rect.left)/rect.width)),y:Math.min(1,Math.max(0,(event.clientY-rect.top)/rect.height))};}
stage.addEventListener('pointerdown',event=>{
  if(!editing||event.target.closest('.region'))return;if(tables.length>=20){toast('You can map up to 20 tables.');return;}
  drag=point(event);stage.setPointerCapture(event.pointerId);$('draw-preview').hidden=false;
});
stage.addEventListener('pointermove',event=>{
  if(!drag)return;const p=point(event);Object.assign($('draw-preview').style,{left:`${Math.min(p.x,drag.x)*100}%`,top:`${Math.min(p.y,drag.y)*100}%`,width:`${Math.abs(p.x-drag.x)*100}%`,height:`${Math.abs(p.y-drag.y)*100}%`});
});
stage.addEventListener('pointerup',event=>{
  if(!drag)return;const p=point(event),x=Math.min(p.x,drag.x),y=Math.min(p.y,drag.y),w=Math.abs(p.x-drag.x),h=Math.abs(p.y-drag.y);drag=null;$('draw-preview').hidden=true;
  if(w<.025||h<.025)return;const id=String(Math.max(0,...tables.map(t=>Number(t.id)||0))+1);
  tables.push(invalidate({id,name:`Table ${id.padStart(2,'0')}`,x,y,w,h,fx:(x+w/2)*100,fy:Math.min(83,Math.max(35,(y+h/2)*75+10))}));generation++;saveRegions();render();
});
stage.addEventListener('pointercancel',()=>{drag=null;$('draw-preview').hidden=true;});
$('area-filter').onchange=e=>{areaFilter=e.target.value;render();};
$('undo-action').onclick=()=>{const undo=pendingUndo;if(!undo||undo.epoch!==generation||Date.now()>undo.expires||!tables.includes(undo.table)){clearUndo();return;}const restored=undo.previous;if(restored.lastSeen&&Date.now()-restored.lastSeen>staleAfter(interval))Object.assign(restored,invalidate(restored));Object.assign(undo.table,restored);clearUndo();addEvent(`${undo.table.name} · Staff action undone`,'Staff');render();};
$('save-table').onclick=()=>{const t=tables.find(t=>t.id===selected);const name=$('table-name').value.trim();if(t&&name){t.name=name.slice(0,40);t.area=$('table-area').value.trim().slice(0,40)||'Main dining room';saveRegions();render();$('table-dialog').close();}};
$('remove-table').onclick=()=>{tables=tables.filter(t=>t.id!==selected);generation++;saveRegions();render();$('table-dialog').close();};
$('fullscreen').onclick=()=>{const promise=document.fullscreenElement?document.exitFullscreen():stage.requestFullscreen();promise.catch(()=>toast('Fullscreen is unavailable in this browser.'));};
for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>{document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b===button));document.querySelectorAll('.view').forEach(v=>v.hidden=v.id!==`${button.dataset.view}-view`);$('breadcrumb').textContent={overview:'Floor overview',activity:'Activity log',settings:'Settings'}[button.dataset.view];};
$('interval-setting').value=String(interval);$('confidence-setting').value=String(threshold);$('sound-setting').checked=sound;
$('interval-setting').onchange=e=>{interval=Number(e.target.value);persist();updatePlayback();schedule();};
$('confidence-setting').onchange=e=>{threshold=Number(e.target.value);clearUndo();tables=tables.map(t=>recheckForConfidence(t));render();persist();};
$('sound-setting').onchange=e=>{sound=e.target.checked;persist();if(sound)beep();else alertPlayer.stop();};
$('alert-tone').value=alertTone;
$('alert-volume').value=String(Math.round(alertVolume*100));$('alert-volume-value').textContent=`${Math.round(alertVolume*100)}%`;
$('preview-sound').onclick=async()=>{
  if($('preview-sound').dataset.playing==='true'){alertPlayer.stop();$('sound-status').textContent='Sound stopped.';return;}
  try{await alertPlayer.play(alertTone,alertVolume);$('sound-status').textContent='Preview playing. Alerts use this sound when enabled.';}catch(error){$('sound-status').textContent=error.message;}
};
$('alert-tone').onchange=e=>{alertPlayer.stop();alertTone=e.target.value;persist();};
$('alert-volume').oninput=e=>{alertVolume=Number(e.target.value)/100;alertPlayer.setVolume(alertVolume);$('alert-volume-value').textContent=`${e.target.value}%`;};
$('alert-volume').onchange=persist;
$('upload-sound').disabled=true;$('upload-sound').onclick=()=>$('sound-file').click();
$('sound-file').onchange=async event=>{
  const file=event.target.files[0];if(!file)return;
  $('upload-sound').disabled=true;$('remove-sound').disabled=true;
  try{await alertPlayer.upload(file);alertTone='custom';updateCustomSound();persist();$('sound-status').textContent='Custom audio saved in this browser. Use Preview sound to test it.';}
  catch(error){$('sound-status').textContent=error.message;}
  finally{event.target.value='';$('upload-sound').disabled=false;updateCustomSound();}
};
function updateCustomSound(){
  const option=$('alert-tone').querySelector('option[value="custom"]');option.disabled=!alertPlayer.custom;option.textContent=alertPlayer.custom?'Custom audio':'Custom audio (upload first)';
  $('sound-file-name').textContent=alertPlayer.custom?`Custom audio: ${alertPlayer.customName}`:'No custom audio uploaded.';
  $('remove-sound').disabled=!alertPlayer.custom;$('alert-tone').value=alertTone;
}
$('remove-sound').onclick=async()=>{
  $('remove-sound').disabled=true;
  try{await alertPlayer.removeCustom();if(alertTone==='custom')alertTone='chime';persist();$('sound-status').textContent='Custom audio removed.';}catch(error){$('sound-status').textContent=error.message;}
  updateCustomSound();
};
void alertPlayer.loadCustom().catch(error=>{$('sound-status').textContent=error.message;}).finally(()=>{
  if(alertTone==='custom'&&!alertPlayer.custom){alertTone='chime';$('sound-status').textContent='Saved custom audio is unavailable. Soft chime is selected; upload audio to replace it.';}
  updateCustomSound();$('upload-sound').disabled=false;
});
window.addEventListener('pointerdown',()=>{if(sound)void alertPlayer.unlock().catch(()=>{});});
window.addEventListener('pagehide',()=>alertPlayer.destroy());

$('reset-demo').onclick=()=>{loadDemo();document.querySelector('[data-view="overview"]').click();$('source-button').focus();toast('Training demo opened. All observations are simulated.');};
$('export-log').onclick=()=>{
  const cell=value=>`"${String(value).replace(/"/g,'""')}"`;
  const csv=['Time,Event,Source',...events.map(e=>[e.time,e.message,e.source].map(v=>cell(/^[=+@\-\t\r]/.test(v)?`'${v}`:v)).join(','))].join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=element('a');a.href=url;a.download='cafe-watch-activity.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
setInterval(()=>{
  const now=new Date();if(pendingUndo&&Date.now()>pendingUndo.expires)clearUndo();updateHealth();$('clock').textContent=now.toLocaleDateString([],{day:'numeric',month:'short',year:'numeric'});$('camera-time').textContent=now.toLocaleTimeString([],{hour12:false});updateWait();
  if(mode!=='demo'&&!editing){let changed=false;tables=tables.map(t=>{if(Date.now()>(t.manualUntil||0)&&displayStatus(t)!=='cleaning'&&t.status!=='unknown'&&t.lastSeen&&Date.now()-t.lastSeen>staleAfter(interval)){changed=true;return invalidate(t);}return t;});if(changed)render();}
  if(mode==='network'&&networkLastFrame&&!networkFresh())showNetworkWaiting('Waiting for fresh CCTV footage. Retrying automatically…');
},1000);
window.addEventListener('beforeunload',stopSource);
video.addEventListener('error',()=>{if(mode==='video'&&video.getAttribute('src')){cameraFailed=true;clearUndo();running=false;clearTimeout(timer);generation++;tables=tables.map(invalidate);render();updatePlayback();toast('Video playback failed. Open a browser-supported MP4 or WebM.');}});
setModeUi();render();renderActivity();schedule();
