import {mountAssistance} from './assistance.js';
import {timingLabel} from './timing.mjs';
const state = {
  view: "empty",
  projects: [],
  project: null,
  presets: null,
  formPreset: null,
  projectPreset: null,
  sourcePath: "",
  eventSource: null,
  pauseScroll: false,
  logStep: null,
  logStepPicked: false,
  editing: false,
  historyScene:null,
};

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
));
const formatBytes = (bytes) => {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const PROJECT_STATE = {
  idle: "未开始", running: "运行中", aborting: "正在中止", done: "模型已生成",
  failed: "失败", aborted: "已中止", partial: "部分完成",needs_input:"等待用户补充",
};
const STEP_STATE = {
  pending: "待运行", running: "运行中", success: "完成",
  failed: "失败", aborted: "已中止", blocked: "已阻断",needs_input:"等待用户补充",
};

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  if (response.status === 204) return null;
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(payload?.error ?? `请求失败（${response.status}）`);
    error.status = response.status;
    error.details = payload?.details ?? null;
    throw error;
  }
  return payload;
}
const assistance=mountAssistance($("assistancePanel"),{api,onProjectChange:async()=>{
 const id=state.project.id,project=await api(`/api/projects/${id}`);if(state.project?.id!==id)return;state.project=project;renderProject();await refreshEvidence();
},onSceneChange:scene=>{state.historyScene=scene;renderProject();}});

function show(view) {
  state.view = view;
  $("emptyView").classList.toggle("hidden", view !== "empty");
  $("formView").classList.toggle("hidden", view !== "form");
  $("projectView").classList.toggle("hidden", view !== "project");
}

async function loadHealth() {
  const health = await api("/api/health");
  const labels = {
    python: "Python", colmapGpu: "COLMAP(GPU)", colmapCpu: "COLMAP(CPU)",
    brush: "Brush", ffmpeg: "ffmpeg", pycolmap: "pycolmap", opencv: "OpenCV",
  };
  $("health").innerHTML = Object.entries(labels).map(([key, label]) => {
    const ok = health.tools[key];
    const details=health.dependencyDetails?.[key];
    return `<span class="chip ${ok ? "ok" : "bad"}" title="${escapeHtml(details?`${details.message}；${details.repair}`:label)}">${label} ${ok ? "就绪" : "缺失"}</span>`;
  }).join("") + (health.diskFreeBytes != null
    ? `<span class="chip ${health.diskFreeBytes < 20e9 ? "bad" : "ok"}">可用磁盘 ${formatBytes(health.diskFreeBytes)}</span>`
    : "");
}

let lastListSignature = "";
let lastPresetSig = "";

async function loadProjects() {
  const projects = await api("/api/projects");
  // The active id decides the `active` class, so it must be part of the signature.
  const signature = JSON.stringify([state.project?.id ?? "",
    projects.map((p) => [p.id, p.name, p.state, p.scene?.step ?? 0, p.progress.toFixed(2)])]);
  state.projects = projects;
  // Only rebuild the sidebar when something visible actually changed.
  if (signature === lastListSignature) return;
  lastListSignature = signature;

  const list = $("projectList");
  list.innerHTML = projects.map((project) => `
    <li data-id="${project.id}" class="${state.project?.id === project.id ? "active" : ""}">
      <div class="name">${escapeHtml(project.name)}</div>
      <div class="meta">
        <span class="badge ${project.state}">${PROJECT_STATE[project.state] ?? project.state}</span>
        ${project.scene ? ` · export_${project.scene.step}` : ""}
      </div>
    </li>`).join("");
  $("listEmpty").classList.toggle("hidden", projects.length > 0);
  for (const item of list.querySelectorAll("li")) {
    item.onclick = () => openProject(item.dataset.id);
  }
}

function presetCards(container, selected, onPick, disabled = false) {
  container.innerHTML = Object.entries(state.presets.trainingPresets).map(([key, preset]) => `
    <div class="preset ${selected === key ? "selected" : ""}${disabled ? " disabled" : ""}" data-key="${key}"
         role="button" tabindex="${disabled ? -1 : 0}" aria-disabled="${disabled}">
      <div class="title">${escapeHtml(preset.label)}</div>
      <div class="desc">${preset.totalSteps} 步 · 上限 ${(preset.maxSplats / 10000)} 万高斯 · SH${preset.shDegree}<br>
        每 ${preset.exportEvery} 步导出 · ${escapeHtml(preset.eta)} · ${escapeHtml(preset.ply)}</div>
    </div>`).join("");
  if (disabled) return;   // 运行中不绑定处理器，避免“可点但静默忽略”
  for (const card of container.querySelectorAll(".preset")) {
    const pick = () => onPick(card.dataset.key);
    card.onclick = pick;
    card.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pick(); }
    };
  }
}

function renderForm() {
  if (!state.presets) return;
  presetCards($("presetList"), state.formPreset, (key) => { state.formPreset = key; renderForm(); });
  $("formSource").value = state.sourcePath;
  $("sourceHint").textContent = state.sourcePath ? "" : "支持 JPG / PNG / WEBP / HEIC / TIFF，至少 2 张。";
}

/** Viewer URL, carrying the reconstruction-derived pose, upright basis and scale. */
function viewerUrl(project, stamp) {
  const pose = project.scene?.home;
  let extra = "";
  if (pose) {
    extra += `&home=${[...pose.position, pose.yaw, pose.pitch].map((value) => value.toFixed(4)).join(",")}`;
    if (pose.basis) {
      extra += `&basis=${pose.basis.flat().map((value) => value.toFixed(5)).join(",")}`;
    }
    // 缩放上限用相机轨迹尺度，不用高斯点包围盒（后者常被漂浮点撑大）。
    if (Number.isFinite(pose.extent) && pose.extent > 0) {
      extra += `&radius=${pose.extent.toFixed(4)}`;
    }
  }
  return `/viewer.html?scene=${encodeURIComponent(project.scene?.url??`/api/projects/${project.id}/scene.ply`)}&t=${stamp}${extra}`;
}

function stepProgressText(step) {  if (step.status === "success") return "完成";
  if (step.status === "running") {
    return step.progress > 0 ? `进行中 · 约 ${Math.round(step.progress * 100)}%（估算）` : "进行中 · 无法估算";
  }
  return STEP_STATE[step.status] ?? step.status;
}

/** Steps are updated in place: a rebuild on every progress event thrashes the DOM. */
function renderSteps(project) {
  const list = $("stepList");
  if (list.children.length !== project.steps.length) {
    list.innerHTML = project.steps.map((step) => `
      <li data-id="${step.id}">
        <span class="dot"></span>
        <span class="step-name"><span class="label"></span><span class="note"></span><span class="err"></span></span>
        <span class="step-state"><span class="step-status"></span><span class="step-duration"></span></span>
        <button class="retry" data-step="${step.id}">重试此步</button>
      </li>`).join("");
    for (const button of list.querySelectorAll("button.retry")) {
      button.onclick = () => retryFrom(button.dataset.step);
    }
  }
  project.steps.forEach((step, index) => {
    const row = list.children[index];
    row.querySelector(".dot").className = `dot ${step.status}`;
    row.querySelector(".label").textContent = step.name;
    const note=step.id==='gate'&&step.status==='success'?'几何检查已通过':step.note;
    row.querySelector(".note").textContent = note ? ` ${note}` : "";
    row.querySelector(".err").textContent = step.error ? ` ${step.error}` : "";
    row.querySelector(".err").style.color = step.error ? "var(--danger)" : "";
    const stateCell = row.querySelector(".step-state");
    stateCell.querySelector('.step-status').textContent = stepProgressText(step);
    stateCell.classList.toggle("indeterminate", step.status === "running" && !step.progress);
    row.querySelector("button.retry").disabled = project.state === "running" || project.state === "aborting";
  });
}

// A clock tick changes only text; it must not reload the viewer or annotation UI.
function renderTiming(project) {
  const now = Date.now();
  $("totalDuration").textContent = timingLabel(project.timing, now);
  $("timingNote").textContent = '累计各阶段运行时间，包含重试；不含暂停和人工等待。'
    + (project.timing?.complete === false ? '历史或中断记录不完整，仅显示已记录时间。' : '');
  project.steps.forEach((step, index) => {
    const cell = $("stepList").children[index]?.querySelector('.step-duration');
    if (!cell) return;
    cell.textContent = `耗时：${timingLabel(step.timing, now)}`;
    cell.title = step.timing?.complete === false ? '历史或中断记录不完整，仅统计现有记录。' : '累计运行时间，包含重试。';
  });
}

function renderProject() {
  const project = state.project;
  if (!project || !state.presets) return;

  $("projectName").textContent = project.name;
  const modelInfo = project.gate?.models?.length ? `${project.gate.models.length} 个模型` : "";
  $("projectMeta").textContent = [
    project.sourceDir,
    `相机模型 ${project.cameraModel}`,
    `重建方式 ${project.mapper === "global" ? "全局式" : "增量式"}`,
    `特征 ${project.featurePreset === "enhanced" ? "增强" : "标准"}`,
    project.componentSource ? "独立区域；整体布局未验证" : "",
    project.useGpu ? "GPU 加速" : "仅 CPU",
    modelInfo,
  ].filter(Boolean).join(" · ");

  $("editPanel").classList.toggle("hidden", !state.editing);
  if (state.editing) {
    $("editName").value = project.name;
    $("editGpu").checked = Boolean(project.useGpu);
    $("editCamera").value = project.cameraModel;
    $("editFeatures").value = project.featurePreset ?? "standard";
    $("editCamera").disabled = Boolean(project.componentSource);
    $("editFeatures").disabled = Boolean(project.componentSource);
    $("editHint").textContent = "修改相机模型或特征档位后，需要重新提取特征，并重跑后续步骤。独立区域项目使用已定位的数据。";
  }

  const running = project.state === "running" || project.state === "aborting";
  $("presetNote").textContent = running ? "运行中不可更改" : "开始重建前可更改";

  const presetSig = `${state.projectPreset}|${running}`;
  if (presetSig !== lastPresetSig) {
    lastPresetSig = presetSig;
    presetCards($("presetListProject"), state.projectPreset, (key) => {
      state.projectPreset = key;
      renderProject();
    }, running);
  }

  $("globalBar").style.width = `${Math.round((project.progress ?? 0) * 100)}%`;
  $("globalNote").textContent = `总进度约 ${Math.round((project.progress ?? 0) * 100)}%（按各步骤权重估算，仅供参考）`;

  renderSteps(project);
  renderTiming(project);

  $("runButton").disabled = running||project.state==='needs_input';
  $("runButton").textContent = project.steps.some((step) => step.status === "success") ? "继续重建" : "开始重建";
  $("abortButton").classList.toggle("hidden", !running);
  $("deleteButton").disabled = running;

  const banner = $("banner");
  const nextStep = project.steps.find((step) => step.status !== "success");
  if(project.state==='needs_input'){
    banner.className='banner warn';banner.textContent='等待用户补充。请在辅助重建中保存回答，再继续求解。';
  } else if (project.state === "failed" || project.state === "aborted") {
    banner.className = "banner failed";
    banner.textContent = project.lastError ?? "重建失败";
  } else if (!running && project.gate && project.gate.verdict !== "pass") {
    banner.className = "banner warn";
    banner.textContent = project.gate.message;
  } else if (project.state === "done") {
    banner.className = "banner done";
    banner.textContent = `模型已生成：export_${project.scene?.step}（${formatBytes(project.scene?.size)}）。${project.quality?.complete?'完整检查已通过。':'请检查几何、覆盖和实际画面。'}`;
  } else if (running) {
    banner.className = "banner running";
    banner.textContent = `正在运行「${project.steps.find((s) => s.status === "running")?.name ?? "…"}」`;
  } else if (nextStep?.id === "train" && project.scene) {
    banner.className = "banner warn";
    banner.textContent =
      '已有导出场景。重新训练将使用新的尝试，并保留原有模型。';
  } else if (project.gate && project.gate.verdict !== "pass") {
    banner.className = "banner warn";
    banner.textContent = project.gate.message;
  } else {
    banner.className = "banner hidden";
    banner.textContent = "";
  }

  const viewingProject=state.historyScene?{...project,scene:state.historyScene}:project;
  const hasScene = Boolean(viewingProject.scene);
  $("viewerCard").classList.toggle("hidden", !hasScene);
  if (hasScene) {
    const wanted = viewerUrl(viewingProject, viewingProject.scene.step);
    if ($("viewer").getAttribute("src") !== wanted) $("viewer").setAttribute("src", wanted);
    $("viewerNote").textContent =
      `${state.historyScene?'历史模型。':''}场景文件：${viewingProject.scene.path}（${formatBytes(viewingProject.scene.size)}）。若长时间停留在“正在加载”，请确认浏览器支持 WebGL2。`;
  }

  const options = project.steps.map((step) => `<option value="${step.id}">${escapeHtml(step.name)}</option>`).join("");
  if ($("logStep").innerHTML !== options) $("logStep").innerHTML = options;
  if (!state.logStepPicked) {
    // Prefer the running step, else the last step that actually ran: `blocked`
    // steps never produced a log file.
    const ran = new Set(["success", "failed", "aborted", "running"]);
    const activeStep = project.steps.find((step) => step.status === "running")
      ?? [...project.steps].reverse().find((step) => ran.has(step.status));
    if (activeStep) $("logStep").value = activeStep.id;
  }
}

function appendLog(text) {
  const panel = $("logPanel");
  const node = $("log");
  node.appendChild(document.createTextNode(text));
  // Trim from the front by whole nodes so the panel cannot grow without bound.
  while (node.textContent.length > 400000 && node.childNodes.length > 1) {
    node.removeChild(node.firstChild);
  }
  if (!state.pauseScroll) panel.scrollTop = panel.scrollHeight;
}

function connectEvents(id) {
  state.eventSource?.close();
  const source = new EventSource(`/api/projects/${id}/events`);
  state.eventSource = source;

  source.addEventListener("state", (event) => {
    state.project = JSON.parse(event.data);
    renderProject();
    loadProjects().catch(() => {});
    if (["done", "failed", "aborted", "partial","needs_input"].includes(state.project.state)) refreshEvidence();
  });

  source.addEventListener("progress", (event) => {
    const payload = JSON.parse(event.data);
    const step = state.project?.steps.find((entry) => entry.id === payload.step);
    if (!step) return;
    step.progress = payload.value;
    state.project.progress = payload.global;
    renderProject();
  });

  source.addEventListener("log", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.replay) {
      // A reconnect replays the current step's tail; replace instead of appending.
      $("log").textContent = "";
      state.logStep = payload.step;
    } else if (payload.step !== state.logStep) {
      state.logStep = payload.step;
      $("log").appendChild(document.createTextNode(`\n───── ${payload.step} ─────\n`));
    }
    appendLog(payload.text);
  });

  source.onerror = () => {
    $("banner").className = "banner warn";
    $("banner").textContent = "与后台的连接已中断，正在自动重连…";
  };
}

async function refreshEvidence() {
  if (!state.project) return;
  const projectId=state.project.id;
  try {
    const data = await api(`/api/projects/${projectId}/summary`);
    if(state.project?.id!==projectId)return;
    assistance.update(state.project,data);
    const gate = data.pendingGate??data.gate;
    const evidenceImage=name=>`/api/projects/${projectId}/image?${new URLSearchParams({name,...(data.pendingGate&&state.project.pendingAttemptId?{attemptId:state.project.pendingAttemptId}:{})})}`;
    const blocks = [];
    if (gate) {
      blocks.push(`<p><strong>门禁结论：</strong>${escapeHtml(gate.verdict)} — ${escapeHtml(gate.message)}</p>`);
      const multi = gate.models.length > 1;
      blocks.push(`<table><thead><tr><th>模型</th><th>注册</th><th>注册率</th><th>重投影误差</th><th>稀疏点</th>${multi ? "<th></th>" : ""}</tr></thead><tbody>
        ${gate.models.map((model) => `<tr>
          <td>${escapeHtml(model.name)}</td><td>${model.registered}</td>
          <td>${(model.registration_ratio * 100).toFixed(1)}%</td>
          <td>${model.mean_reprojection_error == null ? "—" : model.mean_reprojection_error.toFixed(3) + " px"}</td>
          <td>${model.points}</td>
          ${multi ? `<td><button class="use-model" data-model="${escapeHtml(model.name)}">用此模型继续</button></td>` : ""}</tr>`).join("")}
      </tbody></table>`);
      if (multi) {
        blocks.push(`<p class="muted">稀疏重建分裂成多个模型时，工作台默认中止。若无法补拍，有两条路：`
          + `① 将一个独立区域复制到新项目，检查通过后训练；`
          + `② 校准相机后尝试全局式重建。全局式也可能产生独立区域。</p>`);
        if (!state.project.componentSource) blocks.push(`<p><button id="useGlobalMapper">改用全局式重建重跑</button></p>`);
      }
      if (gate.geometryValidationVersion === 1) {
        blocks.push(`<p>最终几何分量（通过共享三维点检查）：</p>`);
        for (const model of gate.models) {
          for (const component of model.geometryComponents ?? []) {
            blocks.push(`<details><summary>模型 ${escapeHtml(model.name)} · 区域 ${component.index + 1}：${component.registered} 张照片</summary>`
              + `<p class="muted">${component.images.map(escapeHtml).join("、")}</p>`
              + (component.registered >= 3 ? `<button class="use-component" data-model="${escapeHtml(model.name)}" data-component="${component.index}">复制此区域并检查</button>` : "")
              + `</details>`);
          }
        }
      } else {
        blocks.push(`<p>几何连接未验证。请重试「几何门禁」步骤。</p>`);
      }
      if (gate.bridgeCandidates?.length) {
        blocks.push(`<details><summary>跨区域候选照片：需要人工确认共同内容</summary><p class="muted">匹配点数量不能证明房间连接正确。请检查门框、墙角和固定家具，排除相似地砖。</p>`
          + gate.bridgeCandidates.map(pair => `<div class="bridge-pair"><p>${escapeHtml(pair.first)} ↔ ${escapeHtml(pair.second)}：${pair.inliers} 个匹配点；${escapeHtml(pair.configuration)}</p>`
            + [pair.first, pair.second].map(name => `<a target="_blank" rel="noopener" href="${evidenceImage(name)}"><img loading="lazy" alt="${escapeHtml(name)}" src="${evidenceImage(name)}"></a>`).join("") + `</div>`).join("") + `</details>`);
      }
      if (gate.strongComponentSizes?.length) {
        blocks.push(`<p class="muted">强匹配连通分量大小：${gate.strongComponentSizes.join("、")}</p>`);
      }
      const missing = gate.models[0]?.unregistered ?? [];
      if (missing.length) {
        blocks.push(`<p class="muted">未注册照片 ${missing.length} 张：${escapeHtml(missing.slice(0, 40).join("、"))}${missing.length > 40 ? " …" : ""}</p>`);
      }
      if (gate.discardedFragments?.length) {
        blocks.push(`<p class="muted">已丢弃的碎片模型：${escapeHtml(gate.discardedFragments.join("、"))}</p>`);
      }
    }
    if (data.manifest) {
      blocks.push(`<p class="muted">输入 ${data.manifest.source_count} 张，保留 ${data.manifest.retained_count} 张，
        相机分组 ${escapeHtml(JSON.stringify(data.manifest.camera_groups))}，源文件未被修改：${data.manifest.sources_unchanged ? "是" : "否"}</p>`);
    }
    $("evidence").innerHTML = blocks.join("") || "<p class='muted'>暂无证据数据。</p>";
    for (const button of $("evidence").querySelectorAll("button.use-model")) {
      button.remove();
    }
    for (const button of $("evidence").querySelectorAll("button.use-component")) {
      button.onclick = () => continueWithComponent(button.dataset.model, Number(button.dataset.component));
    }
    const globalButton = $("useGlobalMapper");
    if (globalButton) globalButton.onclick = () => rerunWithGlobalMapper();
    $("evidenceCard").classList.toggle("hidden", blocks.length === 0);
  } catch {
    $("evidenceCard").classList.add("hidden");
  }
}

/**
 * The gate stops on a split reconstruction. When the photos cannot be retaken, the
 * user can still pick one of the sparse models and train that.
 */
async function continueWithComponent(modelName, component) {
  try {
    const created = await api(`/api/projects/${state.project.id}/components`, {
      method: "POST",
      body: JSON.stringify({ model: modelName, component }),
    });
    await loadProjects();
    await openProject(created.id);
  } catch (error) {
    reportRunError(error);
  }
}

/** Calibrate a database copy, then try global SfM. */
async function rerunWithGlobalMapper() {
  const ok = confirm(
    "将改用「全局式重建」重跑稀疏重建。\n\n"
    + "先校准相机，再联合求解相机位姿。仍需检查最终几何连接。\n"
    + "本次使用新的尝试。旧模型会保留，去畸变与训练需要重新运行。\n\n确定继续吗？",
  );
  if (!ok) return;
  try {
    await api(`/api/projects/${state.project.id}`, {
      method: "PATCH",
      body: JSON.stringify({ mapper: "global" }),
    });
    state.project = await api(`/api/projects/${state.project.id}`);
    renderProject();
    await requestRun({ fromStep: "sparse" });
  } catch (error) {
    reportRunError(error);
  }
}

async function openProject(id) {
  if(state.project?.id!==id)state.historyScene=null;
  state.project = await api(`/api/projects/${id}`);
  const address=new URL(location.href);address.searchParams.set('project',id);window.history.replaceState(null,'',address);
  assistance.update(state.project);
  state.logStep = null;
  state.logStepPicked = false;
  state.editing = false;
  state.projectPreset = state.project.trainingPreset;
  lastPresetSig = "";
  $("log").textContent = "";
  show("project");
  renderProject();
  await loadProjects();
  connectEvents(id);
  refreshEvidence();
}

/** Run, transparently handling the train-clean confirmation gate. */
async function requestRun(body) {
  const url = `/api/projects/${state.project.id}/run`;
  try {
    return await api(url, { method: "POST", body: JSON.stringify(body) });
  } catch (error) {
    if (error.details?.code === "train_clean_confirmation_required") {
      const list = error.details.files.map((file) => `　· ${file.name}（${formatBytes(file.size)}）`).join("\n");
      const ok = confirm(`${error.details.message}\n\n${list}\n\n确定要删除它们并重新训练吗？`);
      if (!ok) return null;
      return api(url, { method: "POST", body: JSON.stringify({ ...body, allowTrainClean: true }) });
    }
    throw error;
  }
}

function reportRunError(error) {
  $("banner").className = "banner failed";
  $("banner").textContent = error.message;
}

async function boot() {
  try {
    state.presets = await api("/api/presets");
  } catch (error) {
    document.body.insertAdjacentHTML("afterbegin",
      `<div class="banner failed">无法读取工作台配置：${escapeHtml(error.message)}。请确认服务仍在运行后刷新页面。</div>`);
  }
  await loadHealth().catch(() => {});
  await loadProjects();
  show(state.projects.length ? "project" : "empty");
  if (state.projects.length) {
    const requested=new URLSearchParams(location.search).get('project');
    await openProject((state.projects.find(p=>p.id===requested)??state.projects[0]).id);
  }
}

$("newProject").onclick = async () => {
  state.formPreset = null;
  state.sourcePath = "";
  $("formName").value = "";
  $("formError").textContent = "";
  show("form");
  // 档位配置可能因首屏接口失败而缺失，这里懒加载重试一次即可自愈。
  if (!state.presets) {
    try {
      state.presets = await api("/api/presets");
    } catch (error) {
      $("formError").textContent =
        `无法读取训练档位配置：${error.message}。请确认服务仍在运行后再次点击「+ 新建项目」。`;
      return;
    }
  }
  renderForm();
};

$("cancelCreate").onclick = () => { show(state.projects.length ? "project" : "empty"); };

$("pickFolder").onclick = async () => {
  $("sourceHint").textContent = "等待文件夹选择…";
  try {
    const chosen = await api("/api/dialog/folder", { method: "POST", body: JSON.stringify({}) });
    if (!chosen) {
      $("sourceHint").textContent = "已取消选择，可直接手动填写路径。";
      return;
    }
    state.sourcePath = chosen.path;
    $("formSource").value = chosen.path;
    $("sourceHint").textContent = `该文件夹内识别到 ${chosen.imageCount} 张图片。`;
  } catch (error) {
    $("sourceHint").textContent = `无法打开系统对话框（${error.message}），请手动填写路径。`;
  }
};

$("formSource").oninput = (event) => { state.sourcePath = event.target.value; };

$("createProject").onclick = async () => {
  $("formError").textContent = "";
  if (!state.formPreset) { $("formError").textContent = "请选择训练档位"; return; }
  try {
    const created = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: $("formName").value,
        sourceDir: $("formSource").value,
        trainingPreset: state.formPreset,
        useGpu: $("formGpu").checked,
        cameraModel: $("formCamera").value,
        mapper: $("formMapper").value,
        featurePreset: $("formFeatures").value,
      }),
    });
    await loadProjects();
    await openProject(created.id);
  } catch (error) {
    $("formError").textContent = error.message;
  }
};

$("runButton").onclick = async () => {
  try {
    await requestRun({ trainingPreset: state.projectPreset });
  } catch (error) {
    reportRunError(error);
  }
};

async function retryFrom(stepId) {
  const labels = {
    prepare: "照片预处理", features: "特征提取", match: "特征匹配", sparse: "稀疏重建",
    gate: "几何门禁", undistort: "去畸变", train: "Brush 训练",
  };
  const ok = confirm(
    `将从「${labels[stepId] ?? stepId}」重新开始。\n\n`
    + "该步骤及其之后的所有步骤都会被重置为待运行；已经成功的上游步骤保持不变。\n"
    + "本次使用新的尝试。旧数据库、模型和训练结果会保留。",
  );
  if (!ok) return;
  try {
    await requestRun({ fromStep: stepId, trainingPreset: state.projectPreset });
  } catch (error) {
    reportRunError(error);
  }
}

$("abortButton").onclick = async () => {
  try {
    await api(`/api/projects/${state.project.id}/abort`, { method: "POST", body: JSON.stringify({}) });
  } catch (error) {
    if (error.status === 409) {
      $("banner").className = "banner warn";
      $("banner").textContent = "后台已经没有在运行的作业，可以直接点「继续重建」。";
      return;
    }
    reportRunError(error);
  }
};

$("deleteButton").onclick = async () => {
  if (!confirm(`确定删除项目「${state.project.name}」及其全部产物？此操作不可撤销。`)) return;
  try {
    await api(`/api/projects/${state.project.id}`, { method: "DELETE" });
    state.project = null;
    state.eventSource?.close();
    await loadProjects();
    show(state.projects.length ? "project" : "empty");
    if (state.projects.length) await openProject(state.projects[0].id);
  } catch (error) {
    reportRunError(error);
  }
};

$("editToggle").onclick = () => { state.editing = !state.editing; $("editError").textContent = ""; renderProject(); };
$("cancelEdit").onclick = () => { state.editing = false; $("editError").textContent = ""; renderProject(); };

$("saveEdit").onclick = async () => {
  $("editError").textContent = "";
  try {
    const updated = await api(`/api/projects/${state.project.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: $("editName").value,
        useGpu: $("editGpu").checked,
        ...(state.project.componentSource ? {} : { cameraModel: $("editCamera").value,
          featurePreset: $("editFeatures").value }),
      }),
    });
    state.project = updated;
    state.projectPreset = updated.trainingPreset;
    state.editing = false;
    lastListSignature = "";
    lastPresetSig = "";
    renderProject();
    await loadProjects();
    refreshEvidence();
  } catch (error) {
    $("editError").textContent = error.message;
  }
};

$("downloadScene").onclick = () => {
  const scene=state.historyScene??state.project?.scene;if(!scene)return;
  window.location.href = `${scene.url??`/api/projects/${state.project.id}/scene.ply`}?download=1`;
};

$("reloadScene").onclick = () => {
  const scene=state.historyScene??state.project?.scene;if(!scene)return;
  $("viewer").setAttribute("src", viewerUrl({...state.project,scene}, Date.now()));
};

$("pauseScroll").onchange = (event) => { state.pauseScroll = event.target.checked; };

$("logStep").onchange = () => {
  state.logStepPicked = true;
  state.logStep = $("logStep").value;
};

$("loadLog").onclick = async () => {
  try {
    const text = await fetch(`/api/projects/${state.project.id}/log?step=${$("logStep").value}&tail=200000`)
      .then((response) => response.text());
    $("log").textContent = text;
    state.logStep = $("logStep").value;
    state.logStepPicked = true;
  } catch (error) {
    $("log").textContent = `读取日志失败：${error.message}`;
  }
};

setInterval(() => {
  if (state.view === 'project' && state.project) renderTiming(state.project);
}, 1000);

boot().catch((error) => {
  document.body.insertAdjacentHTML("afterbegin",
    `<div class="banner failed">工作台初始化失败：${escapeHtml(error.message)}</div>`);
});
