# Café Watch

A local restaurant floor monitor inspired by [Roman Khrupa’s demo](https://x.com/romankhrupa/status/2119913625511137746). Open a camera or video, automatically locate dining tables, and monitor whether each table is occupied, ready, or needs cleaning.

## Run

The dashboard and simulated demo need only Python 3.9+:

```sh
python3 server.py
```

Open [localhost:8080](http://localhost:8080). For another port, use `--port 8081`.

For actual AI detection and classification:

```sh
./setup-ai.sh
.venv/bin/python server.py
```

Setup uses `uv` when installed, provisions Python 3.12, installs PyTorch, Transformers, and Ultralytics, and downloads d1-2B (approximately 4 GB) plus YOLO11s (approximately 19 MB). Without `uv`, run the script using a Python version supported by the dependencies (3.12 recommended). Subsequent server runs force Hugging Face and YOLO offline mode. CPU, Apple Metal, and CUDA devices are selected automatically. There are no API keys or hosted inference calls.

## Use

1. Choose **Connect a source**, then a webcam or local video. Grant the browser camera permission when using a webcam. The app prefers a rear-facing camera if available. Use the **Camera** dropdown below the preview to select another built-in, USB, or continuity camera. Aim it at the tables, showing whole tabletops and nearby seats. A selfie view or a close-up of only part of a desk may contain no recognizable dining tables.
2. A local YOLO11s detector looks for dining tables after the camera warms up. It checks up to ten frames and requires two matching layouts before accepting the regions and starting monitoring. d1-2B then classifies each table’s condition. The first model load takes longer than later scans.
3. Review the boxes. Use **Edit tables** to add missing regions by dragging, rename tables, or remove incorrect boxes. **Detect tables** runs detection again and replaces the layout. After manual editing, press **Done editing**, then the play button if monitoring is paused.
4. States change after two consecutive observations above the configured confidence threshold. Two uncertain or low-confidence results revoke an earlier status, including Ready. Unclear or stale tables appear as Uncertain / unscanned rather than being forced into a service state. The cleaning queue orders dirty tables by how long they have been waiting.
5. **Start cleaning → Mark ready** records staff work; after marking Ready, AI waits 15 seconds before changing it again. The activity log can be exported as CSV.

Table IDs and regions are mapped on source connection. Keep the camera fixed. Every scan rechecks that a dining table is still visible at the mapped region; if the camera moves away, the app reports uncertainty and asks you to rerun detection. Manual regions also need a recognizable table in view for automatic status decisions. The detector and editor support up to 20 regions. If no stable layout is found after ten attempts, the app explains how to adjust the view; **Detect tables** retries the search and **Edit tables** allows manual mapping. The small YOLO11n checkpoint remains a fallback for older installs, but rerunning setup installs YOLO11s. This app handles one source per browser tab, including webcams, local files, and network CCTV streams.

## Live CCTV / streaming URL

Choose **Connect a source → Connect live CCTV**, enter a camera name and its direct stream URL, then select **Connect CCTV**. Table detection begins when frames arrive; two matching observations confirm the layout before monitoring starts automatically.

Supported inputs include:

- RTSP / RTSPS: `rtsp://camera-address:554/stream`.
- Authenticated cameras: `rtsp://username:password@camera-address:554/stream`. URL-encode special characters in the username and password.
- HLS: `https://camera-address/live/index.m3u8`.
- HTTP(S) MJPEG or other FFmpeg-supported direct video feeds.

Use the stream URL supplied by your camera or recorder, rather than a camera login page, a YouTube page, or a vendor app link. This feature does not discover devices or implement ONVIF, browser sign-in, vendor cloud sessions, DRM, or WebRTC signaling. Your computer must have network access to the camera. RTSP uses TCP transport. RTSPS and HTTPS certificate trust is handled by FFmpeg; the app does not disable verification options or bypass browser warnings.

The local server uses FFmpeg to decode the stream into a 2 fps JPEG preview, with AI running at the configured scan interval. FFmpeg comes bundled through `imageio-ffmpeg` in `./setup-ai.sh`; an installed `ffmpeg` or the `FFMPEG_PATH` environment variable can also supply it. Preview traffic stays between this app and the local server. The server contacts the camera or streaming host you enter.

The URL is sent to the local server in a POST body, retained for the current session, and cleared from the form after connection. It is not saved in browser preferences, recordings, or activity logs. FFmpeg receives it as a process argument, so an operating-system user with process-inspection access may see it. Use a camera account with the access you need. The application never includes FFmpeg stderr in browser errors.

Dropped feeds display a reconnecting message and clear the table states. Only fresh frames are used for monitoring. The decoder retries with backoff and a watchdog restarts stalled reads. **Disconnect CCTV**, switching sources, or closing the tab releases the session; abandoned sessions expire after 75 seconds without preview requests. At most four CCTV sessions may run on the local server. Pausing AI keeps the preview connected.

Video playback includes a timeline and speed selection. Samples are taken at the selected interval after the previous inference completes; this is sampled monitoring rather than frame-by-frame tracking. Seeking clears prior classifications.

## Demo and actual inference

The dashboard starts offline. The optional training demo uses an AI-generated still with explicitly simulated table states. It is an interactive demonstration, not measured restaurant footage. Selecting a camera or video switches to real local model inference. If dependencies or model weights are missing, the app reports the failure and permits manual region setup; it never substitutes simulated detections for AI results.

YOLO11s proposes regions using its COCO `dining table` class; LiquidAI verifies tabletop visibility before a region is accepted (minimum 75% model score). On every scan, the d1 adapter uses the documented `system_one` API to ask three named questions together: tabletop visibility, four-way table state, and native multi-label object recognition (`type: choice`, `multiple: true`). Full-frame YOLO person detections supply nearby guest evidence. The model returns typed scores without generated text; responses include the model revision, API, and output-token count.

LiquidAI object categories include plates/bowls, cups/glasses, bottles/cans, books/papers, personal belongings, food, litter/spills, and intentional decor. The dashboard shows labels only above an 80% score. Labels describe the mapped crop; they are not individual object bounding boxes. Strong unattended-item evidence conflicting with Ready produces Uncertain for review. Objects at occupied tables do not override occupancy, and decor alone does not require cleaning. Changing sources, camera movement, stale frames, and manual staff overrides clear prior object evidence.

Unoccupied tables with unattended bottles, books, papers, dishes, food, litter, or personal belongings require clearing; intentional small decor and fixed table settings may stay. Ready requires a clear-table score of at least 80%, sufficient visibility, and no positive occupancy evidence from the full-frame person detector. These are model scores rather than measured accuracy. Unclear crops are reported as uncertain. These questions do not generate text. d1-2B is pinned to revision `652f920e544ea37f81e4b0ce89b81d4ed0da90b1`. See the [official d1 model card](https://huggingface.co/LiquidAI/d1-2B) and [Ultralytics licensing](https://www.ultralytics.com/license) for their terms, including Ultralytics AGPL-3.0 / Enterprise licensing. Reported confidence is a model score, not a measured accuracy guarantee. Verify detection and classifications on your actual room, camera angle, and lighting before relying on alerts during service.

## Privacy and storage

The server binds to `127.0.0.1` and rejects cross-origin inference and CCTV session requests. Frames are held in memory; there are no recordings, frame uploads to third parties, or saved images. For network sources, the server reads frames from the camera or streaming host you specify and serves the preview locally. Model setup requires internet access once. Preferences and the last region layout are stored in browser local storage. Activity is held in the current page’s memory and disappears on reload unless exported. Do not expose this development server to the network.

## Checks

```sh
npm test
# Optional, runs actual downloaded model on the sample café image:
.venv/bin/python tests/smoke_ai.py
# Optional eight-table generated-video regression (requires output demo assets and running server):
.venv/bin/python tests/smoke_restaurant.py
# Real FFmpeg decoding, dropped-feed recovery, and disconnect cleanup:
.venv/bin/python tests/smoke_streams.py
# Authenticated RTSP over TCP with a synthetic local camera:
.venv/bin/python tests/smoke_rtsp.py
```

The standard tests also validate native object-score responses, conflicting object/state evidence, decor handling, and stale object-evidence clearing. The real-model smoke check verifies table acceptance by LiquidAI, dishes and cups on the dirty sample table, and zero output tokens.

The standard tests cover state confirmation, confidence filtering, uncertainty invalidation, visibility gates, full-frame person association, camera movement, input validation, region bounds, and detection deduplication. The real-model sample check asserts two ready, two occupied, and one dirty table against the known sample scene. The frontend has no build step or package dependencies. The backend uses the Python standard library; AI dependencies are loaded lazily.

Live verification on 11 November 2026 also checked one physical table: clearing the tabletop produced Ready; leaving a bottle and notebooks on it produced Needs cleaning (about 90% model confidence); seating a guest beside it produced Occupied (about 90%). Moving the camera away invalidated the mapped region. These checks verify those observed cases, not a general accuracy percentage across other rooms or conditions.

## Files

- `server.py`: local HTTP API, table detection, and d1-2B classification.
- `streams.py`: in-memory CCTV sessions, FFmpeg decoding, freshness checks, reconnect, and cleanup.
- `public/`: dashboard, source capture, table editor, floor plan, and cleaning queue.
- `public/state.js`: confirmed table-state transitions.
- `setup-ai.sh`, `requirements-ai.txt`: optional local AI environment.
- `tests/`: unit checks and an optional real-model smoke check.

## Service dashboard workflow

The dashboard starts offline with zero confirmed availability. Demo is entered explicitly through **Connect a source → Explore the demo**; disconnecting CCTV never starts simulated monitoring. The health banner distinguishes offline, AI unavailable, checking, paused, stale, and live states. It displays the last successful AI response time, plus uncertain and cleaning counts. Old AI observations are invalidated after 30 seconds or three scan intervals, whichever is longer.

Cleaning tasks use **Start cleaning → Mark ready**. Cleaning is a staff-controlled workflow separate from model classification and is held until completed or the source becomes unavailable. Mark ready permits AI rechecking after 15 seconds. The latest staff action can be undone for 12 seconds; switching sources, lost feeds, and stale results revoke unsafe overrides. Activity remains session-only and can be exported as CSV.

Open a table to edit its dining area. The area selector scopes status counts, overlays, the floor plan, observations, and cleaning tasks; inference still checks all mapped tables. Table names and areas are stored in this browser per source type and source name, and transferred to matching regions when detection is rerun. One camera source is active at a time; simultaneous multi-camera monitoring is not implemented. Browser camera-device selection remains available for webcams. Do not enter credentials in camera names.

Frames are processed by the server hosting the application, which may be a restaurant server rather than the viewing device. No external AI inference API is used. These interface changes do not add staff authentication, shared cross-device task state, persistent audit storage, TLS, or production hosting; the bundled development server still binds to localhost and enforces local origins. Commercial deployment also needs the model-license review described above.

### Dashboard sizing

The dashboard uses natural card heights with normal page scrolling. The full-width camera preview keeps its 16:9 frame, with the floor plan underneath. Desktop columns stack independently to avoid empty row space; phones use a single column. Long task and observation lists can also scroll inside their cards. Fullscreen remains available for camera inspection.

### Cleaning alert sounds

In **Settings**, enable cleaning alerts, choose Soft chime, Service bell, Double beep, or Gentle reminder, and adjust the volume. **Preview sound** works even when automatic alerts are off, and its button stops a playing sound. New confirmed cleaning tasks trigger the selected sound; closely timed alerts are coalesced to avoid overlapping audio.

**Upload audio** accepts browser-decodable audio such as MP3, WAV, OGG, and M4A, up to 5 MB and 10 seconds. The file is decoded and stored in IndexedDB in the current browser; it is never uploaded to the application server. Invalid uploads leave the previous custom sound intact. **Remove custom audio** deletes it from this browser and falls back to Soft chime if selected. Tone and volume preferences also survive reload. Storage is per browser/origin, not shared between staff devices; clearing site data removes uploaded audio. Browser autoplay rules can require clicking Preview after reopening the app. Alerts require this page to remain open, audible, and permitted to play audio.
