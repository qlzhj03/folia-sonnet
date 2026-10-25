# 分支保护配置（owner 一次性操作）

本仓库的开发由 AI agent 主导（AGENTS.md「人与 agent 的分工」），流程上 agent 只准备 PR、不创建不合并。**把这件事变成硬门禁靠 GitHub 分支保护**——这只能在网页上由 admin 配置（脚本和 CI 账号都不是 admin），配一次即可。权威仓库是 `maimai993/folia-sonnet`。

对 `dev` 和 `main` 两个分支，Settings → Branches → Add rule（或编辑现有规则），逐项勾上：

## 1. 走 PR、由人审

- **Require a pull request before merging**
  - Require approvals: **1**——approval 只能由人给（AI review 是评论，永远不会变成 approval，见 AGENTS.md「CI」）。
  - Require review from Code Owners（仓库根 `.github/CODEOWNERS` 目前是 `* @maimai993`，按需调整）。
  - Dismiss stale pull request approvals when new commits are pushed（推荐，避免旧的 approval 盖住新代码）。
- **Do not allow bypassing the above settings**（对 admin 也生效；没有这条，保护形同虚设）。

## 2. Required status checks（CI 全绿才能合并）

Require status checks to pass before merging，勾选（名称必须与 job 名完全一致）：

- `Run unit tests`（typecheck + 单测）
- `Typecheck sync-server`
- `Build web bundle`（含产物密钥扫描）
- `Build android apk`（debug APK 出包 + artifact）
- `Version policy`
- `Secret guard`
- `UI gates`
- `Pull request links an issue`（fix 关联 issue 门禁）
- `Android field-test evidence`（安卓实测证据门禁）

注意：GitHub 的候选列表只显示**至少跑过一次**的 check。`Build android apk` 和 `Android field-test evidence` 是新加的 job——等第一个带着它们的 PR 跑过一次之后，再回来把这两项补进 required 列表。

可选项：Require branches to be up to date before merging（合并前要求与目标分支同步，减少「CI 测的是旧代码」的窗口；会多一点 rebase 成本，按团队习惯决定）。

## 3. 不许直接 push

- Restrict who can push to matching branches（不给任何人直接 push 权限）。`main`/`dev` 一律走 PR，见 AGENTS.md「分支与发版」。

## 4. 配完怎么验证

1. 开一个自测 PR：正文不带「安卓实测」段、改动里随便加一行 `src/` 注释——`Android field-test evidence` 和（若分支是 fix/*）`Pull request links an issue` 应该红，且没有 approval 时 Merge 按钮不可用。
2. 在本地试 `git push upstream dev`——应被拒绝（不是 admin bypass 不了）。
3. 配置入口：仓库页 **Settings → Branches → Branch protection rules**。`gh api repos/maimai993/folia-sonnet/branches --jq '.[].name'` 可核对分支名；保护状态非 admin 读不到（404 是正常的）。

## 5. 发版分支（可选）

`release/*` 分支由 android-release.yml 消费（推上去即出包），同样建议加保护：Require PR + 只允许 owner 操作，避免误推触发发版。`v*` 标签的保护（tag protection rule）同理可选。
