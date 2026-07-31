---
name: arduino-compile
description: Compile Arduino .ino sketches and check for compilation errors. Use when asked to compile Arduino code, check Arduino code for errors, verify an Arduino sketch builds, or test Arduino libraries. Supports multiple board types (Uno, ESP32, Mega, etc.).
---

# arduino-compile

編譯 Arduino .ino sketch，檢查編譯錯誤。用 `compile.mjs` 驅動。

## 互動規則

- **（必須）問使用者使用 `AskUserQuestion` 功能**

- **沒指定板子（FQBN）→ 先問使用者**
- **沒指定要編譯的檔案 → `find src/ -name '*.h'`（排除 SDK 自帶），列出 .h 讓使用者選。若使用者說要測範例，則掃描 `examples/` 下的 .ino 檔。**
- **沒指定要編譯的 library → 掃描子目錄，（必須）給用戶列出 .h 檔（`find lib_dir/ -name '*.h'`），選定後用 `--header` 編譯。若使用者說要測範例，改掃 `examples/` 下的 .ino 用 `--sketch` 編譯。**
- **開發中嘅 library（喺 `~/Documents/Arduino/libraries/` 之外）要 compile 之前，必須先問使用者「要唔要 sync library 先？」**
  - 用戶話要 → 用 `find` 搵到 library 源路徑，行 `--lib-sync <path>` 同步去 `~/Documents/Arduino/libraries/`，再行 `--code` / `--sketch` / `--header`
  - 用戶話唔使 → 直接 compile
  - 原因：`arduino-cli` 只認 `~/Documents/Arduino/libraries/` 入面嘅 library；開發緊嘅庫（例如 git repo 喺 `~/Documents/Coding/GitHub/`）未必 sync 咗過去，唔 sync 可能會 compile 失敗
  - 已安裝喺 `~/Documents/Arduino/libraries/` 嘅 library **唔需要**問 sync

## Run（agent 路徑）

```bash
node ~/.claude/skills/arduino-compile/compile.mjs --code '<ino code>' --fqbn <FQBN>
node ~/.claude/skills/arduino-compile/compile.mjs --sketch ./path/to/sketch.ino --fqbn <FQBN>
node ~/.claude/skills/arduino-compile/compile.mjs --header ./path/to/header.h --fqbn <FQBN>
node ~/.claude/skills/arduino-compile/compile.mjs --lib-sync /path/to/lib-dir      # standalone sync
```

加 GitHub 庫：`--lib "https://github.com/user/repo,DirName"`
同步本地 library：`--lib-sync <path>`（完整路徑指向 library 根目錄——要有 `library.properties` 或 `src/`。會 rsync 去 `~/Documents/Arduino/libraries/<basename>/`，可獨立執行或配合編譯指令一齊用。Library 源冇固定位置，agent 應先用 `find` 搵路徑再傳入。）

## JSON 輸出

腳本最後輸出 `---JSON-RESULT---` 區塊，agent 用它解析結果：

```json
{"success":true,"output":"...","errors":[],"sketchDir":null}
```

- `success`: 編譯是否成功
- `errors`: 錯誤列表
- `sketchDir`: 失敗時保留的暫存目錄（供除錯）

## 注意

- `arduino-cli` 要求 **sketch 資料夾名 == .ino 檔名**，`compile.mjs` 已自動處理
- GitHub 庫的 `library.properties` 可能在根目錄或 `src/` 下，腳本會自動偵測
- `compile.mjs` **唔會**自動掃描所有 library 子目錄加 `-I`（避免同 SDK header 如 FreeRTOS `queue.h` 撞名，esp32 會 compile 失敗）。只會喺 `--header` 時加目標 library 嘅 `src/` root，子路徑 header（如 `#include <modules/Sub/Header.h>`）照樣可引用
- `--lib-sync` 會驗證路徑：唔存在 → `Not found`；唔係 library → `Not a library`（兩者都 exit 1）
