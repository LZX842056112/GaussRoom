"""Static cross-check: every element id app.js touches must exist in index.html."""
import pathlib
import re

here = pathlib.Path(__file__).resolve().parent
public = here / "public"
html = (public / "index.html").read_text(encoding="utf-8")
js = (public / "app.js").read_text(encoding="utf-8")
server = (here / "server.mjs").read_text(encoding="utf-8")

html_ids = set(re.findall(r'id="([^"]+)"', html))
dynamic_ids = set(re.findall(r'id="([^"]+)"', js))
js_ids = set(re.findall(r'\$\("([^"]+)"\)', js))

print("HTML id 数:", len(html_ids), " app.js 引用 id 数:", len(js_ids))
missing = js_ids - html_ids - dynamic_ids
print("app.js 引用但 HTML 缺失 ->", sorted(missing) or "无")
assert not missing, f'界面缺少元素：{sorted(missing)}'
print("HTML 定义但 app.js 未用 ->", sorted(html_ids - js_ids) or "无")

routes = sorted(set(re.findall(r'router\.(?:get|post|patch|delete)\("([^"]+)"', server)))
print("服务端路由:", routes)

# Every fetch/EventSource target in app.js must correspond to a served path.
targets = set(re.findall(r'fetch\(`?([^`"\']+)', js))
targets |= set(re.findall(r'api\(`?([^`"\']+)', js))
targets |= set(re.findall(r'EventSource\(`?([^`"\']+)', js))
print("app.js 请求目标:", sorted(targets))

static_files = {p.name for p in public.iterdir() if p.is_file()}
print("public 目录文件:", sorted(static_files))
