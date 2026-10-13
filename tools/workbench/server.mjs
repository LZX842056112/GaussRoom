// Reconstruction workbench: local-only HTTP service for the browser UI.
import { createServer } from "node:http";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { resolve } from "node:path";
import { PUBLIC_DIR, PROJECTS_DIR, REPO, TOOLS, toolStatus } from "./lib/paths.mjs";
import { createRouter, readJson, sendJson, sendText, serveStatic, streamFile } from "./lib/http.mjs";
import * as projects from "./lib/projects.mjs";
import * as jobs from "./lib/jobs.mjs";
import { GATE, TRAINING_PRESETS, dirs } from "./lib/pipeline.mjs";

const router = createRouter();
const fail = (response, error) => sendJson(response, error.code ?? 500, {
  error: error.message,
  ...(error.details ? { details: error.details } : {}),
});

function diskFreeBytes() {
  try {
    const stats = statfsSync(REPO);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

router.get("/api/health", (request, response) => {
  sendJson(response, 200, {
    ok: true,
    tools: toolStatus(),
    paths: { repo: REPO, projects: PROJECTS_DIR, tools: TOOLS },
    diskFreeBytes: diskFreeBytes(),
    busyProject: jobs.busyId(),
  });
});

router.get("/api/presets", (request, response) => {
  sendJson(response, 200, { trainingPresets: TRAINING_PRESETS, gate: GATE });
});

/** Step progress lives in memory while a job runs; overlay it on the on-disk record. */
function summarise(id) {
  return projects.summarise(jobs.liveProject(id) ?? projects.read(id));
}

router.get("/api/projects", (request, response) => {
  const live = jobs.liveProjects();
  sendJson(response, 200, projects.list().map((item) => (
    live.has(item.id) ? projects.summarise(live.get(item.id)) : item
  )));
});

router.post("/api/projects", async (request, response) => {
  const body = await readJson(request);
  try {
    sendJson(response, 201, projects.summarise(projects.create(body)));
  } catch (error) {
    fail(response, error);
  }
});

router.get("/api/projects/:id", (request, response, { id }) => {
  try {
    sendJson(response, 200, summarise(id));
  } catch (error) {
    fail(response, error);
  }
});

router.patch("/api/projects/:id", async (request, response, { id }) => {
  try {
    const body = await readJson(request);
    sendJson(response, 200, projects.summarise(projects.update(id, body)));
  } catch (error) {
    fail(response, error);
  }
});

router.delete("/api/projects/:id", (request, response, { id }) => {
  try {
    if (jobs.current(id)) throw Object.assign(new Error("项目正在运行，请先中止"), { code: 409 });
    projects.remove(id);
    sendJson(response, 200, { removed: id });
  } catch (error) {
    fail(response, error);
  }
});

router.post("/api/dialog/folder", async (request, response) => {
  const body = await readJson(request);
  try {
    const chosen = await projects.pickFolder(body.title || "选择图片文件夹");
    if (!chosen) {
      response.writeHead(204).end();
      return;
    }
    sendJson(response, 200, { path: chosen, imageCount: projects.countImages(chosen) });
  } catch (error) {
    fail(response, error);
  }
});

router.post("/api/projects/:id/run", async (request, response, { id }) => {
  const body = await readJson(request);
  try {
    // Rerunning train wipes its directory; make that an explicit decision.
    if (!body.allowTrainClean) {
      const warning = jobs.trainCleanWarning(projects.read(id), body);
      if (warning) throw Object.assign(new Error(warning.message), { code: 409, details: warning });
    }
    const job = jobs.start(id, body);
    sendJson(response, 202, { jobId: job.id });
  } catch (error) {
    fail(response, error);
  }
});

router.post("/api/projects/:id/abort", async (request, response, { id }) => {
  try {
    await jobs.abort(id);
    sendJson(response, 202, { aborted: true });
  } catch (error) {
    fail(response, error);
  }
});

router.get("/api/projects/:id/events", (request, response, { id }) => jobs.attachEvents(id, request, response));

router.get("/api/projects/:id/log", (request, response, { id }, query) => {
  try {
    const raw = Number(query.get("tail") ?? 65536);
    const tail = Number.isFinite(raw)
      ? Math.min(Math.max(Math.trunc(raw), 1024), 4 * 1024 * 1024)
      : 65536;
    const { text } = jobs.readStepLog(id, query.get("step") ?? undefined, tail);
    sendText(response, 200, text);
  } catch (error) {
    fail(response, error);
  }
});

router.get("/api/projects/:id/summary", (request, response, { id }) => {
  try {
    const project = projects.read(id);
    const folder = dirs(project).summary;
    const readOrNull = (name) => {
      const path = resolve(folder, name);
      if (!existsSync(path)) return null;
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return null;
      }
    };
    sendJson(response, 200, {
      gate: readOrNull("gate.json"),
      modelSummary: readOrNull("model-summary.json"),
      manifest: (() => {
        const path = resolve(dirs(project).root, "manifest.json");
        if (!existsSync(path)) return null;
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        const { records, ...rest } = manifest;
        return rest;
      })(),
    });
  } catch (error) {
    fail(response, error);
  }
});

router.get("/api/projects/:id/scene", (request, response, { id }) => {
  try {
    const project = projects.read(id);
    const scene = projects.latestExport(project);
    sendJson(response, 200, scene ? { ...scene, url: `/api/projects/${id}/scene.ply` } : null);
  } catch (error) {
    fail(response, error);
  }
});

function sceneFile(request, response, { id }, query) {
  try {
    const project = projects.read(id);
    const scene = projects.latestExport(project);
    if (!scene) throw Object.assign(new Error("尚未导出任何场景"), { code: 404 });
    streamFile(response, scene.path, {
      head: request.method === "HEAD",
      download: query?.get("download") === "1",
    });
  } catch (error) {
    fail(response, error);
  }
}

router.get("/api/projects/:id/scene.ply", sceneFile);

const server = createServer(async (request, response) => {
  // Every request path is wrapped: a malformed URI used to throw out of the
  // async handler and take the whole process down with an unhandled rejection.
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const method = request.method === "HEAD" ? "GET" : request.method;
    const hit = router.match(method, url.pathname);
    if (hit) {
      await hit.handler(request, response, hit.params, url.searchParams);
      return;
    }
    serveStatic(request, response, url.pathname, PUBLIC_DIR);
  } catch (error) {
    if (!response.headersSent) fail(response, error);
    else response.destroy();
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("[workbench] 未处理的 Promise 拒绝：", reason?.message ?? reason);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[workbench] 收到 ${signal}，正在终止子进程…`);
  try {
    await jobs.killAll();
  } catch (error) {
    console.error(`[workbench] 终止子进程失败：${error.message}`);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { shutdown(signal); });
}

const orphans = await jobs.cleanupOrphans();
if (orphans.length) {
  console.log(`[workbench] 已清理 ${orphans.length} 个遗留子进程：${orphans.map((o) => `${o.id}#${o.pid}`).join("、")}`);
}
const reconciled = projects.reconcile();
if (reconciled.length) {
  console.log(`[workbench] 已对账 ${reconciled.length} 个被中断的项目：${reconciled.join("、")}`);
}

let port = Number(process.env.PORT ?? process.argv[2] ?? 8123);
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    port += 1;
    server.listen(port, "127.0.0.1");
    return;
  }
  throw error;
});
server.listen(port, "127.0.0.1", () => {
  console.log(`workbench: http://127.0.0.1:${port}/`);
  console.log(`projects : ${PROJECTS_DIR}`);
});
