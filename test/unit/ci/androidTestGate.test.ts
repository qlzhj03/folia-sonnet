// test/unit/ci/androidTestGate.test.ts
// 安卓实测门禁的判定规则：哪些改动要求实测、正文证据段怎么算填了、什么情况下豁免。
// CI 的 android-test job 跑的是同一份实现（ci/checkAndroidTest.ts）。

import { describe, expect, it } from 'vitest';
import { evaluateAndroidTestGate, isFilledValue, parseAndroidSection, touchesRuntime } from '../../../ci/checkAndroidTest.ts';

describe('touchesRuntime（哪些改动要求实测）', () => {
    it('运行时代码的路径前缀与构建关键文件都算', () => {
        expect(touchesRuntime(['src/App.tsx'])).toBe(true);
        expect(touchesRuntime(['src/components/app/home/explore/index.tsx'])).toBe(true);
        expect(touchesRuntime(['android/app/src/main/java/top/izuna/foliamajor/MainActivity.java'])).toBe(true);
        expect(touchesRuntime(['api-ts/qq.ts'])).toBe(true);
        expect(touchesRuntime(['vite.config.ts'])).toBe(true);
        expect(touchesRuntime(['package-lock.json'])).toBe(true);
    });

    it('纯文档 / CI / 测试脚本改动豁免', () => {
        expect(touchesRuntime(['docs/issue-workflow.md', 'AGENTS.md'])).toBe(false);
        expect(touchesRuntime(['.github/workflows/ci.yml', 'ci/openPr.ts'])).toBe(false);
        expect(touchesRuntime(['test/unit/ci/issueLink.test.ts'])).toBe(false);
        expect(touchesRuntime([])).toBe(false);
    });

    it('同一条路径里的运行时与豁免混在一起时，只要碰了运行时就要求', () => {
        expect(touchesRuntime(['docs/readme.md', 'src/utils/foo.ts'])).toBe(true);
    });

    it('Windows 风格的反斜杠路径也认', () => {
        expect(touchesRuntime(['src\\components\\PlayerPanel.tsx'])).toBe(true);
    });
});

describe('parseAndroidSection（正文证据段的解析）', () => {
    const filledBody = [
        '## 改了什么',
        '修复了播放暂停。',
        '',
        '## 安卓实测',
        '',
        '- [x] 已在模拟器/真机安装运行本 PR 的 APK，功能符合预期',
        '- 设备：Medium Phone AVD（API 36 模拟器）',
        '- 验证：播放、暂停、切歌各三次，无卡顿',
        '- 证据：preview/android-20261026.png + logcat 无 FATAL',
        '',
        '## 备注',
        '无',
    ].join('\n');

    it('勾选、三项都填时能完整取回', () => {
        const parsed = parseAndroidSection(filledBody);
        expect(parsed.sectionFound).toBe(true);
        expect(parsed.confirmed).toBe(true);
        expect(parsed.fields).toEqual({
            device: 'Medium Phone AVD（API 36 模拟器）',
            verification: '播放、暂停、切歌各三次，无卡顿',
            evidence: 'preview/android-20261026.png + logcat 无 FATAL',
        });
    });

    it('段到下一个 ## 标题为止，后面的内容不算', () => {
        const parsed = parseAndroidSection(filledBody);
        expect(parsed.fields.device).not.toContain('无');
    });

    it('checkbox 没勾就是没确认', () => {
        const parsed = parseAndroidSection(filledBody.replace('- [x]', '- [ ]'));
        expect(parsed.confirmed).toBe(false);
    });

    it('没有安卓实测段、或正文为空时 sectionFound 为 false', () => {
        expect(parseAndroidSection('## 改了什么\n只有说明').sectionFound).toBe(false);
        expect(parseAndroidSection('').sectionFound).toBe(false);
        expect(parseAndroidSection(null).sectionFound).toBe(false);
    });

    it('半角冒号与前面有空格的写法也认', () => {
        const parsed = parseAndroidSection(['## 安卓实测', '- 设备: Pixel 7 真机', '- 验证 ： 冒号前后有空格'].join('\n'));
        expect(parsed.fields.device).toBe('Pixel 7 真机');
        expect(parsed.fields.verification).toBe('冒号前后有空格');
    });
});

describe('isFilledValue（值怎么算填了）', () => {
    it('空串和占位括号不算，真实内容算', () => {
        expect(isFilledValue('')).toBe(false);
        expect(isFilledValue('（模拟器名称或真机型号）')).toBe(false);
        expect(isFilledValue('(placeholder)')).toBe(false);
        expect(isFilledValue('Pixel 7 真机')).toBe(true);
        expect(isFilledValue('Medium Phone AVD，API 36')).toBe(true);
    });
});

describe('evaluateAndroidTestGate（整体判定）', () => {
    const goodBody = [
        '## 安卓实测',
        '- [x] 已实测',
        '- 设备：Medium Phone AVD',
        '- 验证：启动播放无崩溃',
        '- 证据：preview/android-x.png',
    ].join('\n');

    it('不含运行时改动的 PR 豁免通过', () => {
        const result = evaluateAndroidTestGate({ body: '', files: ['docs/a.md', 'ci/x.ts'] });
        expect(result).toEqual({ required: false, ok: true, problems: [] });
    });

    it('运行时改动 + 证据齐全时通过', () => {
        const result = evaluateAndroidTestGate({ body: goodBody, files: ['src/App.tsx'] });
        expect(result.required).toBe(true);
        expect(result.ok).toBe(true);
    });

    it('运行时改动但没有证据段时红，原因说清缺什么', () => {
        const result = evaluateAndroidTestGate({ body: '## 改了什么\n说明', files: ['src/App.tsx'] });
        expect(result.ok).toBe(false);
        expect(result.problems.some((line) => line.includes('缺少「## 安卓实测」段'))).toBe(true);
    });

    it('有段但 checkbox 没勾、三项留占位时逐条报出', () => {
        const body = [
            '## 安卓实测',
            '- [ ] 已实测',
            '- 设备：（模拟器名称或真机型号）',
            '- 验证：（实测了什么，结果如何）',
            '- 证据：（截图/logcat 摘要）',
        ].join('\n');
        const result = evaluateAndroidTestGate({ body, files: ['android/app/build.gradle'] });
        expect(result.ok).toBe(false);
        expect(result.problems).toHaveLength(4);
        expect(result.problems.some((line) => line.includes('checkbox'))).toBe(true);
        expect(result.problems.filter((line) => line.includes('没有填写实际内容'))).toHaveLength(3);
    });

    it('正文为 null 与空串同样处理', () => {
        const result = evaluateAndroidTestGate({ body: null, files: ['src/x.ts'] });
        expect(result.ok).toBe(false);
    });
});
