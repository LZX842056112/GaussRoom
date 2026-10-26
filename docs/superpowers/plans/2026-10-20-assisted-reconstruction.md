# 通用辅助重建 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在工作台中发现重建连接或位置不确定，保存用户回答和照片标记，用真实观察完成一次全局重建，并在验证后继续训练一个模型。

**Architecture:** 维持七步流程，在稀疏重建和几何检查中加入可恢复的辅助子阶段。Node 管理版本、任务和本地接口；Python 验证真实观察并执行全局求解；浏览器完成问答、标记和验收。每次求解使用独立目录，验证通过后才切换当前结果。

**Tech Stack:** Windows PowerShell；现有 Node HTTP/SSE 和浏览器 ES modules；Python >=3.13、NumPy、Pillow、pycolmap 4.2.1、opencv-python-headless 5.0.0.93；COLMAP 4.2.1 CUDA；Brush 0.3.0；Node test、Python unittest、现有 Playwright。

**Spec:** [已批准设计](../specs/2026-10-20-assisted-reconstruction-design.md)。执行者必须同时读取设计和本计划。

## Global Constraints

- 原图保持只读。照片、回答、匹配和求解均在本机处理。
- 产品代码不得依赖特定项目 ID、照片名称、房间名称或固定像素坐标。`room` 仅用于真实数据验收。
- 保留现有七步：`prepare`、`features`、`match`、`sparse`、`gate`、`undistort`、`train`。辅助求解是子阶段。
- 默认目标是一个统一模型。系统不能自动改成两个独立区域训练。
- 等待信息时，项目和当前步骤为 `needs_input`；后续步骤为 `blocked`。释放作业锁和 GPU；等待不计运行超时。
- 辅助状态为 `needs_input`、`ready`、`solving`、`verified`、`stale`、`failed`。`ready` 只表示可尝试求解；`verified` 不能替代画面检查。
- 每条接受的区域连接至少 8 个可靠共享点；每点在两侧分别至少 2 张照片；两侧视差分别至少 1 度；每次观察的重投影误差不超过 4 个工作图片像素。最终求解后重新检查。
- 内容确认、平面投影和布局提示不能生成虚构观察。只有用户标记或实际图片中检测的特征可以成为观察。
- 保留 `SIMPLE_RADIAL`、`OPENCV`、`RADIAL`、`PINHOLE`。沿用相机分组。仅在明确的畸变证据下提示变更模型。
- 校准失败立即停止并显示实际日志。全局式和增量式均只能使用源匹配快照的工作副本。
- 保留现有模型、接口字段和训练档位。`full` 为 30000 步、最多 1000000 个高斯、SH 阶数 2。
- 几何、区域覆盖、训练目标和画面检查全部通过后，才显示“完整重建通过”。无实测值时显示“绝对尺寸未验证”。
- 不从 `runs/` 加载模块或临时依赖。不直接复制已有训练模型作为新项目验收结果。
- 此计划不授权提交、推送或删除现有项目。执行前读取工作区规则并按隔离技能选择工作目录。

## Review Focus

1. 两个页面同时改答案，或旧任务稍后结束：旧版本不得覆盖新答案，也不得采用旧求解结果。任务 1、3、8、9。
2. SQLite 仅改变事务计数，或照片改名后重复导入：不能误判内容改变，也不能自动复用未经用户选择的事实。任务 2、12。
3. 三个以上区域、少量未定位照片、单一分量中的局部重影：不能漏掉第三个区域，也不能因定位率超过 80% 就确认完整覆盖。任务 4、6、7、13。
4. 窗口变化、图片留白、EXIF 方向、缩放和平移：界面标记必须始终对应实际工作图片像素。任务 2、11。
5. 求解失败、取消或服务重启，同时存在旧 PLY：保留旧结果，但不能把旧 PLY 当作新模型的训练成功证据。任务 3、8、13、14。

---

## 文件与接口约定

新增文件职责：

- `tools/workbench/assistance-config.json`：Node 和 Python 共用的版本、几何阈值及输入数量上限。
- `tools/workbench/lib/assistance.mjs`：辅助记录、修订控制、输入校验及答案复用。
- `tools/workbench/lib/assistance-diagnosis.mjs`：触发原因、本地问题模板和缺少信息清单。
- `tools/workbench/lib/attempts.mjs`：独立尝试目录、结果清单、切换和历史访问。
- `tools/workbench/lib/quality.mjs`：四类质量状态、人工检查记录和完成条件。
- `tools/workbench/py/assistance_inputs.py`：照片目录、SQLite 一致快照和内容指纹。
- `tools/workbench/py/assisted_features.py`：ROI、平面四角和手动点引导的真实特征搜索。
- `tools/workbench/py/assisted_geometry.py`：多视角检查、稳健 Sim3、区域图和尺度检查。
- `tools/workbench/py/assisted_database.py`：轨迹清理和新的几何匹配数据库。
- `tools/workbench/py/assisted_reconstruct.py`：命令行编排、原生全局求解和最终约束复查。
- `tools/workbench/public/assistance.js`：问答、照片选择、保存、恢复和历史结果入口。
- `tools/workbench/public/annotation.js`：照片上的圈选、四角、对应点和尺寸端点。
- `tools/workbench/public/annotation-coordinates.mjs`：可单测的像素与视图坐标转换。
- `tools/workbench/test_assistance*.mjs`、`tools/workbench/py/test_assistance*.py`：按任务列出的行为测试。
- `tools/workbench/verify_assisted_room.py`：显式指定项目的真实验收；不得使用固定现有项目 ID。

修改现有 `projects.mjs`、`pipeline.mjs`、`jobs.mjs`、`paths.mjs`、`http.mjs`、`server.mjs`、预处理和稀疏脚本、前端入口、依赖及 README。职责不相关的现有模块不重写。

共享数据用 JSDoc 和 Python dataclass/TypedDict 说明，不增加 TypeScript 构建。

- `PhotoRef = { photoId, name, sourceSha256, workSha256, width, height }`；`photoId` 使用源内容 SHA-256，工作图片必须已统一方向。同内容重复文件只提供一个物理照片身份。
- `InputFingerprint = { photosSha256, matchingContentSha256, matchingSnapshotSha256, geometrySha256, configSha256 }`。前四项分别说明照片目录、数据库逻辑内容、已保存快照和稀疏几何；数据库源文件字节指纹只作诊断。photosSha256 按 photoId 排序并包含工作内容和尺寸，不包含文件名；新项目仍须重建自身模型，不能复用旧几何签名。
- `Observation = { photoId, xy:[number,number], origin:'manual'|'detected' }`。一个 landmark 在同一照片最多一项观察。
- `Landmark = { id, objectId, observations:Observation[] }`。
- `ObjectConstraint = { id, kind:'planar'|'points', regions:string[], rois:[{photoId,polygon}], corners:[{photoId,xy:[x,y][]}] }`；平面每张照片四角顺序相同。
- `Dimension = { id, value:number|null, unit:'mm'|'cm'|'m', source:'measured'|'estimated'|'unknown', endpoints:[{landmarkId},{landmarkId}]|null }`。只有实测值且端点可靠时参与尺度校准。
- `AssistancePatch = { answers, regionLabels, objects, landmarks, dimensions, coverage, onlyExistingPhotos }`；PUT 使用完整可编辑部分，不接受客户端状态、结果或路径。
- `AssistanceRecord = { version:1, revision, state, reasons, inputs, photos, regions, questions, missing, ...AssistancePatch, attempts, verifiedAgainst }`。没有记录时 GET 返回 `record:null`。
- `Attempt = { id, kind:'automatic'|'assisted', inputRevision:number|null, inputFingerprint:InputFingerprint|null, status, createdAt, result, failure }`；ID 由服务端生成。自动尝试在匹配完成前可以尚无完整指纹；辅助尝试必须先冻结完整指纹。`result` 含 selectedModel、模型签名、门禁报告和桥接报告。
- `Quality = { geometry:'unverified'|'failed'|'verified', coverage:'unreviewed'|'missing'|'reviewed', appearance:'unreviewed'|'passed'|'needs_improvement', scale:'unmeasured'|'calibrated', trainingComplete:boolean, complete:boolean }`。
- CLI 结果为 `{ outcome:'verified'|'needs_input'|'failed', inputRevision, inputFingerprint, model, gate, bridges, missing, error }`。退出码依次为 0、2、1；取消不写 `verified`。

配置初值：`minSharedPoints=8`、`minViewsPerSide=2`、`minParallaxDeg=1`、`maxReprojectionPx=4`、`minImageSpanFraction=0.08`、`minSecondSingularRatio=0.02`、`maxAlignmentResidualFraction=0.02`、`seed=42`。图像范围按图片对角线归一化；非共线用中心化三维点的第二与第一奇异值之比，不拒绝正常平面。对齐残差按对应点的稳健空间跨度归一化。所有阈值进入报告，不能按项目临时降低。

输入上限：请求体沿用 1 MiB；200 个问题回答、100 个物体、2000 个 landmark、每点 32 个观察、100 项尺寸、每个 polygon 最多 64 个顶点、每个标签最多 120 字。超过上限返回 400 或现有 413。坐标为有限数，`0 <= x < width`、`0 <= y < height`。重复物理观察不允许分配到不同 landmark。

## 执行与测试约定

按任务顺序在本对话执行最合适。任务之间共享修订、尝试和质量接口。未选执行方式前，只交付本计划。

命令默认在仓库根目录运行。`node` 使用当前已安装的 Node；如果 PATH 缺失，使用 `C:\Users\lzx84\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`。Python 使用 `.venv\Scripts\python.exe`。`uv` 使用 PATH 中的命令，缺失时使用 `C:\Users\lzx84\AppData\Local\hermes\bin\uv.exe`。

每个任务先写行为测试，运行并记录预期失败，再实现并运行到通过。不要把导入失败当作行为验证；增加接口后，至少确认一次断言因缺少行为而失败。以下测试片段中的 fixture 均在对应测试文件内定义，使用临时项目和小型合成相机，不读取真实项目。每个任务完成后检查差异；不自动提交。

### Task 1: 保存和验证用户输入

**Files:** Create `assistance-config.json`、`lib/assistance.mjs`、`test_assistance.mjs`，均位于 `tools/workbench/`；Modify `lib/projects.mjs` 的读取兼容逻辑。

**Interfaces:** Produces `readAssistance(project):AssistanceRecord|null`、`saveAssistance(project, {expectedRevision, patch, catalog, inputs}):AssistanceRecord`、`validatePatch(patch,catalog):AssistancePatch`。初次保存预期修订号为 0；每次用户成功保存加 1。服务端诊断/进度更新不增加输入修订，不覆盖编辑字段；文件写入使用同一项目写锁。错误带 `code:400|409`。

- [ ] **1. 写测试。** `revision_conflict_keeps_latest_answer`、`invalid_observation_never_changes_record`、`legacy_project_has_no_record`：

```js
const saved = saveAssistance(p, {expectedRevision:0, patch:valid, catalog, inputs});
assert.equal(saved.revision, 1);
assert.throws(() => saveAssistance(p, {expectedRevision:0, patch:other, catalog, inputs}), {code:409});
assert.deepEqual(readAssistance(p), saved);
assert.throws(() => validatePatch(withXY([NaN, 10]), catalog), {code:400});
assert.throws(() => validatePatch(withUnknownPhoto(), catalog), {code:400});
assert.throws(() => validatePatch(withDuplicateObservation(), catalog), {code:400});
assert.equal(readAssistance(legacy), null);
```

- [ ] **2. 运行失败测试。** `node --test tools/workbench/test_assistance.mjs`。确认冲突、坐标或旧项目断言失败。
- [ ] **3. 实现记录。** 使用临时文件加原子替换；序列化同项目写入；严格只接收共享可编辑字段。已验证记录改答案后回到 `ready` 或 `needs_input`，旧结果仍留在 attempts。跨版本照片、区域或问题引用返回明确错误。补测四角数量、尺寸来源/端点、数量上限、Infinity、负值和边界像素。
- [ ] **4. 运行通过测试。** 同命令全部通过；验证失败前后 `assistance.json` 字节相同。

### Task 2: 固定照片和匹配输入

**Files:** Create `py/assistance_inputs.py`、`py/test_assistance_inputs.py`；Modify `py/prepare_project.py`、`py/sparse_reconstruct.py`、`py/test_sparse_reconstruct.py`。

**Interfaces:** Produces `build_catalog(manifest:dict, images:Path)->list[PhotoRef]`、`snapshot_database(source:Path, destination:Path)->dict`、`matching_content_signature(database:Path)->str`、`fingerprint_inputs(catalog:list, snapshot:Path, models:list[Path], config:dict)->InputFingerprint`。CLI `assistance_inputs.py --request request.json --result result.json`，只接受服务端生成的请求文件。

- [ ] **1. 写测试。** `test_header_counter_does_not_invalidate_matching_content`、`test_exif_work_image_uses_display_orientation`、`test_both_mappers_preserve_source`：

```python
self.assertEqual(matching_content_signature(db), matching_content_signature(header_only_changed))
self.assertNotEqual(matching_content_signature(db), matching_content_signature(changed_match))
self.assertEqual(build_catalog(oriented_manifest, images)[0]['width'], displayed_width)
for mapper in ('global', 'incremental'):
    reconstruct_fake(mapper, source=db)
    self.assertEqual(sha256_file(db), original_sha)
    self.assertNotEqual(native_input(mapper), db)
```

- [ ] **2. 运行失败测试。** `.venv\Scripts\python.exe -m unittest discover -s tools/workbench/py -p test_assistance_inputs.py -v`，并运行现有 `test_sparse_reconstruct.py`。
- [ ] **3. 实现快照。** 用 SQLite 只读连接和 backup API 产生一致快照；原生程序使用第二个工作副本。逻辑签名按 schema、表名、稳定主键和真实行内容排序计算，包含 cameras、images、keypoints、descriptors、matches、two_view_geometries 及影响解算的已存在表；不按文件头比较。预处理记录源 SHA、方向统一后的工作 SHA 和尺寸；同名异内容不得复用事实。源目录不写入。
- [ ] **4. 运行通过测试。** 上述两组通过；增加 SQLite 完整性检查和快照源文件 SHA 断言。对增量式的副本改动不改变其既有求解参数。

### Task 3: 隔离每次尝试和历史结果

**Files:** Create `lib/attempts.mjs`、`test_assistance_attempts.mjs`；Modify `lib/pipeline.mjs`、`lib/projects.mjs`、`lib/pose.mjs`。

**Interfaces:** Produces `createAttempt(project,{kind,inputRevision,inputFingerprint}):Attempt`、`readAttempt(project,id):Attempt`、`adoptAttempt(project,attempt,{currentRevision,currentFingerprint}):Project`、`listAttempts(project):Attempt[]`。`dirs(project,{attemptId=project.activeAttemptId??null}={})` 保留旧返回键。`readGate`、`matchingDatabase`、`requireValidatedModel` 接受同样可选 `attemptId`；`requireTrainingDataset` 在原 options 内增加它。

- [ ] **1. 写测试。** `failed_or_stale_attempt_preserves_active_scene`、`old_ply_is_not_export_of_new_attempt`、`legacy_paths_still_resolve`：

```js
assert.throws(() => adoptAttempt(p, stale, {currentRevision:3,currentFingerprint:changed}), {code:409});
assert.equal(projects.read(p.id).activeAttemptId, previousId);
assert.equal(projects.latestExport({...p,activeAttemptId:fresh.id}), null);
assert.equal(dirs(legacy).train, resolve(legacyRoot,'train'));
assert.ok(dirs(p,{attemptId:fresh.id}).train.includes(fresh.id));
```

- [ ] **2. 运行失败测试。** `node --test tools/workbench/test_assistance_attempts.mjs`。
- [ ] **3. 实现目录与采用。** 使用 `attempts/<server-generated-id>/`，其中保存 `attempt.json`、`inputs/`、`sfm/`、`summary/`、`undistorted/`、`train/`、`logs/`。`dirs.root` 始终为项目根目录；其他产物键在给定 attempt 时定位到该尝试，images 定位到 `inputs/images`。inputs 保存只读照片目录副本/清单、匹配快照和约束版本。metadata 中的 `activeAttemptId` 及 selectedModel 只在最终报告通过且修订/指纹一致时原子切换；`pendingAttemptId` 和待选模型不能改变查看器当前结果。训练来源加入 attemptId 和几何签名。初次运行也先建尝试，匹配后冻结指纹；从中间重试时复制前置有效输入，不清理旧结果。已有 legacy 布局作为历史只读入口保留。
- [ ] **4. 运行通过测试。** 同命令以及 `node --test tools/workbench/test_quality.mjs` 全部通过；补测非法 ID 和 attempt 目录逃逸。检查 `pose.mjs`、导出列表和模型选择均使用选定尝试。

### Task 4: 产生具体问题和覆盖检查

**Files:** Create `lib/assistance-diagnosis.mjs`、`lib/quality.mjs`、`test_assistance_diagnosis.mjs`；Modify `py/gate_model.py`、`lib/projects.mjs`。

**Interfaces:** Produces `diagnoseAssistance({gate,catalog,record,manualRequest}):{required,reasons,questions,missing,regions}`、`classifyToolFailure(error):'failed'`、`deriveQuality(project,{gate,record,review,training}):Quality`。问题 `type` 只使用 `same_object`、`door_relation`、`coverage`、`observations`、`position_review`，每项带 `id`、`reason`、`photoIds`、合法选项和局部标记位置。

- [ ] **1. 写测试。** `split_requires_input_even_at_full_registration`、`unregistered_room_needs_scope_review`、`one_component_can_request_position_review`、`tool_failure_is_not_photo_question`：

```js
assert.equal(diagnose(fixtureGate([150,147])).required, true);
assert.equal(diagnose(fixtureGate([149,146])).required, true);
assert.equal(diagnose(fixtureGate([297])).required, false);
assert.ok(diagnose(withUnregisteredPhotos()).questions.some(q=>q.type==='coverage'));
assert.equal(diagnose({manualRequest:true,gate:connected}).required, true);
assert.equal(classifyToolFailure('calibration failed'), 'failed');
assert.equal(deriveQuality(trained,{gate:connected,record,review:null,training:done}).complete,false);
```

- [ ] **2. 运行失败测试。** `node --test tools/workbench/test_assistance_diagnosis.mjs`。
- [ ] **3. 实现诊断和模板。** 实际共享点定义区域，不用原始匹配数宣称连接。保留 5% 碎片阈值、全部分量清单和旧 gate 字段；所有未定位照片都可见。候选按跨区域证据排序，平面/纯旋转作提示，允许全相册选择。`不是` 排除该候选，`不知道` 保持未解决。没有共同观察或覆盖答案时给具体缺项，不伪造 ready。图已连通时提供主动位置复查，不仅提供合并按钮。
- [ ] **4. 运行通过测试。** 同命令和现有 Python `test_geometry.py` 通过。补测三个区域、少量碎片、全部照片被定位但跨组主要为可疑平面匹配，以及覆盖答案“新区域/不知道”。

### Task 5: 从标记中取得真实特征

**Files:** Create `py/assisted_features.py`、`py/test_assistance_features.py`；Modify `pyproject.toml`、`uv.lock`、`lib/paths.mjs`、工具状态界面。

**Interfaces:** Produces `collect_observations(catalog:list, models:list, constraints:dict, config:dict)->dict`，返回 `{landmarks, rejected, missing}`。每项自动观察带检测点索引、描述子来源和原图像素；手工观察保留 origin。提供 `extend_observations(landmark:dict, region:dict, context:dict)->dict`，只能返回在其他照片内实际检测的观察。

- [ ] **1. 写测试。** `test_same_object_answer_does_not_create_observations`、`test_homography_search_keeps_detected_pixels`、`test_rejected_candidate_is_not_reintroduced`：

```python
self.assertEqual(collect(answer_only)['landmarks'], [])
for obs in collect(planar_roi)['landmarks'][0]['observations']:
    self.assertIn(tuple(obs['xy']), detected_pixels[obs['photoId']])
self.assertEqual(collect(rejected_pair)['landmarks'], [])
self.assertEqual(collect(blank_images)['missing'][0]['code'], 'no_real_features')
```

- [ ] **2. 运行失败测试。** `.venv\Scripts\python.exe -m unittest discover -s tools/workbench/py -p test_assistance_features.py -v`。
- [ ] **3. 安装声明依赖。** 通过 `uv add pycolmap==4.2.1 opencv-python-headless==5.0.0.93` 更新项目和锁文件。验证目标 Python 的 wheel 与 import；缺依赖在工具检查中返回具体 module 和修复命令，不扫描 `runs` 或临时目录。
- [ ] **4. 实现实际搜索。** 从批准设计中的平面四角生成搜索变换；在实际工作图片检测 SIFT，做双向描述子匹配、ROI 和几何过滤；非平面只用对应点/邻域搜索。区域内已知相机可引导再检测和描述子核对，但预测位置不写成观察。记录所有拒绝原因和来源，支持任意模型/区域数量及相机组。
- [ ] **5. 运行通过测试。** 同命令通过。合成纹理、重复格子、空白图和非平面例均断言输出坐标来自真实检测或手工输入；缺包测试不启动原生求解。

### Task 6: 验证多视角点并连接区域图

**Files:** Create `py/assisted_geometry.py`、`py/test_assistance_geometry.py`。

**Interfaces:** Produces `triangulate_observations(observations:list, reconstruction, config:dict)->dict`、`estimate_region_alignment(shared_points:list, config:dict)->dict`、`connect_regions(regions:list, edges:list, config:dict)->dict`、`check_dimensions(dimensions:list, points:dict, config:dict)->dict`。返回结果均包含 `accepted`、`rejected`、`missing`；alignment 另带 Sim3，region graph 另带所有目标区域变换。

- [ ] **1. 写测试。** `test_each_side_needs_two_views_and_one_degree`、`test_collinear_or_clustered_support_is_rejected`、`test_third_region_cannot_be_dropped`、`test_estimated_dimension_does_not_calibrate_scale`：

```python
self.assertFalse(validate_bridge(points=7, views=(2,2), parallax=(2,2))['accepted'])
self.assertFalse(validate_bridge(points=8, views=(1,2), parallax=(2,2))['accepted'])
self.assertFalse(validate_bridge(points=8, views=(2,2), parallax=(0.9,2))['accepted'])
self.assertFalse(validate_bridge(max_error=4.1)['accepted'])
self.assertFalse(estimate_region_alignment(collinear, config)['accepted'])
self.assertTrue(estimate_region_alignment(spread_planar_points, config)['accepted'])
self.assertIn('unconnected_region', codes(connect_regions(three_regions, [edge_ab], config)))
self.assertEqual(check_dimensions(estimated, points, config)['scale'], 'unmeasured')
```

- [ ] **2. 运行失败测试。** `.venv\Scripts\python.exe -m unittest discover -s tools/workbench/py -p test_assistance_geometry.py -v`。
- [ ] **3. 实现几何检查。** 用 pycolmap 相机投影/反投影和已标定姿态，稳健三角化并检查正深度、逐观察 4px、两侧 2 视图及 1°。用固定 seed 的 RANSAC 和 NumPy Umeyama 估计 Sim3，检查归一化跨度、第二奇异值和对齐残差。所有目标区域必须在同一图内；不一致回路返回需要补充的连接，不静默采用不一致尺度。尺寸只对有可靠端点的实测值求整体尺度，并报告每项残差；未知/估计保持提示。
- [ ] **4. 运行通过测试。** 同命令通过；加入已知 Sim3、有离群点、负深度、相机畸变、刚好阈值边界、三个区域和互相矛盾测量的数值断言。相机组和模型保持输入定义。

### Task 7: 构建数据库并执行一次全局求解

**Files:** Create `py/assisted_database.py`、`py/assisted_reconstruct.py`、`py/test_assistance_solver.py`；Modify `py/gate_model.py` 的可复用检查入口。

**Interfaces:** Produces `build_geometry_database(source:Path, destination:Path, models:list, observations:dict, alignments:dict, constraints:dict, config:dict)->dict`、`solve_assisted(request:dict, run=subprocess.run)->dict`、`verify_final_bridges(model:Path, request:dict, config:dict)->dict`。CLI `assisted_reconstruct.py --request <server-file> --result <server-file>`；stdout 阶段事件以 `ASSISTANCE_PROGRESS ` 加单行 JSON 输出。

- [ ] **1. 写测试。** `test_calibration_failure_stops_before_global_mapper`、`test_final_disconnected_or_weak_bridge_is_not_verified`、`test_tracks_have_one_observation_per_photo`：

```python
result = solve_assisted(request, run=fake_calibration_failure)
self.assertEqual(result['outcome'], 'failed')
self.assertNotIn('global_mapper', called_commands)
self.assertEqual(sha256_file(source_db), source_sha)
self.assertEqual(solve_with_final_components([149,146])['outcome'], 'needs_input')
self.assertEqual(solve_with_final_strong_points(7)['outcome'], 'needs_input')
self.assertEqual(solve_with_final_three_region_graph()['outcome'], 'verified')
self.assertEqual(duplicate_observations(output_tracks), 0)
```

- [ ] **2. 运行失败测试。** `.venv\Scripts\python.exe -m unittest discover -s tools/workbench/py -p test_assistance_solver.py -v`。
- [ ] **3. 实现数据库。** 从输入快照在尝试内建新库；保留 cameras/rigs/frames/images 兼容关系。仅插入清理后的实际观察轨迹；同图重复选择低重投影观察，冲突不合并。排除用户否定的跨区域内容；根据求解出的真实几何形成相对 R/t、E 和匹配，不把手填区域关系转换为绝对相机位置。检查 COLMAP pair ID、四元数顺序、blob 形状和数据库完整性。
- [ ] **4. 实现 CLI 编排。** 顺序执行任务 5、6、数据库工作副本、`view_graph_calibrator`、原生 `global_mapper`、三角化/联合优化及最终 gate。辅助库已有可靠多视角相对姿态时，global mapper 使用 `--GlobalMapper.num_threads 12 --GlobalMapper.random_seed 42 --GlobalMapper.min_num_matches 8 --GlobalMapper.decompose_relative_pose 0 --log_color 0`。校准必须实际成功；如平面分解改变了已独立验证的相对姿态，仅按该对的多视角证据恢复，并记录前后值和原因，不按门名恢复整库。未经验证的相对姿态不能使用此开关。显式传递 stdout/stderr，保留 Windows 隐藏窗口和子进程退出码。最终按真实点轨迹重做 8/2/1°/4px/分布/所有区域检查；局部位置复查可在同一分量内限定两组照片，重检新增观察和旧可疑轨迹的残差，不能因没有待合并分量而跳过修复。未改善的主动复查不能返回完整修复。
- [ ] **5. 运行通过测试。** 同命令通过，另加小型原生烟雾测试，实际运行校准和 global mapper 并读取输出。模拟测试不替代原生兼容性检查。缺证据为退出 2；损坏数据库、缺程序和校准失败为退出 1。

### Task 8: 等待、恢复、取消和重试

**Files:** Modify `lib/jobs.mjs`、`lib/pipeline.mjs`、`lib/projects.mjs`；Create `test_assistance_jobs.mjs`。

**Interfaces:** Produces `jobs.startAssistance(projectId,{expectedRevision}):Project`。扩展现有 `jobs.start`，保留所有原参数；步骤 `clean/command/verify` 接受可选 `{attemptId}`。辅助阶段通过现有日志/SSE 发送；项目持久化 `pendingAttemptId` 和锁定输入修订。`projects.reconcile()` 保留 needs_input，仅将中断的 solving 标为可重试。

- [ ] **1. 写测试。** `waiting_releases_slot_without_timeout`、`resume_uses_frozen_revision`、`restart_and_abort_keep_answers`、`direct_train_retry_cannot_bypass_assistance`：

```js
assert.equal(afterGate.state,'needs_input');
assert.equal(afterGate.steps.find(s=>s.id==='gate').status,'needs_input');
assert.equal(jobs.busyId(),null);
assert.ok(afterGate.steps.filter(s=>['undistort','train'].includes(s.id)).every(s=>s.status==='blocked'));
assert.throws(()=>jobs.startAssistance(id,{expectedRevision:oldRevision}),{code:409});
assert.deepEqual(readAssistance(afterRestart).landmarks, savedLandmarks);
assert.throws(()=>jobs.start(id,{fromStep:'train'}),{code:409});
```

- [ ] **2. 运行失败测试。** `node --test tools/workbench/test_assistance_jobs.mjs`，使用可注入短子进程和独立临时项目，不操作真实训练。
- [ ] **3. 实现调度。** gate 的资料不确定走等待分支，不走通用 halt；运行故障继续 failed。等待时结束计时器、释放 active job；只有用户显式 run 才启动新尝试。允许运行期间保存新修订，运行输入不可变；结束时修订不同则保留结果但不采用。通过后切换 attempt，再继续 undistort/train。重试早期步骤同样不清除旧结果；后续重试重新校验 coverage、版本、几何、dataset 和 checkpoint。运行日志读取 pending attempt，默认查看器仍读 active attempt；历史日志显式指定已存在的 attemptId。采用后 verifiedAgainst 记录新输出签名，保留旧输入指纹作为求解证据，不能因正常采用新模型而立即将自身标 stale。
- [ ] **4. 实现进程恢复。** 新 CLI 加入精确脚本所有权清单；中断时只终止本任务树。取消后保留回答、输入与日志，不留 verified 假状态。恢复不自动重启已完成 30000 步的历史任务。
- [ ] **5. 运行通过测试。** 新测试和现有 `test_quality.mjs` 通过；补测等待数小时的虚拟时钟、第二项目可启动、重复 run 不重复训练、模型选择变化失效及服务重启。

### Task 9: 提供本地接口和版本保护

**Files:** Modify `server.mjs`、`lib/http.mjs`、`lib/projects.mjs`；Create `test_assistance_api.mjs`。只为服务测试提取可创建/关闭 server 的入口，生产默认启动方式保持兼容。

**Interfaces:** `GET .../assistance -> {record,quality,catalog,attempts}`；`PUT .../assistance {expectedRevision,patch} -> {record,quality}`；`POST .../assistance/run {expectedRevision} -> 202 {project,attemptId}`；`POST .../assistance/review {expectedRevision,attemptId,geometrySignature,review} -> {record,quality}`。新增 `GET .../attempts/:attemptId/scene` 及 `/scene.ply`，只解析服务端已有清单。原 summary 增加 assistance、quality、attempts，原字段原义保留。

- [ ] **1. 写测试。** `api_rejects_stale_revision_and_client_paths`、`old_review_cannot_approve_new_geometry`、`put_route_is_supported`、`summary_keeps_existing_fields`：

```js
assert.equal((await put(validBody)).status,200);
assert.equal((await put({...validBody,expectedRevision:0})).status,409);
assert.equal((await put(withClientOutputPath)).status,400);
assert.equal((await review({attemptId:oldId,geometrySignature:newSignature})).status,409);
assert.equal((await get('../outside/scene.ply')).status,400);
assert.ok(['gate','modelSummary','manifest','assistance','quality'].every(k=>k in summary));
```

- [ ] **2. 运行失败测试。** `node --test tools/workbench/test_assistance_api.mjs`；测试服务监听随机空闲端口。
- [ ] **3. 实现接口。** 给 router 增加 PUT；调用任务 1、3、4、8 的正式函数，不能由请求设置 verified。版本冲突返回当前修订及明确原因。默认 scene 只服务 active attempt；历史入口必须验证项目归属和 realpath。所有会启动或采用结果的入口重新读取指纹。昂贵哈希不在每次 SSE/列表轮询内重复执行。
- [ ] **4. 运行通过测试。** 同命令通过；覆盖非法 JSON/坐标/尺寸、超大请求、未知照片和模型、重复提交、并发两次 PUT、跨项目 attempt、未验证直接 undistort/train，及旧客户端读取。

### Task 10: 显示问答和照片选择

**Files:** Create `public/assistance.js`、`test_assistance_ui.mjs`；Modify `public/app.js`、`public/index.html`、`public/style.css`。

**Interfaces:** Produces `mountAssistance(root,{api,onProjectChange}):{update(project,summary),destroy()}`；api 为现有 JSON 请求包装。向导仅持有编辑草稿和服务器 revision，不自行推断 verified。任务 11 通过 `onChange(patch)` 更新同一草稿。

- [ ] **1. 写浏览器测试。** `answers_survive_reload`、`unknown_and_manual_selection_are_available`、`save_and_run_are_separate_actions`：

```js
await page.getByRole('button',{name:'不知道',exact:true}).click();
await page.getByRole('button',{name:'保存回答',exact:true}).click();
assert.equal(runCalls,0);
await page.reload();
await expectSavedAnswer('unknown');
await choosePhotoOutsideTopCandidates();
assert.equal(selectedPhotoId, catalog.at(-1).photoId);
assert.equal(await page.getByText('等待用户补充',{exact:true}).count()>0,true);
```

- [ ] **2. 运行失败测试。** `node tools/workbench/test_assistance_ui.mjs`，按现有 Playwright 查找方式启动浏览器，路由 mock 仅服务测试项目。
- [ ] **3. 实现向导。** 显示每个问题的原因、相关照片和固定物体提示，支持是/不是/不知道、近处门/门外门/拍摄侧、区域归属及手动选图。A/B 字母必须绑定本图标记。显示缺项、保存状态和 409 冲突恢复；切项目或销毁时移除监听器。保存不会启动；继续按钮只针对服务端当前 ready 版本，不把选项“是”显示为连接已验证。
- [ ] **4. 运行通过测试。** 新测试和 `test_quality_ui.mjs` 通过；验证七步数量不变，needs_input 可继续、工具失败显示日志，且仍能主动打开“检查位置”。

### Task 11: 标记共同区域、对应点和尺寸

**Files:** Create `public/annotation.js`、`public/annotation-coordinates.mjs`、`test_annotation.mjs`；Extend `test_assistance_ui.mjs` 和样式。

**Interfaces:** Produces `viewToImage(point,transform):[number,number]|null`、`imageToView(xy,transform):{x,y}`，transform 明确包含图片内容矩形、工作尺寸、zoom、pan。`mountAnnotation(root,{photos,objects,landmarks,dimensions,onChange}):{update(data),destroy()}`。

- [ ] **1. 写坐标和浏览器测试。** `round_trip_survives_letterbox_pan_zoom_and_resize`、`drag_updates_work_pixels`、`dimension_requires_linked_endpoints`：

```js
for(const t of transforms){
  const xy=viewToImage(imageToView([153,287],t),t);
  assert.ok(Math.abs(xy[0]-153)<1e-6 && Math.abs(xy[1]-287)<1e-6);
}
assert.equal(viewToImage(inLetterbox, transform),null);
await moveLandmarkAndResize();
assert.deepEqual(saved.landmarks[0].observations[0].xy, expectedWorkPixels);
assert.equal(saved.dimensions[0].source,'unknown');
```

- [ ] **2. 运行失败测试。** `node --test tools/workbench/test_annotation.mjs` 和浏览器测试。
- [ ] **3. 实现编辑器。** 以已统一方向的工作图片 naturalWidth/naturalHeight 为准；内容矩形排除 CSS 留白。支持 ROI polygon、按顺序四角、编号对应点跨多图、移动/删除、缩放和平移。标记的内容与物体模式互相清楚，不能强制非平面四角。尺寸输入区显示实测/估计/不知道、单位和两端点关联；未知尺寸不阻止继续几何求解。
- [ ] **4. 运行通过测试。** 两组命令通过；浏览器覆盖 DPR 1/2、窄/宽窗口、100%/150% 页面缩放、竖图方向，以及画布隐藏再显示。截图检查标记、按钮和问题文字不重叠。

### Task 12: 增加照片或主动复用已确认信息

**Files:** Modify `lib/assistance.mjs`、`py/assistance_inputs.py`、`server.mjs`、`public/assistance.js`；Create `test_assistance_import.mjs`。

**Interfaces:** Produces `previewFactReuse(project,sourceProjectId):{photos,answers,conflicts}`、`reuseFacts(project,{expectedRevision,sourceProjectId,answerIds}):AssistanceRecord`。新增 `GET .../assistance/reuse?sourceProjectId=...`、`POST .../assistance/reuse` 和 `POST .../assistance/photos {expectedRevision,sourceDir}`。sourceDir 仅为用户选择的照片输入目录，不接受输出/数据库路径。

- [ ] **1. 写测试。** `rename_allows_explicit_reuse_but_not_auto_reuse`、`same_name_different_bytes_is_not_same_photo`、`photo_import_preserves_originals_and_old_attempt`：

```js
assert.equal(readAssistance(newProject),null);
assert.equal(previewFactReuse(renamed,old.id).photos.length, matchingHashes.length);
assert.equal(previewFactReuse(changedBytes,old.id).photos.length,0);
assert.notEqual(reuseFacts(renamed,chosen).state,'verified');
assert.deepEqual(sourceHashesAfter,sourceHashesBefore);
assert.equal(oldAttemptHashAfter,oldAttemptHashBefore);
```

- [ ] **2. 运行失败测试。** `node --test tools/workbench/test_assistance_import.mjs`。
- [ ] **3. 实现受控导入。** “只有现有照片”是合法保存项，不强制补拍。主动选择目录才复制新照片；同 SHA 去重，同名异内容产生唯一工作名，不覆盖旧图片。输入变化标记 stale，旧答案保留，相关特征/匹配/模型重算使用新尝试。复用只选已确认事实并重新映射 SHA；坐标必须校验工作方向/尺寸，相机和模型结论不得直接复用。
- [ ] **4. 运行通过测试。** 同命令通过；补测正在运行时导入返回 409、用户取消文件夹选择不改变状态、过期导入修订、重复内容及 UI 明确预览后才复用。

### Task 13: 分开几何、覆盖、画面和训练完成条件

**Files:** Modify `lib/quality.mjs`、`lib/jobs.mjs`、`lib/projects.mjs`、`public/assistance.js`、`public/app.js`；Create `test_assistance_quality.mjs`；Extend API/UI 测试。

**Interfaces:** Produces `saveReview(project,{expectedRevision,attemptId,geometrySignature,review}):Quality`。review 为 `{appearance:'passed'|'needs_improvement',items:[{code:'doorway'|'ghosting'|'proportions'|'coverage'|'other',photoIds,regionIds,note,status}],requestPositionCheck:boolean}`；所有照片和区域必须来自对应尝试。比较视图固定同一 eval 照片清单并链接对应步数渲染。

- [ ] **1. 写测试。** `training_done_does_not_imply_complete`、`review_is_invalidated_by_new_geometry`、`failed_bathroom_review_keeps_needs_improvement`：

```js
assert.equal(quality({geometry:'verified',coverage:'reviewed',appearance:'unreviewed',trainingComplete:true}).complete,false);
assert.equal(quality({geometry:'verified',coverage:'reviewed',appearance:'passed',trainingComplete:true}).complete,true);
assert.equal(quality({geometry:'verified',coverage:'missing',appearance:'passed',trainingComplete:true}).complete,false);
assert.equal(reviewedDifferentGeometry.appearance,'unreviewed');
assert.equal(savedFailedReview.appearance,'needs_improvement');
assert.equal(savedFailedReview.complete,false);
```

- [ ] **2. 运行失败测试。** `node --test tools/workbench/test_assistance_quality.mjs`。
- [ ] **3. 实现质量和检查入口。** 训练 done 文案改为“模型已生成”；完整通过由独立四类状态和训练目标推导。覆盖未知阻止统一目标训练，不因 80% 定位率略过。无尺度显示未验证，不输出虚假米/厘米数。主动复查可从已连通模型选择照片/ROI，再进入等待与求解；只有标签不能改变姿态。新签名清除旧画面通过状态，历史 PLY 保留所属尝试和旧审阅。全局模式不显示“不会分裂”。
- [ ] **4. 运行通过测试。** 质量、API、UI 三组通过；检查固定 eval 对比、历史模型选择、旧项目状态和局部重影复查不会自动宣告修复。

### Task 14: 回归检查和真实项目验收

**Files:** Create `verify_assisted_room.py`；Modify 根 `README.md`；运行记录保存到新的验收项目 `summary/assistance-acceptance/`，不提交照片/PLY/数据库。

**Interfaces:** 验收 CLI `verify_assisted_room.py --base-url <local-url> --source-dir <photos> --facts <json> --training-preset full --report-dir <new-project-summary>`。facts 只含正式辅助输入，不含目标模型或输出路径。支持 `--until gate|train`；真实训练只在 gate 和覆盖通过后启动。运行前明确输出目标项目 ID。

- [ ] **1. 写端到端失败测试。** 在临时项目用合成小模型和短原生替身跑正式 HTTP 流程，断言 `needs_input -> ready -> solving -> verified -> undistort -> train`；重复提交只产生一次作业，断开的 150/147 不得标完整，失败不换 active attempt，重启后回答保留。将故意断桥和旧 PLY 放入夹具，先确认测试失败。
- [ ] **2. 实现并通过端到端测试。** 加入统一测试入口，运行全部 `test_assistance*.mjs`、`test_annotation.mjs`、`test_quality.mjs`、Python `test_*.py` 和新旧 UI 测试。服务器使用独立端口；保留现有 8123 服务与项目。现有 `verify_api.py` 有固定 demo 状态写入，不用于此验收。
- [ ] **3. 通过正式接口新建 room 全局式项目。** 保留已有 `room-707167` 与 `room-unified-8b7850`；原图目录为 `C:\Users\lzx84\Desktop\images\room`。记录 297 张原图 SHA、相机四组和模型。跑原生特征、匹配、校准和全局重建到检查；记录实际分量和定位率，不假设自动结果必定分裂。若有不确定，确认正式界面显示原因和等待状态。
- [ ] **4. 回放明确的人工作业输入。** 仅从既有专项记录提取已确认的门身份、共同区域和实际点观察，转换为新项目 SHA/工作像素并经 PUT 保存。缺少的可靠观察在正式标记界面补充，不能直接采用专项最终模型。运行正式 run 接口；检查一个全局坐标、一个实际几何分量、每条区域连接的强点数，以及所有目标区域覆盖。证据不足则如实保持 needs_input，不能降阈值或伪造成功。
- [ ] **5. 运行同输入但改照片名的检查。** 用小型可运行合成项目验证全流程不依赖名字；对完整 room 建立改名清单并验证 SHA 映射、问题和输入消费。检查产品源码无 room ID、照片名或专项路径分支；验收脚本的显式测试参数除外。
- [ ] **6. 检查通过后运行 full 训练。** 确认参数 30000/1000000/SH2、模型与数据签名、目标步数导出及 API 服务的 PLY SHA。固定与既有对照相同的 eval 照片和随机种子；不因训练步数完成就通过画面检查。逐项检查门口连接、墙面重影、房间比例，特别记录卫生间残留问题及实际渲染对比。
- [ ] **7. 交付证据。** README 说明新建项目、等待信息、标记、继续、重试、历史模型、质量状态和资料不足的处理。报告列出新项目 ID、尝试、命令、输入/输出签名、分量、强连接、评估照片、画面检查和未解决项。链接可查看模型和结果，不把仅有数值通过写成所有画面已修复。

## 自检记录与执行交接

- 设计第 1–3、5、10 节由任务 4、8、13、14 覆盖；四种质量状态独立保存。
- 设计第 4、6、12 节由任务 1、5、10、11、12 覆盖；只有真实观察进入几何，尺寸和布局提示不造点。
- 设计第 7 节由任务 5–7 覆盖；多区域、局部错误、8/2/1°/4px 和最终复查均有测试。
- 设计第 8–9、11 节由任务 1–3、8–9、12 覆盖；原子保存、逻辑指纹、失败保留、旧项目和路径检查均有明确接口。
- 设计第 13–15 节由文件职责和任务 14 覆盖；包含真实新项目、改名数据、正式输入和 full 训练验收。
- Review Focus 的五项均映射到拥有该行为的任务测试。接口与数据字段使用本文件约定；`ready`、`verified` 和 `complete` 含义不互换。
- 首选在本对话由主代理顺序执行。各任务共享状态与几何接口，顺序实施便于检查一致性。也可由用户选择子代理执行，再使用对应实施技能。
- 本节记录计划编写时的检查。当前已实现通用流程，并完成真实数据的强连接检查和 full 训练。卫生间画面仍需改进。最新证据见 `docs/validation/2026-10-21-assisted-reconstruction.md`；逐项执行记录见 `.superpowers/sdd/2026-10-20-assisted-reconstruction/progress.md`。
