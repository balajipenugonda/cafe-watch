"""Inspect native object probabilities on known generated images."""
import json
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import DecisionEngine
from objects import OBJECT_QUESTION, object_evidence

root=Path(__file__).resolve().parents[1]
engine=DecisionEngine()
cases=[('cafe_dirty',root/'public/cafe-scene.png',(.07,.58,.31,.38)),
       ('cafe_clear_decor',root/'output/sample-video/ready.png',(.07,.58,.31,.38)),
       ('hotel_dirty',root/'output/restaurant-manager-demo/dirty.png',(.04,.57,.27,.42)),
       ('hotel_clear',root/'output/restaurant-manager-demo/ready.png',(.04,.57,.27,.42))]
reports=[]
for name,path,(x,y,w,h) in cases:
    torch,image=engine.prepare(path.read_bytes())
    crop=image.crop((int(x*image.width),int(y*image.height),int((x+w)*image.width),int((y+h)*image.height)))
    crop.thumbnail((768,768))
    with torch.inference_mode():out=engine.model.system_one(None,{'objects':OBJECT_QUESTION},media=[crop])
    objects,scores=object_evidence(out['answers']['objects'])
    report={'case':name,'objects':objects,'scores':scores,'usage':out.get('usage')}
    reports.append(report);print(json.dumps(report),flush=True)
(root/'output/liquid-object-probe.json').write_text(json.dumps(reports,indent=2))
