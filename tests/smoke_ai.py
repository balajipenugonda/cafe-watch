"""Optional real-model check: .venv/bin/python tests/smoke_ai.py"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import DecisionEngine

engine = DecisionEngine()
raw = (Path(__file__).resolve().parents[1] / 'public' / 'cafe-scene.png').read_bytes()
regions = engine.detect(raw)
print(json.dumps({'detected': regions}), flush=True)
assert regions, 'No tables detected in the sample café.'
results = engine.analyze(raw, regions)
print(json.dumps({'classified': results}), flush=True)
assert len(results) == len(regions)
assert all(r['status'] in {'dirty', 'free', 'occupied'} for r in results)
assert sorted(r['status'] for r in results) == ['dirty', 'free', 'free', 'occupied', 'occupied'], 'Sample scene did not match its known five-table states.'
assert all(r['verified_by']=='LiquidAI/d1-2B' and r['table_confidence']>=.75 for r in regions)
assert all(r['inference']['output_tokens']==0 for r in results)
dirty=next(r for r in results if r['status']=='dirty')
assert {'dishes','drinkware'} <= {o['key'] for o in dirty['objects']}, 'Expected visible dishes and cups on the dirty table.'
