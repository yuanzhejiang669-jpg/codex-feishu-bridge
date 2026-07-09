# Codex Desktop Control MCP

这是一个 Windows 桌面控制 MCP server，面向 Codex 的真实桌面自动化。它优先提供可诊断、可降级的操作路径，而不是只依赖单一截图或坐标方法。

## 能力

- 窗口状态和自检：`codex_desktop_control_status`、`codex_desktop_control_self_check`
- 截图、OCR、找文字：`codex_desktop_control_screenshot`、`codex_desktop_control_ocr`、`codex_desktop_control_find_text`、`codex_desktop_control_wait_for_text`
- UI 检测：`codex_desktop_control_detect_ui_elements`
- 坐标动作：`codex_desktop_control_click`、`codex_desktop_control_double_click`、`codex_desktop_control_hotkey`
- 粘贴文本：`codex_desktop_control_paste_text`，默认会尝试恢复原剪贴板文本格式
- UI Automation 语义层：`codex_desktop_control_uia_status`、`codex_desktop_control_uia_tree`、`codex_desktop_control_uia_find`、`codex_desktop_control_uia_click`

## 降级策略

`self_check` 会区分基础服务是否可用和当前交互桌面是否可捕获：

- `ok`: MCP server、依赖、视觉 fallback、剪贴板等基础能力是否正常
- `desktop_available`: 当前会话能否枚举窗口并截图
- `uia.available`: 是否可用 UI Automation 语义控件路径

当桌面截图不可用时，服务不会被误判为坏掉，而是明确提示窗口、截图、坐标动作可能失败。当 UIA 不可用时，Agent 应回退到 OCR、视觉 fallback 和坐标动作。

## UIA 依赖

核心依赖见 `requirements.txt`。UIA 语义层使用：

```text
uiautomation
comtypes
```

未安装或当前会话权限不足时，`codex_desktop_control_uia_status` 会稳定返回 `available: false`，不会影响已有 OCR、视觉和坐标能力。不同 Windows session/沙箱权限下 UIA 可见的控件树可能不同，先用 `codex_desktop_control_uia_tree` 诊断当前可见 root 和子控件。

## 验证

```powershell
python scripts\verify_all.py
python scripts\desktop_protocol_smoke_test.py
python scripts\desktop_smoke_test.py
python scripts\desktop_notepad_e2e_test.py
```

`desktop_smoke_test.py` 使用系统临时目录创建合成 UI 图片，不依赖用户 home 目录可写。

`desktop_notepad_e2e_test.py` 会启动 Notepad，覆盖窗口激活、粘贴、OCR 验证和截图，并在结束时清理测试进程和临时目录。

## 依赖和模型

`requirements.txt` 使用当前已验证环境的 pinned 版本；`requirements.lock.txt` 保留同一组直接依赖锁定。

UI 检测模型默认路径为：

```text
%CODEX_DESKTOP_CONTROL_OUTPUT_DIR%\weights\icon_detect\model.pt
```

安装或更新模型：

```powershell
python scripts\install_ui_model.py --source <url-or-local-model.pt> --sha256 <optional-sha256>
```

也可以用环境变量 `CODEX_DESKTOP_CONTROL_UI_MODEL_SOURCE` 和 `CODEX_DESKTOP_CONTROL_UI_MODEL_SHA256`。`codex_desktop_control_status` 与 `self_check` 会返回模型路径、hash、安装脚本和修复命令。

公开工具失败时会返回稳定 `code`，例如 `VALIDATION_ERROR`、`WINDOW_NOT_FOUND`、`COORD_OUT_OF_BOUNDS`、`UIA_UNAVAILABLE`、`OCR_UNAVAILABLE`、`UI_MODEL_MISSING`、`CLIPBOARD_UNAVAILABLE` 和 `TIMEOUT`。
