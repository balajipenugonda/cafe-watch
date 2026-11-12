"""In-memory CCTV sessions; FFmpeg decodes streams into bounded JPEG previews."""
import atexit
import os
import secrets
import shutil
import subprocess
import threading
import time
from urllib.parse import urlsplit

ALLOWED_PROTOCOLS = 'rtsp,rtsps,http,https,tcp,tls,udp,rtp,crypto,httpproxy'


def validate_url(value):
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise ValueError('Enter a camera stream URL (up to 4096 characters).')
    if any(ord(c) <= 32 or ord(c) == 127 for c in value) or '\\' in value:
        raise ValueError('Encode spaces and special characters in the stream URL.')
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {'rtsp', 'rtsps', 'http', 'https'} or not parsed.hostname or parsed.fragment:
            raise ValueError()
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError()
    except ValueError:
        raise ValueError('Use an rtsp://, rtsps://, http://, or https:// stream URL with a valid host and port.') from None
    return value


def ffmpeg_path():
    executable = os.environ.get('FFMPEG_PATH') or shutil.which('ffmpeg')
    if executable:
        return executable
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError):
        raise RuntimeError('FFmpeg is missing. Run ./setup-ai.sh and restart with .venv/bin/python server.py.') from None


def decoder_command(executable, url):
    validate_url(url)
    scheme = urlsplit(url).scheme
    args = [executable, '-nostdin', '-hide_banner', '-loglevel', 'error',
            '-protocol_whitelist', ALLOWED_PROTOCOLS]
    if scheme in {'rtsp', 'rtsps'}:
        args += ['-rtsp_transport', 'tcp', '-timeout', '10000000']
    else:
        args += ['-rw_timeout', '10000000']
    if scheme in {'https', 'rtsps'}:
        args += ['-tls_verify', '1']
    # Pace file-like HTTP sources as well as genuinely live sources.
    args += ['-re', '-i', url, '-map', '0:v:0', '-an', '-sn', '-dn',
             '-vf', 'fps=2,scale=1280:-2', '-threads', '2', '-c:v', 'mjpeg',
             '-q:v', '5', '-f', 'image2pipe', 'pipe:1']
    return args


class JPEGBuffer:
    def __init__(self):
        self.buffer = bytearray()

    def feed(self, chunk):
        self.buffer.extend(chunk)
        if len(self.buffer) > 8_000_000:
            raise ValueError('Decoded frame exceeds size limit.')
        frames = []
        while True:
            start = self.buffer.find(b'\xff\xd8')
            if start < 0:
                self.buffer[:] = self.buffer[-1:]
                break
            if start:
                del self.buffer[:start]
            end = self.buffer.find(b'\xff\xd9', 2)
            if end < 0:
                break
            frames.append(bytes(self.buffer[:end+2]))
            del self.buffer[:end+2]
        return frames


class CameraStream:
    def __init__(self, url, executable):
        self.id = secrets.token_urlsafe(24)
        self._url = validate_url(url)
        self._executable = executable
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.process = None
        self.frame = None
        self.frame_time = 0
        self.process_started = 0
        self.last_access = time.monotonic()
        self.state = 'connecting'
        self.attempts = 0
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        delay = 1
        while not self.stop_event.is_set():
            with self.lock:
                self.state = 'connecting' if not self.attempts else 'reconnecting'
                self.attempts += 1
            process = None
            try:
                process = subprocess.Popen(decoder_command(self._executable, self._url),
                                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                           stderr=subprocess.DEVNULL, bufsize=0)
                with self.lock:
                    self.process = process
                    self.process_started = time.monotonic()
                decoder = JPEGBuffer()
                while not self.stop_event.is_set():
                    chunk = process.stdout.read(65536)
                    if not chunk:
                        break
                    for frame in decoder.feed(chunk):
                        with self.lock:
                            self.frame = frame
                            self.frame_time = time.monotonic()
                            self.state = 'live'
                        delay = 1
            except (OSError, ValueError):
                pass  # Never expose FFmpeg output or the credential-bearing URL.
            finally:
                if process:
                    self._terminate(process)
                    process.stdout.close()
                with self.lock:
                    self.process = None
                    self.state = 'stopped' if self.stop_event.is_set() else 'reconnecting'
            if self.stop_event.wait(delay):
                break
            delay = min(delay * 2, 15)
        self._url = None

    @staticmethod
    def _terminate(process):
        if process.poll() is None:
            try:
                process.terminate()
            except ProcessLookupError:
                return
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)

    def latest(self):
        now = time.monotonic()
        with self.lock:
            self.last_access = now
            if self.state == 'live' and self.frame and now - self.frame_time < 5:
                return self.frame, {'state': 'live'}
            return None, {'state': 'reconnecting' if self.attempts > 1 or self.frame else 'connecting',
                          'message': 'Waiting for video. Check the URL, credentials, camera network, and stream availability. Retrying automatically.'}

    def watchdog(self):
        with self.lock:
            process = self.process
            stalled = process and time.monotonic() - max(self.process_started, self.frame_time) > 20
        if stalled:
            self._terminate(process)

    def close(self):
        self.stop_event.set()
        with self.lock:
            process = self.process
            self.frame = None
            self.state = 'stopped'
        if process:
            self._terminate(process)


class StreamPool:
    def __init__(self):
        self.sessions = {}
        self.lock = threading.Lock()
        self.closing = threading.Event()
        threading.Thread(target=self._reap, daemon=True).start()
        atexit.register(self.close)

    def create(self, url):
        url = validate_url(url)
        executable = ffmpeg_path()
        with self.lock:
            if len(self.sessions) >= 4:
                raise RuntimeError('Four CCTV sources are already connected. Disconnect one or close its tab and wait 75 seconds.')
            stream = CameraStream(url, executable)
            self.sessions[stream.id] = stream
            return stream

    def get(self, token):
        with self.lock:
            return self.sessions.get(token)

    def remove(self, token):
        with self.lock:
            stream = self.sessions.pop(token, None)
        if stream:
            stream.close()

    def _reap(self):
        while not self.closing.wait(1):
            with self.lock:
                streams = list(self.sessions.values())
            for stream in streams:
                if time.monotonic() - stream.last_access > 75:
                    self.remove(stream.id)
                else:
                    stream.watchdog()

    def close(self):
        self.closing.set()
        with self.lock:
            tokens = list(self.sessions)
        for token in tokens:
            self.remove(token)
