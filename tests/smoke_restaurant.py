"""Optional local API regression using the generated eight-table demo assets."""
import base64
import io
import json
from pathlib import Path
from urllib.request import Request, urlopen
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SCENES = ROOT / 'output' / 'restaurant-manager-demo'

def call(endpoint, payload):
    request = Request('http://127.0.0.1:8080' + endpoint,
                      data=json.dumps(payload).encode(),
                      headers={'Content-Type': 'application/json'})
    with urlopen(request, timeout=240) as response:
        return json.load(response)

def frame(path):
    image = Image.open(path).convert('RGB')
    image.thumbnail((1600, 1600))
    buffer = io.BytesIO()
    image.save(buffer, format='JPEG', quality=90)
    return 'data:image/jpeg;base64,' + base64.b64encode(buffer.getvalue()).decode()

layout = json.loads((SCENES / 'layout.json').read_text())
regions = call('/api/detect', {'frame': frame(SCENES / 'encoded-ready.png')})['regions']
assert len(regions) == 8, f'Expected eight tables, got {len(regions)}'
assert all(r['verified_by'] == 'LiquidAI/d1-2B' and r['table_confidence'] >= .75 for r in regions)
reports = []
for phase in ['ready', 'occupied', 'dirty']:
    # Reuse the known spatial layout to compare each table to its visual ground truth.
    results = call('/api/analyze', {'frame': frame(SCENES / f'encoded-{phase}.png'),
                                    'regions': layout['regions']})['results']
    expected = {r['id']: ('free' if phase == 'ready' or r['id'] not in layout['targets']
                          else 'occupied' if phase == 'occupied' else 'dirty')
                for r in layout['regions']}
    assert len(results) == len(expected)
    assert all(r['status'] == expected[r['id']] for r in results), (phase, results)
    assert all(r['inference']['output_tokens'] == 0 for r in results)
    if phase == 'dirty':
        for result in results:
            if result['status'] == 'dirty':
                assert {'dishes', 'drinkware'} <= {o['key'] for o in result['objects']}
    report = {'phase': phase, 'matches': len(results), 'results': results}
    reports.append(report)
    print(json.dumps({'phase': phase, 'matches': len(results)}), flush=True)
(ROOT / 'output' / 'liquid-restaurant-regression.json').write_text(
    json.dumps({'verified_tables': regions, 'scenes': reports}, indent=2))
