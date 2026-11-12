import unittest
from unittest.mock import patch
from streams import JPEGBuffer, decoder_command, validate_url, CameraStream


class StreamTests(unittest.TestCase):
    def test_allowed_urls_include_credentials_ipv6_and_hls(self):
        for url in ['rtsp://user:p%40ss@192.168.1.10:554/live', 'rtsps://camera.local/live',
                    'https://camera.local/live.m3u8?token=example', 'http://[::1]:9000/live']:
            self.assertEqual(validate_url(url), url)

    def test_rejects_files_commands_and_bad_ports_without_echoing_credentials(self):
        for url in ['file:///etc/passwd', 'concat:http://a|file:///etc/passwd', '-i test',
                    'http://host:99999/live', 'http:///live', 'rtsp://user:secret@host/live\n',
                    'http://host/live#fragment', None, 42]:
            with self.assertRaises(ValueError) as caught:
                validate_url(url)
            self.assertNotIn('secret', str(caught.exception))

    def test_rtsp_uses_tcp_and_all_inputs_restrict_nested_protocols(self):
        cmd = decoder_command('/ffmpeg', 'rtsp://camera.local/live')
        self.assertEqual(cmd[cmd.index('-rtsp_transport')+1], 'tcp')
        self.assertIn('-timeout', cmd)
        self.assertNotIn('-rw_timeout', cmd)
        self.assertNotIn('file', cmd[cmd.index('-protocol_whitelist')+1].split(','))
        self.assertEqual(cmd[cmd.index('-i')+1], 'rtsp://camera.local/live')
        self.assertNotIn('-rtsp_transport', decoder_command('/ffmpeg', 'https://camera/live.m3u8'))
        self.assertIn('-rw_timeout', decoder_command('/ffmpeg', 'https://camera/live.m3u8'))
        self.assertIn('-tls_verify', decoder_command('/ffmpeg', 'rtsps://camera/live'))

    def test_jpeg_parser_handles_split_markers_noise_and_multiple_frames(self):
        decoder = JPEGBuffer()
        self.assertEqual(decoder.feed(b'noise\xff'), [])
        self.assertEqual(decoder.feed(b'\xd8one\xff'), [])
        self.assertEqual(decoder.feed(b'\xd9\xff\xd8two\xff\xd9'), [b'\xff\xd8one\xff\xd9', b'\xff\xd8two\xff\xd9'])

    def test_jpeg_buffer_is_bounded(self):
        with self.assertRaises(ValueError): JPEGBuffer().feed(b'x' * 8_000_001)

    def test_stale_frame_is_never_returned_as_live(self):
        with patch.object(CameraStream, '_run'):
            stream = CameraStream('rtsp://camera/live', '/ffmpeg')
            stream.thread.join()
        stream.state = 'live'
        stream.frame = b'jpeg'
        stream.frame_time = 1
        with patch('streams.time.monotonic', return_value=10):
            frame, state = stream.latest()
        self.assertIsNone(frame)
        self.assertEqual(state['state'], 'reconnecting')
        stream.close()
