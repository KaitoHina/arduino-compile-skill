#!/usr/bin/env node
import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname, join } from "path";

// 目標 Arduino libraries 目錄（arduino-cli 實際使用呢度）
const A_LIB = join(homedir(), "Documents", "Arduino", "libraries");

// 執行 shell command；timeout 單位係毫秒
function run(cmd, timeout = 120000) {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe", timeout });
}

// 由任意路徑向上搵 library 根目錄（有 src/ 或 library.properties 即係根）
// 用嚟判斷 header 屬於邊個 library，以及 clone 完之後搵 lib root
function findLibRoot(path) {
  let dir = dirname(path);
  while (dir !== "/") {
    if (existsSync(join(dir, "src")) || existsSync(join(dir, "library.properties"))) {
      return { root: dir, name: basename(dir) };
    }
    dir = dirname(dir);
  }
  return null;
}

// rsync 源 library 入 A_LIB；--delete 確保目標 = 源（清 stale 檔案）
// 排除開發工具目錄，避免污染 Arduino 環境
function rsync(sourceDir, name) {
  const target = join(A_LIB, name);
  mkdirSync(target, { recursive: true });
  run(`rsync -av --delete "${sourceDir}/" "${target}/" --exclude .git --exclude .vscode --exclude .claude --exclude .DS_Store`, 30000);
}

// 將 header 路徑轉成 wrapper include + 需要嘅 -I 目錄：
// - A_LIB 內 src/ 路徑（如 .../TestLib/src/modules/X.h）→ include <modules/X.h>，src/ root 加做 -I
// - A_LIB 外 /src/ 路徑 → 同上（resolveInclude 後 rsync 咗先 compile）
// - 其他 → 直接用 basename，header 所在目錄加做 -I
function resolveInclude(headerPath, extraDirs) {
  const wrapInclude = s => ({ include: `<${s}>`, code: `#include <${s}>\n\nvoid setup() {}\nvoid loop() {}` });
  if (headerPath.startsWith(A_LIB + "/")) {
    const parts = headerPath.slice(A_LIB.length + 1).split("/");
    if (parts.length >= 3 && parts[1] === "src") return wrapInclude(parts.slice(2).join("/"));
    return wrapInclude(parts.slice(1).join("/"));
  }
  const srcIdx = headerPath.lastIndexOf("/src/");
  if (srcIdx !== -1) { extraDirs.push(headerPath.slice(0, srcIdx + 4)); return wrapInclude(headerPath.slice(srcIdx + 5)); }
  extraDirs.push(dirname(headerPath));
  return wrapInclude(basename(headerPath));
}

// 呼叫 arduino-cli compile；includeDirs 經 compiler.*.extra_flags 注入
function compile(sketchDir, fqbn, includeDirs) {
  let cmd = `arduino-cli compile --clean --fqbn "${fqbn}"`;
  if (includeDirs.length) {
    const flags = includeDirs.map(dir => `-I${dir}`).join(" ").replace(/"/g, '\\"');
    cmd += ` --build-property "compiler.c.extra_flags=${flags}" --build-property "compiler.cpp.extra_flags=${flags}"`;
  }
  try {
    const output = run(`${cmd} "${sketchDir}" 2>&1`);
    return { ok: true, out: output, errors: [] };
  } catch (e) {
    const errorOutput = e.stderr || e.stdout || e.message;
    return { ok: false, out: errorOutput, errors: errorOutput.split("\n").filter(line => /error:/i.test(line)).map(line => line.trim()) };
  }
}

// ---- main ----
const args = process.argv.slice(2);
const options = { code: null, sketch: null, header: null, fqbn: null, libs: [], sync: null };
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--code": options.code = args[++i]; break;
    case "--sketch": options.sketch = args[++i]; break;
    case "--header": options.header = args[++i]; break;
    case "--fqbn": options.fqbn = args[++i]; break;
    case "--lib": { const [url, name] = args[++i].split(",").map(s => s.trim()); if (url && name) options.libs.push({ url, name }); break; }
    case "--lib-sync": options.sync = args[++i]; break;
    case "-h": case "--help":
      console.log(`Usage:\n  node compile.mjs --code <code> --fqbn <FQBN>\n  node compile.mjs --sketch <path> --fqbn <FQBN>\n  node compile.mjs --header <path> --fqbn <FQBN>\n  node compile.mjs --lib-sync <lib-path>\nOptions:\n  --code <string>      .ino code\n  --sketch <path>      .ino file\n  --header <path>      .h file (auto wraps)\n  --fqbn <string>      board FQBN\n  --lib "url,name"     GitHub lib\n  --lib-sync <path>    rsync local lib dir into A_LIB (validates lib root)`); process.exit(0);
  }
}

const hasCode = options.code || options.sketch || options.header;
if (hasCode && !options.fqbn) { console.error("Need --fqbn"); process.exit(1); }
if (!hasCode && !options.sync) { console.error("Need --code/--sketch/--header or --lib-sync"); process.exit(1); }

mkdirSync(A_LIB, { recursive: true });

// --lib-sync：驗證路徑係 library 之後 rsync 入 A_LIB（本身喺 A_LIB 內就 skip）
if (options.sync) {
  const isLib = path => existsSync(join(path, "src")) || existsSync(join(path, "library.properties"));
  if (!existsSync(options.sync)) { console.error("Not found:", options.sync); process.exit(1); }
  if (!isLib(options.sync)) { console.error(`Not a library: ${options.sync} (need library.properties or src/)`); process.exit(1); }
  if (options.sync.startsWith(A_LIB + "/")) console.log(`Already in ${A_LIB}, skipping sync`);
  else rsync(options.sync, basename(options.sync));
}
// --lib：GitHub clone → 搵 lib root → rsync 入 A_LIB → 清理 temp
for (const lib of options.libs) {
  const cloneDir = join(tmpdir(), `lib-${Date.now()}-${lib.name}`);
  run(`git clone --depth 1 "${lib.url}" "${cloneDir}"`, 60000);
  const libRoot = findLibRoot(cloneDir);
  rsync(libRoot ? libRoot.root : cloneDir, lib.name);
  rmSync(cloneDir, { recursive: true, force: true });
}
if (!hasCode) { console.log(JSON.stringify({ success: true, output: "Sync only" })); process.exit(0); }

// --header 喺 A_LIB 外：先 rsync 個 library 入 A_LIB 先 compile
if (options.header && !options.header.startsWith(A_LIB + "/")) {
  const libRoot = findLibRoot(options.header);
  if (!libRoot) { console.error("Cannot detect lib root:", options.header); process.exit(1); }
  rsync(libRoot.root, libRoot.name);
}

const includeDirs = [];
let sketchDir, tmp;

// 建立 sketch 目錄：--code / --header 寫入 temp，--sketch 直接用原目錄
if (options.code) {
  tmp = join(tmpdir(), `ac-${Date.now()}`); sketchDir = join(tmp, "s");
  mkdirSync(sketchDir, { recursive: true }); writeFileSync(join(sketchDir, "s.ino"), options.code);
} else if (options.sketch) {
  if (!existsSync(options.sketch)) { console.error("File not found:", options.sketch); process.exit(1); }
  sketchDir = dirname(options.sketch);
} else {
  if (!existsSync(options.header)) { console.error("File not found:", options.header); process.exit(1); }
  const resolved = resolveInclude(options.header, includeDirs);
  tmp = join(tmpdir(), `ac-${Date.now()}`); sketchDir = join(tmp, "s");
  mkdirSync(sketchDir, { recursive: true }); writeFileSync(join(sketchDir, "s.ino"), resolved.code);
}

const result = compile(sketchDir, options.fqbn, includeDirs);
const json = {
  success: result.ok, output: result.out, errors: result.errors,
  sketchDir: result.ok ? null : tmp || sketchDir,
  inoContent: options.code || (options.header ? `#include "${options.header}"\n\nvoid setup() {}\nvoid loop() {}` : null),
};
console.log(JSON.stringify(json));
if (tmp && result.ok) rmSync(tmp, { recursive: true, force: true });
process.exit(result.ok ? 0 : 1);
