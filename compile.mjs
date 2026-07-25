#!/usr/bin/env node

/**
 * compile.mjs — Arduino 編譯檢查驅動腳本
 *
 * 用法：
 *   node compile.mjs --code "<ino程式碼>" --fqbn <FQBN> [--lib "url,name" ...]
 *   node compile.mjs --sketch <path/to/sketch.ino> --fqbn <FQBN> [--lib "url,name" ...]
 *   node compile.mjs --header <path/to/header.h> --fqbn <FQBN> [--lib "url,name" ...]
 *
 * 功能：
 *   1. 自動生成合法的 .ino sketch 資料夾結構
 *   2. 從 GitHub clone 庫並用 rsync 同步到 ~/Documents/Arduino/libraries/
 *   3. 用 arduino-cli compile 編譯檢查
 *   4. 直接編譯單個 .h 檔案（自動產生 wrapper .ino）
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname, join } from "path";

const ARDUINO_LIB_DIR = join(homedir(), "Documents", "Arduino", "libraries");
const LIB_DIR = join(import.meta.dirname, "..", "..", "..", "libraries");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { code: null, sketchPath: null, headerPath: null, fqbn: null, libs: [], libName: null };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--code":
        opts.code = args[++i];
        break;
      case "--sketch":
        opts.sketchPath = args[++i];
        break;
      case "--header":
        opts.headerPath = args[++i];
        break;
      case "--fqbn":
        opts.fqbn = args[++i];
        break;
      case "--lib": {
        const val = args[++i];
        const [url, name] = val.split(",").map((s) => s.trim());
        if (url && name) opts.libs.push({ url, name });
        break;
      }
      case "--lib-sync": {
        opts.libName = args[++i];
        break;
      }
      case "--help":
      case "-h":
        console.log(`
用法:
  node compile.mjs --code "<ino程式碼>" --fqbn <FQBN> [--lib "url,name" ...]
  node compile.mjs --sketch <path> --fqbn <FQBN> [--lib "url,name" ...]
  node compile.mjs --header <path> --fqbn <FQBN> [--lib "url,name" ...]

選項:
  --code <string>      .ino 程式碼內容
  --sketch <path>      已有 .ino 檔案路徑
  --header <path>      單個 .h 檔案路徑（自動產生 wrapper .ino 編譯）
  --fqbn <string>      目標板 FQBN（必需，如 arduino:avr:uno）
  --lib "url,name"     從 GitHub clone 的庫（可多次使用）
  --lib-sync <name>    用 rsync 同步本地 library 到 Arduino libraries（從 ~/.claude/skills/arduino-compile/libraries/name/）
  -h, --help           顯示說明
`);
        process.exit(0);
    }
  }

  if (!opts.fqbn) {
    console.error("錯誤: 必須指定 --fqbn 參數");
    process.exit(1);
  }
  if (!opts.code && !opts.sketchPath && !opts.headerPath) {
    console.error("錯誤: 必須指定 --code 或 --sketch 或 --header 參數");
    process.exit(1);
  }

  return opts;
}

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts });
}

/**
 * 建立暫存 sketch 目錄，寫入 .ino 檔案
 * sketch 資料夾名必須與 .ino 檔案名一致
 */
function createTempSketch(code) {
  const sketchName = "sketch";
  const tmpDir = join(tmpdir(), `arduino-compile-${Date.now()}`);
  const sketchDir = join(tmpDir, sketchName);
  mkdirSync(sketchDir, { recursive: true });

  const inoPath = join(sketchDir, `${sketchName}.ino`);
  writeFileSync(inoPath, code, "utf-8");
  return { sketchDir, inoPath, tmpDir };
}

/**
 * 遞迴掃描目錄下所有子目錄，回傳完整路徑列表
 */
function scanDirsRecursive(dir) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      const full = join(dir, e.name);
      results.push(full, ...scanDirsRecursive(full));
    }
  }
  return results;
}

function scanLibraries() {
  const dirs = [ARDUINO_LIB_DIR, LIB_DIR];
  const results = [];
  for (const base of dirs) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const srcDir = join(base, entry.name, "src");
        if (existsSync(srcDir)) {
          results.push(srcDir, ...scanDirsRecursive(srcDir));
        }
      }
    }
  }
  return results;
}

function ensureLibDir() {
  if (!existsSync(ARDUINO_LIB_DIR)) {
    mkdirSync(ARDUINO_LIB_DIR, { recursive: true });
    console.log(`建立庫目錄: ${ARDUINO_LIB_DIR}`);
  }
}

/**
 * 將 header 絕對路徑轉成 library-style include 和對應的 .ino wrapper
 * ex: /libraries/MyLib/src/Sub.h → <Sub.h>, #include <Sub.h>
 * ex: /libraries/MyLib/src/modules/X.h → <modules/X.h>
 */
function resolveHeaderInclude(headerPath, extraDirs) {
  const makeInclude = (subPath) => ({
    include: `<${subPath}>`,
    code: `#include <${subPath}>\n\nvoid setup() {}\nvoid loop() {}`
  });

  // 1. 已在 ARDUINO_LIB_DIR → 原有邏輯
  const libPrefix = ARDUINO_LIB_DIR + "/";
  if (headerPath.startsWith(libPrefix)) {
    const after = headerPath.substring(libPrefix.length);
    const parts = after.split("/");
    if (parts.length >= 3 && parts[1] === "src") {
      return makeInclude(parts.slice(2).join("/"));
    }
    return makeInclude(parts.slice(1).join("/"));
  }
  // 2. 不在 ARDUINO_LIB_DIR → 搵 src/ 做 root，用相對 path
  const parts = headerPath.split("/");
  const srcIdx = parts.lastIndexOf("src");
  if (srcIdx !== -1) {
    const srcRoot = parts.slice(0, srcIdx + 1).join("/");
    const subPath = parts.slice(srcIdx + 1).join("/");
    extraDirs.push(srcRoot);
    return makeInclude(subPath);
  }
  // 3. 冇 src/ 目錄 → fallback: 用 parent dir 做 include root
  const parentDir = dirname(headerPath);
  extraDirs.push(parentDir);
  return makeInclude(basename(headerPath));
}

/**
 * 從本地 ~/.claude/skills/arduino-compile/libraries/ 同步 library 到 Arduino libraries
 */
function syncLocalLib(name, fallbackSrc) {
  const srcDir = join(LIB_DIR, name);
  const targetDir = join(ARDUINO_LIB_DIR, name);
  const actualSrc = existsSync(srcDir) ? srcDir : fallbackSrc;
  if (!actualSrc) {
    console.error(`錯誤: 找不到 library ${name}，不在 ${srcDir} 也未提供來源路徑`);
    process.exit(1);
  }
  console.log(`\n📋 同步本地庫: ${actualSrc} → ${targetDir}`);
  mkdirSync(targetDir, { recursive: true });
  run(`rsync -a "${actualSrc}/" "${targetDir}/"`, { timeout: 30000 });
  console.log(`✅ 同步完成: ${name}`);
}

/**
 * 從 GitHub clone 庫並用 rsync 同步到 Arduino 庫目錄
 */
function syncGithubLib(url, name) {
  const cloneDir = join(tmpdir(), `arduino-lib-clone-${Date.now()}-${name}`);

  console.log(`\n📦 克隆庫: ${name} (${url})`);
  run(`git clone --depth 1 "${url}" "${cloneDir}"`, { timeout: 60000 });

  const targetDir = join(ARDUINO_LIB_DIR, name);

  // 查找實際的庫目錄（有些 repo 的庫程式碼在子目錄中）
  let srcDir = cloneDir;
  if (existsSync(join(cloneDir, "src"))) {
    srcDir = join(cloneDir, "src");
  } else if (existsSync(join(cloneDir, "library.properties"))) {
    srcDir = cloneDir;
  } else {
    // 嘗試查找包含 library.properties 的子目錄
    try {
      const found = run(`find "${cloneDir}" -maxdepth 2 -name "library.properties" -type f 2>/dev/null | head -1`).trim();
      if (found) {
        srcDir = dirname(found);
      }
    } catch (_) {}
  }

  console.log(`📋 同步到: ${targetDir}`);
  // 確保目標目錄存在，先用 rsync 同步
  mkdirSync(targetDir, { recursive: true });
  run(`rsync -a "${srcDir}/" "${targetDir}/"`, { timeout: 30000 });

  // 清理 clone 暫存目錄
  rmSync(cloneDir, { recursive: true, force: true });

  console.log(`✅ 庫已同步: ${name} → ${targetDir}`);
}

/**
 * 編譯 sketch
 */
function compile(sketchDir, fqbn, extraIncludeDirs = []) {
  console.log(`\n🔨 編譯中... (FQBN: ${fqbn})`);
  try {
    let cmd = `arduino-cli compile --fqbn "${fqbn}"`;
    // 將 src/ 目錄及所有子目錄透過 -I 加入 compiler 搜尋路徑
    // 同時設定 compiler.c.extra_flags 和 compiler.cpp.extra_flags
    // 這樣就可以直接用 #include <modules/Bluetooth/BLEManager.h>
    if (extraIncludeDirs.length > 0) {
      const includes = extraIncludeDirs.map(d => `-I${d}`).join(" ");
      const escaped = includes.replace(/"/g, '\\"');
      cmd += ` --build-property "compiler.c.extra_flags=${escaped}" --build-property "compiler.cpp.extra_flags=${escaped}"`;
    }
    cmd += ` "${sketchDir}" 2>&1`;
    const output = run(cmd, { timeout: 120000 });
    return { success: true, output, errors: [] };
  } catch (e) {
    const stderr = e.stderr || e.stdout || e.message;
    const errors = stderr
      .split("\n")
      .filter((l) => /error:/i.test(l))
      .map((l) => l.trim());
    return { success: false, output: stderr, errors };
  }
}

// ============ Main ============

async function main() {
  const opts = parseArgs();
  let sketchDir, tmpDir, extraIncludeDirs = [];

  console.log("🚀 Arduino 編譯檢查開始\n");
  console.log(`📁 庫目錄: ${ARDUINO_LIB_DIR}`);

  ensureLibDir();

  // 1. 同步本地 library 到 Arduino libraries
  if (opts.libName) {
    syncLocalLib(opts.libName, opts.headerPath ? dirname(opts.headerPath) : null);
  }

  // 2. 處理 GitHub 庫同步
  if (opts.libs.length > 0) {
    for (const lib of opts.libs) {
      syncGithubLib(lib.url, lib.name);
    }
  }

  // 自動掃描 ~/Documents/Arduino/libraries/*/src/ 下所有子目錄加入 -I
  extraIncludeDirs = scanLibraries();

  // 2. 準備 sketch
  if (opts.code) {
    const result = createTempSketch(opts.code);
    sketchDir = result.sketchDir;
    tmpDir = result.tmpDir;
    console.log(`📝 建立暫存 sketch: ${result.inoPath}`);
  } else if (opts.sketchPath) {
    if (!existsSync(opts.sketchPath)) {
      console.error(`錯誤: 檔案不存在: ${opts.sketchPath}`);
      process.exit(1);
    }
    sketchDir = dirname(opts.sketchPath);
    tmpDir = null;
    console.log(`📂 使用已有 sketch: ${opts.sketchPath}`);
  } else if (opts.headerPath) {
    if (!existsSync(opts.headerPath)) {
      console.error(`錯誤: 檔案不存在: ${opts.headerPath}`);
      process.exit(1);
    }
    // 讀取 .h 檔案
    const { include, code: inoCode } = resolveHeaderInclude(opts.headerPath, extraIncludeDirs);

    console.log(`📄 編譯 header: ${opts.headerPath}`);
    console.log(`📋 使用 include 形式: #include ${include}`);

    // 產生 wrapper .ino（使用 library 風格的 include）
    const result = createTempSketch(inoCode);
    sketchDir = result.sketchDir;
    tmpDir = result.tmpDir;
    console.log(`📝 建立 wrapper sketch: ${result.inoPath}`);
    console.log(`📋 --- wrapper .ino 內容 ---\n${inoCode}\n--- wrapper .ino 結束 ---`);
  }

  // 3. 編譯
  const result = compile(sketchDir, opts.fqbn, extraIncludeDirs);

  // 4. 輸出結果
  if (result.success) {
    console.log(`\n✅ 編譯成功!\n`);
    console.log(result.output);
  } else {
    console.log(`\n❌ 編譯失敗!\n`);
    console.log(result.output);
    if (result.errors.length > 0) {
      console.log(`\n📋 錯誤摘要 (${result.errors.length} 個):`);
      result.errors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
    }
  }

  // 5. 清理暫存檔案
  if (tmpDir) {
    if (result.success) {
      rmSync(tmpDir, { recursive: true, force: true });
      console.log(`\n🧹 暫存檔案已清理`);
    } else {
      console.log(`\n📁 暫存 sketch 保留在: ${tmpDir}（編譯失敗，供除錯）`);
    }
  }

  // 6. 輸出 JSON 結果給 agent 解析
  const inoContent = opts.code || (opts.headerPath ? `#include "${opts.headerPath}"\n\nvoid setup() {}\nvoid loop() {}` : null);
  const output = {
    success: result.success,
    output: result.output,
    errors: result.errors,
    sketchDir: result.success ? null : tmpDir || sketchDir,
    inoContent: inoContent,
  };
  console.log(`\n---JSON-RESULT---\n${JSON.stringify(output)}\n---JSON-RESULT---`);

  process.exit(result.success ? 0 : 1);
}

main().catch((e) => {
  console.error("致命錯誤:", e.message);
  process.exit(1);
});