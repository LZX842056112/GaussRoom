# iPhone LiDAR Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Each task is verified before whole-branch review.

**Goal:** Add an offline LiDAR iPhone scanner and connect its calibrated RGBD captures to the existing Windows Gaussian workbench.

**Architecture:** Native iOS capture and mesh editing remain independent of the desktop. A versioned scan package connects a restricted LAN gateway to the existing seven-stage pipeline. The shared viewer provides online mobile Gaussian browsing.

**Tech Stack:** SwiftUI / ARKit / RealityKit / Foundation; Node built-ins; Python / NumPy / Pillow / pycolmap 4.2.1.

**Spec:** `docs/superpowers/specs/2026-11-01-iphone-lidar-design.md`

## Global Constraints

- Use `docs/mobile/protocol.md` verbatim for interchange and HTTP fields.
- Preserve original scans, gate thresholds, existing projects, attempts and cumulative timing.
- No new cloud services or npm dependencies. Reuse native platform APIs.
- No commits or pushes are requested. Keep changes reviewable in the current clean `codex/reconstruction-quality` checkout.
- Windows checks do not prove iOS compilation or real LiDAR behavior.

## Review Focus

- Corrupt/hostile archives cannot create projects or escape their staging directory.
- Interrupted uploads cannot advertise bytes that were not durably accepted.
- Rotation, image scaling and nonsequential COLMAP IDs cannot corrupt camera calibration.
- Pausing/backgrounding cannot mix AR world origins or discard saved frames.
- Texture projections and WKWebView credentials must work beyond the initial request.

### Task 1: Native iPhone app

Files: create `apps/ios/` only, including source, core tests, Xcode project and build documentation.
Consumes: protocol contract. Produces: valid `.gaussroom.zip` packages, OBJ exports and the HTTP client.

- [x] Add tests for transforms, padded depth copying, crop/UV geometry, measurement and package hashing before their implementations.
- [x] Implement bounded same-frame capture, mesh snapshots, native local persistence and lifecycle recovery.
- [x] Implement on-device texture projection, model viewing, crop, measurement and ZIP exports.
- [x] Implement pairing, chunk upload/resume, job state and cookie-authorized online viewer.
- [x] Supply Xcode build and device acceptance instructions; label Windows-only checks precisely.

### Task 2: Archive validation and calibrated reconstruction

Files: create `tools/workbench/py/scan_archive.py`, `arkit_reconstruct.py`, their tests and fixtures; modify Python preparation only if required.
Consumes: protocol and existing prepare manifest. Produces: validated source scan; calibrated matching database; tracked sparse model and depth report.

- [x] Write and run failing archive, coordinate, calibration/ID and depth-layout tests.
- [x] Implement bounded ZIP validation, per-file hashes and atomic extraction.
- [x] Implement the agreed features/sparse CLIs; keep poses and intrinsics fixed, preserve actual observation tracks.
- [x] Run new tests and existing Python regressions with UTF-8 mode on Windows.

### Task 3: LAN gateway and desktop import controls

Files: create `tools/workbench/lib/mobile.mjs` and tests; own changes to `server.mjs`, `public/index.html`, `public/app.js`, `public/style.css`.
Consumes: protocol and Python archive CLI. Produces: pair/upload/project routes, local enable/revoke/import controls and lifecycle cleanup.

- [x] Write and run failing auth, ownership, resume, duplicate commit, corrupt archive and restart tests.
- [x] Implement opt-in private LAN listener, expiring pairing and device revocation.
- [x] Implement bounded raw upload and a single importer for online/offline packages.
- [x] Serve only authorized mobile projects and whitelisted viewer assets; enforce cookies for read-only web requests.
- [x] Add desktop connection/import controls without changing the loopback-only default.

### Task 4: Pipeline, shared touch controls and integration

Files: modify project/pipeline/jobs integrations; add a pure touch gesture module and shared viewer controls; update README and acceptance evidence.
Consumes: tasks 1–3 interfaces. Produces: existing seven-stage workbench processing calibrated mobile scans and phone-friendly online viewing.

- [x] Write and run failing mobile project/pipeline and gesture behavior tests.
- [x] Add backward-compatible inputKind/capture metadata and invoke agreed Python CLIs.
- [x] Preserve capture metadata across attempts and show sensor scale as unmeasured.
- [x] Add touch orbit/pan/pinch and movement buttons without changing mouse controls.
- [x] Run full Node and Python tests, synthetic calibrated RGBD fixture integration, structural Xcode checks and diff checks.
- [x] Obtain fresh code review, fix material findings and report unverified Mac/device acceptance explicitly.

## Delivery evidence

Windows source/integration delivery completed on 2026-11-02. Node: 137 passed. Python: 119 total, 6 skipped, 0 failures. Whole-change findings addressed. See `docs/validation/2026-11-02-iphone-lidar.md`. Mac compilation, XCTest and device acceptance remain explicitly pending.
