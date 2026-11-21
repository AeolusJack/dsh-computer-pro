# Computer Pro for DeepSeek Harness

Desktop control, local OCR, application launching and isolated Chromium DOM automation.
Maintained by [AeolusJack](https://github.com/AeolusJack). Community plugin; not affiliated with DeepSeek or OpenAI.

**Release status:** Windows x64 acceptance candidate. macOS arm64 and x64 adapters are experimental and have not been compiled or tested on a Mac. This is not a cross-platform production-certified release.

## Install the published package

Requires DeepSeek Harness **0.2.2-rc.5**, Node.js **24.9+**, and pnpm. Close Harness before an offline installation. Run in the Harness source checkout:

```sh
pnpm dsh plugin --profile web add "https://github.com/AeolusJack/dsh-computer-pro/releases/download/v0.2.0/dsh-windows-computer-pro-0.2.0.tgz"
```

Download and checksums: [v0.2.0 release](https://github.com/AeolusJack/dsh-computer-pro/releases/tag/v0.2.0). If your package manager cannot download the URL, download the `.tgz` there and supply its absolute local path to the same `add` command. The public archive was downloaded anonymously, checked against its SHA-256, installed into a separate Harness profile, and its configuration composition checked successfully.

For Git-based installation, the complete package is also available at `git+https://github.com/AeolusJack/dsh-computer-pro.git#a36555989323639c96f0c3437a8a8a52db3230ef`. The repository includes the prebuilt Windows x64 runtime; no additional helper download or .NET SDK is required for Windows. On macOS, Swift 6 / Xcode 16+ tools and macOS 14+ are required to build helpers locally. Grant Accessibility and Screen Recording permissions through macOS settings. Chrome or Edge is required for browser DOM tools.

After installation, start Harness and create a new session. Ask the agent to call `computer_pro_info`. Application-control permission remains with the upstream CUA permission flow. Do not enable another provider for `browserUse` at the same time.

## Validation and provenance

- 42 Node tests, 116 portable native protocol checks and 9 Windows desktop fixture checks passed on the development machine.
- Harness integration exercised launch-and-observe, OCR on a session attachment, DOM fill/click/readback, standard/PTC modes, separate browser sessions, and rejection of cross-session OCR references.
- Summary: [validation/windows-acceptance.json](validation/windows-acceptance.json). This evidence is from a single Windows machine, not independent certification.
- Modified Windows native source: `upstream-native/`; new OCR/launch source: `extras-native/windows/`; Mac helper: `native/macos/Extras.swift`.
- `payload-manifest.json` records hashes of the bundled Windows native files and the exact upstream commit. `node scripts/verify.mjs` verifies those bytes on Windows.
- Native libraries contain vendor license notices; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Known limits

Some Microsoft Store applications deny activation from Harness and must be opened manually. OCR may misread characters. Browser tools use separate per-session profiles, not personal browser login state. No UAC, lock-screen control or unattended login. Long-duration, multi-monitor/DPI, cross-machine and macOS acceptance remain outstanding. See [SECURITY.md](SECURITY.md) for data handling and permissions.

---

# Computer Pro 0.2.0

适配 DeepSeek Harness **0.2.2-rc.5**。保留 npm 名 `dsh-windows-computer-pro` 便于升级。Windows x64 已做本机验收；macOS Apple 芯片和 Intel 仅提供实验性适配，尚无 Mac 实机编译、签名、权限或运行验证。不是已获生产认证的产品。

## 功能

- 原生桌面：Windows UI Automation / macOS Accessibility、窗口、控件调用、键鼠、截图。保留官方授权。
- 工作流：精确控件选择、歧义拒绝、串行执行、正向等待、取消、输入后验证；不自动重放输入。
- 启动应用：`computer_pro_apps` 枚举启动目录，`computer_pro_launch` 按精确目录 ID 启动一次。启动 ID 与 cua ID 不同；启动后必须重新观察应用与窗口，不凭 dispatched 判断成功。
- 本地 OCR：`computer_pro_ocr_languages` 查询语言，`computer_pro_ocr` 读取当前会话已有图片。Windows OCR / Apple Vision，不上传图片。
- Chromium DOM：复用 Harness 固定的 Playwright MCP 0.0.80；实测 24 个工具，涵盖导航、快照、元素点击、表单、键盘、标签页、截图、脚本、控制台和网络信息。
- `computer_pro_info` 返回版本、平台、初始化代码和模块位置。

底层采用 DeepSeek MIT 开源 CUA；浏览器复用上游已集成的服务。不是 OpenAI 内部工具。

## 安装与版本约束

Windows：Windows 10 build 19041+，x64，Node.js 24.9+。自带 .NET 运行时，不需要 SDK。可双击交付的安装器，或在 Harness 目录中运行：

```powershell
pnpm dsh plugin --profile web add "C:\path\dsh-windows-computer-pro-0.2.0.tgz"
```

macOS 实验版：要求 macOS 14+、Swift 6（Xcode 16+ 开发工具）、同版本 Harness 源码安装、Node、pnpm、Chrome/Edge。同一 tgz 支持 arm64 / x64。在 Mac 上安装 Apple 开发工具后运行 `bash Install-macOS.command /path/to/deepseek-harness`。Harness 将构建其桌面 helper，本包首次使用 OCR/启动工具时用 `xcrun swiftc` 编译 Swift helper。需要用户授予辅助功能、录屏权限。没有已签名、公证的 Mac 安装器。

独立启用本包即可。若同时启用官方 Computer Use 组合包，本包必须排在官方之后，以禁用重复组件。不要同时启用另一个占用 browserUse 的浏览器后端；本包浏览器组件可单独禁用。更新后重新加载服务并新开会话，浏览器工具不会追加入已经运行的会话。

## 调用方式

标准模式使用 `cua_run_code`；PTC 使用 `run_code`，通过 `tools` 调用其他工具。`computer_pro_info` 返回两种模式的初始化代码。

```javascript
var { createDesktop } = await import("computer_pro_info 返回的 workflowModule");
var desktop = createDesktop(cua);
inspect(await desktop.findApps("记事本"));
var app = await desktop.selectApp("实际 cua 应用 ID");
inspect(await app.windows());
var win = await app.window("实际窗口 ID");
inspect(await win.observe());
await win.setValue({automationId:"实际控件 ID"}, "你好", {verify:true});
inspect(await win.screenshot());
```

选择器支持 name、role、automationId、value、enabled、selected 精确匹配，以及 nameContains。invoke 的 verify 可指定正向确认控件。`dispatched:true` 不等于业务完成；找不到控件不能证明它不存在。等待不能强制中断已经进入原生系统的调用。

`win.activate()` 是应用级激活。macOS 键盘作用域为应用，工作流要求选中窗口有可观察的焦点控件才发送键盘输入，`keyboardScope` 会说明作用域。不要在工作流之外并发操作同一应用。

启动工具只接受刚查询到的启动目录 ID，不接受任意命令或额外参数。部分 Windows 商店应用在 Harness 内会被系统拒绝激活；此时返回错误，请手动打开，不会自动提权。

OCR：先让一次工具调用返回截图，再在后续调用用其 attachmentId 调用 OCR。用户上传的会话图片也可识别。只从当前会话日志定位图片，拒绝跨会话读取与任意文件路径。返回图像尺寸及文本框；Windows 为词级框，macOS 为行级框。坐标是图像左上角像素，不能直接当全局桌面坐标。上限 32 MiB / 2500 万像素，另受系统边长限制。OCR 会误读与错误分词，不能作为业务成功的唯一依据。

浏览器：新会话中调用 `mcp__playwright-mcp__*`；PTC 中用 `tools["mcp__playwright-mcp__browser_snapshot"]({})`。以当前工具 schema 为准，本版 click 和 fill_form 使用 `target` 参数。每个会话独立 Chromium，默认可见，不接管个人浏览器标签页或登录资料。会话卸载后关闭，登录状态不承诺持久化。Firefox、Safari、个人浏览器附加模式未交付。

配置行 computer-pro-browser 支持 executablePath（绝对路径）、headless、toolCallTimeoutMs。默认发现 Windows Edge/Chrome 和 Mac Chrome/Edge/Chromium；找不到时记录提示并跳过 DOM 后端，保留其他功能。

## 稳定性与生产边界

Windows 后台直接在 Harness 管理的进程树启动，修复 Explorer COM 冷启动失败；不改系统策略、不提权。管道按用户、桌面会话、安装路径及原生版本隔离。一个 profile 不要运行多个 Harness 实例。关闭宿主会清理受它管理的子进程，被启动应用能否独立存活仍需按应用验证。

扩展工具最多排队 16 项，外部进程有输出上限、超时和取消。取消不能撤销已经发出的操作；失败后先观察再决定是否重试。浏览器继承上游文件访问边界；本机 Harness 报告文件沙箱仅部分实施，不是企业安全隔离。

没有 UAC/锁屏控制、无人值守登录、企业审计后台。多屏/DPI、远程桌面、自绘 UI、崩溃时按键释放、长时运行仍需验收。没有模型自主任务成功率和跨电脑生产稳定性承诺。哈希用于检测损坏，不是代码签名。

## 源码构建

Windows 原生源码基于清单中的 DeepSeek 提交，修改了程序集名和 SharedRuntime.cs 的启动/管道隔离。另有新增的 Windows OCR/启动程序与 Swift helper。

```powershell
dotnet publish upstream-native/entry/CuaWindows.csproj -c Release -r win-x64 --self-contained true -o native/win-x64
dotnet publish extras-native/windows/ComputerProExtras.csproj -c Release -r win-x64 --self-contained true -o native/win-x64
node scripts/manifest.mjs 2e39e70496aa02986ca6a820c5d497e816b69d7e
npm test
npm run verify
npm pack
```

先构建后更新清单，不要打包运行日志。Mac 上可用 `scripts/check-macos.sh` 做编译和能力检查，但仍需交互验收。

参考：[Harness](https://github.com/deepseek-ai/deepseek-harness)、[Playwright](https://playwright.dev/docs/library)、[Windows OCR](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine)、[Apple Vision](https://developer.apple.com/documentation/vision/recognizing-text-in-images)。
