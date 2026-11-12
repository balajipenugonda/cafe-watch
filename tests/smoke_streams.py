"""Real FFmpeg stream/reconnect check; use --serve for a browser fixture on :8091."""
import argparse
import io
import sys
import threading
import time
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PIL import Image
from streams import StreamPool, ffmpeg_path

buffer = io.BytesIO()
Image.open(Path(__file__).resolve().parents[1] / 'public' / 'cafe-scene.png').convert('RGB').save(buffer, format='JPEG')
JPEG = buffer.getvalue()
blank_buffer = io.BytesIO()
Image.new('RGB', (1280, 720), (140, 140, 140)).save(blank_buffer, format='JPEG')
BLANK_JPEG = blank_buffer.getvalue()
BLANK_FIRST = False
FIRST_FRAME_AT = None
UP = threading.Event()
UP.set()
HLS_ROOT = None


class Fixture(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def do_GET(self):
        global FIRST_FRAME_AT
        if HLS_ROOT and self.path.startswith('/hls/'):
            name = self.path.removeprefix('/hls/')
            if '/' in name or not (HLS_ROOT / name).is_file():
                self.send_error(404)
                return
            body = (HLS_ROOT / name).read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'application/vnd.apple.mpegurl' if name.endswith('.m3u8') else 'video/mp2t')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path != '/live.mjpg' or not UP.is_set():
            self.send_response(503)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
        self.send_header('Connection', 'close')
        self.end_headers()
        if FIRST_FRAME_AT is None:
            FIRST_FRAME_AT = time.monotonic()
        try:
            while UP.is_set():
                frame = BLANK_JPEG if BLANK_FIRST and time.monotonic() - FIRST_FRAME_AT < 10 else JPEG
                self.wfile.write(b'--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + str(len(frame)).encode() + b'\r\n\r\n' + frame + b'\r\n')
                self.wfile.flush()
                time.sleep(.25)
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = True


def wait_for(check, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(.25)
    raise AssertionError('Stream state did not change before deadline.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--blank-first', action='store_true')
    args = parser.parse_args()
    BLANK_FIRST = args.blank_first
    server = ThreadingHTTPServer(('127.0.0.1', 8091 if args.serve else 0), Fixture)
    server.daemon_threads = True
    if args.serve:
        print('Generated sample MJPEG fixture: http://127.0.0.1:8091/live.mjpg', flush=True)
        server.serve_forever()
    else:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        pool = StreamPool()
        session = pool.create(f'http://127.0.0.1:{server.server_port}/live.mjpg')
        try:
            wait_for(lambda: session.latest()[0] is not None)
            frame, _ = session.latest()
            image = Image.open(io.BytesIO(frame))
            assert image.width == 1280
            print('PASS: HTTP MJPEG feed decoded into a valid bounded preview.', flush=True)
            UP.clear()
            wait_for(lambda: session.latest()[0] is None)
            print('PASS: Dropped feed stops returning old frames.', flush=True)
            UP.set()
            wait_for(lambda: session.latest()[0] is not None)
            print('PASS: Stream reconnects with the same session.', flush=True)
            with session.lock:
                process = session.process
            pool.remove(session.id)
            assert pool.get(session.id) is None
            assert process is None or process.poll() is not None
            print('PASS: Disconnect releases the FFmpeg decoder.', flush=True)
            with tempfile.TemporaryDirectory(prefix='cafe-hls-') as folder:
                HLS_ROOT = Path(folder)
                subprocess.run([ffmpeg_path(), '-nostdin', '-hide_banner', '-loglevel', 'error',
                                '-loop', '1', '-framerate', '5', '-i', str(Path(__file__).resolve().parents[1] / 'public' / 'cafe-scene.png'),
                                '-t', '4', '-vf', 'scale=640:360', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                                '-preset', 'ultrafast', '-g', '5', '-hls_time', '1', '-hls_list_size', '0',
                                '-hls_segment_filename', str(HLS_ROOT / 'segment%d.ts'), str(HLS_ROOT / 'stream.m3u8')], check=True)
                hls = pool.create(f'http://127.0.0.1:{server.server_port}/hls/stream.m3u8')
                wait_for(lambda: hls.latest()[0] is not None)
                pool.remove(hls.id)
                print('PASS: HLS playlist and HTTP segments decode successfully.', flush=True)
        finally:
            pool.close()
            UP.clear()
            server.shutdown()
            server.server_close()
