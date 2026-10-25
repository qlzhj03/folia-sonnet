// ci/openPr.ts
// 提 PR 的准备脚本：本地门禁 → 实测证据核对 → 推分支 → 生成 PR 正文和 compare 链接。
// 用法：npm run pr -- "fix: 一句话标题" [--issue 42] [--base dev] [--repo owner/repo]
//
// 流程顺序是硬约束（AGENTS.md「人与 agent 的分工」）：先测试（单测全绿 + 安卓实测取证），
// 后提交 PR。脚本只做「准备」：**创建 PR 由人在浏览器完成，agent 不执行 gh pr create / gh pr merge**。
// 顺序即检查顺序：
//   1. 参数与分支检查（fix/* 必须 --issue；拒绝 main/dev、未提交的改动）
//   2. npm run ci:local（不可跳过，单测必须全绿）
//   3. 改动碰运行时代码时核对 preview/android-evidence.json（存在、无崩溃、commit 等于当前 HEAD）
//   4. 都过了才 push；PR 正文写进 preview/pr-body.md，打印 compare 链接交给人创建
//
// 目标仓库：有 upstream remote 且与 origin 不同时（fork 场景），compare 链接指向 upstream，head 写 <fork 的 owner>:<分支>。
//
// 所有 CLI 解析都在 main() 里：这个文件会被单测 import，模块顶层不能碰 process.exit。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { touchesRuntime } from './checkAndroidTest.ts';

const USAGE = `用法：npm run pr -- "标题" [选项]

  --issue <编号>  关联 issue，正文自动写 Closes #<编号>；fix/* 分支必填
  --base <分支>   目标分支，默认 dev
  --repo <仓库>   目标仓库，owner/repo；有 upstream remote 时默认用它，否则用 origin

脚本会按顺序做：本地门禁（npm run ci:local，不可跳过）→ 改动碰运行时代码时核对安卓实测证据
（node scripts/androidSmoke.mjs 生成 preview/android-evidence.json，commit 必须是当前 HEAD）→
推分支 → 把 PR 正文写进 preview/pr-body.md 并打印 compare 链接。

创建 PR 由人在浏览器完成：打开链接、粘贴 preview/pr-body.md 的内容、点 Create pull request。
agent 不执行 gh pr create / gh pr merge（AGENTS.md「人与 agent 的分工」）。

完整例子：
  git switch -c fix/login-timeout origin/dev
  node scripts/androidSmoke.mjs --note "实测说明"      # 改动碰运行时代码时
  git add -A && git commit -m "fix: 登录超时后不再卡住"
  npm run pr -- "fix: 登录超时后不再卡住" --issue 42
`;

export interface GithubRepo {
    owner: string;
    repo: string;
}

export interface PrTarget {
    repo: GithubRepo;
    /** 跨仓库 PR 的 head 前缀（fork 的 owner）；同仓库 PR 为 null。 */
    headOwner: string | null;
}

export interface PrArgs {
    title: string | null;
    base: string;
    issue: number | null;
    repo: string | null;
    help: boolean;
}

/** 从 remote 的 URL 里取出 GitHub 的 owner/repo；HTTPS、ssh://、git@ 三种写法都认。 */
export function githubRepoFromRemote(url: string): GithubRepo | null {
    const matched = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url.trim());
    return matched ? { owner: matched[1], repo: matched[2] } : null;
}

/** 解析 --repo 的 owner/repo；允许带 .git 后缀。 */
export function parseRepoName(value: string): GithubRepo | null {
    const matched = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(value.trim());
    return matched ? { owner: matched[1], repo: matched[2] } : null;
}

/**
 * 决定 PR 建到哪个仓库：
 * - 有 upstream 且与 origin 不同：建到 upstream，head 用 origin 的 owner（fork → upstream）；
 * - 否则建到 origin；
 * - --repo 覆盖目标仓库，head 仍按 origin 是否同仓库判断。
 */
export function selectPrTarget(originUrl: string, upstreamUrl: string | null | undefined, repoOverride?: string | null): PrTarget | null {
    const origin = githubRepoFromRemote(originUrl);
    const upstream = upstreamUrl ? githubRepoFromRemote(upstreamUrl) : null;
    const override = repoOverride ? parseRepoName(repoOverride) : null;
    const repo = override ?? (upstream && (!origin || upstream.owner !== origin.owner || upstream.repo !== origin.repo) ? upstream : origin);
    if (!repo) return null;
    const isSameRepo = origin !== null && origin.owner === repo.owner && origin.repo === repo.repo;
    return { repo, headOwner: origin && !isSameRepo ? origin.owner : null };
}

const VALUE_FLAGS = new Set(['--base', '--issue', '--repo']);

/** 解析命令行；标题只能有一个，未知参数直接报错，避免把 --issue 的编号当成标题。 */
export function parseArgs(argv: string[]): PrArgs {
    const args: PrArgs = { title: null, base: 'dev', issue: null, repo: null, help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') {
            args.help = true;
            continue;
        }
        if (VALUE_FLAGS.has(arg)) {
            const value = argv[index + 1];
            if (!value || value.startsWith('--')) throw new Error(`${arg} 需要一个值`);
            index += 1;
            if (arg === '--base') args.base = value;
            else if (arg === '--repo') args.repo = value;
            else {
                if (!/^[1-9]\d*$/.test(value)) throw new Error('--issue 需要 issue 编号（正整数）');
                args.issue = Number(value);
            }
            continue;
        }
        if (arg.startsWith('-')) throw new Error(`不认识的参数：${arg}（本地门禁不可跳过，没有 --skip-ci）`);
        if (args.title !== null) throw new Error(`标题只能给一个：${args.title} / ${arg}`);
        args.title = arg;
    }
    if (args.repo && !parseRepoName(args.repo)) throw new Error('--repo 需要 owner/repo 形式');
    return args;
}

/** scripts/androidSmoke.mjs 写进 preview/android-evidence.json 的证据清单。 */
export interface AndroidEvidenceFile {
    commit?: string | null;
    branch?: string | null;
    timestamp?: string;
    device?: { serial?: string; model?: string } | null;
    apk?: string;
    screenshot?: string;
    logcat?: string;
    crashed?: boolean;
    note?: string;
}

/** 解析证据文件内容；不是合法 JSON 时返回 null，由调用方按「没有证据」处理。 */
export function readAndroidEvidence(content: string): AndroidEvidenceFile | null {
    try {
        const parsed = JSON.parse(content) as AndroidEvidenceFile;
        return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * 核对实测证据能不能支撑这次提交：没崩过、说明写了、commit 是当前的 HEAD。
 * 证据锚定 HEAD 是刻意的：代码改过就必须重跑实测（skills/run-android）。
 */
export function validateEvidence(evidence: AndroidEvidenceFile, head: string): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    if (evidence.crashed) problems.push('上次实测判定崩溃（FATAL/ANR 或启动即退）：先看 logcat 修复问题，再重跑实测。');
    if (!evidence.note || !evidence.note.trim()) problems.push('实测说明没写：node scripts/androidSmoke.mjs --note "实测了什么，结果如何" --skip-build 补上。');
    if (evidence.commit !== head) problems.push(`实测证据过期：证据来自 ${evidence.commit ?? '未知 commit'}，当前 HEAD 是 ${head}。代码改过之后必须重跑 node scripts/androidSmoke.mjs。`);
    return { ok: problems.length === 0, problems };
}

/**
 * 生成的 PR 正文（写进 preview/pr-body.md，由人粘贴到浏览器）：
 * 运行时改动时「安卓实测」段由证据自动填充；纯文档/CI 改动写明豁免。
 */
export function buildPrBody(options: { issue: number | null; runtime: boolean; evidence?: AndroidEvidenceFile | null }): string {
    const androidLines = options.runtime
        ? [
            '- [x] 已在模拟器/真机安装运行本 PR 的 APK，功能符合预期',
            `- 设备：${options.evidence?.device?.model || '未知型号'}（serial ${options.evidence?.device?.serial || '未知'}）`,
            `- 验证：${(options.evidence?.note ?? '').trim()}`,
            `- 证据：截图 ${options.evidence?.screenshot ?? ''}、logcat ${options.evidence?.logcat ?? ''}（本机 preview/ 目录；创建 PR 时把截图拖进正文替换本行）`,
            `- 实测 commit：${options.evidence?.commit ?? ''}`,
        ]
        : ['- [x] 本次改动不含运行时代码（纯文档/CI/测试），无需安卓实测'];
    return [
        '## 改了什么',
        '（一句话说明改了什么、为什么）',
        '',
        '## 关联 issue',
        options.issue === null ? '（非 fix/* 且没有 bug 标签时可以不关联；有相关任务就写 `Refs #编号`）' : `Closes #${options.issue}`,
        '',
        '## 本地门禁已跑',
        '- [x] `npm run ci:local`（控件/体积/版本/密钥扫描 + typecheck + sync-server typecheck + 单测 + vite build + 产物密钥扫描）',
        '',
        '## 安卓实测',
        ...androidLines,
        '',
        '## 界面',
        '- [ ] 如涉及界面：已渲染预览图并请人工确认布局（见 docs/preview-rendering.md）',
        '',
        '## 备注',
        '（遗留项、已知风险、需要 review 重点关注的地方。）',
    ].join('\n');
}

/** 给人打开的 compare 链接；fork 的 head 要写成 owner:branch。 */
export function compareUrl(target: PrTarget, base: string, branch: string): string {
    const head = target.headOwner ? `${target.headOwner}:${branch}` : branch;
    return `https://github.com/${target.repo.owner}/${target.repo.repo}/compare/${base}...${head}?expand=1`;
}

function run(command: string, args: string[], capture = false): string {
    const result = spawnSync(command, args, {
        stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
        encoding: 'utf8',
    });
    if (result.error || result.status !== 0) {
        console.error(`\n[pr] 这一步失败了：${command} ${args.join(' ')}`);
        process.exit(result.status ?? 1);
    }
    return (result.stdout ?? '').trim();
}

function tryRun(command: string, args: string[]): boolean {
    const result = spawnSync(command, args, { stdio: 'ignore' });
    return !result.error && result.status === 0;
}

/** 找 base 分支在本地的落点：优先 upstream/<base>（权威仓库），其次 origin/<base>，最后本地 <base>。 */
function resolveBaseRef(base: string): string | null {
    for (const candidate of [`upstream/${base}`, `origin/${base}`, base]) {
        if (tryRun('git', ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])) return candidate;
    }
    return null;
}

function main(): void {
    const argv = process.argv.slice(2);
    let args: PrArgs;
    try {
        args = parseArgs(argv);
    } catch (error) {
        console.error(`[pr] ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
        process.exit(1);
    }

    if (args.help || argv.length === 0) {
        console.log(USAGE);
        process.exit(argv.length === 0 ? 1 : 0);
    }
    if (!args.title) {
        console.error('缺少标题。\n\n' + USAGE);
        process.exit(1);
    }
    const prTitle: string = args.title;
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], true);
    if (branch === 'main' || branch === 'dev') {
        console.error(`[pr] 不能直接往 ${branch} 提 PR。先切分支：git switch -c fix/你的改动 origin/dev`);
        process.exit(1);
    }
    if (branch.startsWith('fix/') && args.issue === null) {
        console.error('[pr] fix/* 的 PR 必须关联 issue。先 gh issue create 建 issue，然后在命令末尾加 --issue <编号>。');
        process.exit(1);
    }
    if (run('git', ['status', '--porcelain'], true)) {
        console.error('[pr] 还有没提交的改动。先 git add -A && git commit -m "..."，再跑一次。');
        process.exit(1);
    }

    const originUrl = run('git', ['remote', 'get-url', 'origin'], true);
    const upstreamUrl = tryRun('git', ['remote', 'get-url', 'upstream']) ? run('git', ['remote', 'get-url', 'upstream'], true) : null;
    const target = selectPrTarget(originUrl, upstreamUrl, args.repo);
    if (!target) {
        console.error('[pr] origin / upstream 都不是 GitHub 仓库，请用 --repo owner/repo 指定目标。');
        process.exit(1);
    }
    const forkNote = target.headOwner ? `（从 fork ${target.headOwner} 提交）` : '';
    console.log(`\n[pr] 分支 ${branch} → ${target.repo.owner}/${target.repo.repo}:${args.base}${forkNote}\n`);

    // 顺序即检查顺序：先测试，后提交。本地门禁（单测必须全绿）不可跳过。
    console.log('[pr] 1/4 本地门禁（与 CI 同一套）');
    run(npm, ['run', 'ci:local']);

    console.log('\n[pr] 2/4 核对安卓实测证据');
    const head = run('git', ['rev-parse', 'HEAD'], true);
    const baseRef = resolveBaseRef(args.base);
    const changedFiles = baseRef
        ? run('git', ['diff', '--name-only', `${baseRef}...${head}`], true).split(/\r?\n/).filter((line) => line.length > 0)
        : [];
    const runtime = touchesRuntime(changedFiles);
    let evidence: AndroidEvidenceFile | null = null;
    if (runtime) {
        console.log(`[pr] 改动碰运行时代码（如 ${changedFiles.find((file) => touchesRuntime([file]))}），要求实测证据。`);
        const evidencePath = path.join('preview', 'android-evidence.json');
        if (!fs.existsSync(evidencePath)) {
            console.error(`[pr] 缺少 ${evidencePath}：先在模拟器/真机上实测：node scripts/androidSmoke.mjs --note "实测了什么"（见 skills/run-android/SKILL.md）。`);
            process.exit(1);
        }
        evidence = readAndroidEvidence(fs.readFileSync(evidencePath, 'utf8'));
        if (!evidence) {
            console.error(`[pr] ${evidencePath} 不是合法的证据文件：重跑 node scripts/androidSmoke.mjs 重新生成。`);
            process.exit(1);
        }
        const verdict = validateEvidence(evidence, head);
        if (!verdict.ok) {
            console.error(`[pr] 实测证据核对不通过：\n  - ${verdict.problems.join('\n  - ')}`);
            process.exit(1);
        }
        console.log(`[pr] 证据有效：${evidence.device?.model || '未知型号'}，${evidence.timestamp ?? ''}，commit ${head.slice(0, 8)}。`);
    } else {
        console.log('[pr] 本次改动不含运行时代码，豁免安卓实测。');
    }

    console.log('\n[pr] 3/4 推分支');
    run('git', ['push', '-u', 'origin', 'HEAD']);

    console.log('\n[pr] 4/4 准备 PR 正文（创建由人完成）');
    const body = buildPrBody({ issue: args.issue, runtime, evidence });
    const bodyPath = path.join('preview', 'pr-body.md');
    fs.mkdirSync('preview', { recursive: true });
    fs.writeFileSync(bodyPath, `${body}\n`);
    console.log(`[pr] PR 正文已写进 ${bodyPath}`);

    const url = compareUrl(target, args.base, branch);
    console.log(`\n[pr] 接下来由人完成：\n  1. 打开 ${url}\n  2. 粘贴 ${bodyPath} 的内容（界面改动把预览截图一并附上）\n  3. 点 Create pull request`);
    console.log('[pr] PR 建好之后 agent 要做：盯 CI 全绿（gh pr checks <编号> --watch，或 PR 页 Checks 标签）、发一条 AI review 评论（gh pr review <编号> --comment --body-file review.md）。合并由人确认。');
}

// 只有直接运行才走 CLI；单测 import 时没有副作用。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
