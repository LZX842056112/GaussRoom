# Universal Mobile Photo Reconstruction Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Keep tasks separate and validate the complete request flow.

**Goal:** Let iPhone Safari and Android Chrome upload ordinary photos and use the Windows Gaussian workbench without a native app or Mac.

**Architecture:** A small public mobile page pairs with the existing opt-in gateway. A durable owner-scoped photo batch creates a normal photo project. The existing seven-stage pipeline, job slot and touch viewer remain the processing and viewing path.

**Tech Stack:** Node built-ins, browser file controls/Fetch/localStorage, existing Python/Pillow/ffmpeg.

**Spec:** The user-approved plan in chat and `docs/mobile/photos-protocol.md`.

## Global Constraints

- Preserve all current uncommitted LiDAR work. Reuse codex/reconstruction-quality; no commits, pushes, cloud deployment or worktree changes.
- No additional npm or Python runtime dependencies. No getUserMedia, video extraction or browser-side 3D reconstruction.
- Limits: 64 MiB/file, 500 files, 4 GiB/batch; at least 2 different decodable photos with long edge >=1000 pixels.
- Mutations require bearer authorization after awaits. Browser artifacts cannot prove real iPhone/Android acceptance.

## Review Focus

- Revocation during upload, validation or commit prevents further mutations.
- A forced termination cannot publish a half-created photo project or delete unrelated files.
- A renamed, corrupt or HEIC image is validated by content and decoded safely.
- Browser reload cannot lose uploaded files, mix partial files or silently reuse a wrong local image.
- Viewer and progress authorization remains valid for ordinary photos and existing LiDAR clients.

### Task 1: Durable photo sessions

Files: new `tools/workbench/lib/photo-sessions.mjs` and `tools/workbench/test_mobile_photos.mjs` only.
Consumes: photos-protocol.md; injected validators, store and authorization callbacks.
Produces: createPhotoSessions service, API handling, project recovery/ownership, targeted HTTP tests.

- [x] Write behavioral RED tests for ownership, upload/retry, size/count, duplicates, commit idempotence, crash recovery and revoke-after-await.
- [x] Implement bounded streamed files, atomic metadata, dedicated ready directory and safe recovery journal.
- [x] Create normal photo projects using allocated IDs and source-images; keep user originals and old models.
- [x] Validate targeted tests and report evidence.

### Task 2: Photo validation

Files: new `tools/workbench/py/validate_photo.py`, `test_validate_photo.py`, small licensed fixture if needed.
Consumes: validator CLI defined in photos-protocol.md and existing ffmpeg configuration.
Produces: PhotoInfo and honest format capabilities.

- [x] Write RED tests for valid JPEG/PNG/EXIF, corrupt/truncated content, suffix mismatch, low resolution, oversize and unsupported HEIC.
- [x] Fully decode images while preserving originals; hash streamed bytes and limit pixels/size.
- [x] Probe HEIC decoding honestly using actual supported input; document any fixture provenance.
- [x] Run targeted Python tests and CLI checks.

### Task 3: Shared mobile webpage

Files: new `tools/workbench/public/mobile/` and `tools/workbench/test_mobile_web.mjs` only.
Consumes: exact DTOs/API in photos-protocol.md. Produces: no-build HTML/CSS/JS and pure state helpers.

- [x] Test state/progress/retry/reload parsing behavior before implementation.
- [x] Build pair, capture/select, bounded thumbnails, sequential upload and retry/remove controls.
- [x] Restore token/batch; reselect only remaining photos; use server hashes for duplicates.
- [x] Commit then explicitly run, poll timing/quality, and open cookie-authenticated viewer.
- [x] Verify frontend behavior and report browser/device limits.

### Task 4: Gateway integration and acceptance

Files: existing mobile gateway, desktop connection UI, docs; integration tests.
Consumes: tasks 1–3; produces actual photo route integration and shared project access.

- [x] Add real image validator bridge and capabilities; allow only four public mobile assets.
- [x] Extend ownership for photo projects and expose generic phone page URL in desktop controls.
- [x] Test public entry, actual image -> project -> normal pipeline selection, revoked request boundaries and LiDAR compatibility.
- [x] Run full Node/Python suites, browser checks and review; publish evidence and pending real-device tests.
