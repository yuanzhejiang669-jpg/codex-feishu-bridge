# CLI 后端升级：文件与交接索引

## 最终交付

源码/规划主目录：`C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge-cli-backend`。

- `docs/codex-cli-backend-upgrade-plan-2026-09-08.md`：目标、策略与验收条件。
- `docs/codex-cli-backend-upgrade-execution-2026-09-08.md`：最新设备矩阵在最前，随后是过程记录。
- 本文件：文件树、报告、临时产物及清理边界。
- Linux独立工作区：`C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge-cli-linux`。两工作区分别发布main与linux/ubuntu-client，不混合发行渠道。

下面列出主目录内本次有意新增/修改的源文件（与基线2579be0相比）；Linux对应同名文件与其独立版本号：

```text
apps/desktop/package-lock.json
apps/desktop/package.json
apps/desktop/src/main/index.cjs
apps/desktop/src/main/services/environment.cjs
apps/desktop/src/main/services/supervisor.cjs
apps/desktop/src/renderer/app.js
apps/desktop/test/environment.test.cjs
apps/desktop/test/supervisor.test.cjs
codex-feishu-bridge.mjs
package.json
scripts/resolve-installed-codex.cjs
src/codex/installed-runtime.cjs
src/config/env.mjs
src/runtime/single-instance-lock.mjs
start-codex-feishu-bridge.ps1
test/installed-runtime.test.cjs
test/single-instance-lock.test.mjs
```

初始规划/执行记录也保留于原目录`C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge\docs\`中的同名两个文件；原目录Pi分支及用户修改未合入此次发布。正式后续记录以本主目录为准。

## 完整路径清单与证据

本机报告目录：`C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge-cli-backend\.codex-work\cli-upgrade\0.8.22`。

- `local-artifact-files.txt`：本机两个新工作区内的源码、依赖、generated/engine、打包out、helper、下载/分段、截图、JSON报告与pending-upgrades文件的绝对路径。列出安装树的完整集合，含未改变项。
- `oldpc-artifact-files.txt`：旧Windows独立CLI安装、正式Bridge安装树、两轮pending-upgrades产物。
- `mac-artifact-files.txt`：Mac两轮临时目录（含旧应用回滚目录）、新CLI、正式应用、新Git工作区。
- `ubuntu-artifact-files.txt`：Ubuntu两轮临时目录、新CLI、正式应用、新Git源码。
- `oldpc-final-verification.json`、`oldpc-process-verification.json`、`mac-final-verification.json`、`ubuntu-final-verification.json`：最终Bot与进程验收；远程原件在下列目录。
- 上一级`cli-upgrade`内`local-native-cli-verification.json`、`oldpc-cli-verification.json`与Mac/Ubuntu各临时目录的`cli-verification.json`：10个唯一配置空间的真实CLI初始化/模型列表/最小回复证据。

所有下载、派生、重建包均只有与官方完整SHA256一致后才使用。分段文件、blockmap、checksum、完整包与未完成尝试均在清单内，不将下载进度当安装结果。

## 各设备产生的文件位置

| 设备 | 安装/源码 | 临时/验证/待安装 |
|---|---|---|
| 当前Windows | `C:\Users\yzjiang\Documents\Codex\tools\codex-feishu-bridge-cli-backend`；同级`codex-feishu-bridge-cli-linux` | `C:\Users\yzjiang\AppData\Local\CodexFeishuBridgeDesktop\pending-upgrades\cli-0.8.21`、`cli-0.8.22`；本主目录`.codex-work` |
| 旧Windows | `C:\Users\12644\AppData\Local\Programs\Codex Feishu Bridge`；`C:\Users\12644\AppData\Roaming\npm\node_modules\@openai\codex`；`C:\Users\12644\Documents\Codex\tools\codex-feishu-bridge` | `C:\Users\12644\AppData\Local\CodexFeishuBridgeDesktop\pending-upgrades\cli-0.8.21`、`cli-0.8.22`；下方列出的Temp helper |
| Mac | `/Applications/Codex Feishu Bridge.app`；`/Users/cathyhuang/.local/share/codex-cli/0.153.4`；`/Users/cathyhuang/.local/bin/codex`；`/Users/cathyhuang/Documents/Codex/tools/codex-feishu-bridge-cli-backend` | `/tmp/cfb-cli-upgrade.XYakJW`；`/tmp/cfb-upgrade-0822.XsaAua` |
| Ubuntu | `/opt/Codex Feishu Bridge`；`/home/yzj666/.local/share/codex-cli/0.153.4`；`/home/yzj666/.local/bin/codex`；`/home/yzj666/Codex/tools/codex-feishu-bridge-cli-backend` | `/tmp/cfb-cli-upgrade.86CowP`；`/tmp/cfb-upgrade-0822.umhYc2` |

旧Windows Temp helper根为`C:\Users\12644\AppData\Local\Temp`；本次文件名：

```text
device-inventory.cjs
oldpc-inventory.ps1
prepare-oldpc.ps1
upgrade-windows.ps1
schedule-oldpc.ps1
verify-cli.mjs
verify-oldpc.ps1
inspect-oldpc-upgrade.ps1
inspect-oldpc-locks.ps1
inspect-stale-oldpc.ps1
repair-stale-oldpc.ps1
final-verify-oldpc.ps1
schedule-upgrade.ps1
download-release.cjs
download-delta.cjs
download-and-schedule-oldpc.ps1
start-download-oldpc.ps1
status-upgrade.ps1
inventory-artifacts.cjs
finish-oldpc-audit.ps1
```

安装程序亦更新标准安装元数据/快捷方式（Windows每用户Start Menu与卸载记录；Ubuntu dpkg数据库、`/usr/bin/codex-feishu-bridge` alternatives、桌面图标缓存）。npm ci/install产生平台npm缓存与日志；Git fetch/worktree/commit更新原仓库`.git`中的objects/refs/logs/worktrees。它们不是用户配置改动。Bot运行还正常写各设备Bridge数据目录下`runtime-localappdata/CodexFeishuBridge/instances/<Bot>/state`、`logs`及Codex自身运行日志；不能把这些运行记录误认为清空/替换会话。

## 已清理与后续清理

- 旧Windows仅删除失效的`C:\Users\12644\AppData\Local\CodexFeishuBridgeDesktop\runtime-localappdata\CodexFeishuBridge\instances\codex-assistant-old-baike-5\state\bridge.pid`和同目录`bridge.lock.json`，之后由正常启动生成新标记；未删会话。
- 自动测试的临时`cfb-*`目录由测试finally清理；旧Windows0821/0822升级任务与被替代下载任务已注销，当前Windows0821任务已注销，0822任务仍等待空闲。Ubuntu当前GUI单位为`cfb-upgrade-launch-0822.service`，是维持正常桌面进程的用户临时服务，不应在运行中清除。
- 当前Windows验收尚未结束，暂保留下载、helper、日志及两份Mac旧应用作为可核对/回滚证据。完成后仅按上述清单清理本次临时产物；不得递归删除用户Home、工作区根、Bot状态目录或任何未登记资料。
