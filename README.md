# arduino-compile

> Claude Code skill：編譯 Arduino `.ino` sketch，檢查錯誤。支援多種板型、自動處理 library、GitHub 庫同步。

## 安裝

前置：[Claude Code](https://claude.ai/code) + [arduino-cli](https://arduino.github.io/arduino-cli/)（`arduino-cli core install arduino:avr`）

```bash
git clone https://github.com/KaitoHina/arduino-compile-skill.git
mkdir -p ~/.claude/skills && cp -r arduino-compile-skill ~/.claude/skills/arduino-compile
```

Project-scoped：`mkdir -p .claude/skills && cp -r ~/.claude/skills/arduino-compile .claude/skills/`

## 解除安裝

```bash
rm -rf ~/.claude/skills/arduino-compile
```

## 用法

喺 Claude Code 對話直接打 `/arduino-compile` 或自然語言描述，例如：

```text
/arduino-compile compile 呢段 code for Uno：void setup() { pinMode(13, OUTPUT); } ...
/arduino-compile check 下有冇 compilation error
/arduino-compile compile 呢個 library header 睇下有冇問題
```

或者直接行 `compile.mjs`：

```bash
# 編譯程式碼
node ~/.claude/skills/arduino-compile/compile.mjs --code 'void setup() {} void loop() {}' --fqbn arduino:avr:uno

# 編譯現有 sketch
node ~/.claude/skills/arduino-compile/compile.mjs --sketch ./Blink.ino --fqbn arduino:avr:uno

# 編譯 header
node ~/.claude/skills/arduino-compile/compile.mjs --header ./MyLib.h --fqbn arduino:avr:uno

# 加 GitHub library
node ~/.claude/skills/arduino-compile/compile.mjs --code '...' --fqbn esp32:esp32:esp32 --lib "https://github.com/adafruit/Adafruit-GFX-Library,Adafruit_GFX"

# 同步本地 library（開發庫源路徑，例如 git repo）
node ~/.claude/skills/arduino-compile/compile.mjs --lib-sync /Users/GodLight/Documents/Coding/GitHub/PeanutKing_Soccer
```

## 支援板型

| 板型 | FQBN |
|------|------|
| Uno | `arduino:avr:uno` |
| Mega | `arduino:avr:mega:cpu=atmega2560` |
| Nano | `arduino:avr:nano` |
| ESP32 | `esp32:esp32:esp32` |
| ESP8266 | `esp8266:esp8266:nodemcuv2` |

## 運作原理

```
你 → arduino-compile skill → compile.mjs → arduino-cli compile
```

- 自動處理 sketch 資料夾名 == .ino 檔名（arduino-cli 要求）
- `--header` 時自動加目標 library 嘅 `src/` root 做 `-I`，子路徑 header（如 `#include <modules/Sub/Header.h>`）可直接引用
- 唔掃全部 library 子目錄加 `-I`（避免同 SDK header 如 FreeRTOS `queue.h` 撞名，esp32 會 compile 失敗）
- 單獨 `.h` 檔自動產生 wrapper `.ino`
- `--lib-sync <path>`：將開發中嘅 library（源路徑）rsync 去 `~/Documents/Arduino/libraries/<basename>/`，可獨立執行或配合編譯指令
- 輸出 JSON 俾 agent 解析

## 目錄結構

```
arduino-compile/
├── SKILL.md          # skill 描述
└── compile.mjs       # 編譯腳本
```

## License

MIT
