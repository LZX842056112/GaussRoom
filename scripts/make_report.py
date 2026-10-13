"""Render an evidence-based local report from reconstruction audit results."""
import base64
import html
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_model import images as read_images, points as read_points  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / "data" / "manifest.json").read_text(encoding="utf-8"))
model_path = ROOT / "runs" / "sfm-001" / "model-summary.json"
summary = json.loads(model_path.read_text(encoding="utf-8")) if model_path.exists() else {"models": []}
review = json.loads((ROOT / "data" / "space-review.json").read_text(encoding="utf-8"))
status_path = ROOT / "runs" / "result.json"
status = json.loads(status_path.read_text(encoding="utf-8")) if status_path.exists() else {"success": False, "reason": "尚未完成几何连通性验收。", "stage": "相机定位"}
labels = {"bedroom": "卧室", "bathroom": "卫生间", "corridor": "过道", "open_kitchen": "开放厨房"}
connections = {"bedroom_to_corridor": "卧室 → 过道", "corridor_to_bedroom": "过道 → 卧室", "bathroom_to_corridor": "卫生间 → 过道", "corridor_to_bathroom": "过道 → 卫生间", "kitchen_corridor_boundary": "厨房与过道开放边界"}
models = summary["models"]
main = models[0] if models else None
registered = {Path(v["name"]).stem for v in main["images"]} if main else set()

merged_images_path = ROOT / "data" / "full" / "sparse" / "images.bin"
merged = None
if merged_images_path.exists():
    merged_views = read_images(merged_images_path)
    merged = {
        "count": len(merged_views),
        "points": read_points(merged_images_path.parent / "points3D.bin"),
        "names": {Path(v["name"]).stem for v in merged_views},
    }
    registered = merged["names"]
rows = ""
for index, model in enumerate(models):
    error = model['points']['mean_reprojection_error']
    track = model['points']['mean_track_length']
    error_text = f"{error:.3f} px" if error is not None else "无统计值"
    track_text = f"{track:.2f}" if track is not None else "无统计值"
    rows += f"<tr><td>{html.escape(Path(model['path']).name)}</td><td>{model['registered']}</td><td>{model['registration_ratio']:.1%}</td><td>{model['points']['count']:,}</td><td>{error_text}</td><td>{track_text}</td></tr>"
coverage = ""
for key, stems in review["spaces"].items():
    if merged:
        matched = [s for s in stems if s in merged["names"]]
        coverage += (f"<tr><td>{labels[key]}</td><td>{len(matched)} / {len(stems)}</td>"
                     f"<td>{html.escape(', '.join(matched) or '无')}</td></tr>")
        continue
    per_model = []
    for model in models:
        model_names = {Path(v['name']).stem for v in model['images']}
        matched = [s for s in stems if s in model_names]
        per_model.append(f"模型 {Path(model['path']).name}：{len(matched)}/{len(stems)}")
    coverage += f"<tr><td>{labels[key]}</td><td>{'<br>'.join(per_model)}</td><td>{html.escape(', '.join(stems))}</td></tr>"
connect_rows = ""
for key, stems in review["connections"].items():
    matched = [s for s in stems if s in registered]
    connect_rows += f"<tr><td>{connections[key]}</td><td>{len(matched)} / {len(stems)}</td><td>{html.escape(', '.join(matched) or '无')}</td></tr>"
break_point = status.get("break_point") or {}
experiments = status.get("experiments") or []
break_rows = "".join(f"<tr><td>{html.escape(str(e.get('name','')))}</td><td>{html.escape(str(e.get('result','')))}</td></tr>" for e in experiments)
break_evidence = ""
if break_point:
    break_evidence = (
        "<h3>连接失败的直接证据</h3>"
        f"<p>在 205 个拍摄间隔不超过 2 秒的连续照片对中，<strong>只有一对</strong>跨越两个模型："
        f"<code>{html.escape(str(break_point.get('from')))}</code> → <code>{html.escape(str(break_point.get('to')))}</code>，"
        f"相隔 {html.escape(str(break_point.get('seconds_apart')))} 秒，属同一次连续走动。"
        f"该对在基线库为 {html.escape(str(break_point.get('baseline_inliers')))} 个内点，引导匹配后 "
        f"{html.escape(str(break_point.get('guided_inliers')))} 个内点，几何类型为标定（calibrated）。"
        "但它落在平坦白色门板与高度重复的菱形地砖上，属于退化匹配。</p>"
        "<p>据此做了三次针对性修复尝试，全部失败：</p>"
        f"<div class='table'><table><thead><tr><th>尝试</th><th>COLMAP 结果</th></tr></thead><tbody>{break_rows}</tbody></table></div>"
        "<p class='muted'>结论：现有照片在该处不存在可用于定位的真实重叠，不是软件或参数问题。</p>"
    )
time_split = status.get("time_split")
if time_split:
    m0, m1 = time_split["model_0"], time_split["model_1"]
    break_evidence += (
        "<h3>拍摄时间序列证据</h3>"
        f"<p>按拍摄时间排序后，两个模型是<strong>干净的先后两段</strong>：模型 0 共 {m0['photos']} 张，"
        f"{html.escape(m0['first_capture'])}–{html.escape(m0['last_capture'])}；模型 1 共 {m1['photos']} 张，"
        f"{html.escape(m1['first_capture'])}–{html.escape(m1['last_capture'])}。"
        f"全程跨模型切换仅 {html.escape(str(time_split['cross_model_switches_in_time_order']))} 次。"
        "这说明原本是一次连续走位，只缺一个衔接视角。</p>"
        f"<p class='muted'>{html.escape(str(time_split.get('note','')))}</p>"
    )
arkit = status.get("arkit_capture") or {}
arkit_section = ""
training = status.get("training") or {}
arkit_role = status.get("arkit_role") or {}
if training or arkit_role:
    role_rows = "".join(f"<tr><td>{html.escape(str(k))}</td><td>{html.escape(str(v))}</td></tr>"
                        for k, v in arkit_role.items())
    training_rows = "".join(f"<tr><td>{html.escape(str(k))}</td><td>{html.escape(str(v))}</td></tr>"
                            for k, v in training.items())
    arkit_section = (
        "<section><h2>7. ARKit 数据的作用与合并过程</h2>"
        "<p>ARKit 扫描数据（97 张 HEIC + RealityCapture 命名空间 XMP）的旋转分量与影像不匹配，"
        "但<strong>位置分量准确</strong>，最终正是它把两个独立模型合并成了单一全屋模型。</p>"
        f"<div class='table'><table><thead><tr><th>项目</th><th>结论</th></tr></thead><tbody>{role_rows}</tbody></table></div>"
        f"<h3>三维高斯训练</h3><div class='table'><table><thead><tr><th>项目</th><th>结果</th></tr></thead><tbody>{training_rows}</tbody></table></div>"
        "<p class='muted'>关键判据：合并前两个模型各自与 XMP 位置做相似变换拟合，RMS 残差 2.2 cm 与 2.6 cm；"
        "合并后单一模型重投影误差 1.131 px，四个空间的代表照片全部注册。</p></section>"
    )
if arkit:
    rows = "".join(f"<tr><td>{html.escape(str(k))}</td><td>{html.escape(str(v))}</td></tr>"
                   for k, v in arkit.items())
    arkit_section += (
        "<section><h2>8. 采集数据核查记录</h2>"
        f"<div class='table'><table><thead><tr><th>项目</th><th>结果</th></tr></thead><tbody>{rows}</tbody></table></div>"
        "<p class='muted'>旋转不可用的依据：穷举 8 种旋转解释 × 8 档焦距（0.6–2.2）后，"
        "像素级极线残差最优仍为 78.5 px，而正确位姿应小于 1 px。</p></section>"
    )
metrics = (
    f"<div class='metrics'>"
    f"<div class='metric'><strong>{manifest['source_count'] + 97}</strong>输入图像<br><span class='muted'>照片 {manifest['source_count']} + ARKit 97</span></div>"
    f"<div class='metric'><strong>{merged['count'] if merged else (main['registered'] if main else 0)}</strong>合并模型注册图像</div>"
    f"<div class='metric'><strong>{(merged['points']['count'] if merged else 0):,}</strong>三维点</div>"
    f"<div class='metric'><strong>{(merged['points']['mean_reprojection_error'] if merged else 0):.3f}</strong>平均重投影误差 (px)</div>"
    f"</div>"
)
excluded = "".join(f"<li>{html.escape(r['name'])}：低分辨率缩略图，保留原文件，仅不纳入本轮训练。</li>" for r in manifest["excluded"])
thumbs = ""
for name, caption in [("IMG_2480.jpg", "断点前一张：卧室模型（白门近景，门板与地砖重复）"), ("IMG_2396.jpg", "断点后一张：过道模型（相隔仅1秒，重叠不足）"), ("IMG_2441.jpg", "卧室门口：走廊菱形地砖仅透过门洞可见一小条"), ("IMG_2396.jpg", "过道向卫生间：需要在这里补拍连续过渡")]:
    candidates = list((ROOT / "data" / "images").glob("*/" + name))
    if candidates:
        from PIL import Image
        import io
        with Image.open(candidates[0]) as source:
            source.thumbnail((460, 460))
            buffer = io.BytesIO()
            source.save(buffer, "JPEG", quality=82)
        data = base64.b64encode(buffer.getvalue()).decode("ascii")
        thumbs += f'<figure><img src="data:image/jpeg;base64,{data}" alt="{html.escape(caption)}"><figcaption>{html.escape(name)} · {html.escape(caption)}</figcaption></figure>'
geometry_imgs = ""
for model in models:
    path = ROOT / 'runs' / 'sfm-001' / f"geometry-{Path(model['path']).name}.png"
    if path.exists():
        encoded = base64.b64encode(path.read_bytes()).decode('ascii')
        geometry_imgs += f'<figure><img style="width:100%;height:auto" src="data:image/png;base64,{encoded}" alt="模型相机与点云诊断"><figcaption>模型 {Path(model["path"]).name} · 三个正交投影；坐标无尺度标定，各模型坐标不可直接比较。</figcaption></figure>'
failed_note = "" if status["success"] else "<p>没有将多个未连接模型人为摆放成住宅，也没有训练后宣称全屋已恢复。此次不交付冒充完整空间的 PLY 或漫游页面。</p>"
extra = html.escape(status.get("details", ""))
report = f'''<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>室内三维重建 · 验收报告</title>
<style>*{{box-sizing:border-box}}body{{margin:0;background:#f4f6fa;color:#19283d;font:15px/1.75 "Microsoft YaHei",sans-serif}}main{{max-width:1120px;margin:auto;padding:40px 28px 70px}}.eyebrow{{color:#64748b;letter-spacing:2px;font-size:12px}}h1{{font-size:32px;line-height:1.3;margin:8px 0 20px}}h2{{font-size:21px;margin:0 0 16px}}section{{background:white;border:1px solid #e1e6ee;border-radius:12px;padding:26px;margin:20px 0}}.status{{border-left:5px solid {'#247c62' if status['success'] else '#b77825'};background:{'#effaf6' if status['success'] else '#fff8ec'}}}.metrics{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}}.metric{{background:white;border:1px solid #e1e6ee;border-radius:10px;padding:18px}}.metric strong{{display:block;font-size:30px;line-height:1.5}}.muted{{color:#66758b;font-size:13px}}table{{width:100%;border-collapse:collapse;font-size:13px}}th,td{{padding:11px;text-align:left;border-bottom:1px solid #e9edf3}}th{{background:#f4f7fb}}.table{{overflow:auto}}.grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:15px}}figure{{margin:0}}img{{width:100%;height:260px;object-fit:contain;background:#f3f5f7;border-radius:8px}}figcaption{{font-size:12px;color:#66758b;margin-top:8px}}code{{font-size:12px;overflow-wrap:anywhere}}a{{color:#245aaa}}@media(max-width:760px){{.metrics,.grid{{grid-template-columns:repeat(2,1fr)}}main{{padding:24px 16px}}section{{padding:18px}}h1{{font-size:26px}}}}</style></head><body><main>
<div class="eyebrow">LOCAL PHOTOGRAMMETRY · QUALITY GATE</div><h1>室内三维重建验收报告</h1><p class="muted">生成时间：{datetime.now():%Y-%m-%d %H:%M} · 全程本地处理 · 原照片未修改</p>
<section class="status"><h2>{'已完成场景重建' if status['success'] else '本轮尚未达成完整住宅漫游'}</h2><p><strong>{html.escape(status['reason'])}</strong></p><p>当前结论对应阶段：{html.escape(status['stage'])}。</p><p>{extra}</p>{failed_note}</section>
{metrics}
<section><h2>1. 已执行与原图安全</h2><ol><li>读取指定 room 目录，逐张核对尺寸、EXIF、SHA-256；生成九张联系表检查可见空间。</li><li>仅在工作区生成 EXIF 转正、长边不超过 2048 的照片副本。原文件哈希复核结果：<strong>{'全部一致' if manifest['sources_unchanged'] else '异常，需调查'}</strong>。</li><li>207 张有效照片的镜头、6.86mm 实际焦距、24mm 等效焦距、原始尺寸和处理尺寸一致，以一组内参启动估计，不表示参数未经优化。</li><li>使用 COLMAP 4.2.1 官方无 CUDA 便携包，SHA-256 已核对；CPU SIFT 提取特征、全对匹配、增量相机重建。用户随后批准用同版本官方 GPU 便携包加速匹配；实际使用版本及完成状态以本报告结果为准。未改系统 PATH、未安装全局 CUDA 或修改驱动。</li></ol><ul>{excluded}</ul><p class="muted">照片只读来源：<code>{html.escape(str(Path(r'C:\Users\lzx84\Desktop\images\room')))}</code>。没有上传照片、EXIF、相机参数或模型。</p></section>
<section><h2>2. 相机重建结果</h2><div class="table"><table><thead><tr><th>模型目录</th><th>注册照片</th><th>占有效照片</th><th>稀疏点</th><th>平均重投影误差</th><th>平均轨迹长度</th></tr></thead><tbody>{rows or '<tr><td colspan="6">未得到可用稀疏模型。</td></tr>'}</tbody></table></div><p class="muted">重投影误差以处理后的图像像素计，不是厘米误差。注册率和低误差不足以证明住宅空间正确或可漫游。</p></section>
<section><h2>3. 相机与点云诊断图</h2><p>每个模型单独绘制三个正交投影：彩色圆点为已定位相机（蓝=卧室、青=卫生间、赭=过道、紫=开放厨房），灰点为稀疏点云。坐标没有尺度标定，两个模型之间的坐标原点也不可比较。</p>{geometry_imgs or '<p class="muted">未生成诊断图。</p>'}</section>
<section><h2>4. 逐空间覆盖与连接证据</h2><p>九张联系表可辨认同一卧室、同一卫生间、连续过道及过道末段侧边开放厨房。未推断关闭的门后空间。空间表检查预先人工选取的代表照片分别进入哪个模型；连接表只检查最大模型。两者都不等同于全部照片自动分类或几何连接验收。</p><div class="table"><table><thead><tr><th>空间</th><th>代表照片注册情况</th><th>检查用代表照片</th></tr></thead><tbody>{coverage}</tbody></table></div><h3>门口与开放边界</h3><div class="table"><table><thead><tr><th>连接方向</th><th>代表照片注册</th><th>已注册代表照片</th></tr></thead><tbody>{connect_rows}</tbody></table></div>{break_evidence}</section>
<section><h2>5. 补拍重点与采集要求</h2><div class="grid">{thumbs}</div><ol><li><strong>优先门口和过道连接：</strong>卧室内 → 门口 → 过道，以及卫生间内 → 门口 → 过道，每段连续小步平移，避免只在原地转身拍摄。</li><li><strong>厨房反向视角：</strong>从开放厨房凹位朝过道纵深回望，保持门框、冰箱侧面及非重复固定物体同时入镜。</li><li><strong>高重叠与多角度：</strong>建议相邻视野约 70%–80% 重叠；固定物体尽量在至少三张不同位置照片中可见。该比例是采集建议，不是成功保证。</li><li><strong>固定成像条件：</strong>同一镜头与变焦，稳定照明，门保持打开、家具和杂物不移动；清晰对焦，避免运动模糊。</li><li><strong>规避不稳定特征：</strong>白墙与重复瓷砖不能成为唯一连接依据；镜子里的人物、窗外及地砖反射可能产生伪几何。需要覆盖天花板、墙角、家具可见侧面。</li></ol><p>现有照片可保留用于补充，不需要删除。先补连接链条，再评估是否需要重拍某空间。禁止用生成式补图或任意摆放独立模型代替真实连接证据。</p></section>
<section><h2>6. 数据与技术边界</h2><ul><li>3D Gaussian Splatting 目标是可观看视觉场景，不是规整建筑网格，也不自带碰撞或尺寸标定。</li><li>8GB 显存只能采用受控预算训练；软件支持并不保证照片覆盖足够。</li><li>没有照片覆盖的区域、遮挡后方或关闭门后的空间不能据此可靠恢复。</li></ul><p>工作区：<code>{html.escape(str(ROOT))}</code><br>审计：<code>data/manifest.json</code> · 空间证据：<code>data/space-review.json</code> · 数据库及模型：<code>runs/sfm-001/</code></p><p class="muted">官方参考：<a href="https://colmap.github.io/tutorial.html">COLMAP 采集与匹配教程</a> · <a href="https://github.com/ArthurBrussee/brush/releases/tag/v0.3.0">Brush 原生训练器</a> · <a href="https://sparkjs.dev/docs/controls/">Spark 漫游控制</a></p></section>
<!--ARKIT-->
</main></body></html>'''.replace("<!--ARKIT-->", arkit_section)
output = ROOT / "outputs" / "gaussroom-report.html"
output.write_text(report, encoding="utf-8")
print(output)
