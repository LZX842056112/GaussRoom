# Local Position Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Continue inline in the existing checkout, as previously authorized. No Git commit or push is authorized.

**Goal:** Let any project retain the complete area that needs position repair, use measured shared pixels to recover local poses, and continue only after final geometric checks.

**Architecture:** Extend the existing versioned assistance record with an optional local repair selection. The server freezes photo IDs and prior verified connection checks; it supplies all paths. A generic native reconstruction and bundle adjustment module reconstructs the selected area with reference views, validates computed manual anchors, preserves outside poses, and checks every repaired photo and the prior connections. Scope IDs, landmark IDs and optional feature exclusion geometry are input data, never project-specific code.

**Tech Stack:** Existing Node HTTP service, browser modules, NumPy, OpenCV, pycolmap and local COLMAP. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-20-assisted-reconstruction-design.md`, plus the concrete decisions below. This is a continuation of the already requested generic position assistance and actual room acceptance, not a separate project.

## Global Constraints

- Keep original photos, old models, raw matching databases and failed attempts.
- Preserve all four camera groups and SIMPLE_RADIAL models for the real dataset.
- Keep the seven workbench steps and explicit save/run separation.
- Use only actual observed pixels. Computed projections may exclude features but cannot supply observations.
- Keep 8 physical points, 2 views per side, 1 degree parallax, 4 pixel error and spatial spread thresholds.
- No adoption based solely on registration count, average error, a directory name, or candidate initialization.
- Do not train a candidate until every geometric check passes. Inspect actual matched-checkpoint renders before replacing the existing model.

## Design Decisions

- `localRepair` is optional and defaults to null for old records.
- It contains `photoIds` for the complete area, `referencePhotoIds` for unchanged camera references, optional `contextPhotoIds` for automatic reconstruction context, optional `refineCornerIds`, and optional four-landmark polygons whose interiors are excluded from automatic feature tracking.
- Local repair must explicitly cover the whole affected area; the annotation photo selection remains a view control, separate from this persisted scope.
- Reject unknown IDs, duplicates, intersecting repair/reference sets, client filesystem paths, unsupported rigs and missing measured support.
- Select local landmarks by actual observations in the repair photos. Reference poses and manual point XYZ are computed from measured pixels; the user supplies neither camera XYZ nor room dimensions.
- First validate a small bundle of measured anchors: manual observations and server-detected features inside explicitly selected common regions. Keep client submissions manual-only. Use accepted anchor poses and shared points to constrain the full local bundle; background native tracks enter later.
- Check every target with at least eight submitted shared points, and every target with a cross-region ROI, at initialization and after final track cleanup. Valid older targets cannot hide an unsupported new target. Deduplicate detected physical pixels before counting support.
- Reconstruct source poses from copied matches. Align the initial coordinate gauge through identical float32 pixels in outside images. Preserve outside poses and untouched points. Native bundle adjustment and final track filtering supply the result, not a copied prototype.
- A common object with search regions in at least two target and two reference photos can make input ready for real feature collection. Ready does not mean verified. Client-detected observations remain forbidden.
- Complementary frozen native candidates may initialize a new repair through the existing native model merger. Require complete target/reference coverage and unchanged source signatures. Preserve failed merge outputs. Recompute every anchor, target, camera, prior and final geometry check after a merge.
- Native coverage also requires at least eight actual 3D point observations for every required image. Prefer supported candidate pairs over a larger weak cache. A weak merge may try the reverse direction once; preserve both outputs and recompute all final checks. A weak complete cache must not suppress fresh mapping.
- Preserve prior verified bridge checks in a server-owned request. Also check the local boundary, all participating camera groups and actual support for every target photo.
- The actual 12-photo preview failed appearance review. Visual inspection found 61 bathroom photos (49 in camera-01 and 12 in camera-04). This is acceptance data only. Product code cannot contain these names, counts or time ranges.

## Task 1: Generic Geometry Module

- [x] Add failing synthetic geometry tests: corrupt connected local poses, recover with independent measured seed poses, retain original model/database hashes, preserve outside poses, reject seven-point support, denied facts and duplicate physical pixels.
- [x] Implement focused helpers in `tools/workbench/py/assisted_local_repair.py`: scope validation, bounded image-corner refinement, measured manual anchors, native local bundle and strict final checks.
- [x] Add native regression with unrelated photo/project names. No raw projected pixels may appear in the resulting observations.

## Task 2: Versioned Record and Server Job

- [x] Add failing record/API tests for scope persistence, compatibility, invalid IDs and stale revisions.
- [x] Extend `lib/assistance.mjs` validation and record defaults. Preserve the selection through imports, retries and geometry rebasing.
- [x] Compile only server-owned source paths and prior verified bridge checks in `lib/assistance-service.mjs`.
- [x] Route explicit local repair through the existing sparse job in `py/assisted_reconstruct.py`. Keep normal global reconstruction unchanged.
- [x] Verify failed/stale repairs preserve the active export; successful repair still passes the normal gate and adoption protocol.

## Task 3: Scope Selection UI

- [x] Add failing browser tests for adding/removing repair and reference photos, saving/reloading the complete scope and preserving dirty annotations.
- [x] Add clear controls in `public/assistance.js`. Keep panning and source-pixel coordinate behavior intact.
- [x] Show the full scope count and that marked correspondence photos are only part of it. Keep optional advanced corner/exclusion choices separate from basic selection.

## Task 4: Actual Acceptance and Review

- [x] Run appropriate complete regressions and a fresh read-only review of this new major local repair path only.
- [x] Replay the real measured input and the visually checked complete scope through the formal API in a new preserved attempt; do not import a diagnostic final model as success.
- [x] Compare identical evaluation photos, reference bytes, seed, settings and checkpoint schedule. Inspect door joins, bathroom fixtures, wall ghosts and proportions. Full result inspected; overall appearance failed.
- [x] Run the authorized full 30000-step schedule in the preserved independent project and inspect its final output. The ledger records the decision to inspect the corrected formal geometry at the full schedule; this does not count as visual acceptance.
- [ ] Update records with actual receipts and any remaining limitations. Keep absolute scale unmeasured. Do not claim completion while bathroom appearance is unresolved.

## Verification Focus

- Scope must include later and other-camera photos, not just directly marked photos.
- A small manual-only solve is an initializer, not final acceptance.
- New local geometry must not lose the previously verified global room connection.
- Count actual fixed outside observers when retaining boundary tracks. One or two target observations may form a valid track with multiple outside observations; a target-only view count must not discard those constraints. Final connection thresholds remain unchanged.
- Mask projections must never become fabricated feature observations.
- Any answer change, source change or unsupported target photo must prevent adoption.
