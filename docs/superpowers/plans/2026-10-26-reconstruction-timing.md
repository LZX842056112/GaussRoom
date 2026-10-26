# Reconstruction Timing Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this small change. Steps use checkbox syntax for tracking.

**Goal:** Show total model creation time and the time spent in each of the seven existing stages.

**Architecture:** Persist accumulated stage execution time. The total is the sum of stage times, including retries and sparse calibration. Exclude pauses and time waiting for user input. Update the visible running timer each second without rebuilding the viewer.

**Tech Stack:** Existing Node.js service, browser JavaScript, Node test runner.

**Spec:** The user request in this conversation. Implementation choices: use cumulative processing time; preserve existing API fields; mark incomplete historical timing; do not start reconstruction or change source photos.

## Global Constraints

- Keep the current seven stages and existing reconstruction behavior.
- Retain recorded time across retries and parameter changes.
- Missing historical timing must not be presented as zero seconds.
- Freeze stopped timers. Do not count server downtime after interrupted jobs.
- Use the existing checkout and dependencies. Do not commit or push without a new request.

## Review Focus

- Old successful stages can lack timestamps or overwritten retry history.
- Waiting for manual input can last hours or days.
- Failure or cancellation can happen during setup or verification.
- Server restart must stop timers at the last saved activity.
- A timer tick must not reload the model or lose unsaved annotations.

### Task 1: Record and expose stage timing

**Files:** Create `tools/workbench/lib/timing.mjs` and `tools/workbench/test_timing.mjs`; modify `lib/projects.mjs`, `lib/jobs.mjs`, `lib/assistance-import.mjs` and the related regression tests.

**Interfaces:** `stepTiming(step, now)` and `projectTiming(project, now)` return elapsed milliseconds, completeness and running state. `beginStepTiming`, `endStepTiming` and `preserveStepTiming` maintain the persisted accumulator.

- [x] Write API tests for running, stopped and incomplete historical timings. Run them and confirm failure.
- [x] Add accumulation and lifecycle handling. Add tests for retry, parameter reset, interruption and waiting.
- [x] Run targeted timing and job tests. Confirm success.

### Task 2: Display total and stage timing

**Files:** Create `tools/workbench/public/timing.mjs`; modify `public/app.js`, `public/index.html`, `public/style.css` and `README.md`.

**Interfaces:** `elapsedTiming(timing, now)` calculates a live display value from a server sample. `formatDuration(ms)` formats seconds, minutes and hours. The page updates only duration text on its one-second interval.

- [x] Add failing display tests for elapsed, missing and long durations.
- [x] Display total timing in the progress card and stage timing below each stage state. Explain cumulative timing and historical limits.
- [x] Verify the browser display, including waiting and switching projects. Run the complete workbench regression and static UI check.

## Validation

- Node regression: 117 passed, 0 failed, 0 skipped (`runs/timing-20261026/regression/node-final.log`).
- Native Python regression: 105 passed, 0 failed, 0 skipped (`runs/timing-20261026/regression/python.log`).
- Static UI check: all 56 referenced HTML IDs exist.
- Browser check uses a read-only fixture server. Its running and waiting projects do not create files in the project store or start reconstruction.
- Input snapshot preparation is included in the first executing stage. This makes the visible timer start with the job.
- Adding photos retains existing stage accumulators and available legacy timestamps while resetting step statuses.
