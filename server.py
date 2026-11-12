"""Local-only café monitor. Start with: python3 server.py"""
import argparse
import base64
import io
import json
import math
import os
import signal
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from streams import StreamPool
from decisions import QUESTIONS, decide
from occupancy import associate_people, table_overlap
from objects import OBJECT_QUESTION, apply_object_evidence

ROOT = Path(__file__).parent / 'public'
LABELS = {'free', 'occupied', 'dirty'}
MODEL_REVISION = '652f920e544ea37f81e4b0ce89b81d4ed0da90b1'
# Model code also loads processors internally; enforce offline operation for all of it.
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ.setdefault('HF_MODULES_CACHE', str(Path(__file__).parent / '.cache' / 'hf-modules'))
os.environ.setdefault('YOLO_CONFIG_DIR', str(Path(__file__).parent / '.cache' / 'ultralytics'))
os.environ['YOLO_AUTOINSTALL'] = 'false'
os.environ['YOLO_OFFLINE'] = 'true'
os.environ.setdefault('MPLCONFIGDIR', str(Path(__file__).parent / '.cache' / 'matplotlib'))


def validate_frame(payload):
    frame = payload.get('frame', '')
    if not isinstance(frame, str) or not frame.startswith('data:image/jpeg;base64,'):
        raise ValueError('A JPEG frame is required.')
    try:
        raw = base64.b64decode(frame.split(',', 1)[1], validate=True)
    except Exception:
        raise ValueError('Invalid frame encoding.')
    if not raw or len(raw) > 6_000_000:
        raise ValueError('Frame must be smaller than 6 MB.')
    return raw


def validate(payload):
    regions = payload.get('regions')
    if not isinstance(regions, list) or not 1 <= len(regions) <= 20:
        raise ValueError('Detect or draw between 1 and 20 table regions.')
    ids = set()
    for region in regions:
        if not isinstance(region, dict) or not isinstance(region.get('id'), str) or region['id'] in ids:
            raise ValueError('Every table needs a unique string ID.')
        ids.add(region['id'])
        for key in ('x', 'y', 'w', 'h'):
            v = region.get(key)
            if isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) or not 0 <= v <= 1:
                raise ValueError('Region coordinates must be normalized between 0 and 1.')
        if region['w'] < .01 or region['h'] < .01 or region['x'] + region['w'] > 1.001 or region['y'] + region['h'] > 1.001:
            raise ValueError('Table region is empty or outside the frame.')
    return validate_frame(payload), regions


def detected_regions(boxes):
    regions = []
    valid = []
    for item in boxes:
        box = item.get('box')
        if not isinstance(box, dict):
            continue
        values = [box.get(k) for k in ('left', 'top', 'right', 'bottom')]
        if not all(isinstance(v, (int, float)) and math.isfinite(v) and 0 <= v <= 1 for v in values):
            continue
        left, top, right, bottom = values
        if right - left < .025 or bottom - top < .025:
            continue
        valid.append((left, top, right, bottom))
    # A detector can return both the tabletop and the whole table. Keep the
    # larger region first, then suppress substantially contained duplicates.
    valid.sort(key=lambda b: (b[2]-b[0])*(b[3]-b[1]), reverse=True)
    for left, top, right, bottom in valid:
        # Add surrounding seats so the classifier can distinguish occupied tables.
        pad_x, pad_y = (right - left) * .18, (bottom - top) * .35
        x, y = max(0, left - pad_x), max(0, top - pad_y)
        w, h = min(1, right + pad_x) - x, min(1, bottom + pad_y) - y
        # Drop near-duplicate detections, retaining the first in reading order.
        duplicate = False
        for r in regions:
            intersection = max(0, min(x+w, r['x']+r['w'])-max(x,r['x'])) * max(0,min(y+h,r['y']+r['h'])-max(y,r['y']))
            if (intersection / (w*h + r['w']*r['h'] - intersection) > .6
                    or intersection / min(w*h, r['w']*r['h']) > .85):
                duplicate = True
        if not duplicate:
            regions.append({'id': str(len(regions)+1), 'name': f'Table {len(regions)+1:02}', 'x': x, 'y': y, 'w': w, 'h': h})
    regions.sort(key=lambda r: (round(r['y'] * 5), r['x']))
    for index, region in enumerate(regions[:20], 1):
        region.update(id=str(index), name=f'Table {index:02}')
    return regions[:20]


class DecisionEngine:
    def __init__(self):
        self.model = None
        self.detector = None
        self.lock = threading.Lock()

    def load_detector(self):
        if self.detector is None:
            from ultralytics import YOLO, settings
            weights = Path(__file__).parent / 'models' / 'yolo11s.pt'
            if not weights.is_file():
                weights = weights.with_name('yolo11n.pt')
            if not weights.is_file():
                raise RuntimeError('Table detector weights are missing. Run ./setup-ai.sh to download them.')
            settings.update({'sync': False})
            self.detector = YOLO(str(weights))

    def prepare(self, raw):
        # Only import the optional, heavyweight dependencies when live inference is requested.
        try:
            import torch
            from PIL import Image
            from transformers import AutoModel
        except ImportError as exc:
            raise RuntimeError('Local AI dependencies are missing. Run ./setup-ai.sh, then restart the server.') from exc
        if self.model is None:
            device = 'cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu'
            dtype = torch.float32 if device == 'cpu' else torch.bfloat16
            try:
                self.model = AutoModel.from_pretrained(
                    'LiquidAI/d1-2B', revision=MODEL_REVISION, trust_remote_code=True, dtype=dtype,
                    local_files_only=True,
                ).to(device).eval()
            except Exception as exc:
                raise RuntimeError('Cannot load cached d1-2B. Run ./setup-ai.sh to download the model, then start with .venv/bin/python server.py.') from exc
        Image.MAX_IMAGE_PIXELS = 20_000_000
        try:
            image = Image.open(io.BytesIO(raw))
            if image.width * image.height > 20_000_000:
                raise ValueError('Frame resolution is too large.')
            image = image.convert('RGB')
        except Exception as exc:
            raise ValueError('Could not decode the image.') from exc
        return torch, image

    def detect(self, raw):
        with self.lock:
            try:
                import torch
                from PIL import Image
                from ultralytics import YOLO, settings
            except ImportError as exc:
                raise RuntimeError('Local table detector is missing. Run ./setup-ai.sh, then restart the server.') from exc
            self.load_detector()
            Image.MAX_IMAGE_PIXELS = 20_000_000
            try:
                image = Image.open(io.BytesIO(raw)).convert('RGB')
                if image.width * image.height > 20_000_000:
                    raise ValueError('Frame resolution is too large.')
            except Exception as exc:
                raise ValueError('Could not decode the image.') from exc
            table_class = next((key for key, value in self.detector.names.items() if value == 'dining table'), None)
            if table_class is None:
                raise RuntimeError('This detector does not include the dining table class.')
            device = 'cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu'
            prediction = self.detector.predict(source=image, classes=[table_class], conf=.20, iou=.45,
                                               imgsz=1280, device=device, verbose=False, max_det=20)[0]
            boxes = []
            for coords in prediction.boxes.xyxyn.cpu().tolist():
                left, top, right, bottom = coords
                boxes.append({'box': {'left': left, 'top': top, 'right': right, 'bottom': bottom}})
            boxes.sort(key=lambda item: (round(item['box']['top'] * 5), item['box']['left']))
            candidates=detected_regions(boxes)
            if not candidates:
                return []
            torch,image=self.prepare(raw)
            verified=[]
            for region in candidates:
                crop=image.crop((int(region['x']*image.width),int(region['y']*image.height),
                                 int((region['x']+region['w'])*image.width),int((region['y']+region['h'])*image.height)))
                crop.thumbnail((768,768))
                with torch.inference_mode():
                    answer=self.model.system_one(None,{'visible':QUESTIONS['visible']},media=[crop])['answers']['visible']
                score=float(answer['noul'])
                if math.isfinite(score) and .75<=score<=1:
                    verified.append({**region,'table_confidence':score,'verified_by':'LiquidAI/d1-2B'})
            for index,region in enumerate(verified,1):
                region.update(id=str(index),name=f'Table {index:02}')
            return verified

    def analyze(self, raw, regions):
        with self.lock:
            torch, image = self.prepare(raw)
            self.load_detector()
            device = 'cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu'
            table_class = next(key for key, value in self.detector.names.items() if value == 'dining table')
            detections = self.detector.predict(source=image, classes=[0,table_class], conf=.20, iou=.45, imgsz=1280,
                                               device=device, verbose=False)[0].boxes
            people, table_boxes = [], []
            for coords, confidence, cls in zip(detections.xyxyn.cpu().tolist(), detections.conf.cpu().tolist(), detections.cls.cpu().tolist()):
                if int(cls)==0 and confidence>=.35:
                    people.append(coords+[confidence])
                elif int(cls)==table_class:
                    left,top,right,bottom=coords
                    table_boxes.append({'box': {'left':left,'top':top,'right':right,'bottom':bottom}})
            visible_tables=detected_regions(table_boxes)
            guests = associate_people(regions, people)
            results = []
            for r in regions:
                if table_overlap(r, visible_tables)<.25:
                    results.append({'id':r['id'], 'status':'unknown', 'confidence':0,
                                    'reason':'Mapped table is no longer visible. Hold the camera fixed and run Detect tables again.',
                                    'signals':{'table_visible':0,'guest_present':0,'surface':'unavailable','surface_confidence':0},
                                    'objects':[],'object_scores':{},'object_model':'LiquidAI/d1-2B'})
                    continue
                crop = image.crop((int(r['x'] * image.width), int(r['y'] * image.height),
                                   int((r['x'] + r['w']) * image.width), int((r['y'] + r['h']) * image.height)))
                crop.thumbnail((768, 768))
                with torch.inference_mode():
                    output = self.model.system_one(None, {**{key: QUESTIONS[key] for key in ('visible', 'state')},'objects':OBJECT_QUESTION}, media=[crop])
                    answers=output['answers']
                    answers['guest'] = {'noul': guests[r['id']]}
                try:
                    decision = apply_object_evidence(decide(answers),answers['objects'])
                except (KeyError, ValueError, TypeError) as exc:
                    raise RuntimeError('The model returned invalid decision scores.') from exc
                results.append({'id': r['id'], **decision,'inference':{'model':'LiquidAI/d1-2B',
                                'revision':MODEL_REVISION,'api':'system_one','output_tokens':output.get('usage',{}).get('output_tokens')}})
            return results


ENGINE = DecisionEngine()
STREAMS = StreamPool()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):
        # Session tokens in preview paths should not be retained in access logs.
        if urlparse(self.path).path.startswith('/api/streams/'):
            return
        super().log_message(format, *args)

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def json(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith('/api/streams/'):
            if not self.local_request():
                return
            parts = path.strip('/').split('/')
            session = STREAMS.get(parts[2]) if len(parts) == 4 and parts[3] == 'frame' else None
            if not session:
                return self.json(404, {'error': 'CCTV session expired. Connect the camera again.'})
            frame, status = session.latest()
            if not frame:
                return self.json(202, status)
            self.send_response(200)
            self.send_header('Content-Type', 'image/jpeg')
            self.send_header('Content-Length', str(len(frame)))
            self.end_headers()
            try:
                self.wfile.write(frame)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if urlparse(self.path).path == '/api/health':
            return self.json(200, {'ok': True, 'model_loaded': ENGINE.model is not None, 'model': 'LiquidAI/d1-2B'})
        return super().do_GET()

    def local_request(self):
        origin = self.headers.get('Origin')
        host = self.headers.get('Host', '')
        if host not in {f'localhost:{self.server.server_port}', f'127.0.0.1:{self.server.server_port}'}:
            self.json(403, {'error': 'Local requests only.'})
            return False
        if origin and origin not in {f'http://localhost:{self.server.server_port}', f'http://127.0.0.1:{self.server.server_port}'}:
            self.json(403, {'error': 'Cross-origin requests are not accepted.'})
            return False
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            self.json(403, {'error': 'Cross-site requests are not accepted.'})
            return False
        return True

    def do_POST(self):
        if self.path not in ('/api/analyze', '/api/detect', '/api/streams', '/api/streams/stop'):
            return self.json(404, {'error': 'Not found'})
        if not self.local_request():
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 8_000_000:
                return self.json(413, {'error': 'Request exceeds 8 MB or is empty.'})
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError('Expected an object.')
            if self.path == '/api/streams':
                session = STREAMS.create(payload.get('url'))
                return self.json(201, {'id': session.id, 'state': 'connecting'})
            if self.path == '/api/streams/stop':
                token = payload.get('id')
                if not isinstance(token, str):
                    raise ValueError('A CCTV session ID is required.')
                STREAMS.remove(token)
                return self.json(200, {'ok': True})
            started = time.monotonic()
            if self.path == '/api/detect':
                regions = ENGINE.detect(validate_frame(payload))
                return self.json(200, {'regions': regions, 'elapsed_ms': round((time.monotonic() - started) * 1000)})
            raw, regions = validate(payload)
            results = ENGINE.analyze(raw, regions)
            return self.json(200, {'results': results, 'elapsed_ms': round((time.monotonic() - started) * 1000)})
        except (ValueError, TypeError, KeyError) as exc:
            return self.json(400, {'error': str(exc)})
        except RuntimeError as exc:
            return self.json(503, {'error': str(exc)})
        except Exception:
            return self.json(500, {'error': 'Local inference failed. Check your model installation and server terminal.'})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8080)
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    def stop_server(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop_server)
    print(f'Café Watch → http://localhost:{args.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        STREAMS.close()
        server.server_close()
