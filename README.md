# GaussRoom 高斯房间

从一组照片重建**可漫游的室内三维高斯场景**。本地 Node 服务驱动浏览器界面，串起 COLMAP 稀疏重建与 Brush 高斯泼溅训练，产出可在网页里用 WASD 自由漫游的 `.ply` 场景。

整条链路是自托管的：照片不进任何远端服务，原图只读，工作台只在项目目录里生成长边 2048 的工作副本。

## 目录结构

```
GaussRoom/
├── pyproject.toml          uv 管理的 Python 依赖（numpy、pillow）
├── uv.lock / .python-version
├── .env.example            配置模板 → 复制为 .env 后按本机填写（.env 不入库）
├── .gitignore
├── start.bat               一键启动
├── tools/
│   ├── workbench/          Web 工作台：零 npm 依赖的 Node 22 服务
│   │   ├── server.mjs        HTTP 入口（默认 127.0.0.1:8123）
│   │   ├── lib/              paths / pipeline / projects / jobs / pose / http
│   │   ├── py/               prepare_project.py、gate_model.py
│   │   ├── public/           index.html、app.js、viewer.html、vendor/（Three.js + Spark）
│   │   ├── scripts/          folder-dialog.ps1（系统文件夹选择）
│   │   └── verify_ui.mjs / verify_api.py / check_ui.py   验收脚本
│   ├── colmap-4.2.1-cuda/  COLMAP GPU 版（必需）
│   ├── colmap-4.2.1/        COLMAP CPU 版（useGpu=false 时回退）
│   └── brush-0.3.0/         Brush 训练器
├── scripts/                一次性分析脚本（模型合并、位姿校验、联系表等）
└── data/ projects/ runs/ outputs/ target/    数据与产物（均不入库）
```

`tools/` 下的外部工具约 2 GB，按下面「准备外部工具」自行放置；`.gitignore` 已排除这些目录与所有归档包。

## 环境要求

| 组件 | 版本 / 说明 |
|---|---|
| Node | ≥ 20.12（用到内置 `process.loadEnvFile`），实测 22.22.2 |
| uv | 任意较新版本，用于管理 Python 环境 |
| Python | 3.13（`.python-version` 固定，`uv sync` 自动获取） |
| COLMAP | 4.2.1，**CUDA 版必需**（特征提取/匹配走 GPU） |
| Brush | 0.3.0 |
| ffmpeg | 可选，仅用于解码 HEIC 原图；源图全是 JPEG 时可留空 |

## 快速开始

```bat
:: 1. Python 环境
uv sync

:: 2. 配置（.env 不入库，模板见 .env.example）
copy .env.example .env

:: 3. 启动（也可以双击 start.bat）
node tools\workbench\server.mjs
```

浏览器打开 <http://127.0.0.1:8123/>。页面顶部的工具徽章显示哪些外部工具已就绪；缺哪个就配哪个的 `.env` 路径。

**准备外部工具**：分别把 COLMAP、Brush 解压到 `tools/colmap-4.2.1-cuda/`、`tools/colmap-4.2.1/`、`tools/brush-0.3.0/`。`.gitignore` 已排除这些目录，也排除了下载的 zip/whl 归档。

## 使用流程

1. 左侧 **「+ 新建项目」** → 填项目名称、选图片文件夹、选训练档位与相机模型 → **创建项目**
2. 项目页点 **「开始重建」**，7 个步骤自动串行：

| # | 步骤 | 调用 |
|---|---|---|
| 1 | 照片预处理 | `prepare_project.py`（复制/缩放、分组、写清单，ffmpeg 解 HEIC） |
| 2 | 特征提取 | COLMAP `feature_extractor` |
| 3 | 特征匹配 | COLMAP `exhaustive_matcher` |
| 4 | 稀疏重建 | COLMAP `mapper` / `global_mapper` |
| 5 | 几何门禁 | `gate_model.py`（见下） |
| 6 | 去畸变 | COLMAP `image_undistorter` |
| 7 | 高斯训练 | Brush（中途每 N 步导出 `.ply`） |

3. 训练结束后漫游区自动出现；ESC 或在页面内点「重置视角」回到默认机位。

## 训练档位

| 档位 | 训练步数 | 高斯上限 | SH 阶数 | 参考耗时 | 参考体积 |
|---|---|---|---|---|---|
| `fast` | 10 000 | 50 万 | 1 | 约 20 分钟 | 约 50 MB |
| `standard` | 20 000 | 80 万 | 2 | 约 40 分钟 | 约 100 MB |
| `full` | 30 000 | 100 万 | 2 | 约 60 分钟 | 约 150 MB |

## 相机模型

COLMAP 特征提取的 `--ImageReader.camera_model`，配合 `single_camera_per_folder=1`（同一相机分组的照片共用一套内参）。

| 模型 | 何时用 |
|---|---|
| `SIMPLE_RADIAL`（默认） | 绝大多数情况。参数最少，最不易过拟合，手机/普通相机够用 |
| `OPENCV` | 畸变明显（广角、运动相机、近距离）且照片充足（建议 ≥ 50 张） |
| `RADIAL` | 需要两个径向系数但不要切向项，很少比默认更好 |
| `PINHOLE` | **仅用于已经去畸变的图**（如 ARKit 直出的无畸变图） |

改动相机模型会把 features 及之后所有步骤标记为待运行（内参变了，下游结果作废）。

## 几何门禁

| 阈值 | 值 |
|---|---|
| 注册率 | ≥ 80% |
| 平均重投影误差 | ≤ 2.0 px |
| 稀疏点数 | ≥ 5 000 |
| 碎片份额 | ≤ 5%（多个近似匀速的不连通模型） |

不通过即中止训练。检查会读取最终三维点的观察轨迹，列出每个模型的几何分量、照片数量和照片清单。一个模型文件也可能包含多个没有共享三维点的区域。较大的独立区域按 5% 输入照片阈值判定为分裂；少量孤立照片也会显示，并要求提取连通区域后再训练。

在「验收证据」中点「复制此区域并检查」，工作台会保留源项目，把所选区域复制到新项目，并重新检查。检查通过后，可继续去畸变和训练。独立区域会标注「整体布局未验证」。接口和单步重试都不能跳过几何检查。旧报告在重新检查前显示「几何连接未验证」。

**重建方式**：项目页可切 `incremental`（默认，增量式）／`global`（全局式）。全局式在稀疏重建步骤中先将匹配数据库备份到 `sfm/database-global.db`，运行 `view_graph_calibrator`，再运行 `global_mapper`。校准失败即停止。两种方式都依赖可靠的跨区域匹配，都可能产生独立区域。

**特征档位**：标准档使用最多 8192 个 SIFT 特征。增强档使用最多 16384 个，并开启引导匹配。修改档位后，需要从特征提取重跑。训练继续使用原有 fast／standard／full 档位；所有档位都固定随机种子并保存评估图像，以便比较同一组照片在不同训练步数下的结果。

质量报告会列出跨区域候选照片。候选匹配需要检查真实共同内容，例如门框、墙角和固定家具。相似地砖不能单独证明房间连接正确。缺少可确认的共同内容时，应保留独立区域。

接口新增：`POST /api/projects/:id/components`，请求体为 `{ "model": "0", "component": 0 }`。返回新项目，自动执行区域提取和几何检查，随后等待继续训练。`GET /api/projects/:id/image?name=...` 只提供项目工作图片。项目创建和 PATCH 支持 `featurePreset: "standard" | "enhanced"`，旧项目默认为标准档。

去畸变数据会记录对应的稀疏模型和自身数据签名。直接重试训练时，工作台先检查签名。数据过期或缺失时停止，保留已有训练输出，并提示重新去畸变。

回归检查：`node --test tools/workbench/test_quality.mjs` 和 `python -B -m unittest discover -s tools/workbench/py -p "test_*.py" -v`。

已准备恢复配置的项目可以从检查点继续训练。工作台先检查模型、去畸变数据、训练档位和检查点 SHA256。通过检查后，保留已有导出并追加日志。目录中已有更晚的模型或评估图时，旧检查点不能覆盖它们。重新去畸变会清除恢复配置。训练只有产出目标步数的模型，才会显示完成。

PLY 恢复会载入模型参数，并重新初始化优化器。本次 `room` 的恢复准备脚本位于 `runs/room-quality/prepare_resume.mjs`。它会备份最新完整检查点，并保存中断后的评估图。[Brush v0.3.0 的恢复实现](https://github.com/ArthurBrussee/brush/blob/v0.3.0/crates/brush-process/src/train_stream.rs)。

## 漫游页操作

| 操作 | 效果 |
|---|---|
| 右键拖动 | 360° 旋转：yaw 与 pitch 同时变，左右不夹紧（可转满一圈），上下夹紧在 ±1.5 rad |
| 左键拖动 | 平移：相机与支点一起在屏幕平面内移动，位移随距离缩放（跟手） |
| 滚轮 | 缩放：改相机到支点的距离，范围 `0.1 – maxDistance`（`maxDistance = max(3×场景半径, 20)`，拉到上限即可看见整体模型） |
| <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> | 在水平面内移动（固定速度 1.6 m/s，没有加速 / 减速） |
| 重置视角 | yaw / pitch / fov / 距离 / 位置全部复位 |
| 切开顶部 | 用水平面把该高度以上的泼溅变透明，从上方看到房间内部（dollhouse） |
| 只显示房间范围 | 挡掉相机轨迹尺度之外的泼溅（默认开） |
| 切面高度 | 拖动滑块调切割面高度，范围 `home.y ± 0.6×场景尺度` |

相机是**轨道式**：状态为 `target`（支点）+ `yaw` / `pitch` / `distance`。支点放在初始视线前方 2 米，所以开局观感仍是「站在原地环视」，拉远后支点近似场景中心，就能绕着整个模型看。

缩放上限的场景尺度优先取 `?radius=`（工作台按**相机轨迹半径**算：质心到最远相机的距离，本项目实测 7.91 → 上限 23.74）。**不要用高斯点的包围盒**：3DGS 常有远处漂浮点，本项目包围球半径 64、上限会被撑到 192，而房间本体只有 8 左右。`?radius=` 缺失时才退回包围盒，两者都拿不到就用 4。

### 拉远时为什么会「白线糊屏」，以及三个参数

3DGS 训练会产出少数**尺度极大的高斯**。本项目 50 万个泼溅里有 **1,380 个（0.276%）`max(scale) > 2`，最大 221 单位**（房间本体才 16 单位）；离中心 15 单位以外的 490 个漂浮点平均尺度 10.24（是普通点的 170 倍）、平均亮度 0.865（偏白）。Spark 默认 `maxPixelRadius = 512`，单个泼溅最多能画 1024px 直径，几千个叠起来就是整屏白雾 + 放射状白线。三个旋钮（都在 `viewer.html` 的 `new SparkRenderer({...})` 里）：

| 参数 | 取值 | 理由 |
|---|---|---|
| `maxPixelRadius` | `512 → 32` | 主杠杆。实测拉远到 23.7 时平均亮度 78.4→20.9、亮像素 15.9%→6.5%。再小（16）会让巨型泼溅变成满屏麻点 |
| `minAlpha` | `≈0.00196 → 0.005` | 兜底剔近全透明点，只丢约 0.3% 的泼溅。**不要靠它治白线**：巨物 alpha 中位数只有 0.022，要剔掉得提到 0.03，那会丢掉 10%+ 的泼溅 |
| 裁剪球（`SplatEditSdf` sphere，`invert`） | 半径 `1.2×场景尺度` | 挡掉轨迹尺度之外的漂浮点。实测到 `home` 的距离 p99.5 = 1.11×尺度，所以 1.2× 只切掉 0.26% |

**不要动** `maxStdDev` / `blurAmount` / `clipXY` / `focalAdjustment`（会改变全局观感）。**`minPixelRadius` 也没用**：`blurAmount = 0.3` 会给每个泼溅的协方差加 0.3，屏幕半径下限被抬到约 1.55px，取 ≤1.55 不生效、取 ≥2 会把拉远后的整个模型剔掉。

切开顶部与裁剪都用 `SplatEdit`（`splat.edits` 数组，**不挂子节点**——子节点会继承 `basis` 旋转，切割面就歪了）。切割面是 `plane` 型 SDF，`rotation.x = π/2` 让局部 +Z 落到世界 −Y，于是 `distance<0` 恰好是「切面以上」。默认切面高度 `home.y + 0.15×尺度`：实测世界系 Y 的 p95 = `+0.12×尺度`、p99 = `+0.19×尺度`，且**没有明显的天花板平面**（−2.5~−1.0 占 56%，是地板）。**不要用 `splat.getBoundingBox()` 定切面高度**：它返回重建局部系，且被 Y 最高 +47.7 的漂浮点撑大。

默认机位**由重建数据推导**，不是硬编码角度：位置取相机轨迹质心，朝向取轨迹水平主轴并看向较长一端——这样在任意重建里都成立。

## 配置项（`.env`）

所有配置都从 `.env` 读，代码里只保留仓库内默认值；真实环境变量优先于 `.env`。相对路径按仓库根目录解析。**本项目不需要任何密钥。**

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | 8123 | HTTP 端口，被占用自动 +1 |
| `WORKBENCH_PYTHON` | `.venv/Scripts/python.exe` | Python 解释器 |
| `COLMAP_GPU` | `tools/colmap-4.2.1-cuda/bin/colmap.exe` | GPU 版 |
| `COLMAP_CPU` | `tools/colmap-4.2.1/bin/colmap.exe` | CPU 版回退 |
| `BRUSH` | `tools/brush-0.3.0/brush_app.exe` | 训练器 |
| `FFMPEG` | 空 | 解 HEIC；全是 JPEG 可留空 |

## 数据与产物

| 目录 | 内容 | 是否入库 |
|---|---|---|
| `data/` | 复制的演示输入、联系表、合并结果 | 否 |
| `projects/<id>/` | 逐项目产线数据：`images/`、`sfm/`、`undistorted/`、`train/`、`summary/`、`logs/` | 否 |
| `runs/` | 手工实验的临时输出 | 否 |
| `outputs/` | 独立 viewer 与 HTML 报告 | 否 |
| `target/` | 自动调参输出 | 否 |
| `tools/workbench/public/vendor/` | Three.js / Spark（离线内置） | **是** |

`projects/<id>/project.json` 是项目的唯一事实源（状态、步骤、档位、相机模型、选中稀疏模型、重建方式）；同一时刻只允许一个作业在跑。

## 验收脚本

```bat
python tools\workbench\check_ui.py      :: 前端元素与后端路由交叉校验
python tools\workbench\verify_api.py     :: 接口验收
node   tools\workbench\verify_ui.mjs     :: 浏览器自动化逐个点击验收
```

`verify_ui.mjs` 从本机 npx 缓存加载 Playwright 驱动 chromium；它需要**仓库内没有带场景的项目时**会跳过漫游相关用例（12 项），其余照常执行。破坏性用例只落在脚本自建自删的临时项目上。

## 已知限制

- **漫游页的 3D 渲染无法在无头环境验证**：headless + 软件渲染下 Spark 的 `splat.initialized` 不完成，渲染循环不启动、截图是空的。鼠标控制靠 `?debug=1` 门控的只读状态钩子断言，画面本身需人工确认。
- 两种重建方式在跨区域约束不足时都可能产生独立区域。增加高斯训练步数不能修复缺失的几何连接。
- 重建吃磁盘（一个 300 张的 full 档项目约 1.8 GB），开始新项目前留意剩余空间。
