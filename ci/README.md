# ci

新 CI 的落地目录：检查逻辑都写在这里，`.github/workflows/` 只留薄入口调它。

## 现在有什么

- `checkVersionPolicy.ts`：版本约束检查，`npm run check:versions`。CI 的 `version-policy` job 和 `test/unit/versionPolicy.test.ts` 跑的是同一份实现。
  查的是：平台依赖钉死且与 `deploy/docker/<平台>-api/package.json` 同版本；`.nvmrc`、`engines.node` 与各 workflow 的 `node-version` 一致；版本号满足 `android/app/build.gradle` 的 versionCode 推导；锁文件版本和 `package.json` 同步。
- `contracts/extract.ts`：把三份隐式契约抽成 `docs/contracts/manifest/` 下的 manifest —— `electron/preload.cjs` 的 contextBridge 暴露面、`sync-server/src/app.ts` 挂载的路由、`src/services/onlineMusic/providerRegistry.ts` 注册的 omni provider。`node ci/contracts/extract.ts` 校验 manifest 与当前实现一致，`--update` 重写；`test/unit/contracts/contractsDrift.test.ts` 跑同一份实现，实现改了而 manifest 没跟上时 CI 红。
- `uiPolicy.ts`：两条重构门禁。`npm run check:ui` 禁止在 `src/components/ui/` 与设置页 kit 之外手写 `<button>/<input>/<select>/<textarea>`；`npm run check:size` 禁止文件超过 800 行。基线 `uiControlBaseline.json`、`fileSizeBaseline.json` 只许变小，收紧时跑 `node ci/uiPolicy.ts all --update`。
- `checkSecrets.ts`：密钥泄漏门禁。`node ci/checkSecrets.ts` 扫 `.env.example` 与 `src/`、`electron/`、`shared/`、`api/`：名字里带 KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL/AUTH 的 `VITE_` 变量（Vite 会把值内联进前端包），以及 `sk-`、`AIza`、`ghp_`、`github_pat_`、`xox[baprs]-`、`Bearer` 这类明文密钥形态；`node ci/checkSecrets.ts --dist dist` 在打包之后扫产物（CI 的 `build-web` 跑这条）。假值走 `secretsAllowlist.json`，每条必须写理由。检查项清单与规则见 `docs/contracts/secrets-guard.md`。
- `checkIssueLink.ts`：PR 正文必须关联 issue 的判定（`fix/*` 分支与带 `bug` 标签的 PR），`issue-link.yml` 调它；本地自查 `node ci/checkIssueLink.ts --text "Closes #12"`。用例在 `test/unit/ci/issueLink.test.ts`。
- `checkAndroidTest.ts`：PR 正文「安卓实测」证据段的判定（改动含运行时代码时要求 checkbox 已勾、设备/验证/证据三项非占位），`android-test.yml` 调它；本地自查 `node ci/checkAndroidTest.ts --text "正文" --files "a.ts,b.ts"`。用例在 `test/unit/ci/androidTestGate.test.ts`。
- `openPr.ts`：提 PR 准备脚本（`npm run pr`），见下文；用例在 `test/unit/ci/openPr.test.ts`。

## workflow 入口

GitHub 只运行 `.github/workflows/*.yml`，子目录不读。所以那里只能放入口：

- `ci.yml`：调本目录的检查，加上 typecheck、单测、`vite build` 冒烟、`build-android`（`assembleDebug` 出 debug APK 上传 artifact）。
- `android-release.yml`：APK/AAB 出包，`release/*` 分支、`v*` 标签或手动触发。
- `issue-link.yml`、`android-test.yml`：两条 PR 正文门禁。
- `ci-failure-notice.yml`：CI 红了在 PR 上留指引评论。
- 服务器端沿用：`docker-stack-check`、`docker-stack-publish`、`sync-server-docker-publish`；以及 `triage-*`、`codemap-sync`。
- **桌面端 CI 已下线**（本仓库主要维护安卓）：`electron-release`、`canary-pre-release`、`nightly-pre-release`、`release-candidate`、`linux-arm64-package-check` 已删除；桌面端本地开发脚本（`dev:electron`、`build:electron`）保留。

## 提 PR：先测试，后提交；创建由人完成

流程顺序是硬约束（AGENTS.md「人与 agent 的分工」），`npm run pr` 在工具层强制：

```text
git switch -c fix/登录超时 origin/dev                  # 1. 从 dev 切分支
# ...改代码，单元测试全部通过...
node scripts/androidSmoke.mjs --note "实测说明"        # 2. 运行时改动必做：安卓模拟器/真机实测取证
npm run pr -- "fix: 登录超时后不再卡住" --issue 42      # 3. 本地门禁 → 证据核对 → 推分支 → 生成正文和链接
# 4. 人打开 compare 链接、粘贴 preview/pr-body.md、点 Create pull request
# 5. 盯 CI：有 gh 用 gh pr checks <PR号> --watch，没有就开 PR 页面的 Checks 标签
```

`npm run pr` 会按顺序做这些，做不了就当场说清楚原因：

- 拒绝在 `main` / `dev` 上直接提 PR；`fix/*` 分支要求 `--issue <编号>`（先 `gh issue create` 建 issue）；拒绝还有没提交的改动；
- **先跑 `npm run ci:local`**（与 CI 同一套，没有 `--skip-ci`，单测必须全绿）；
- **再核对安卓实测证据** `preview/android-evidence.json`：改动碰运行时代码（`src/`、`android/`、`api*/`、`shared/`、`electron/`、`public/`、构建配置、`package.json`）时，证据必须存在、无崩溃判定、且 commit 等于当前 HEAD——代码改过就过期，要求重跑实测；纯文档/CI 改动豁免；
- 都过了才 `git push -u origin`（HTTPS 或 SSH 都行，用你 git 自己的凭据）；
- 把 PR 正文写进 `preview/pr-body.md`（`安卓实测` 段由证据自动填充），打印 **compare 链接**——**创建 PR 由人在浏览器完成**，agent 不执行 `gh pr create` / `gh pr merge`；
- fork 场景：配了 `upstream` remote 且与 `origin` 不同时，链接指向 upstream，head 写 `<fork 的 owner>:<分支>`；`--repo owner/repo` 可以手动指定。

**`gh` 是可选的**：建 issue（`gh issue create`）、盯 CI（`gh pr checks --watch`）、发 review 评论（`gh pr review --comment`）、编辑 PR 内容（`gh pr edit`）用它方便；提 PR 的路径本身完全不依赖 gh。

**Windows 上的已知失败**：`npm run ci:local` 里 `test/unit/mod-system/modSignature.test.ts` 有一个用例要在临时目录建符号链接，没开「开发者模式」或不是管理员时会被 EPERM 拒。不是你改出来的；其余通过就能开 PR，这一项以 Linux 的 CI 为准。

**合并前必须有 review**（至少一次 AI review 评论 + 人 approve，最终合并由人点）：有 gh 用 `gh pr review <PR号> --comment --body-file review.md`，没有就在网页 **Files changed → Review changes → Comment** 里写。只在聊天里说「看过了」不算。

## 加一个检查

1. 本目录写脚本。Node 24 能直接跑 TypeScript（`node ci/xxx.ts`），不装依赖，所以能在没有 `npm ci` 的 job 里跑。
2. `package.json` 加一条 `npm run` script（需要单独入口时）。
3. 对应 workflow 里加一个 step；需要 `node_modules` 的检查放进带 `npm ci` 缓存的 job。
4. 逻辑里能单独测的部分，在 `test/unit/` 补一条用例（参考 `versionPolicy.test.ts`、`test/unit/ci/`）。
