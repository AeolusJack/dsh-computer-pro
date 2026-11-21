# Computer Pro for DeepSeek Harness

Windows desktop automation, local OCR, application launching, structured document editing, and isolated Chromium DOM tools.
Maintained by [AeolusJack](https://github.com/AeolusJack). Community software, not affiliated with DeepSeek or OpenAI.

**0.3.0: Windows acceptance candidate.** macOS remains experimental. Single-machine tests do not establish production certification or support for every application.

## 安装

需要 DeepSeek Harness **0.2.2-rc.5**、Node.js **24.9+**、pnpm；Windows 10 build 19041+、x64。Windows 包内含运行时，不需要 .NET SDK。更新正在运行的实例可在 DSH 插件管理页安装新版；命令行安装前关闭该 profile 的 Harness。

```powershell
pnpm dsh plugin --profile web add "https://github.com/AeolusJack/dsh-computer-pro/releases/download/v0.3.0/dsh-windows-computer-pro-0.3.0.tgz"
```

[发行包与校验值](https://github.com/AeolusJack/dsh-computer-pro/releases/tag/v0.3.0)。也可下载 tgz 后将上述 URL 换成绝对路径。安装后新开 DSH 会话，调用 `computer_pro_info` 确认版本。不要同时启用另一套占用 computerUse/browserUse 的提供器。

## 0.3.0 的 Windows 改进

| 问题 | 现在的行为 |
| --- | --- |
| 完全权限仍重复审批 | `fullAccessControlsDesktop: true` 默认开启。读取**当前会话**的完全权限，不再逐应用询问；每次调用重新核对。明确拒绝仍生效，不写入永久授权。关闭此选项即恢复上游审批流程。 |
| WPS 不在启动目录、COM 启动失败 | 合并用户/系统 App Paths、开始菜单快捷方式、AppsFolder 和运行进程；单个目录失败不丢弃其他结果。商店启动通过 Explorer 调度，普通程序直接启动。 |
| WPS 应用 ID 变化 | `selectApp` 可以使用已发现的 Windows exe 绝对路径；也提供按当前精确显示名重新查询的 `selectAppByName`。歧义仍拒绝。 |
| 频繁 FOREGROUND_REQUIRED | 工作流的 Windows 键盘操作先尝试激活应用。系统拒绝激活或前台是另一窗口时仍停止；不强行抢占或把键发往别处。可设 `autoActivate:false`。 |
| 关闭窗口后读树报错 | 无显式验证条件时返回 `dispatched-unverified` 和 `observationError`；用 `verify:{closed:true}` 检查窗口确实消失。显式验证失败仍报错。`strictObservation:true` 恢复旧行为。 |
| OCR 返回 JSON 字符串 | 附加工具和 info 返回对象，可直接读取 `.text` / `.data`。Windows OCR 支持区域裁剪与 1–3 倍放大，词框换算回原始附件像素。 |
| 不能操作任务栏/托盘 | 新增整桌面截图与系统指针 click/scroll/drag。支持显示器位置偏移与图像缩放换算；必须使用新截图凭证。 |
| WPS 正文/表格 UIA 为空 | 新增保存文件的 DOCX/RTF/TXT 正文读取、精确替换，以及 XLSX 单元格/公式读取和写入。无需 WPS COM 或可访问性树。 |

普通 UIA/API 不会凭空补齐自绘控件的信息。优先顺序应是：应用专用 API/文件数据 → UIA/DOM → 截图/OCR/坐标。`observe().coverage` 报告可命名控件占比，帮助识别半盲界面。

## 使用方式

标准模式使用 `cua_run_code`；PTC 使用 `run_code`。`computer_pro_info` 返回两种模式的初始化代码。工作流模块通过 info 返回的 URL 导入。

```javascript
var { createDesktop } = await import(workflowModule);
var desktop = createDesktop(cua);
var app = await desktop.selectApp(discoveredExePath);
inspect(await app.windows());
var win = await app.window(exactWindowId);
inspect(await win.observe());
await win.setValue({automationId: 'editor'}, '你好', {verify:true});
await win.invoke({role:'Button',name:'不保存'}, {verify:{closed:true}});
```

选择器支持 name、role、automationId、value、enabled、selected、nameContains。零个或多个匹配都拒绝。新增包装方法 `paste`、`performAction`、`selectText`；原有 `click`、`drag`、`scroll`、`typeText`、`pressKey`、`screenshot` 保留。每次输入仅派发一次，不因超时或观察失败自动重放。

### WPS / Office 文件

`computer_pro_office_read({path, sheet?, range?})` 读取保存文件。`computer_pro_office_edit_copy({path,outputPath,operations,sheet?,range?})` 先写暂存副本，全部修改成功并重新打开后才发布新文件；拒绝覆盖已有目标。

```javascript
// PTC 中直接通过 tools 调用；返回对象，无需 JSON.parse。
var doc = await tools.computer_pro_office_read({path: 'D:\\docs\\report.docx'});
inspect(doc.data.paragraphs);
await tools.computer_pro_office_edit_copy({
  path:'D:\\docs\\report.docx', outputPath:'D:\\docs\\report-edited.docx',
  operations:[{kind:'replaceText',find:'唯一的原文',replacement:'修改后的内容'}]
});
await tools.computer_pro_office_edit_copy({
  path:'D:\\docs\\data.xlsx', outputPath:'D:\\docs\\data-edited.xlsx',sheet:'Sheet1',range:'A1:D10',
  operations:[{kind:'setCell',sheet:'Sheet1',cell:'B2',expected:12,value:15}]
});
```

支持 DOCX、XLSX、RTF、UTF-8 TXT。DOCX 正文包括表格中的段落，不包括页眉页脚、批注；替换要求原文只出现一次且位于单一普通段落，可跨文字 run 并保留 run 格式。含修订、域或复杂段落的替换明确拒绝。RTF 由 Windows RichEdit 处理，复杂格式可能被规范化，须目视检查。

XLSX 返回值与公式分开；日期是数值序列。已有公式值是**上次保存的缓存**，工具不计算公式；编辑后清空公式缓存并标记下次由 WPS/Excel 重算。字符串以文字保存，公式必须显式用 `formula:'=...'`。拒绝合并单元格、受保护工作表及共享/数组公式直接修改。默认读取 A1:T50，上限 10000 单元格。所有这些工具只处理磁盘文件，不读取尚未保存的编辑内容。

### 系统指针与 OCR

`computer_pro_desktop_capture()` 返回附件、宽高、显示器信息和 `snapshotId`。随后 `computer_pro_desktop_action({snapshotId,action:'click',point:{x,y}})` 使用**返回图像内像素**。支持 `button`、`clickCount`；drag 还需 `to`，scroll 需 `delta`。截图凭证每个 agent 独立，30 秒有效、一次性使用；显示器布局变更后拒绝旧坐标。整桌面工具要求完全权限，存在明确拒绝的应用时停止，避免绕过应用拒绝。不会点 UAC 或锁屏，不会提权。Esc 可中断拖动，异常路径尝试释放按钮；进程被强杀/机器崩溃时不能保证释放。

OCR 接受当前会话已有图片的 `attachmentId`。可加 `region:{x,y,width,height}` 和 `scale:2`。返回框始终对应原附件尺寸，不能直接当物理屏幕坐标；放大不会恢复原图中不存在的细节。识别本地执行，但输出文本仍会进入配置的模型上下文。Windows 为词框，macOS 为行框。

### 浏览器、Blender、Unity

浏览器继续提供 `mcp__playwright-mcp__*` 的 DOM/表单/导航/脚本工具，每个会话独立 Chromium，不接管个人 Chrome 登录态。默认查找 Chrome/Edge。浏览器组件可设 executablePath、headless、toolCallTimeoutMs。

Blender 常通过其 Python API/后台命令行操作场景；Unity 常通过 C# Editor API、`-batchmode -executeMethod` 操作工程。它们的可靠性来自专用接口，而不是看图点击。这一版没有声称已交付或验收 Blender/Unity 专用适配器；DSH 已有脚本工具可以调用这些软件接口，桌面插件负责窗口和交互补充。

## 权限与限制

DSH 的文件完全权限本来不等同于应用授权。本插件的 `fullAccessControlsDesktop` 选项明确建立这项 Windows 映射。只读取真实当前会话策略，不自动修改策略、不自动回答批准问题、不持久化全权产生的应用授权。切回受限模式后，全权取得的句柄失效；既有人工授予的永久/会话授权按原规则保留。委派会话不使用这项快捷授权。

Windows 新增文件/系统指针工具和启动工具要求完全权限。普通受限模式下可继续使用已授权的上游 CUA 功能。无法保证消除操作系统或目标软件自己的对话框。多屏拓扑换算已实现，但多种硬件、远程桌面、混合 DPI 与长时间运行仍需验收。

本机当前测试环境的 Windows Graphics Capture 返回 E_ACCESSDENIED，因此上游单窗口截图项目存在限制；新增整桌面截图已通过测试。没有更改系统录屏策略或隐瞒失败。未把此项目计入成功数。自绘界面、复杂办公文档和公式计算仍有上述边界，不承诺所有软件都能无差别自动化。

macOS arm64/x64 适配器保持实验状态，需要 macOS 14+、Swift 6 / Xcode 16+，以及系统辅助功能、录屏授权。0.3.0 的 Windows 专用改进没有宣称通过 Mac 验收。

## 验证与源码

测试结果见 `validation/`。测试窗口和文档均为自建样本，未修改用户办公文件。Windows 包核对所有运行时哈希；哈希不是签名或独立安全审计。

```powershell
node scripts/vendor.mjs D:/deepseek-harness
dotnet publish extras-native/windows/ComputerProExtras.csproj -c Release -r win-x64 --self-contained true -o native/win-x64
node scripts/manifest.mjs 2e39e70496aa02986ca6a820c5d497e816b69d7e
npm test
$env:DSH_SOURCE='D:\deepseek-harness'
node --import ./test/host-loader.mjs --test test/permissions.host.mjs
npm run verify
npm pack
```

`src/vendor/` 是固定上游提交的 MIT 运行时及小范围权限补丁；生成脚本遇到上游结构变化会停止。Windows 主 helper 继续沿用经验证的 0.2.0 程序，新增功能在 extras helper 中。不要打包运行日志。依赖和许可证见 THIRD_PARTY_NOTICES.md。
