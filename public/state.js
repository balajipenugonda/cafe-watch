export const labels = {free: 'Ready', occupied: 'Occupied', dirty: 'Needs cleaning', unknown: 'Uncertain', cleaning: 'Cleaning'};

// Require two consecutive confident observations before changing a table's state.
export function observe(table, status, confidence, now = Date.now(), threshold = .65) {
  // Unknown is a real model result, not an instruction to keep a previous Ready label.
  const lowConfidence=['free','occupied','dirty'].includes(status)&&Number.isFinite(confidence)&&confidence>=0&&confidence<threshold;
  if(status==='unknown'||lowConfidence){
    table.confidence=null;table.candidate=null;table.streak=0;table.lastSeen=now;table.uncertainStreak=(table.uncertainStreak||0)+1;
    if(table.uncertainStreak>=2&&table.status!=='unknown'){table.status='unknown';table.since=now;return true;}
    return false;
  }
  if (!['free', 'occupied', 'dirty'].includes(status) || !Number.isFinite(confidence) || confidence < threshold || confidence > 1) {
    table.candidate = null; table.streak = 0;
    return false;
  }
  table.confidence = confidence;
  table.uncertainStreak=0;
  table.lastSeen = now;
  if (table.candidate === status) table.streak++;
  else { table.candidate = status; table.streak = 1; }
  if (table.streak < 2 || table.status === status) return false;
  table.status = status; table.since = now;
  return true;
}

export function invalidate(table) {
  return {...table, status: 'unknown', confidence: null, since: Date.now(), candidate: null, streak: 0, lastSeen: null, uncertainStreak:0, reason:null, signals:null, objects:[], objectScores:{}, inference:null, workflow:null, manualUntil:0};
}
