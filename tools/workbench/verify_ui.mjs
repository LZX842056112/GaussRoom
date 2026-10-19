/**
 * Browser-automation acceptance for the workbench UI.
 *
 * Drives the already-running local service with Playwright (reused from the npx
 * cache — nothing is installed and the zero-dependency project stays clean) and
 * clicks every interactive control, asserting the observable effect of each.
 *
 * Safety: destructive cases run only against a project this script creates and
 * deletes. The two existing demo projects are only ever read.
 *
 * Usage:  node tools/workbench/verify_ui.mjs
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const BASE = process.env.WORKBENCH_URL ?? "http://127.0.0.1:8123";
const REPO = resolve(import.meta.dirname, "..", "..");
const TEMP_SOURCE = resolve(REPO, "runs", "wb-selftest", "src12");

/**
 * The self-test needs a folder of real photos: create() rejects a missing path or
 * one holding fewer than two images, and the run/abort cases need prepare to run
 * long enough to interrupt. They are generated with the project's own Pillow, so
 * nothing is downloaded, and they live under runs/ (gitignored) so the repository
 * stays clean. Earlier revisions leaned on a leftover directory that has since been
 * cleaned up, which silently broke every case that creates a project.
 */
function ensureFixture() {
  const present = readdirSafe(TEMP_SOURCE).filter((name) => name.toLowerCase().endsWith(".jpg")).length;
  if (present >= 12) return;
  mkdirSync(TEMP_SOURCE, { recursive: true });
  const python = resolve(REPO, ".venv", "Scripts", "python.exe");
  if (!existsSync(python)) throw new Error(`缺少 Python 环境：${python}（先跑 uv sync）`);
  const script = `
from PIL import Image
from pathlib import Path

out = Path(r"${TEMP_SOURCE}")
for i in range(12):
    img = Image.linear_gradient("L").rotate(i * 3).resize((1024, 768))
    img.convert("RGB").save(out / ("%02d.jpg" % (i + 1)), quality=85)
`;
  execFileSync(python, ["-c", script], { stdio: "ignore" });
}

function readdirSafe(folder) {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  const cache = resolve(process.env.LOCALAPPDATA ?? "", "npm-cache", "_npx");
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache)) {
      candidates.push(resolve(cache, dir, "node_modules", "playwright"));
    }
  }
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try { return require(path); } catch { /* try the next candidate */ }
  }
  throw new Error("未在 npx 缓存中找到 playwright");
}

/**
 * Playwright's headless mode prefers `chromium_headless_shell-<rev>`, which is not
 * installed here. Fall back to the full chromium build that is present.
 */
function resolveExecutable(chromium) {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH;
  }
  try {
    const fromPlaywright = chromium.executablePath();
    if (fromPlaywright && existsSync(fromPlaywright)) return fromPlaywright;
  } catch { /* fall through to scanning */ }

  const root = resolve(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  if (!existsSync(root)) return undefined;
  const revisions = readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const name of revisions) {
    const exe = resolve(root, name, "chrome-win64", "chrome.exe");
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

// ---------------------------------------------------------------- assertions

const results = [];
let currentCase = null;

async function test(id, name, fn, skipReason = null) {
  if (skipReason) {
    results.push({ id, name, ok: true, skipped: true });
    console.log(`  – ${id}  ${name}（跳过：${skipReason}）`);
    return;
  }
  currentCase = { id, name };
  try {
    await fn();
    results.push({ id, name, ok: true });
    console.log(`  ✓ ${id}  ${name}`);
  } catch (error) {
    results.push({ id, name, ok: false, error: error.message });
    console.log(`  ✗ ${id}  ${name}\n        ${error.message}`);
  } finally {
    currentCase = null;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- HTTP helpers

async function apiJson(method, path, body) {
  const response = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { status: response.status, body: payload };
}

const apiGet = (path) => apiJson("GET", path);

async function projectIds() {
  const { body } = await apiGet("/api/projects");
  return body.map((project) => project.id).sort();
}

// ---------------------------------------------------------------- entry point

const { chromium } = loadPlaywright();
const baselineIds = await projectIds();
// The scene-dependent cases need any project that already has an export; which one
// is irrelevant, and hardcoding an id breaks as soon as the user deletes it.
const allProjects = (await apiGet("/api/projects")).body;
const demoProject = allProjects.find((project) => project.scene) ?? null;
const DEMO_ID = demoProject?.id ?? null;
const baselineDemo = demoProject ? (await apiGet(`/api/projects/${DEMO_ID}`)).body : null;

console.log(`workbench: ${BASE}`);
console.log(`baseline projects: ${baselineIds.join(", ")}`);
console.log(`demo project (has scene): ${DEMO_ID ?? "（无，相关用例将跳过）"}`);
ensureFixture();
console.log(`temp source: ${TEMP_SOURCE}（${readdirSafe(TEMP_SOURCE).length} 个文件）\n`);

const executablePath = resolveExecutable(chromium);
const browser = await chromium.launch({ headless: true, executablePath });
console.log(`chromium: ${browser.version()}`);
console.log(`executable: ${executablePath}\n`);

const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

let dialogAction = "accept";
let lastDialog = null;
page.on("dialog", async (dialog) => {
  lastDialog = dialog.message();
  try {
    await (dialogAction === "accept" ? dialog.accept() : dialog.dismiss());
  } catch { /* already handled */ }
});

// Match the PLY pathname only: viewer.html also has scene.ply in its query.
await page.route((url) => url.pathname.endsWith("/scene.ply"), (route) => {
  const url = route.request().url();
  if (url.includes("download=1")) {
    return route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="export_10000.ply"',
      },
      body: "ply\nformat ascii 1.0\nelement vertex 0\nend_header\n",
    });
  }
  return route.fulfill({
    status: 200,
    headers: { "Content-Type": "application/octet-stream" },
    body: "ply\nformat ascii 1.0\nelement vertex 0\nend_header\n",
  });
});

const $ = (selector) => page.locator(selector);
const textOf = async (selector) => (await $(selector).textContent()) ?? "";

async function bootWorkbench() {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  // Ready means boot() finished loading /api/presets, which is what re-enables
  // #newProject. Waiting for a sidebar row instead breaks when no project exists.
  await page.waitForFunction(() => !document.getElementById("newProject").disabled, null, { timeout: 15000 });
}

async function busyProject() {
  return (await apiGet("/api/health")).body.busyProject;
}

console.log("=== 工作台页 ===");
await bootWorkbench();

let tempId = null;

await test("W1", "#newProject 打开新建表单并渲染 3 张档位卡", async () => {
  await $("#newProject").click();
  assert(await $("#formView").isVisible(), "表单未显示");
  assertEqual(await page.locator("#presetList .preset").count(), 3, "档位卡数量");
});

await test("W2", "presets 接口失败后按钮仍可用，再点一次自愈", async () => {
  await page.route("**/api/presets", (route) => route.abort());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#newProject");
  assert(!(await $("#newProject").isDisabled()), "按钮不应被禁用");
  await page.unroute("**/api/presets");
  await $("#newProject").click();
  await page.waitForSelector("#presetList .preset");
  assertEqual(await page.locator("#presetList .preset").count(), 3, "懒加载后档位卡数量");
});

await test("W8", "表单内点第 2 张档位卡切换选中", async () => {
  const cards = page.locator("#presetList .preset");
  await cards.nth(1).click();
  assert(await cards.nth(1).evaluate((el) => el.classList.contains("selected")), "第 2 张未选中");
  assert(!(await cards.nth(0).evaluate((el) => el.classList.contains("selected"))), "第 1 张仍选中");
});

await test("W3", "#pickFolder 用户取消（204）", async () => {
  await page.route("**/api/dialog/folder", (route) => route.fulfill({ status: 204 }));
  await $("#pickFolder").click();
  await page.waitForFunction(() => document.getElementById("sourceHint").textContent.includes("已取消"));
  assert((await $("#formSource").inputValue()) === "", "取消后不应写入路径");
  await page.unroute("**/api/dialog/folder");
});

await test("W4", "#pickFolder 返回路径（200）", async () => {
  await page.route("**/api/dialog/folder", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ path: TEMP_SOURCE, imageCount: 12 }),
  }));
  await $("#pickFolder").click();
  await page.waitForFunction((expected) => document.getElementById("formSource").value === expected, TEMP_SOURCE);
  assert((await textOf("#sourceHint")).includes("12"), "提示未显示图片数");
  await page.unroute("**/api/dialog/folder");
});

await test("W5", "#createProject 未选档位时报错", async () => {
  // 重新进入表单以清空档位选择
  await $("#cancelCreate").click();
  await $("#newProject").click();
  await page.waitForSelector("#presetList .preset");
  await $("#formName").fill("V 临时项目");
  await $("#formSource").fill(TEMP_SOURCE);
  await $("#createProject").click();
  assertEqual((await textOf("#formError")).trim(), "请选择训练档位", "错误提示");
});

await test("W6", "#createProject 名称为空时报错", async () => {
  await page.locator("#presetList .preset").first().click();
  await $("#formName").fill("");
  await $("#createProject").click();
  await page.waitForFunction(() => document.getElementById("formError").textContent.includes("项目名称"));
});

await test("W7", "#createProject 正常创建并自动打开", async () => {
  await $("#formName").fill("V 临时项目");
  await $("#createProject").click();
  await page.waitForSelector("#projectView:not(.hidden)", { timeout: 15000 });
  assertEqual((await textOf("#projectName")).trim(), "V 临时项目", "项目名");
  const ids = await projectIds();
  assertEqual(ids.length, baselineIds.length + 1, "项目总数");
  tempId = ids.find((id) => !baselineIds.includes(id));
  assert(tempId, "未找到新建的项目 id");
  const activeId = await page.locator("#projectList li.active").getAttribute("data-id");
  assertEqual(activeId, tempId, "侧栏高亮");
  const created = await apiGet(`/api/projects/${tempId}`);
  assertEqual(created.body.mapper, "incremental", "重建方式默认值");
  assert((await textOf("#projectMeta")).includes("重建方式 增量式"), "项目页未显示重建方式");
});

await test("W10", "侧栏点击切换项目时高亮跟随", async () => {
  // Needs a second project besides the temporary one to switch to.
  const otherId = baselineIds.find((id) => id !== tempId);
  if (!otherId) {
    console.log("        （基线里只有一个项目，改用临时项目自身验证高亮）");
  }
  const target = otherId ?? tempId;
  await $(`#projectList li[data-id="${target}"]`).click();
  await page.waitForFunction((id) => document.querySelector("#projectList li.active")?.dataset.id === id, target);
  if (otherId) {
    await $(`#projectList li[data-id="${tempId}"]`).click();
    await page.waitForFunction((id) => document.querySelector("#projectList li.active")?.dataset.id === id, tempId);
  }
  const active = await page.locator("#projectList li.active").count();
  assertEqual(active, 1, "active 项数量");
});

await test("W15", "#logStep 下拉有 7 个步骤且可切换", async () => {
  assertEqual(await page.locator("#logStep option").count(), 7, "步骤选项数");
  await $("#logStep").selectOption("gate");
  assertEqual(await $("#logStep").inputValue(), "gate", "选中值");
});

await test("W16", "#loadLog 载入所选步骤日志", async () => {
  await $("#loadLog").click();
  await page.waitForFunction(() => document.getElementById("log").textContent.trim().length > 0, null, { timeout: 8000 });
});

await test("W17", "#pauseScroll 勾选后保持勾选状态", async () => {
  await $("#pauseScroll").check();
  assert(await $("#pauseScroll").isChecked(), "复选框未勾选");
  await $("#pauseScroll").uncheck();
});

await test("W11", "#editToggle 展开编辑面板", async () => {
  await $(`#projectList li[data-id="${tempId}"]`).click();
  await page.waitForFunction((id) => document.querySelector("#projectList li.active")?.dataset.id === id, tempId);
  await $("#editToggle").click();
  assert(await $("#editPanel").isVisible(), "编辑面板未显示");
  assertEqual(await $("#editName").inputValue(), "V 临时项目", "编辑框初值");
});

await test("W13", "#saveEdit 名称为空时报错", async () => {
  await $("#editName").fill("");
  await $("#saveEdit").click();
  await page.waitForFunction(() => document.getElementById("editError").textContent.trim().length > 0, null, { timeout: 8000 });
});

await test("W14", "#cancelEdit 取消后名称不变", async () => {
  await $("#editName").fill("不应保存的名字");
  await $("#cancelEdit").click();
  assert(!(await $("#editPanel").isVisible()), "编辑面板未收起");
  assertEqual((await textOf("#projectName")).trim(), "V 临时项目", "项目名");
});

await test("W12", "#saveEdit 改名成功并同步侧栏", async () => {
  await $("#editToggle").click();
  await $("#editName").fill("V 临时项目（已改名）");
  await $("#saveEdit").click();
  await page.waitForFunction(() => document.getElementById("projectName").textContent.trim() === "V 临时项目（已改名）", null, { timeout: 8000 });
  const { body } = await apiGet(`/api/projects/${tempId}`);
  assertEqual(body.name, "V 临时项目（已改名）", "服务端名称");
  await page.waitForFunction((id) => document.querySelector(`#projectList li[data-id="${id}"] .name`)?.textContent.trim() === "V 临时项目（已改名）", tempId);
});

await test("W18", "#downloadScene 触发下载且文件名正确", async () => {
  await $(`#projectList li[data-id="${DEMO_ID}"]`).click();
  await page.waitForFunction(() => !document.getElementById("viewerCard").classList.contains("hidden"), null, { timeout: 8000 });
  const [download] = await Promise.all([
    page.waitForEvent("download", {
      timeout: 10000,
      predicate: (download) => new URL(download.url()).pathname === `/api/projects/${DEMO_ID}/scene.ply`,
    }),
    $("#downloadScene").click(),
  ]);
  assert(/^export_\d+\.ply$/.test(download.suggestedFilename()), `文件名异常: ${download.suggestedFilename()}`);
}, DEMO_ID ? null : "没有带场景的项目");

await test("W19", "#reloadScene 重新设置 iframe 地址", async () => {
  const before = await $("#viewer").getAttribute("src");
  await $("#reloadScene").click();
  await page.waitForFunction((old) => document.getElementById("viewer").getAttribute("src") !== old, before);
  const after = await $("#viewer").getAttribute("src");
  assert(after.includes("t="), "新地址缺少防缓存参数");
}, DEMO_ID ? null : "没有带场景的项目");

await test("W26", "漫游 iframe 携带由重建数据推导的默认机位", async () => {
  const src = await $("#viewer").getAttribute("src");
  const match = /[?&]home=([^&]+)/.exec(src);
  assert(match, `iframe 地址缺少 home 参数: ${src}`);
  const values = match[1].split(",").map(Number);
  assertEqual(values.length, 5, "home 参数个数");
  assert(values.every(Number.isFinite), `home 参数含非数字: ${match[1]}`);
  const [x, y, z, yaw] = values;
  // 默认高度必须接近相机轨迹高度（此项目约 0），不能是旧硬编码的 1.5 m。
  assert(Math.abs(y) < 0.5, `默认高度 ${y} 不合理`);
  // 旧硬编码默认是 (0, 1.5, 0, 0, 0)，只要有一项不同就说明来自重建数据。
  // 注意 yaw 可以合法地接近 0（轨迹主轴恰好对齐参考轴），不能只用它判断。
  const LEGACY = [0, 1.5, 0, 0, 0];
  assert(values.some((value, index) => Math.abs(value - LEGACY[index]) > 1e-3),
    `home 参数与旧硬编码默认一致: ${match[1]}`);
  assert(x !== undefined && z !== undefined, "位置分量缺失");
}, DEMO_ID ? null : "没有带场景的项目");

await test("W27", "漫游 iframe 携带把重建坐标转正的基（正交且为纯旋转）", async () => {
  const src = await $("#viewer").getAttribute("src");
  const match = /[?&]basis=([^&]+)/.exec(src);
  assert(match, `iframe 地址缺少 basis 参数: ${src}`);
  const values = match[1].split(",").map(Number);
  assertEqual(values.length, 9, "basis 参数个数");
  assert(values.every(Number.isFinite), `basis 参数含非数字: ${match[1]}`);

  const rows = [values.slice(0, 3), values.slice(3, 6), values.slice(6, 9)];
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  for (const [index, row] of rows.entries()) {
    assert(Math.abs(Math.sqrt(dot(row, row)) - 1) < 1e-3, `e${"xyz"[index]} 不是单位向量`);
  }
  for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
    assert(Math.abs(dot(rows[i], rows[j])) < 1e-3, `e${i} 与 e${j} 不正交`);
  }
  // 行列式必须是 +1：-1 意味着镜像，会把场景左右翻转。
  const [a, b, c] = rows[0];
  const [d, e, f] = rows[1];
  const [g, h, i] = rows[2];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  assert(Math.abs(det - 1) < 1e-3, `不是纯旋转（行列式 ${det.toFixed(4)}）`);

  // 第二行是重建坐标系里的「上」方向；矩阵必须把它映射到 +Y，
  // 即 M·e_y = (0,1,0)。这里直接验算，确认上下颠倒确实被纠正。
  const mapped = [0, 1, 2].map((axis) => dot(rows[axis], rows[1]));
  assert(Math.abs(mapped[0]) < 1e-3 && Math.abs(mapped[1] - 1) < 1e-3 && Math.abs(mapped[2]) < 1e-3,
    `e_y 未被映射到 +Y: ${mapped.map((v) => v.toFixed(3)).join(",")}`);
}, DEMO_ID ? null : "没有带场景的项目");

await test("W30", "漫游 iframe 携带相机轨迹尺度（radius，用于缩放上限）", async () => {
  const src = await $("#viewer").getAttribute("src");
  const match = /[?&]radius=([^&]+)/.exec(src);
  assert(match, `iframe 地址缺少 radius 参数: ${src}`);
  const value = Number(match[1]);
  assert(Number.isFinite(value) && value > 0, `radius 不是正数: ${match[1]}`);
}, DEMO_ID ? null : "没有带场景的项目");

await test("W20", "#runButton 启动作业并显示中止按钮", async () => {
  await $(`#projectList li[data-id="${tempId}"]`).click();
  await page.waitForFunction((id) => document.querySelector("#projectList li.active")?.dataset.id === id, tempId);
  await $("#runButton").click();
  await page.waitForFunction(() => !document.getElementById("abortButton").classList.contains("hidden"), null, { timeout: 10000 });
  assertEqual(await busyProject(), tempId, "后台活动作业");
});

await test("W21", "运行中档位卡片为禁用态且点击无效", async () => {
  const cards = page.locator("#presetListProject .preset");
  assertEqual(await cards.count(), 3, "档位卡数量");
  const disabled = await cards.nth(0).evaluate((el) => el.classList.contains("disabled"));
  assert(disabled, "卡片缺少 disabled 类");
  assertEqual(await cards.nth(0).getAttribute("aria-disabled"), "true", "aria-disabled");
  const selectedBefore = await page.locator("#presetListProject .preset.selected").getAttribute("data-key");
  await cards.nth(1).click({ force: true });
  const selectedAfter = await page.locator("#presetListProject .preset.selected").getAttribute("data-key");
  assertEqual(selectedAfter, selectedBefore, "运行中不应切换档位");
});

await test("W22", "#abortButton 中止作业", async () => {
  await $("#abortButton").click();
  await page.waitForFunction(() => document.getElementById("abortButton").classList.contains("hidden"), null, { timeout: 15000 });
  assertEqual(await busyProject(), null, "应无活动作业");
});

await test("W24", "步骤「重试此步」取消后不产生新作业", async () => {
  dialogAction = "dismiss";
  lastDialog = null;
  await page.locator("#stepList button.retry").first().click();
  await page.waitForFunction(() => true);
  await page.waitForTimeout(500);
  assert(lastDialog && lastDialog.includes("重新开始"), `未捕获确认框: ${lastDialog}`);
  assertEqual(await busyProject(), null, "取消后不应启动作业");
  dialogAction = "accept";
});

await test("W23", "#abortButton 非运行时隐藏（409 场景由 API 层覆盖）", async () => {
  assert(await $("#abortButton").isHidden(), "非运行时中止按钮应隐藏");
});

await test("W9", "#cancelCreate 返回项目视图", async () => {
  await $("#newProject").click();
  await page.waitForSelector("#formView:not(.hidden)");
  await $("#cancelCreate").click();
  assert(await $("#formView").isHidden(), "表单未收起");
  assert(await $("#projectView").isVisible(), "未回到项目视图");
});

await test("W25", "#deleteButton 删除临时项目并回到基线", async () => {
  await $(`#projectList li[data-id="${tempId}"]`).click();
  await page.waitForFunction((id) => document.querySelector("#projectList li.active")?.dataset.id === id, tempId);
  dialogAction = "accept";
  await $("#deleteButton").click();
  await page.waitForFunction((expected) => document.querySelectorAll("#projectList li").length === expected, baselineIds.length, { timeout: 15000 });
  const ids = await projectIds();
  assertEqual(JSON.stringify(ids), JSON.stringify(baselineIds), "项目集合未回到基线");
});

await test("W28", "#formMapper 选全局式：落盘并在项目页显示", async () => {
  await $("#newProject").click();
  await page.waitForSelector("#formView:not(.hidden)");
  // Re-opening the form clears state.formPreset and state.sourcePath (the latter is
  // mirrored into #formSource by renderForm), so both have to be set again here.
  await page.locator("#presetList .preset").nth(0).click();
  await $("#formSource").fill(TEMP_SOURCE);
  await $("#formName").fill("V 全局式项目");
  await $("#formMapper").selectOption("global");
  await $("#formFeatures").selectOption("enhanced");
  assertEqual(await $("#formMapper").inputValue(), "global", "下拉选中值");
  await $("#createProject").click();
  await page.waitForSelector("#projectView:not(.hidden)", { timeout: 15000 });
  const ids = await projectIds();
  const globalId = ids.find((id) => !baselineIds.includes(id));
  assert(globalId, "未找到新建的项目 id");
  assertEqual((await apiGet(`/api/projects/${globalId}`)).body.mapper, "global", "mapper 落盘");
  assertEqual((await apiGet(`/api/projects/${globalId}`)).body.featurePreset, "enhanced", "增强特征档位落盘");
  assert((await textOf("#projectMeta")).includes("重建方式 全局式"), "项目页未显示重建方式");
  await $("#editToggle").click();
  assertEqual(await $("#editFeatures").inputValue(), "enhanced", "编辑面板特征档位");
  await $("#editFeatures").selectOption("standard");
  await $("#saveEdit").click();
  await page.waitForFunction(() => document.getElementById("editPanel").classList.contains("hidden"));
  assertEqual((await apiGet(`/api/projects/${globalId}`)).body.featurePreset, "standard", "保存标准特征档位");
  dialogAction = "accept";
  await $("#deleteButton").click();
  await page.waitForFunction(
    (expected) => document.querySelectorAll("#projectList li").length === expected,
    baselineIds.length,
    { timeout: 15000 },
  );
});

await test("W29", "接口层拒绝非法的重建方式", async () => {
  const { status, body } = await apiJson("POST", "/api/projects", {
    name: "V 非法 mapper",
    sourceDir: TEMP_SOURCE,
    trainingPreset: "fast",
    mapper: "nope",
  });
  assertEqual(status, 400, "HTTP 状态");
  assertEqual(body?.error, "未知重建方式：nope", "错误文案");
  assertEqual((await projectIds()).length, baselineIds.length, "不应留下项目");
});

// ---------------------------------------------------------------- viewer page

console.log("\n=== 漫游页（鼠标控制）===");

// The viewer page needs a project that actually has an export.
let viewer = null;
let canvasBox = null;
const readState = () => viewer.evaluate(() => ({
  yaw: window.__viewerDebug.yaw,
  pitch: window.__viewerDebug.pitch,
  fov: window.__viewerDebug.fov,
  distance: window.__viewerDebug.distance,
  target: window.__viewerDebug.target,
  sceneRadius: window.__viewerDebug.sceneRadius,
  maxDistance: window.__viewerDebug.maxDistance,
  position: window.__viewerDebug.position,
}));

if (DEMO_ID) {
  const viewerUrl = `${BASE}/viewer.html?scene=/api/projects/${DEMO_ID}/scene.ply&debug=1`;
  viewer = await context.newPage();
  viewer.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
  await viewer.goto(viewerUrl, { waitUntil: "domcontentloaded" });
  await viewer.waitForFunction(() => Boolean(window.__viewerDebug), null, { timeout: 15000 });
  // #loading (z-index 3) covers the HUD (z-index 2); hide it so the controls are clickable.
  await viewer.evaluate(() => { document.getElementById("loading").style.display = "none"; });
  canvasBox = await viewer.locator("canvas").boundingBox();
}
const drag = async (button, dx, dy) => {
  await viewer.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  await viewer.mouse.down({ button });
  await viewer.mouse.move(
    canvasBox.x + canvasBox.width / 2 + dx,
    canvasBox.y + canvasBox.height / 2 + dy,
    { steps: 8 },
  );
  await viewer.mouse.up({ button });
  await viewer.waitForTimeout(120);
};

const distanceMoved = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));

await test("V2", "左键拖动平移：位置与支点一起移动，角度和距离不变", async () => {
  const before = await readState();
  await drag("left", 120, 60);
  const after = await readState();
  assert(distanceMoved(after.position, before.position) > 0.01,
    `位置未变化: ${before.position} -> ${after.position}`);
  assert(JSON.stringify(after.target) !== JSON.stringify(before.target), "支点应随平移移动");
  assertEqual(after.yaw, before.yaw, "yaw 不应变化");
  assertEqual(after.pitch, before.pitch, "pitch 不应变化");
  assertEqual(after.distance, before.distance, "distance 不应变化");
}, DEMO_ID ? null : "没有带场景的项目");

await test("V3", "右键拖动 360° 旋转：yaw 与 pitch 同时改变，绕支点转", async () => {
  const before = await readState();
  await drag("right", 60, 100);
  const after = await readState();
  assert(Math.abs(after.yaw - before.yaw) > 0.05, `yaw 未变化: ${before.yaw} -> ${after.yaw}`);
  assert(Math.abs(after.pitch - before.pitch) > 0.05, `pitch 未变化: ${before.pitch} -> ${after.pitch}`);
  assertEqual(JSON.stringify(after.target), JSON.stringify(before.target), "支点不应移动");
  assertEqual(after.distance, before.distance, "distance 不应变化");
}, DEMO_ID ? null : "没有带场景的项目");

await test("V4", "滚轮缩放 distance，夹紧于 [0.1, maxDistance]，上限足以看见整体", async () => {
  const before = await readState();
  await viewer.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  await viewer.mouse.wheel(0, -120);
  const zoomedIn = await readState();
  assert(zoomedIn.distance < before.distance, `滚轮向前应拉近: ${before.distance} -> ${zoomedIn.distance}`);
  for (let i = 0; i < 60; i += 1) await viewer.mouse.wheel(0, -120);
  assertEqual((await readState()).distance, 0.1, "拉近下限");
  for (let i = 0; i < 120; i += 1) await viewer.mouse.wheel(0, 120);
  const far = await readState();
  assertEqual(far.distance, far.maxDistance, "拉远上限");
  assert(far.distance > far.sceneRadius,
    `拉远上限 ${far.distance} 未超过场景半径 ${far.sceneRadius}，缩到最小仍看不到整体`);
}, DEMO_ID ? null : "没有带场景的项目");

await test("V5", "右键不再弹出浏览器菜单（contextmenu 被阻止）", async () => {
  const prevented = await viewer.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    canvas.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert(prevented, "contextmenu 未被 preventDefault");
}, DEMO_ID ? null : "没有带场景的项目");

await test("V6", "右键左右可转满 360°（yaw 不夹紧），上下夹紧在 ±1.5", async () => {
  await viewer.locator("#reset").click();
  await viewer.waitForTimeout(150);
  const start = await readState();
  const spun = 6 * 400 * 0.004;   // 6 次 × 400 px × 灵敏度
  for (let i = 0; i < 6; i += 1) await drag("right", 400, 0);
  const afterYaw = await readState();
  assert(Math.abs(afterYaw.yaw - (start.yaw - spun)) < 1e-3,
    `yaw 应线性累加: ${afterYaw.yaw} vs ${start.yaw - spun}`);
  assert(Math.abs(afterYaw.yaw) > Math.PI * 2, `yaw 应超过一整圈: ${afterYaw.yaw}`);

  for (let i = 0; i < 4; i += 1) await drag("right", 0, 300);
  assertEqual((await readState()).pitch, -1.5, "俯仰下限");
  for (let i = 0; i < 8; i += 1) await drag("right", 0, -300);
  assertEqual((await readState()).pitch, 1.5, "俯仰上限");
}, DEMO_ID ? null : "没有带场景的项目");

await test("V1", "#reset 复位 yaw / pitch / fov / distance / 位置", async () => {
  await drag("left", 90, 40);
  await viewer.mouse.wheel(0, -120);
  await viewer.locator("#reset").click();
  await viewer.waitForTimeout(150);
  const state = await readState();
  assertEqual(state.yaw, 0, "yaw");
  assertEqual(state.pitch, 0, "pitch");
  assertEqual(state.fov, 65, "fov");
  assertEqual(state.distance, 2, "distance");
  assertEqual(JSON.stringify(state.position), JSON.stringify([0, 1.5, 0]), "position");
}, DEMO_ID ? null : "没有带场景的项目");

if (viewer) await viewer.close();

// V8: the ?basis= parameter must rotate the scene into the upright frame.
await test("V8", "?basis= 生效：场景被旋转，使重建的「上」对齐 +Y", async () => {
  const basis = [-1, 0, 0, 0, -1, 0, 0, 0, 1];
  const target = `${BASE}/viewer.html?scene=/api/projects/${DEMO_ID}/scene.ply&debug=1&basis=${basis.join(",")}`;
  const pageWithBasis = await context.newPage();
  await pageWithBasis.goto(target, { waitUntil: "domcontentloaded" });
  await pageWithBasis.waitForFunction(() => Boolean(window.__viewerDebug), null, { timeout: 15000 });
  const quaternion = await pageWithBasis.evaluate(() => window.__viewerDebug.sceneQuaternion);
  await pageWithBasis.close();
  const [x, y, z, w] = quaternion;
  // diag(-1,-1,1) 对应绕 Z 轴 180°，四元数为 (0,0,±1,0)。
  assert(Math.abs(w) < 1e-3, `四元数实部应为 0（180° 旋转）: ${quaternion.join(",")}`);
  assert(Math.abs(x) < 1e-3 && Math.abs(y) < 1e-3, `旋转轴应为 Z 轴: ${quaternion.join(",")}`);
  assert(Math.abs(Math.abs(z) - 1) < 1e-3, `旋转轴应为 Z 轴: ${quaternion.join(",")}`);
}, DEMO_ID ? null : "没有带场景的项目");

// V7: the ?home= parameter must actually drive the initial pose.
await test("V7", "?home= 参数生效：reset 回到传入的机位", async () => {
  const pose = [1.25, 0.4, -0.75, 2.1, 0.15];
  const target = `${BASE}/viewer.html?scene=/api/projects/${DEMO_ID}/scene.ply&debug=1&home=${pose.join(",")}`;
  const pageWithHome = await context.newPage();
  await pageWithHome.goto(target, { waitUntil: "domcontentloaded" });
  await pageWithHome.waitForFunction(() => Boolean(window.__viewerDebug), null, { timeout: 15000 });
  await pageWithHome.evaluate(() => { document.getElementById("loading").style.display = "none"; });
  await pageWithHome.locator("#reset").click();
  await pageWithHome.waitForTimeout(150);
  const state = await pageWithHome.evaluate(() => ({
    yaw: window.__viewerDebug.yaw,
    pitch: window.__viewerDebug.pitch,
    fov: window.__viewerDebug.fov,
    position: window.__viewerDebug.position,
  }));
  await pageWithHome.close();
  assertEqual(state.yaw, pose[3], "yaw");
  assertEqual(state.pitch, pose[4], "pitch");
  assertEqual(state.fov, 65, "fov");
  assertEqual(
    JSON.stringify(state.position.map((v) => Number(v.toFixed(4)))),
    JSON.stringify(pose.slice(0, 3)),
    "position",
  );
}, DEMO_ID ? null : "没有带场景的项目");

// V9: the ?radius= parameter (camera-trajectory scale) must drive the zoom-out cap.
await test("V9", "?radius= 生效：缩放上限 = max(3×半径, 20)", async () => {
  const target = `${BASE}/viewer.html?scene=/api/projects/${DEMO_ID}/scene.ply&debug=1&radius=12`;
  const pageWithRadius = await context.newPage();
  await pageWithRadius.goto(target, { waitUntil: "domcontentloaded" });
  await pageWithRadius.waitForFunction(() => Boolean(window.__viewerDebug), null, { timeout: 15000 });
  const state = await pageWithRadius.evaluate(() => ({
    sceneRadius: window.__viewerDebug.sceneRadius,
    maxDistance: window.__viewerDebug.maxDistance,
  }));
  await pageWithRadius.close();
  assertEqual(state.sceneRadius, 12, "sceneRadius");
  assertEqual(state.maxDistance, 36, "maxDistance");
}, DEMO_ID ? null : "没有带场景的项目");
await context.close();
await browser.close();

// ---------------------------------------------------------------- summary

const failed = results.filter((item) => !item.ok);

console.log("\n=== 收尾断言 ===");
const finalIds = await projectIds();
const checks = [
  ["项目集合回到基线", JSON.stringify(finalIds) === JSON.stringify(baselineIds)],
  ["无残留作业", (await busyProject()) === null],
];
if (demoProject) {
  const finalDemo = (await apiGet(`/api/projects/${DEMO_ID}`)).body;
  checks.splice(1, 0, ["演示项目状态未变", finalDemo.state === baselineDemo.state && finalDemo.name === baselineDemo.name]);
}
for (const [label, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${label}`);

const skipped = results.filter((item) => item.skipped).length;
console.log(`\n=== 结果：${results.length - failed.length - skipped}/${results.length - skipped} 通过，${skipped} 跳过 ===`);
if (failed.length) {
  for (const item of failed) console.log(`  ✗ ${item.id} ${item.name}: ${item.error}`);
}
process.exit(failed.length || checks.some(([, ok]) => !ok) ? 1 : 0);
