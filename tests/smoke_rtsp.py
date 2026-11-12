"""Real RTSP-over-TCP/authentication smoke check using a local synthetic camera."""
import base64
import re
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from streams import StreamPool, ffmpeg_path


def wait_for(check, timeout=30):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        result = check()
        if result:
            return result
        time.sleep(.1)
    raise AssertionError('RTSP fixture timed out.')


if __name__ == '__main__':
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.bind(('127.0.0.1', 0))
    udp.settimeout(.5)
    stop = threading.Event()
    pool = StreamPool()
    publisher = None
    log = None
    with tempfile.TemporaryDirectory(prefix='cafe-rtsp-') as directory:
        sdp_file = Path(directory) / 'camera.sdp'
        class RTSP(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.settimeout(.5)
                data = b''
                send_lock = threading.Lock()
                playing = threading.Event()

                def forward():
                    while not stop.is_set() and playing.is_set():
                        try:
                            packet = udp.recv(65535)
                            with send_lock:
                                self.request.sendall(b'$\x00' + struct.pack('!H', len(packet)) + packet)
                        except socket.timeout:
                            continue
                        except OSError:
                            break

                try:
                    while not stop.is_set():
                        try:
                            chunk = self.request.recv(65536)
                        except socket.timeout:
                            continue
                        if not chunk:
                            break
                        data += chunk
                        while data:
                            if data[0:1] == b'$':
                                if len(data) < 4:
                                    break
                                length = int.from_bytes(data[2:4], 'big')
                                if len(data) < length + 4:
                                    break
                                data = data[length+4:]
                                continue
                            if b'\r\n\r\n' not in data:
                                break
                            head, data = data.split(b'\r\n\r\n', 1)
                            lines = head.decode().split('\r\n')
                            method = lines[0].split()[0]
                            headers = dict(line.split(': ', 1) for line in lines[1:] if ': ' in line)
                            seq = headers.get('CSeq', '1')
                            body = b''
                            extra = 'Session: cafe-test\r\n'
                            status = '200 OK'
                            expected = 'Basic ' + base64.b64encode(b'fixture:example').decode()
                            if method != 'OPTIONS' and headers.get('Authorization') != expected:
                                status = '401 Unauthorized'
                                extra = 'WWW-Authenticate: Basic realm="cafe-test"\r\n'
                            elif method == 'OPTIONS':
                                extra += 'Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER\r\n'
                            elif method == 'DESCRIBE':
                                sdp = re.sub(r'm=video \d+', 'm=video 0', sdp_file.read_text())
                                body = (sdp + '\r\na=control:trackID=0\r\n').encode()
                                extra += f'Content-Type: application/sdp\r\nContent-Base: rtsp://127.0.0.1:{server.server_address[1]}/camera/\r\n'
                            elif method == 'SETUP':
                                extra += 'Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n'
                            elif method == 'PLAY':
                                extra += 'Range: npt=0.000-\r\n'
                            with send_lock:
                                self.request.sendall(f'RTSP/1.0 {status}\r\nCSeq: {seq}\r\n{extra}Content-Length: {len(body)}\r\n\r\n'.encode() + body)
                            if method == 'PLAY' and status == '200 OK' and not playing.is_set():
                                playing.set()
                                threading.Thread(target=forward, daemon=True).start()
                except (OSError, ValueError):
                    pass
                finally:
                    playing.clear()

        server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), RTSP)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            publisher = subprocess.Popen([
                ffmpeg_path(), '-nostdin', '-hide_banner', '-loglevel', 'error', '-re',
                '-loop', '1', '-framerate', '5', '-i', str(Path(__file__).resolve().parents[1] / 'public' / 'cafe-scene.png'),
                '-vf', 'scale=640:360', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '5',
                '-x264-params', 'repeat-headers=1', '-sdp_file', str(sdp_file),
                '-f', 'rtp', f'rtp://127.0.0.1:{udp.getsockname()[1]}?pkt_size=1200',
            ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            wait_for(lambda: sdp_file.is_file() and sdp_file.stat().st_size)
            log = open(Path(directory) / 'decoder.log', 'wb')
            original_popen = subprocess.Popen
            def logged_popen(*args, **kwargs):
                kwargs['stderr'] = log
                return original_popen(*args, **kwargs)
            with patch('streams.subprocess.Popen', side_effect=logged_popen):
                session = pool.create(f'rtsp://fixture:example@127.0.0.1:{server.server_address[1]}/camera')
                try:
                    frame = wait_for(lambda: session.latest()[0])
                except AssertionError:
                    log.flush()
                    print((Path(directory) / 'decoder.log').read_text().replace('fixture:example', 'fixture:REDACTED'), flush=True)
                    raise
            assert frame.startswith(b'\xff\xd8') and frame.endswith(b'\xff\xd9')
            print('PASS: Authenticated RTSP over TCP decoded into live JPEG preview.', flush=True)
        finally:
            pool.close()
            if log:
                log.close()
            stop.set()
            if publisher:
                publisher.terminate()
                publisher.wait(timeout=5)
            udp.close()
            server.shutdown()
            server.server_close()
