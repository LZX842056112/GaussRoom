// Absolute paths for every external tool the workbench drives. Any of them can be
// overridden in the repo-root .env (template: .env.example); a relative value there
// is resolved against REPO, so the file stays portable.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const REPO = resolve(import.meta.dirname, "..", "..", "..");
export const WORKBENCH = resolve(import.meta.dirname, "..");
export const PUBLIC_DIR = resolve(WORKBENCH, "public");
export const PY_DIR = resolve(WORKBENCH, "py");
export const PROJECTS_DIR = resolve(REPO, "projects");

// A missing .env is fine, and a real environment variable wins over the file.
try {
  process.loadEnvFile(resolve(REPO, ".env"));
} catch { /* no .env yet */ }

const configured = (key, fallback) => {
  const value = process.env[key];
  return value ? resolve(REPO, value) : fallback;
};

export const TOOLS = {
  python: configured("WORKBENCH_PYTHON", resolve(REPO, ".venv/Scripts/python.exe")),
  colmapGpu: configured("COLMAP_GPU", resolve(REPO, "tools/colmap-4.2.1-cuda/bin/colmap.exe")),
  colmapCpu: configured("COLMAP_CPU", resolve(REPO, "tools/colmap-4.2.1/bin/colmap.exe")),
  brush: configured("BRUSH", resolve(REPO, "tools/brush-0.3.0/brush_app.exe")),
  // Only needed to decode HEIC originals; leave unset when every source is JPEG.
  ffmpeg: configured("FFMPEG", ""),
};

export function toolStatus() {
  const status = {};
  for (const [name, path] of Object.entries(TOOLS)) status[name] = existsSync(path);
  return status;
}
