"""Final acceptance checks against the running workbench."""
import json
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8123"


def call(method, path, body=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Content-Type": "application/json"})
    try:
        response = urllib.request.urlopen(request)
        payload = response.read()
        return response.status, (payload if raw else json.loads(payload or b"null")), dict(response.headers)
    except urllib.error.HTTPError as error:
        payload = error.read()
        try:
            parsed = json.loads(payload or b"null")
        except json.JSONDecodeError:
            parsed = payload[:120]
        return error.code, parsed, dict(error.headers)


print("=== V1 畸形 URI")
for path in ["/%", "/api/projects/%", "/%zz", "/%E0%A4%A", "/vendor/%"]:
    print(f"   {path:<18} -> {call('GET', path)[0]}")
print(f"   服务存活 -> {call('GET', '/api/health')[0]}")

print("\n=== V3 项目状态（应无 running 卡死）")
status, projects, _ = call("GET", "/api/projects")
for project in projects:
    scene = project["scene"]["step"] if project["scene"] else None
    gate = project["gate"]["verdict"] if project["gate"] else None
    print(f"   {project['id']:<12} {project['state']:<8} scene={str(scene):<8} gate={gate}")

print("\n=== V7 训练清理闸门")
for label, body in (("继续重建（无待运行步骤）", {}), ("单步重试 train", {"fromStep": "train"})):
    status, payload, _ = call("POST", "/api/projects/60-8d3f36/run", body)
    print(f"   {label}: HTTP {status} {payload.get('error') or '(已接受)'}")
    if payload.get("details"):
        print(f"      将删除: {[f['name'] for f in payload['details']['files']]}")

print("\n=== V10 PATCH 改名与选项")
status, body, _ = call("PATCH", "/api/projects/60-8d3f36",
                       {"name": "演示：连通子集 60 张", "useGpu": True, "cameraModel": "SIMPLE_RADIAL"})
print(f"   HTTP {status} name={body.get('name')} gpu={body.get('useGpu')} camera={body.get('cameraModel')}")
status, body, _ = call("PATCH", "/api/projects/60-8d3f36", {"cameraModel": "NOPE"})
print(f"   非法相机模型 -> HTTP {status} {body.get('error')}")

print("\n=== V11 场景下载")
status, _, headers = call("GET", "/api/projects/60-8d3f36/scene.ply?download=1", raw=True)
print(f"   HTTP {status}")
print(f"   Content-Disposition: {headers.get('Content-Disposition')}")
print(f"   Content-Length: {headers.get('Content-Length')}")
status, payload, headers2 = call("GET", "/api/projects/60-8d3f36/scene.ply?download=1", raw=True)
print(f"   实际下载字节: {len(payload)}  一致: {str(len(payload)) == headers2.get('Content-Length')}")

print("\n=== V13 SSE 快照与重放标记")
request = urllib.request.Request(BASE + "/api/projects/proj-cf925e/events")
response = urllib.request.urlopen(request, timeout=8)
buffer = b""
events = []
try:
    while len(events) < 3:
        chunk = response.read1(4096)
        if not chunk:
            break
        buffer += chunk
        while b"\n\n" in buffer:
            raw, buffer = buffer.split(b"\n\n", 1)
            name = data = None
            for line in raw.decode("utf8", "replace").split("\n"):
                if line.startswith("event: "):
                    name = line[7:]
                elif line.startswith("data: "):
                    data = line[6:]
            if name:
                events.append((name, data))
except Exception as error:  # noqa: BLE001
    print(f"   (读取中断: {error})")
finally:
    response.close()
names = [n for n, _ in events]
print(f"   事件顺序: {names}")
print(f"   首个事件为 state 快照: {names[:1] == ['state']}")
for name, data in events:
    if name == "log":
        print(f"   log 事件 replay 标记: {json.loads(data).get('replay')}")
        break
