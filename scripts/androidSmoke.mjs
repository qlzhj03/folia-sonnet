#!/usr/bin/env node
// scripts/androidSmoke.mjs
// 安卓实测冒烟：构建 debug APK → 装到 adb 设备（模拟器或真机）→ 启动 → 截图 + logcat → 证据写进 preview/android-evidence.json。
// 用法：node scripts/androidSmoke.mjs [--skip-build] [--serial <adb serial>] [--wait-ms 8000] [--note "实测了什么"]
//
// 本地要具备：JDK 21、Android SDK（ANDROID_HOME 或 ~/Android/Sdk）、至少一台 `adb devices` 可见且已授权的设备。
// 证据的 commit 字段锚定当前 HEAD：之后代码再有改动，npm run pr 会拒绝并要求重跑实测（先测试后提交的硬约束）。
// 什么时候必须实测、截图要怎么核对，见 skills/run-android/SKILL.md。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PACKAGE = 'top.izuna.foliamajor';
const ACTIVITY = `${PACKAGE}/.MainActivity`;
const APK_PATH = path.join('android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const PREVIEW_DIR = 'preview';
const EVIDENCE_PATH = path.join(PREVIEW_DIR, 'android-evidence.json');

const USAGE = `用法：node scripts/androidSmoke.mjs [选项]

  --skip-build        复用上一轮构建的 APK（代码没改、只补实测说明时用）
  --serial <serial>   多台设备时指定 adb serial；不指定取第一台可用设备
  --wait-ms <毫秒>     启动后等待多久再截图，默认 8000
  --note "说明"       实测了什么、结果如何；提交 PR 时会写进正文，必填
  --help              显示本说明

流程与要求见 skills/run-android/SKILL.md。`;

function parseArgs(argv) {
    const args = { skipBuild: false, serial: null, waitMs: 8000, note: null, help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--skip-build') args.skipBuild = true;
        else if (arg === '--serial') { args.serial = argv[++index] ?? null; }
        else if (arg === '--wait-ms') { const value = Number(argv[++index]); if (Number.isFinite(value) && value > 0) args.waitMs = value; }
        else if (arg === '--note') { args.note = argv[++index] ?? null; }
        else throw new Error(`不认识的参数：${arg}`);
    }
    return args;
}

// adb 优先取 PATH 里的，其次 ANDROID_HOME / 常见 SDK 路径。
function resolveAdb() {
    const candidates = ['adb'];
    const homes = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(process.env.HOME ?? '', 'Android', 'Sdk')].filter(Boolean);
    for (const home of homes) candidates.push(path.join(home, 'platform-tools', 'adb'));
    for (const candidate of candidates) {
        const probe = spawnSync(candidate, ['version'], { stdio: 'ignore' });
        if (!probe.error && probe.status === 0) return candidate;
    }
    return null;
}

function adb(adbPath, serial, args, options = {}) {
    return spawnSync(adbPath, ['-s', serial, ...args], { encoding: options.binary ? undefined : 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
    if (result.status !== 0) {
        console.error(`[androidSmoke] 这一步失败了：${command} ${args.join(' ')}`);
        process.exit(result.status ?? 1);
    }
    return result;
}

function git(query) {
    const result = spawnSync('git', query, { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}

function pickDevice(adbPath, wanted) {
    const listing = spawnSync(adbPath, ['devices'], { encoding: 'utf8' });
    if (listing.status !== 0) {
        console.error('[androidSmoke] adb devices 跑不了，检查 Android SDK 安装。');
        process.exit(1);
    }
    const devices = listing.stdout.split(/\r?\n/).slice(1)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2 && parts[1] === 'device')
        .map((parts) => parts[0]);
    if (devices.length === 0) {
        console.error('[androidSmoke] 没有可用设备。先启动模拟器（或插上真机并授权 USB 调试），再跑一次；可用 `adb devices` 确认。');
        process.exit(1);
    }
    if (wanted) {
        if (!devices.includes(wanted)) {
            console.error(`[androidSmoke] 指定的 --serial ${wanted} 不在可用列表里：${devices.join('、')}`);
            process.exit(1);
        }
        return wanted;
    }
    if (devices.length > 1) console.warn(`[androidSmoke] 检测到多台设备（${devices.join('、')}），取第一台；要指定请加 --serial。`);
    return devices[0];
}

function main() {
    const argv = process.argv.slice(2);
    let args;
    try {
        args = parseArgs(argv);
    } catch (error) {
        console.error(`[androidSmoke] ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
        process.exit(1);
    }
    if (args.help || argv.length === 0) {
        console.log(USAGE);
        process.exit(argv.length === 0 ? 1 : 0);
    }

    const adbPath = resolveAdb();
    if (!adbPath) {
        console.error('[androidSmoke] 找不到 adb：装好 Android SDK 后把 platform-tools 加进 PATH，或设 ANDROID_HOME。');
        process.exit(1);
    }
    const serial = pickDevice(adbPath, args.serial);

    console.log(`[androidSmoke] 1/5 构建与安装（设备 ${serial}）`);
    if (!args.skipBuild) {
        run('npm', ['run', 'cap:sync:android']);
        const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
        run(gradlew, ['assembleDebug', '--stacktrace'], { cwd: path.resolve('android') });
    } else {
        console.log('[androidSmoke] --skip-build：跳过构建，复用上一轮 APK。');
    }
    if (!fs.existsSync(APK_PATH)) {
        console.error(`[androidSmoke] 找不到 ${APK_PATH}：先去掉 --skip-build 完整构建一次。`);
        process.exit(1);
    }
    const install = adb(adbPath, serial, ['install', '-r', path.resolve(APK_PATH)]);
    if (install.status !== 0) {
        console.error(`[androidSmoke] 安装失败：${install.stdout ?? ''}${install.stderr ?? ''}`);
        process.exit(1);
    }

    console.log('[androidSmoke] 2/5 启动应用');
    adb(adbPath, serial, ['logcat', '-c']);
    const start = adb(adbPath, serial, ['shell', 'am', 'start', '-W', '-n', ACTIVITY]);
    if (start.status !== 0 || /Error type 3|Activity class .* does not exist/.test(start.stdout ?? '')) {
        console.error(`[androidSmoke] 启动失败：${start.stdout ?? ''}${start.stderr ?? ''}`);
        process.exit(1);
    }
    const waitUntil = Date.now() + args.waitMs;
    while (Date.now() < waitUntil) {
        spawnSync(adbPath, ['-s', serial, 'shell', 'sleep', '1']);
    }

    console.log('[androidSmoke] 3/5 截图与 logcat');
    fs.mkdirSync(PREVIEW_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const shotPath = path.join(PREVIEW_DIR, `android-${stamp}.png`);
    const logPath = path.join(PREVIEW_DIR, `android-logcat-${stamp}.txt`);
    const shot = adb(adbPath, serial, ['exec-out', 'screencap', '-p'], { binary: true });
    if (shot.status !== 0 || !shot.stdout || shot.stdout.length === 0) {
        console.error('[androidSmoke] 截图失败。');
        process.exit(1);
    }
    fs.writeFileSync(shotPath, shot.stdout);

    const pid = (adb(adbPath, serial, ['shell', 'pidof', '-s', PACKAGE]).stdout ?? '').trim();
    const fullLog = adb(adbPath, serial, ['logcat', '-d']).stdout ?? '';
    const pidPattern = pid ? new RegExp(`\\s${pid}\\s`) : null;
    const pidLines = fullLog.split(/\r?\n/).filter((line) => (pidPattern ? pidPattern.test(line) : true));
    fs.writeFileSync(logPath, `${pid ? `# pid ${pid}\n` : '# pidof 没取到，下面是完整 logcat\n'}${pidLines.join('\n')}\n`);

    console.log('[androidSmoke] 4/5 崩溃判定');
    const sawFatal = /FATAL EXCEPTION|ANR in/.test(fullLog);
    const alive = (adb(adbPath, serial, ['shell', 'pidof', '-s', PACKAGE]).stdout ?? '').trim().length > 0;
    const crashed = sawFatal || !alive;

    console.log('[androidSmoke] 5/5 写证据');
    const model = (adb(adbPath, serial, ['shell', 'getprop', 'ro.product.model']).stdout ?? '').trim();
    const evidence = {
        commit: git(['rev-parse', 'HEAD']),
        branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
        timestamp: new Date().toISOString(),
        device: { serial, model: model || '未知型号' },
        apk: APK_PATH,
        screenshot: shotPath,
        logcat: logPath,
        crashed: crashed || !alive,
        note: args.note ?? '',
    };
    fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 4)}\n`);

    console.log(`[androidSmoke] 完成：截图 ${shotPath}，logcat ${logPath}，证据 ${EVIDENCE_PATH}`);
    console.log(`[androidSmoke] 崩溃判定：${sawFatal ? '发现 FATAL/ANR，见 logcat' : alive ? '无 FATAL/ANR，进程存活' : '进程已不在，疑似启动即退'}`);
    console.log('[androidSmoke] 接下来必须做：用图片工具打开截图真的看一遍，确认界面符合预期；有异常当场处理，不要带着疑问进 PR。');
    if (!args.note) console.warn('[androidSmoke] --note 没写：提交 PR 时会被要求补上，可用 --skip-build 重跑一次只补说明。');
    if (evidence.crashed) process.exit(1);
}

main();
