// Minimal zero-dependency routing, JSON helpers and static file serving.
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

export function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed percent escape used to escape as a URIError and kill the process.
    throw Object.assign(new Error("请求路径包含非法的百分号编码"), { code: 400 });
  }
}

export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const source = "^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return "([^/]+)";
    }) + "$";
    routes.push({ method, regex: new RegExp(source), keys, handler });
  };
  return {
    get: (path, handler) => add("GET", path, handler),
    post: (path, handler) => add("POST", path, handler),
    put: (path, handler) => add("PUT", path, handler),
    patch: (path, handler) => add("PATCH", path, handler),
    delete: (path, handler) => add("DELETE", path, handler),
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const found = route.regex.exec(pathname);
        if (!found) continue;
        const params = {};
        route.keys.forEach((key, index) => { params[key] = safeDecode(found[index + 1]); });
        return { handler: route.handler, params };
      }
      return null;
    },
  };
}

const MAX_BODY_BYTES = 1024 * 1024;

export function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (message, code) => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error(message), { code }));
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail("请求体过大", 413);
        return;
      }
      chunks.push(chunk);
    });
    request.on("aborted", () => fail("请求被中断", 400));
    request.on("error", () => fail("读取请求体失败", 400));
    request.on("end", () => {
      try {
        // Decode once from the concatenated buffer: multi-byte characters can
        // straddle chunk boundaries and would corrupt a per-chunk toString().
        succeed(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        fail("请求体不是合法 JSON", 400);
      }
    });
  });
}

export function sendJson(response, code, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

export function sendText(response, code, text) {
  response.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(text);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ply": "application/octet-stream",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

export function streamFile(response, path, { download = false, head = false } = {}) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    sendJson(response, 404, { error: "文件不存在" });
    return false;
  }
  if (!stats.isFile()) {
    sendJson(response, 404, { error: "不是文件" });
    return false;
  }
  const headers = {
    "Content-Type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": stats.size,
    "Cache-Control": "no-store",
  };
  if (download) headers["Content-Disposition"] = `attachment; filename="${path.split(/[\\/]/).pop()}"`;
  response.writeHead(200, headers);
  if (head) {
    response.end();
    return true;
  }
  const stream = createReadStream(path);
  stream.on("error", () => {
    // Headers are already on the wire, so the only safe recovery is to drop the
    // connection. Without this listener the error would be uncaught and kill the
    // process (the file can disappear mid-read when a step cleans its directory).
    response.destroy();
  });
  response.on("close", () => stream.destroy());
  stream.pipe(response);
  return true;
}

export function serveStatic(request, response, pathname, root) {
  // On Windows normalize("/") becomes a backslash, so special-case the root first.
  const relative = pathname === "/" ? "index.html" : safeDecode(pathname).replace(/^\/+/, "");
  const target = resolve(root, normalize(relative));
  if (target !== root && !target.startsWith(root + (process.platform === "win32" ? "\\" : "/"))) {
    sendJson(response, 404, { error: "路径越界" });
    return;
  }
  streamFile(response, target, { head: request.method === "HEAD" });
}
