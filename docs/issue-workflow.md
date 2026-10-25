# issue 工作流

规则原文在 AGENTS.md 的「Bug 与 issue」与「人与 agent 的分工」两节；本文是操作说明：什么时候先提 issue、测试和实测怎么做、PR 怎么提交、门禁看什么、CI 红了的那条评论是什么意思。

权威仓库是 `maimai993/folia-sonnet`（PR 的目标，**默认分支是 `dev`**）；`qlzhj03/folia-sonnet` 是开发用的 fork，默认分支是 `main`。CI 与门禁都在权威仓库上跑。

## 先提 issue，再修 bug

要提：

- 能复现的 bug，尤其是别人报的、不是这次改动带出来的。
- 需要跨几次 PR 才能做完、或者要先讨论方案的问题。

不用提：

- 新功能、重构、文档：PR 里写清改了什么和为什么就够了（issue-link 门禁不要求关联）。
- 已经有同一条 issue：直接用它的编号，不要重复提。

提 issue 用 `gh issue create --repo maimai993/folia-sonnet`，或在网页 New issue（模板在 `.github/ISSUE_TEMPLATE/`）。标题写现象，正文写复现步骤、预期与实际、版本和平台。

## 流程

顺序是硬约束（AGENTS.md「人与 agent 的分工」）：先测试，后提交 PR；PR 的创建与合并由人完成。

1. 修 bug 先提 issue，记下编号（例如 `#42`）；新功能、重构、文档可以跳过这一步。
2. 从 `dev` 切 `feat/*` 或 `fix/*` 分支，在分支上改；**单元测试全部通过**。
3. 改动碰运行时代码（`src/`、`android/`、`api/`、`api-ts/`、`shared/`、`electron/`、`public/`、构建配置、`package.json`）时，**先在安卓模拟器/真机上实测**：`node scripts/androidSmoke.mjs --note "实测了什么"`（见 `skills/run-android/SKILL.md`），证据写进 `preview/android-evidence.json`。
4. `npm run pr -- "标题" [--issue 42]`：按顺序跑本地门禁 `npm run ci:local`（不可跳过）→ 核对实测证据（存在、无崩溃、commit 等于当前 HEAD）→ 推分支 → 生成 PR 正文 `preview/pr-body.md` 和 compare 链接。修 bug 加 `--issue 42`，正文自动写 `Closes #42`，合并后 GitHub 自动关掉这个 issue。
5. **人**在浏览器打开链接、粘贴 `preview/pr-body.md` 的内容、点 Create pull request。agent 不执行 `gh pr create`。
6. 盯 CI（含 `Android field-test evidence` 证据复核），红了当场修；修完推送会自动重跑。代码又改过的话，实测证据已过期，先重跑第 3 步。
7. 合并前至少一条 AI review 评论（见 AGENTS.md「CI」）；最终 approve 与合并由人完成。

## PR 关联写法

门禁只对 `fix/*` 分支和带 `bug` 标签的 PR 生效；它只认 **PR 正文** 里的动词 + `#编号`，大小写不敏感，动词与 `#` 之间可以有半角或全角空格：

```text
Closes #12
Fixes #3
Resolves #99
Refs #7
```

- 可以写多行、一行多条。`Closes` / `Fixes` / `Resolves` 表示合并时关掉 issue；`Refs` 只表示相关，不关。
- 下面这些不算关联，门禁会红：
  - 只写编号：`#12`
  - 只提到 issue：`见 issue 里的讨论`、`这个现象和 #12 一样`
  - 动词和编号不在同一行：`Closes` 换行 `#12`
  - 只写在标题里（门禁只看正文）
- 本地自查不需要 `GITHUB_TOKEN`：

```bash
node ci/checkIssueLink.ts --text "Closes #12"
```

判定实现在 `ci/checkIssueLink.ts`，用例在 `test/unit/ci/issueLink.test.ts`。

## 门禁行为

`.github/workflows/issue-link.yml`：PR 的 opened / edited / synchronize / reopened / labeled / unlabeled 事件，目标是 `dev` 或 `main` 时跑 `node ci/checkIssueLink.ts`。它读 `GITHUB_EVENT_PATH` 里这个 PR 的分支、标签和正文：

- 分支不是 `fix/*`、也没有 `bug` 标签：通过，日志里说明本次不要求关联。
- 否则正文没有关联就红，日志里给出失败原因和下一步。
- 改 PR 正文会触发 `edited` 重新判定；补上或去掉 `bug` 标签会触发 `labeled` / `unlabeled`，都不用重新推代码。
- 权限只有 `contents: read`。
- 它应设为 required check（清单见 `docs/branch-protection.md`，owner 在网页上配一次）。

## CI 红了的那条评论

`.github/workflows/ci-failure-notice.yml` 在 `CI` 这次运行失败后，在它对应的 PR 上留一条评论：

> CI 红了。若这是 bug：先 `gh issue create` 提 issue，再修复，PR 里写 `Closes #N`；动手前先读 AGENTS.md。

- 评论里带这次运行的链接。
- 同一个 PR 只有一条（固定标记 `<!-- ci-failure-notice -->`）：后续再红是更新那一条，不重复发。
- 找不到关联的 PR（`dev` / `main` 上的 push 运行、fork PR 关联为空）就直接跳过。
- 它只是提醒，不是门禁：真正拦合并的是 CI 和分支保护。

> 注意：GitHub 的 `workflow_run` 只运行**默认分支**上的 workflow 文件。权威仓库 `maimai993/folia-sonnet` 的默认分支是 `dev`，所以这个 workflow 合进 `dev` 即生效，不存在「先进 main 才生效」的空窗（早期文档写「默认分支是 main」，那是照着 origin fork 的默认分支写的，已更正）。issue-link 门禁同样合进 `dev` 即生效。

## 安卓实测门禁

`.github/workflows/android-test.yml`（job 名 `Android field-test evidence`）在 PR 打开、编辑、推送时复核正文：

- 改动文件不含运行时代码：豁免通过，日志说明「本次不要求安卓实测」。
- 含运行时代码：正文「## 安卓实测」段的 checkbox 必须已勾，`设备：`/`验证：`/`证据：` 三项必须是实际内容（模板占位括号不算），缺任一项就红。
- 本地自查：`node ci/checkAndroidTest.ts --text "正文" --files "a.ts,b.ts"`；判定实现在 `ci/checkAndroidTest.ts`，用例在 `test/unit/ci/androidTestGate.test.ts`。

实测怎么做（`scripts/androidSmoke.mjs`、证据要求）见 `skills/run-android/SKILL.md`；`npm run pr` 在本地先行核对同一份证据，CI 是第二道防线（防止正文被改掉或绕过本地脚本）。

## 相关文件

- `ci/checkIssueLink.ts`、`test/unit/ci/issueLink.test.ts`：关联判定与用例
- `ci/checkAndroidTest.ts`、`test/unit/ci/androidTestGate.test.ts`：安卓实测证据判定与用例
- `ci/openPr.ts`、`test/unit/ci/openPr.test.ts`：提 PR 准备脚本（顺序强制）与用例
- `scripts/androidSmoke.mjs`、`skills/run-android/SKILL.md`：安卓实测与证据链
- `.github/workflows/issue-link.yml`：关联门禁入口
- `.github/workflows/android-test.yml`：实测证据门禁入口
- `.github/workflows/ci-failure-notice.yml`：失败评论入口
- `.github/pull_request_template.md`：PR 模板
- `docs/branch-protection.md`：分支保护与 required check 的一次性配置清单
- `AGENTS.md`「Bug 与 issue」「人与 agent 的分工」：规则原文
