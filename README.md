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

不通过即中止训练。两个可选的逃生通道：在「验收证据」里**挑一个稀疏模型继续**（跳过门禁，从去畸变起训），或**改用全局式重建重跑**。

**重建方式**：项目页可切 `incremental`（默认，增量式）／`global`（全局式）。全局式做旋转平均 + 全局定位，一次性联合求解所有相机位姿，**不存在「增量式长到一半分叉」这种失败模式**——当照片分组细碎、跨组重叠偏弱导致增量式分裂成多个模型时，全局式通常能直接得到单一模型。

## 漫游页操作

| 操作 | 效果 |
|---|---|
| 左键拖动 | 左右转动（yaw） |
| 右键拖动 | 上下俯仰（pitch），不会弹出浏览器菜单 |
| 滚轮 | 缩放视野（fov 20°–100°，每格 2.5°，相机位置不动） |
| <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> | 在水平面内移动（<kbd>Shift</kbd> 加速、<kbd>Ctrl</kbd> 减速） |
| 重置视角 | yaw / pitch / fov / 位置全部复位 |

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
- 增量式重建在「相机分组细碎 + 跨组重叠偏弱」时会分裂成多个模型；换 `global` 通常可解。
- 重建吃磁盘（一个 300 张的 full 档项目约 1.8 GB），开始新项目前留意剩余空间。
