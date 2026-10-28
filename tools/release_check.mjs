#!/usr/bin/env node
/**
 * 发布门禁：把「发版必做」的每一步变成断言，避免靠记性漏项。
 *
 * 用法：
 *   node tools/release_check.mjs                     # 默认读 docs/tasks/<package.json 版本>.md
 *   node tools/release_check.mjs --task docs/tasks/1.7.2.md
 *   node tools/release_check.mjs --new 1.7.3         # 按模板生成任务单（已存在则拒绝）
 *   node tools/release_check.mjs --remote            # 额外核对远端 tag 与本地一致
 *   node tools/release_check.mjs --no-git            # 跳过 git 相关检查（只查包与文档）
 *
 * 退出码：全绿 0，有红项 1。红灯时不要提交/不要汇报完成。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXEC_DIR = path.join(ROOT, 'packages', 'dsh-rust-exec');
const BIN_DIR = path.join(ROOT, 'bin');
const TASK_DIR = path.join(ROOT, 'docs', 'tasks');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};

const TEMPLATE = (version) => `# ${version} 任务单

version: ${version}

## 需求（原文，逐条编号，勿改写）

- R1 \`<把用户原话粘在这里>\`

## 交付清单（未勾选项会挡住 release_check）

- [ ] R1 代码改动 + 至少 1 条能失败的测试断言
- [ ] 全量回归：monitor_render_test / check_client_identity / harness / panel_render_test / projection_render_test / mount（DSH_PROFILE=mounttest）
- [ ] 版本号（package.json）与 CHANGELOG（packages/dsh-rust-exec/CHANGELOG.md）
- [ ] README：版本行、§3.2 包名、受影响的小节
- [ ] 打包：node tools/build_plugin.mjs（或 --skip-rust）产出 bin/dsh-native-${version}.tgz + .sha256
- [ ] commit + tag v${version} + SSH 推送
- [ ] 镜像回工作区（_native/hold/mirror_to_workspace.ps1）并核对 SHA256
- [ ] phase progress 一条（带证据）
- [ ] npm 状态如实说明（发了 / 为什么没发）

## 验收证据（命令 + 输出摘要）

`;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

/** 任务单里的勾选项与声明的版本。 */
function parseSheet(file) {
  const text = fs.readFileSync(file, 'utf8');
  const boxes = [...text.matchAll(/^\s*-\s*\[( |x|X)\]\s*(.+)$/gm)].map((m) => ({
    done: m[1].toLowerCase() === 'x',
    label: m[2].trim(),
  }));
  const version = text.match(/^version:\s*(\S+)/m)?.[1] ?? null;
  return { boxes, version };
}

function main() {
  const newVersion = valueOf('--new');
  if (newVersion) {
    const file = path.join(TASK_DIR, `${newVersion}.md`);
    if (fs.existsSync(file)) {
      console.error(`已存在：${path.relative(ROOT, file)}，不覆盖。`);
      process.exit(1);
    }
    fs.mkdirSync(TASK_DIR, { recursive: true });
    fs.writeFileSync(file, TEMPLATE(newVersion), 'utf8');
    console.log(`已生成任务单 ${path.relative(ROOT, file)}（先把需求原话填进去，再开工）`);
    return;
  }

  const packageJson = readJson(path.join(EXEC_DIR, 'package.json'));
  const version = String(packageJson.version);
  const taskFile = path.resolve(ROOT, valueOf('--task') ?? path.join('docs', 'tasks', `${version}.md`));
  const checks = [];
  const add = (ok, label, detail = '') => checks.push({ ok: Boolean(ok), label, detail });

  // 1) 任务单本身
  const sheetExists = fs.existsSync(taskFile);
  add(sheetExists, '任务单存在', path.relative(ROOT, taskFile));
  let sheet = { boxes: [], version: null };
  if (sheetExists) {
    sheet = parseSheet(taskFile);
    add(sheet.version === version, '任务单版本 == package.json', `${sheet.version ?? '(缺 version: 行)'} vs ${version}`);
    const open = sheet.boxes.filter((box) => !box.done);
    add(open.length === 0, `任务单勾选完成（${sheet.boxes.length - open.length}/${sheet.boxes.length}）`, open.map((box) => `未勾：${box.label}`).join('\n    '));
  }

  // 2) 文档：CHANGELOG 与 README 必须提到本版本
  const changelog = path.join(EXEC_DIR, 'CHANGELOG.md');
  const changelogHit = fs.existsSync(changelog) && new RegExp(`^#{2,3}\\s*.*\\b${version.replace(/\./g, '\\.')}\\b`, 'm').test(fs.readFileSync(changelog, 'utf8'));
  add(changelogHit, 'CHANGELOG 有本版本条目', path.relative(ROOT, changelog));

  const readme = path.join(ROOT, 'README.md');
  const readmeText = fs.existsSync(readme) ? fs.readFileSync(readme, 'utf8') : '';
  add(readmeText.includes(version), 'README 提到本版本号', 'readme 里找不到 ' + version);
  add(readmeText.includes(`dsh-native-${version}.tgz`), 'README 的安装包名是本版本', `期望 dsh-native-${version}.tgz`);

  // 3) 安装包与校验和
  const tarballName = `dsh-native-${version}.tgz`;
  const tarball = path.join(BIN_DIR, tarballName);
  add(fs.existsSync(tarball), 'bin/ 有本版本安装包', path.relative(ROOT, tarball));
  if (fs.existsSync(tarball)) {
    const checksum = `${tarball}.sha256`;
    add(fs.existsSync(checksum), '安装包有 .sha256', path.relative(ROOT, checksum));
    if (fs.existsSync(checksum)) {
      const recorded = fs.readFileSync(checksum, 'utf8').trim().split(/\s+/)[0].toLowerCase();
      const actual = sha256(tarball);
      add(recorded === actual, 'sha256 与实际文件一致', `记录 ${recorded.slice(0, 16)}… / 实际 ${actual.slice(0, 16)}…`);
    }
  }

  // 4) git：干净工作区 + tag 指向 HEAD（+ 可选远端一致）
  if (!has('--no-git')) {
    const status = git(['status', '--porcelain']);
    add(status.ok && status.out === '', '工作区干净', status.out.split('\n').slice(0, 5).join('\n    '));
    const tag = git(['rev-parse', `v${version}^{commit}`]);
    const head = git(['rev-parse', 'HEAD']);
    add(tag.ok && tag.out === head.out, `tag v${version} 指向 HEAD`, tag.ok ? `tag ${tag.out.slice(0, 8)} / HEAD ${head.out.slice(0, 8)}` : `没有 tag v${version}`);
    if (has('--remote')) {
      const remote = git(['ls-remote', 'origin', `refs/tags/v${version}^{}`, `refs/tags/v${version}`]);
      const remoteTip = remote.out.split('\n').map((line) => line.split('\t')[0]).filter(Boolean);
      add(remote.ok && remoteTip.includes(head.out), `远端 tag v${version} 与本地一致`, remote.out);
    }
  }

  const failed = checks.filter((check) => !check.ok);
  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.label}${check.ok || !check.detail ? '' : `\n        ${check.detail.replace(/\n/g, '\n        ')}`}`);
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过${failed.length ? `，${failed.length} 项未过` : '，可以发布'}`);
  process.exit(failed.length ? 1 : 0);
}

main();
