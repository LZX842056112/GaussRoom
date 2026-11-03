# GaussRoom scan protocol v1

The native app and workbench use this contract. All paths in archives are relative POSIX paths. Numbers must be finite. The archive is named `*.gaussroom.zip`.

## Files

`manifest.json` contains:

```json
{
  "format": "gaussroom_scan_v1",
  "scanId": "UUID",
  "createdAt": "ISO8601",
  "sessionId": "UUID",
  "device": {"model": "iPhone", "systemVersion": "17.0"},
  "coordinateSystem": {"handedness":"right","up":"y","units":"metres","cameraForward":"-z","matrixOrder":"column-major","imageOrientation":"sensor"},
  "frames": "frames.json",
  "mesh": "mesh.json",
  "edits": "edits.json",
  "files": [{"path":"frames.json","bytes":123,"sha256":"64 lowercase hex characters"}]
}
```

`files` lists EVERY regular archive file except `manifest.json`. Entries are unique, verified before import, and include images, depth, confidence, mesh and edits. ZIP directory entries may be omitted. Unknown format versions are rejected. The archive hash is SHA256 of the complete ZIP; it is separate from file hashes.

`frames.json` contains `{"frames":[...]}`. Each frame is:

```json
{
  "id": "f000001",
  "timestamp": 1.25,
  "image": {"path":"images/f000001.jpg","width":1920,"height":1440},
  "intrinsics": [1000,0,0,0,1000,0,960,720,1],
  "cameraToWorld": [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
  "depth": {"path":"depth/f000001.bin","width":256,"height":192,"format":"float32_le"},
  "confidence": {"path":"confidence/f000001.bin","width":256,"height":192,"format":"uint8"}
}
```

The timestamp, image, intrinsics, transform, depth and confidence come from ONE ARFrame. Timestamps increase within one session. Image pixels use the camera sensor orientation and EXIF orientation 1; display rotation does not modify stored pixels or K. Matrices are column-major. World coordinates use ARKit's right-handed, Y-up metre convention; camera forward is -Z. Depth is camera-axis depth in metres, tightly packed little-endian float32, one row after another; confidence is tightly packed uint8 (0/1/2). Invalid depth may be zero or non-finite and is excluded from geometry checks. Dimensions and byte counts MUST match. RGB and depth use the same normalized image coordinates; scale K to depth resolution when unprojecting depth.

`mesh.json` is `{"vertices":[[x,y,z]],"normals":[[x,y,z]],"faces":[[i,j,k]]}`. Vertices and normals are in world coordinates. Indices are zero-based. `edits.json` is `{"crop":null,"measurements":[]}`; crop, when present, is `{"min":[x,y,z],"max":[x,y,z]}`. Measurements contain `{"start":[x,y,z],"end":[x,y,z]}`. Edits affect mobile mesh exports, never original RGBD or desktop training input.

Desktop imports require at least two keyframes with different IDs, strictly increasing timestamps, different image paths and at least two different JPEG content hashes. Each image path must be `images/<filename>.jpg` (or `.jpeg`), directly under `images/`. Nested image directories are rejected because the existing prepare stage reads that directory nonrecursively. Short phone drafts may still be saved and exported as OBJ; full scan package export and desktop enhancement require the two-frame condition.

## Mobile HTTP API

The gateway is separate from the loopback-only workbench. It is disabled until the user enables it. Default port: 8124. Base path: `/api/mobile/v1`.

- `POST /pair` `{code,deviceName}` -> `{token,deviceId}`. Codes expire and are rate-limited. All later API calls use `Authorization: Bearer <token>`.
- `POST /session` with bearer token sets an HttpOnly SameSite=Strict cookie for read-only WKWebView assets and model requests. Mutations still require a bearer token. Tokens are never URL parameters.
- `POST /uploads` `{scanId,sha256,bytes}` -> `{id,offset,bytes,projectId?}`.
- `GET /uploads/:id` -> the same upload status. Only the owning device can access it.
- `PUT /uploads/:id` sends raw bytes with `Content-Range: bytes start-end/total`. Maximum chunk: 8 MiB. Only the persisted offset is accepted. Returns `{offset}`. Interrupted requests must not advance the persisted offset.
- `POST /uploads/:id/commit` -> `{projectId}` after complete ZIP and per-file validation. Repeating commit returns the same project. The scanId must match the package. Same scanId with different archive content returns 409.
- `GET /projects/:id` returns a sanitized summary: id, name, state, steps, progress, timing, quality, lastError, and `scene` (null or an object including `viewerUrl`). No host filesystem paths.
- `POST /projects/:id/run` `{trainingPreset:"standard"}` starts existing workbench jobs. Valid presets: fast/standard/full. An occupied job slot returns 409; no new queue.
- `GET /projects/:id/scene.ply` streams the current exported Gaussian scene. Gate and existing model validity rules still apply.

`scene.viewerUrl` is a gateway-relative URL for the shared `/viewer.html`, including the authorized scene URL and the existing home/basis/radius parameters. `/viewer.html`, its local module dependencies and vendor files are a read-only whitelist. The gateway must not proxy all workbench routes. Cookie authorization grants GET/HEAD access only.

Errors are JSON `{"error":"message"}` with the appropriate HTTP status. The server owns all storage paths. Partial uploads persist across server restarts. The desktop offline importer uses the same archive validation as HTTP commit.

## Desktop integration

Project extension: `inputKind: "photos" | "arkit_scan"` (missing means photos); `capture: {format,scanId,root,manifestSha256}` stores the validated capture root. Root is private and not exposed by the gateway. An imported capture is copied into its own project's `capture/` folder; `sourceDir` is `capture/images`.

Python entry point `scan_archive.py --archive ZIP --output NEW_DIRECTORY` validates and extracts, and prints JSON `{scanId,frameCount,imageDirectory,manifestSha256}` on success. Output must not pre-exist. Failure removes only its own partial output.

Python `arkit_reconstruct.py` has subcommands:

- `features --scan ROOT --manifest PREPARE_MANIFEST --colmap EXE --database DB --images DIR --gpu 0|1 --max-features 8192|16384`: extracts features and installs per-frame PINHOLE intrinsics in the matching database.
- `sparse --scan ROOT --manifest PREPARE_MANIFEST --database DB --images DIR --output DIR`: builds known camera poses using actual database image IDs, triangulates real matched observations and optimizes points with camera poses/intrinsics fixed. It writes COLMAP binary model `DIR/0` and `DIR/depth-report.json`.

Use prepare manifest `records[].source`, `work_image`, `work_size`, `excluded` to join source images to work images and scale each K. COLMAP camera transform is `diag(1,-1,-1,1) * inverse(cameraToWorld)`; world coordinates remain ARKit metres. Do not substitute mesh vertices for feature tracks. Depth comparison is diagnostic and cannot mark actual scale as measured. Existing gate thresholds and seven-stage lifecycle remain in force.
