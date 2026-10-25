## 改了什么

<!-- 一两句说清改了什么、为什么。涉及界面的，在这里附预览图。 -->

## 关联 issue

<!-- fix/* 分支和带 bug 标签的 PR 必须保留下面这行：Closes / Fixes / Resolves / Refs + #编号。
     其他 PR（feat / docs / refactor）有相关任务就写 Refs #N，没有可以整段删掉。
     用法与流程见 docs/issue-workflow.md。 -->
Closes #N

## 本地门禁已跑

- [x] `npm run ci:local`（控件/体积/版本/密钥扫描 + typecheck + sync-server typecheck + 单测 + vite build + 产物密钥扫描；第一次跑之前先 `npm --prefix sync-server ci`）

## 安卓实测

<!-- 改动运行时代码（src/、android/、api*/、shared/、electron/、public/、构建配置）的 PR 必须实测后再提交，
     这一段由 `npm run pr` 从 preview/android-evidence.json 自动填充；实测怎么做见 skills/run-android/SKILL.md。
     创建 PR 时把截图拖进正文替换「证据」一行。纯文档/CI 改动会自动豁免（写明即可）。
     「Android field-test evidence」门禁会核对这一段：checkbox 已勾、设备/验证/证据三项都要是实际内容。 -->
- [ ] 已在模拟器/真机安装运行本 PR 的 APK，功能符合预期
- 设备：（模拟器名称或真机型号）
- 验证：（实测了什么，结果如何）
- 证据：（截图/logcat 摘要，或 preview/android-evidence.json 的内容）

## 界面

- [ ] 如涉及界面：已渲染预览图并请人工确认布局（见 docs/preview-rendering.md）

## 备注

<!-- 遗留项、已知风险、需要 review 重点关注的地方。 -->
