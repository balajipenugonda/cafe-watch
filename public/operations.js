import {invalidate} from './state.js';

// Staff workflow is separate from the AI's observation of the table.
export const displayStatus = table => table.workflow === 'cleaning' ? 'cleaning' : table.status;
export const staleAfter = interval => Math.max(30000, interval * 3);
export function health({mode, connected, running, detecting, failed, lastCheck, now=Date.now(), interval=2000}) {
  if (mode === 'demo') return {state:'demo', title:'Demo · simulated data', detail:'Training preview only. Connect a camera for live monitoring.'};
  if (mode === 'offline' || !connected) return {state:'offline', title:'Camera offline', detail:'No live results. Connect or reconnect a source.'};
  if (failed) return {state:'offline', title:'AI unavailable', detail:'Table states are uncertain. Retry detection or check the server.'};
  if (detecting) return {state:'checking', title:'Checking table layout', detail:'Keep the camera fixed while tables are verified.'};
  if (lastCheck && now-lastCheck > staleAfter(interval)) return {state:'stale', title:'Results stale · review required', detail:'The last successful AI check is too old to confirm table availability.'};
  if (!running) return {state:'paused', title:'Monitoring paused', detail:'Table availability is not being updated.'};
  if (!lastCheck) return {state:'checking', title:'Waiting for first AI check', detail:'Table availability has not been confirmed yet.'};
  return {state:'live', title:'Live monitoring', detail:'Two confident observations confirm each AI state change.'};
}
export function staffAction(table, action, now=Date.now()) {
  if (!['start','complete'].includes(action)) throw new Error('Unknown staff action');
  const previous = structuredClone({...table,workflow:table.workflow??null,manualUntil:table.manualUntil??0});
  Object.assign(table,{workflow:action==='start'?'cleaning':null, status:action==='start'?table.status:'free',
    since:now, confidence:null, candidate:null, streak:0, uncertainStreak:0,
    manualUntil:action==='start'?Infinity:now+15000, objects:[], objectScores:{}, inference:null, signals:null,
    reason:action==='start'?'Staff are cleaning this table.':'Marked ready by staff; AI will recheck after 15 seconds.'});
  return previous;
}

// Confidence controls AI decisions, not a staff member's active cleaning work.
export function recheckForConfidence(table, now=Date.now()) {
  return table.workflow==='cleaning'||table.manualUntil>now ? table : invalidate(table);
}
