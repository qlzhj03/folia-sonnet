// ci/checkAndroidTest.ts
// PR 门禁：改动运行时代码的 PR，正文「## 安卓实测」段必须给出模拟器/真机的实测证据。
//   node ci/checkAndroidTest.ts --context pr-context.json        CI 里由 workflow 生成（gh pr view --json body,files 的输出）
//   node ci/checkAndroidTest.ts --text "正文" --files "a.ts,b.ts"   本地检查一段正文
//
// 判定分两步：先看改动文件是否碰运行时代码（src/、android/、api*/ 等），不碰就豁免；
// 碰了则正文必须有三样：勾选的实测 checkbox、非占位的「设备 / 验证 / 证据」三项。
// 实测怎么做、证据怎么留见 skills/run-android/SKILL.md；规则原文在 AGENTS.md 的「人与 agent 的分工」。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 会进 APK 或影响其构建的路径。纯文档 / CI / 测试改动不在此列，自动豁免。
export const RUNTIME_PATH_PREFIXES = ['src/', 'android/', 'api/', 'api-ts/', 'shared/', 'electron/', 'public/'];
export const RUNTIME_PATH_FILES = ['index.html', 'vite.config.ts', 'capacitor.config.ts', 'package.json', 'package-lock.json'];

export function touchesRuntime(files: string[]): boolean {
    return files.some((file) => {
        const normalized = file.trim().replace(/\\/g, '/');
        if (normalized === '') return false;
        return RUNTIME_PATH_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(prefix))
            || RUNTIME_PATH_FILES.includes(normalized);
    });
}

export type AndroidEvidenceField = 'device' | 'verification' | 'evidence';

export const FIELD_LABELS: Record<AndroidEvidenceField, string> = {
    device: '设备',
    verification: '验证',
    evidence: '证据',
};

// 「- 设备：xxx」一行里的值只括号括着一句说明（半角/全角都算），视为没填。PR 模板占位符就是这种形态。
export function isFilledValue(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed === '') return false;
    return !/^[（(][^）)]*[）)]$/.test(trimmed);
}

export interface AndroidEvidence {
    sectionFound: boolean;
    confirmed: boolean;
    fields: Partial<Record<AndroidEvidenceField, string>>;
}

/**
 * 从 PR 正文里取「## 安卓实测」段：checkbox 是否勾选、设备/验证/证据三项填了什么。
 * 段的边界是下一个 `## ` 标题；没有这一段时 sectionFound 为 false。
 */
export function parseAndroidSection(body: string | null | undefined): AndroidEvidence {
    const evidence: AndroidEvidence = { sectionFound: false, confirmed: false, fields: {} };
    const lines = (body ?? '').split(/\r?\n/);
    let inSection = false;
    for (const line of lines) {
        if (/^##\s/.test(line)) {
            inSection = /^##\s*安卓实测\s*$/.test(line);
            if (inSection) evidence.sectionFound = true;
            continue;
        }
        if (!inSection) continue;
        if (/^[-*]\s*\[x\]/i.test(line)) evidence.confirmed = true;
        const matched = /^[-*]\s*(设备|验证|证据)\s*[：:]\s*(.*)$/.exec(line);
        if (matched) {
            const field = matched[1] === '设备' ? 'device' : matched[1] === '验证' ? 'verification' : 'evidence';
            evidence.fields[field] = matched[2].trim();
        }
    }
    return evidence;
}

export interface AndroidTestGateResult {
    required: boolean;
    ok: boolean;
    /** 没过时给人看的原因，一条一句；过了为空。 */
    problems: string[];
}

export function evaluateAndroidTestGate(input: { body: string | null | undefined; files: string[] }): AndroidTestGateResult {
    if (!touchesRuntime(input.files)) {
        return { required: false, ok: true, problems: [] };
    }
    const problems: string[] = [];
    const evidence = parseAndroidSection(input.body);
    if (!evidence.sectionFound) {
        problems.push('正文缺少「## 安卓实测」段（改动包含运行时代码，必须实测后再提交 PR）。');
    } else {
        if (!evidence.confirmed) problems.push('「## 安卓实测」段的 checkbox 没有勾选（- [x]）。');
        for (const field of ['device', 'verification', 'evidence'] as AndroidEvidenceField[]) {
            if (!isFilledValue(evidence.fields[field] ?? '')) {
                problems.push(`「${FIELD_LABELS[field]}：」没有填写实际内容（占位括号不算）。`);
            }
        }
    }
    return { required: true, ok: problems.length === 0, problems };
}

// 门禁失败时给人看的话：先说该做什么，再说去哪读规则。
export function explainMissingEvidence(): string {
    return [
        '改动包含运行时代码的 PR，必须先在安卓模拟器或真机上实测再提交：',
        '1. node scripts/androidSmoke.mjs --note "实测了什么"   # 构建 APK、装机、截图、抓 logcat，证据写进 preview/android-evidence.json',
        '2. npm run pr -- "标题"                                # 单测全绿 + 实测证据核对通过后，生成 PR 正文和链接',
        '实测流程与证据要求见 skills/run-android/SKILL.md，规则原文见 AGENTS.md 的「人与 agent 的分工」。',
    ].join('\n');
}

// gh pr view --json body,files 的输出形态：files 是对象数组，取 filename。
function readContext(contextPath: string): { body: string; files: string[] } {
    const raw = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as {
        body?: string | null;
        files?: Array<{ filename?: string | null } | string>;
    };
    const files = (raw.files ?? []).map((file) => (typeof file === 'string' ? file : file.filename ?? '')).filter((name) => name.length > 0);
    return { body: raw.body ?? '', files };
}

function main(): void {
    const args = process.argv.slice(2);
    const contextIndex = args.indexOf('--context');
    const textIndex = args.indexOf('--text');
    const filesIndex = args.indexOf('--files');

    let body: string;
    let files: string[];
    if (contextIndex >= 0) {
        const contextPath = args[contextIndex + 1];
        if (!contextPath) {
            console.error('--context 需要一个文件路径（gh pr view --json body,files 的输出）。');
            process.exitCode = 1;
            return;
        }
        ({ body, files } = readContext(contextPath));
    } else if (textIndex >= 0) {
        body = args[textIndex + 1] ?? '';
        // 本地自查不给 --files 时按「要求实测」处理，让输出展示门禁要什么。
        files = filesIndex >= 0 && args[filesIndex + 1] ? args[filesIndex + 1].split(',').map((name) => name.trim()).filter(Boolean) : ['src/placeholder.ts'];
    } else {
        console.error('用法：node ci/checkAndroidTest.ts --context pr-context.json，或 --text "正文" [--files "a.ts,b.ts"]');
        process.exitCode = 1;
        return;
    }

    const result = evaluateAndroidTestGate({ body, files });
    if (!result.required) {
        console.log('安卓实测检查通过：本次改动不含运行时代码，自动豁免。');
        return;
    }
    if (!result.ok) {
        console.error(result.problems.join('\n'));
        console.error(explainMissingEvidence());
        process.exitCode = 1;
        return;
    }
    console.log('安卓实测检查通过：正文证据段完整。');
}

// 只有直接 `node ci/checkAndroidTest.ts` 才跑检查；被单测 import 时不产生副作用。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
