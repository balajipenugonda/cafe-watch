export function overlap(a,b){
  const intersection=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
  return Math.min(1,Math.max(0,intersection/(a.w*a.h+b.w*b.h-intersection||1)));
}

// Match whole sets one-to-one so duplicate candidates cannot confirm a layout.
export function stableLayout(previous,current){
  if(!previous?.length||previous.length!==current.length)return false;
  const available=new Set(current.map((_,i)=>i));
  for(const region of previous){
    const match=[...available].find(i=>overlap(region,current[i])>=.45);
    if(match===undefined)return false;
    available.delete(match);
  }
  return true;
}
