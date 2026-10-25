// test/unit/ci/openPr.test.ts
// 提 PR 准备脚本里的纯逻辑：认出 remote 里的 GitHub 仓库（HTTPS / SSH 都认）、决定 PR 建到哪、
// 解析命令行、核对安卓实测证据、生成正文和 compare 链接。main() 里的 git / npm 调用不在这里测。

import { describe, expect, it } from 'vitest';
import {
    buildPrBody,
    compareUrl,
    githubRepoFromRemote,
    parseArgs,
    parseRepoName,
    readAndroidEvidence,
    selectPrTarget,
    validateEvidence,
} from '../../../ci/openPr.ts';

describe('从 origin URL 解析 GitHub 仓库', () => {
    it('HTTPS 写法', () => {
        expect(githubRepoFromRemote('https://github.com/maimai993/folia-sonnet.git')).toEqual({ owner: 'maimai993', repo: 'folia-sonnet' });
        expect(githubRepoFromRemote('https://github.com/maimai993/folia-sonnet')).toEqual({ owner: 'maimai993', repo: 'folia-sonnet' });
    });

    it('SSH 写法（git@ 与 ssh:// 都认）', () => {
        expect(githubRepoFromRemote('git@github.com:maimai993/folia-sonnet.git')).toEqual({ owner: 'maimai993', repo: 'folia-sonnet' });
        expect(githubRepoFromRemote('ssh://git@github.com/maimai993/folia-sonnet.git')).toEqual({ owner: 'maimai993', repo: 'folia-sonnet' });
    });

    it('不是 GitHub 就返回 null', () => {
        expect(githubRepoFromRemote('https://gitlab.com/o/r.git')).toBeNull();
        expect(githubRepoFromRemote('/local/path/repo')).toBeNull();
    });
});

describe('parseRepoName（--repo 的值）', () => {
    it('认 owner/repo，允许带 .git 后缀', () => {
        expect(parseRepoName('maimai993/folia-sonnet')).toEqual({ owner: 'maimai993', repo: 'folia-sonnet' });
        expect(parseRepoName('maimai993/folia-sonnet.git')).toEqual({ owner: 'maimai993', repo: 'folia-sonnet' });
    });

    it('完整 URL、带斜杠或空格的写法都不认', () => {
        expect(parseRepoName('https://github.com/o/r')).toBeNull();
        expect(parseRepoName('o/r extra')).toBeNull();
        expect(parseRepoName('just-a-name')).toBeNull();
    });
});

describe('selectPrTarget（PR 建到哪个仓库）', () => {
    const forkOrigin = 'git@github.com:qlzhj03/folia-sonnet.git';
    const upstream = 'https://github.com/maimai993/folia-sonnet.git';

    it('fork 场景：有 upstream 且与 origin 不同时建到 upstream，head 前缀是 fork 的 owner', () => {
        expect(selectPrTarget(forkOrigin, upstream)).toEqual({
            repo: { owner: 'maimai993', repo: 'folia-sonnet' },
            headOwner: 'qlzhj03',
        });
    });

    it('没有 upstream 时建到 origin 本身，head 不加前缀', () => {
        expect(selectPrTarget(forkOrigin, null)).toEqual({
            repo: { owner: 'qlzhj03', repo: 'folia-sonnet' },
            headOwner: null,
        });
    });

    it('origin 和 upstream 是同一个仓库时不算 fork', () => {
        expect(selectPrTarget(forkOrigin, 'git@github.com:qlzhj03/folia-sonnet.git')).toEqual({
            repo: { owner: 'qlzhj03', repo: 'folia-sonnet' },
            headOwner: null,
        });
    });

    it('--repo 覆盖目标仓库，head 仍按 origin 是否同仓库判断', () => {
        expect(selectPrTarget(forkOrigin, null, 'maimai993/folia-sonnet')).toEqual({
            repo: { owner: 'maimai993', repo: 'folia-sonnet' },
            headOwner: 'qlzhj03',
        });
        expect(selectPrTarget(forkOrigin, null, 'qlzhj03/folia-sonnet.git')).toEqual({
            repo: { owner: 'qlzhj03', repo: 'folia-sonnet' },
            headOwner: null,
        });
    });

    it('origin 不是 GitHub、没有 upstream 也没有 --repo 时返回 null', () => {
        expect(selectPrTarget('https://gitlab.com/o/r.git', null)).toBeNull();
    });
});

describe('parseArgs（准备模式：没有 --skip-ci / --watch）', () => {
    it('默认值：base 是 dev，其余关闭', () => {
        expect(parseArgs([])).toEqual({ title: null, base: 'dev', issue: null, repo: null, help: false });
    });

    it('全部选项一起给，标题位置不限', () => {
        expect(parseArgs(['--issue', '42', '--base', 'main', '--repo', 'o/r', 'fix: 修好了'])).toEqual({
            title: 'fix: 修好了',
            base: 'main',
            issue: 42,
            repo: 'o/r',
            help: false,
        });
    });

    it('--help / -h 单独识别', () => {
        expect(parseArgs(['--help']).help).toBe(true);
        expect(parseArgs(['-h']).help).toBe(true);
    });

    it('--skip-ci / --watch 已删除，报错并说明门禁不可跳过', () => {
        expect(() => parseArgs(['--skip-ci', '标题'])).toThrow('不认识的参数');
        expect(() => parseArgs(['--watch'])).toThrow('不认识的参数');
    });

    it('未知参数、重复标题直接报错，避免把编号当成标题', () => {
        expect(() => parseArgs(['标题', '--wat'])).toThrow('不认识的参数');
        expect(() => parseArgs(['一个标题', '另一个标题'])).toThrow('标题只能给一个');
    });

    it('值选项缺值、--issue 不是正整数、--repo 不是 owner/repo 都报错', () => {
        expect(() => parseArgs(['--base'])).toThrow('--base 需要一个值');
        expect(() => parseArgs(['--issue', '--base'])).toThrow('--issue 需要一个值');
        expect(() => parseArgs(['--issue', 'abc'])).toThrow('--issue 需要 issue 编号');
        expect(() => parseArgs(['--issue', '0'])).toThrow('--issue 需要 issue 编号');
        expect(() => parseArgs(['--repo', '没有斜杠'])).toThrow('--repo 需要 owner/repo 形式');
    });
});

describe('readAndroidEvidence（证据文件解析）', () => {
    it('合法 JSON 取回字段', () => {
        const evidence = readAndroidEvidence('{"commit":"abc","crashed":false,"note":"播放三次"}');
        expect(evidence).not.toBeNull();
        expect(evidence!.commit).toBe('abc');
        expect(evidence!.crashed).toBe(false);
    });

    it('不是 JSON、或者不是对象时返回 null', () => {
        expect(readAndroidEvidence('不是 json')).toBeNull();
        expect(readAndroidEvidence('"只是字符串"')).toBeNull();
        expect(readAndroidEvidence('null')).toBeNull();
    });
});

describe('validateEvidence（证据核对）', () => {
    const head = 'commit-current';
    const base = { commit: head, crashed: false, note: '播放、暂停各三次，无崩溃' };

    it('commit 匹配、无崩溃、有说明时通过', () => {
        expect(validateEvidence(base, head)).toEqual({ ok: true, problems: [] });
    });

    it('崩溃过的证据不通过，并指向重跑实测', () => {
        const result = validateEvidence({ ...base, crashed: true }, head);
        expect(result.ok).toBe(false);
        expect(result.problems.some((line) => line.includes('崩溃'))).toBe(true);
    });

    it('commit 不是当前 HEAD（证据过期）不通过', () => {
        const result = validateEvidence({ ...base, commit: 'commit-old' }, head);
        expect(result.ok).toBe(false);
        expect(result.problems.some((line) => line.includes('过期'))).toBe(true);
    });

    it('说明为空或全是空白不通过，提示用 --skip-build 补跑', () => {
        const result = validateEvidence({ ...base, note: '   ' }, head);
        expect(result.ok).toBe(false);
        expect(result.problems.some((line) => line.includes('实测说明没写'))).toBe(true);
    });

    it('多项问题一起报', () => {
        const result = validateEvidence({ commit: 'old', crashed: true }, head);
        expect(result.problems).toHaveLength(3);
    });
});

describe('buildPrBody（准备模式的正文）', () => {
    const evidence = {
        commit: 'commit-x',
        device: { serial: 'emulator-5554', model: 'Medium Phone' },
        screenshot: 'preview/android-2026.png',
        logcat: 'preview/android-logcat-2026.txt',
        note: '启动播放、切歌，无崩溃',
    };

    it('运行时改动：安卓实测段由证据自动填充，checkbox 预勾', () => {
        const body = buildPrBody({ issue: 42, runtime: true, evidence });
        expect(body).toContain('Closes #42');
        expect(body).toContain('- [x] `npm run ci:local`');
        expect(body).toContain('## 安卓实测');
        expect(body).toContain('- [x] 已在模拟器/真机安装运行本 PR 的 APK');
        expect(body).toContain('- 设备：Medium Phone（serial emulator-5554）');
        expect(body).toContain('- 验证：启动播放、切歌，无崩溃');
        expect(body).toContain('- 证据：截图 preview/android-2026.png');
        expect(body).toContain('- 实测 commit：commit-x');
    });

    it('非运行时改动：实测段写明豁免', () => {
        const body = buildPrBody({ issue: null, runtime: false, evidence: null });
        expect(body).toContain('- [x] 本次改动不含运行时代码（纯文档/CI/测试），无需安卓实测');
        expect(body).not.toContain('Closes #');
        expect(body).toContain('Refs #编号');
    });
});

describe('compareUrl（给人创建 PR 的浏览器链接）', () => {
    it('fork 的 head 写成 owner:branch，指向目标仓库', () => {
        const target = selectPrTarget('git@github.com:qlzhj03/folia-sonnet.git', 'https://github.com/maimai993/folia-sonnet.git');
        expect(target).not.toBeNull();
        expect(compareUrl(target!, 'dev', 'fix/login-timeout')).toBe('https://github.com/maimai993/folia-sonnet/compare/dev...qlzhj03:fix/login-timeout?expand=1');
    });

    it('同仓库的 head 不加前缀', () => {
        const target = selectPrTarget('https://github.com/maimai993/folia-sonnet.git', null);
        expect(target).not.toBeNull();
        expect(compareUrl(target!, 'dev', 'fix/login-timeout')).toBe('https://github.com/maimai993/folia-sonnet/compare/dev...fix/login-timeout?expand=1');
    });
});
