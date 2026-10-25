---
name: run-android
description: Use when a change touches runtime code (src/, android/, api/, api-ts/, shared/, electron/, public/, vite/capacitor config, package.json) and the PR is being prepared — run the app on an Android emulator or real device, verify the feature, capture screenshot/logcat evidence before submitting the PR. Also use when asked to install, launch, or manually test the Android APK locally.
---

# Run Android（安卓实测）

本仓库的发布形态是安卓 APK（Capacitor 容器）。**改动运行时代码的 PR，必须在安卓模拟器或真机上实测通过后才能提交**——这是 `npm run pr` 会核对的硬前置（证据锚定当前 HEAD），CI 的 `Android field-test evidence` 门禁也会复核 PR 正文。规则原文见 AGENTS.md 的「人与 agent 的分工」。

`scripts/androidSmoke.mjs` 一条命令完成：构建 debug APK → 装机 → 启动 → 截图 + logcat → 写证据 `preview/android-evidence.json`。

## 前置（本机一次性准备）

- JDK 21（`java -version` 确认；Android Studio 自带的 JBR 也行）。
- Android SDK：设好 `ANDROID_HOME`，或装在默认的 `~/Android/Sdk`；`adb` 在 `platform-tools/` 下，建议加进 PATH。
- 至少一台设备：`adb devices` 能看到且状态是 `device`。没有就先开一个模拟器（Android Studio → Device Manager → Medium Phone AVD 即可），或插真机并授权 USB 调试。
- 依赖已安装（`npm ci`）。

## 实测流程（agent 必须照做）

```bash
adb devices                                   # 0. 确认有设备；没有先开模拟器
node scripts/androidSmoke.mjs --note "播放、暂停、切歌各三次，无卡顿无崩溃"
```

可选参数：`--serial <adb serial>`（多台设备时指定）、`--wait-ms 15000`（首页加载慢、要过首启引导时加大）、`--skip-build`（代码没改，只补 `--note` 说明时复用上一轮 APK）。

脚本跑完输出三样东西（都在 gitignore 的 `preview/` 里）：

- `android-<时间戳>.png`：启动后的截图。
- `android-logcat-<时间戳>.txt`：本进程的 logcat。
- `android-evidence.json`：证据清单（commit、设备、崩溃判定、说明）。**它锚定跑实测那一刻的 HEAD**——之后再改代码、commit，这份证据就过期，`npm run pr` 会拒绝并要求重跑。

然后**必须**：

1. **用图片工具真的打开截图看一遍**，确认界面符合预期。只看脚本退出码、不看图，等于没实测。截图不清楚就加大 `--wait-ms` 重跑。
2. 看 logcat 里有没有 `FATAL EXCEPTION` / `ANR in`（脚本会判定并写进证据，但异常栈要自己读一遍定位）。
3. 冒烟只证明「能启动、不崩」。**改动涉及的具体功能要在设备上手动点一遍**（模拟器窗口直接操作），确认行为符合预期再算实测完成。

## 证据怎么进 PR

`npm run pr -- "标题"` 会读 `preview/android-evidence.json` 校验（存在、无崩溃、commit 匹配），通过后把设备/验证/证据自动填进 PR 正文的「安卓实测」段。所以实测说明（`--note`）要写「实测了什么、结果如何」，别写「正常」这种没法 review 的话。

## 常见问题

- `找不到 adb`：把 `<SDK>/platform-tools` 加进 PATH，或设 `ANDROID_HOME`。
- `没有可用设备`：模拟器没开或真机没授权，`adb devices` 里状态不是 `device`。
- 启动后停在首启引导页：这是新装包的正常状态；要验证引导之后的界面，手动过一遍引导后重跑脚本（可 `--skip-build`），或加大 `--wait-ms` 等它自己过去。
- 证据过期被 `npm run pr` 拒绝：代码改过了，重跑一遍脚本（web 产物变了的话去掉 `--skip-build`）。
