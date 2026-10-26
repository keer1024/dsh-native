#!/usr/bin/env node
// build_plugin.mjs —— 一条命令完成「编译 → 换装 → 打包 → 归档」。
//
// 做什么（按顺序）：
//   1. 编译 Rust worker（packages/dsh-rust-worker/sources），产出 release 二进制；
//   2. 把二进制换装到 packages/dsh-rust-exec/bin/ 下。Windows 上正在运行的 exe
//      不能被覆盖，但可以被改名，所以先把旧文件备份成
//      dsh-rust-worker-<版本>[-N].exe，再拷新文件进去；
//   3. 在 packages/dsh-rust-exec 里执行 npm pack，打出安装包（tarball）；
//   4. 把 tarball 放到项目根目录的 bin/（只保留最新一份），同时归档到 dist/，
//      两边都写 .sha256 校验文件；
//   5. 打印版本、大小、哈希、文件数等摘要，可直接粘进发布说明。
//
// 用法：
//   node tools/build_plugin.mjs                # 全量构建（含 cargo）
//   node tools/build_plugin.mjs --skip-rust    # 跳过 cargo 与换装，用现有二进制打包
//   node tools/build_plugin.mjs --no-archive   # 只更新 bin/，不往 dist/ 归档
//
// 约定：
//   - 版本号只有一个事实源：packages/dsh-rust-exec/package.json 的 version；
//   - 幂等：重复执行不会产生重复备份，也不会覆盖哈希不同的历史备份；
//   - 不改版本号、不动 git：发版前请自己 bump version 并提交。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';

/** 项目根目录（本脚本位于 <root>/tools/ 下）。 */
const ROOT = path.resolve(import.meta.dirname, '..');
/** 宿主侧插件包（JS 入口 + 打包用的 worker 二进制）。 */
const EXEC_DIR = path.join(ROOT, 'packages', 'dsh-rust-exec');
/** Rust worker 的 Cargo 工程根目录。 */
const RUST_DIR = path.join(ROOT, 'packages', 'dsh-rust-worker', 'sources');
/** 项目根目录下的 bin/：存放最新安装包，供离线安装/分发使用。 */
const BIN_DIR = path.join(ROOT, 'bin');
/** 历史归档目录（已在 .gitignore 里忽略）。 */
const DIST_DIR = path.join(ROOT, 'dist');

const argv = new Set(process.argv.slice(2));
/** --skip-rust：跳过 cargo 编译与换装，直接用 bin/ 里现有二进制打包。 */
const skipRust = argv.has('--skip-rust');
/** --no-archive：只在 bin/ 更新，不往 dist/ 归档。 */
const noArchive = argv.has('--no-archive');

const IS_WIN = process.platform === 'win32';
/** worker 二进制在 npm 包里的文件名（Windows 带 .exe）。 */
const WORKER_NAME = IS_WIN ? 'dsh-rust-worker.exe' : 'dsh-rust-worker';
/** Cargo release 产物路径。 */
const CARGO_BIN = path.join(RUST_DIR, 'target', 'release', WORKER_NAME);
/** 宿主包 bin/ 下的二进制路径（会被 npm 打包进 tarball）。 */
const EXEC_BIN = path.join(EXEC_DIR, 'bin', WORKER_NAME);

/**
 * 统一日志前缀，方便从构建日志里筛出本脚本的输出。
 * @param {string} message
 */
function log(message) {
  console.log(`[build] ${message}`);
}

/**
 * 人类可读的文件大小，例如 "1.01 MB"。
 * @param {number} bytes 字节数
 * @returns {string}
 */
function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * 计算文件 SHA256，用于幂等判断与产物校验。
 * @param {string} file 绝对路径
 * @returns {string} 小写十六进制摘要
 */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * 读版本号——全流程唯一的版本事实源。
 *
 * 只读 packages/dsh-rust-exec/package.json，避免脚本里另存一份版本号，
 * 否则容易出现「包是 1.6.1、脚本写着 1.6.0」这种错位。
 * @returns {string} 形如 "1.6.1" 的语义化版本
 */
function readVersion() {
  const pkg = JSON.parse(readFileSync(path.join(EXEC_DIR, 'package.json'), 'utf8'));
  if (!pkg.version) throw new Error('packages/dsh-rust-exec/package.json 缺少 version 字段');
  return pkg.version;
}

/**
 * 构造子进程环境变量。
 *
 * Windows 上本机 %LOCALAPPDATA%\Temp 的 ACL 常常不允许当前用户创建文件，
 * 链接器会报 "Cannot create temporary file ... Permission denied"；
 * 因此把 TMP/TEMP 重定向到项目内的 .tmp/build（已在 .gitignore 里忽略）。
 * @returns {NodeJS.ProcessEnv}
 */
function buildEnv() {
  const env = { ...process.env };
  if (IS_WIN) {
    const tmp = path.join(ROOT, '.tmp', 'build');
    mkdirSync(tmp, { recursive: true });
    env.TMP = tmp;
    env.TEMP = tmp;
  }
  return env;
}

/**
 * 编译 Rust worker（release；--locked 保证依赖与 Cargo.lock 一致）。
 *
 * 编译失败直接抛错中断，绝不把旧二进制当成新版本打出去。
 * 注：cargo 在 Windows 上是 .cmd，必须经 shell 调用，故用单条命令字符串。
 */
function buildRust() {
  log(`编译 worker：${path.relative(ROOT, RUST_DIR)}`);
  const result = spawnSync('cargo build --release --locked', {
    cwd: RUST_DIR,
    env: buildEnv(),
    stdio: 'inherit',
    shell: true
  });
  if (result.status !== 0) {
    throw new Error(`cargo build 失败（exit ${result.status}），构建中止`);
  }
}

/**
 * 把新二进制换装到宿主包 bin/ 下。
 *
 * 三种情况：
 *   - 内容相同 → 跳过（幂等，CI 里重复跑不会产生垃圾备份）；
 *   - 内容不同且旧文件存在 → 先改名备份，再拷新的；
 *   - bin/ 里还没有 → 直接拷。
 * 备份名不会被 git 跟踪（.gitignore 排除了 dsh-rust-worker-*.exe）。
 * @param {string} version 当前版本号，用于生成备份文件名
 * @returns {{changed: boolean, backup: string|null}}
 */
function installWorker(version) {
  if (!existsSync(CARGO_BIN)) {
    throw new Error(
      `找不到编译产物：${path.relative(ROOT, CARGO_BIN)}（先跑一次 cargo build --release，或改用 --skip-rust）`
    );
  }
  mkdirSync(path.dirname(EXEC_BIN), { recursive: true });

  const fresh = sha256(CARGO_BIN);
  if (existsSync(EXEC_BIN) && sha256(EXEC_BIN) === fresh) {
    log('worker 二进制已是最新，跳过换装');
    return { changed: false, backup: null };
  }

  let backup = null;
  if (existsSync(EXEC_BIN)) {
    // 命名候选：dsh-rust-worker-1.6.1.exe、-1.6.1-2.exe …… 直到不重名
    const base = path.join(EXEC_DIR, 'bin', `dsh-rust-worker-${version}`);
    let candidate = `${base}.exe`;
    for (let index = 2; existsSync(candidate); index += 1) candidate = `${base}-${index}.exe`;
    renameSync(EXEC_BIN, candidate);
    backup = candidate;
    log(`旧二进制已备份：${path.basename(candidate)}`);
  }
  copyFileSync(CARGO_BIN, EXEC_BIN);
  log(`worker 已换装：${humanSize(statSync(EXEC_BIN).size)} · sha256 ${fresh.slice(0, 16)}…`);
  return { changed: true, backup };
}

/**
 * 在宿主包目录执行 npm pack，产出 tarball。
 *
 * 加 --ignore-scripts：打包阶段不该触发任何生命周期脚本。
 * npm 会把 tarball 写在当前工作目录，所以调用方需要负责搬运。
 *
 * npm 会把 scope 拼进文件名（`@keer1024/dsh-native` → `keer1024-dsh-native-1.6.2.tgz`），
 * 安装包对外只叫 `dsh-native-<version>.tgz`，所以打包后立刻把 scope 前缀去掉。
 * 前缀不写死，从 package.json 的 name 推导；无 scope 的包（1.7.0 起的 `dsh-native`）
 * npm 本来就产 `dsh-native-<version>.tgz`，这时不做改名，避免 rename 到自己报 ENOENT。
 * @param {string} version 期望版本号，用于校验产物文件名
 * @returns {string} tarball 绝对路径（仍位于宿主包目录内）
 */
function packTarball(version) {
  log('打包：npm pack');
  const npm = IS_WIN ? 'npm.cmd' : 'npm';
  const result = spawnSync(`${npm} pack --ignore-scripts`, {
    cwd: EXEC_DIR,
    encoding: 'utf8',
    shell: true
  });
  if (result.status !== 0) {
    throw new Error(`npm pack 失败（exit ${result.status}）：${(result.stderr || '').trim()}`);
  }
  const pkg = JSON.parse(readFileSync(path.join(EXEC_DIR, 'package.json'), 'utf8'));
  const bare = String(pkg.name || '').split('/').pop();
  const scopePrefix = String(pkg.name || '').startsWith('@') ? `${String(pkg.name).slice(1).split('/')[0]}-` : '';
  const produced = path.join(EXEC_DIR, `${bare}-${version}.tgz`);
  if (!scopePrefix) {
    // 无 scope：npm 产出的就是产线名，原地校验即可
    if (!existsSync(produced)) throw new Error(`npm pack 未产出预期文件：${path.basename(produced)}`);
    return produced;
  }
  const raw = path.join(EXEC_DIR, `${scopePrefix}${bare}-${version}.tgz`);
  if (!existsSync(raw)) {
    throw new Error(`npm pack 未产出预期文件：${path.basename(raw)}`);
  }
  rmSync(produced, { force: true });
  renameSync(raw, produced);
  return produced;
}

/**
 * 把 tarball 分发到根目录 bin/ 与 dist/，并写 .sha256。
 *
 * bin/ 只保留当前版本（旧包会被清掉），这样「项目根目录下的安装包永远是最新的」；
 * dist/ 按版本归档，方便回溯。校验文件沿用既有格式：<hash>␠␠<文件名>。
 * @param {string} produced npm pack 产出的 tarball
 * @param {boolean} archive 是否同时归档到 dist/
 * @returns {{file: string, size: number, hash: string}}
 */
function publish(produced, archive) {
  const name = path.basename(produced);
  mkdirSync(BIN_DIR, { recursive: true });
  if (archive) mkdirSync(DIST_DIR, { recursive: true });

  // bin/ 只留当前版本：先清掉其它 tarball 及其校验文件
  for (const entry of readdirSync(BIN_DIR)) {
    if (entry.endsWith('.tgz') && entry !== name) {
      rmSync(path.join(BIN_DIR, entry), { force: true });
      rmSync(path.join(BIN_DIR, `${entry}.sha256`), { force: true });
    }
  }
  // 孤立校验文件（对应的 tarball 已不在）一并清掉，避免目录里出现两份"当前版本"的指纹
  for (const entry of readdirSync(BIN_DIR)) {
    if (!entry.endsWith('.tgz.sha256')) continue;
    const owner = entry.slice(0, -'.sha256'.length);
    if (!existsSync(path.join(BIN_DIR, owner))) rmSync(path.join(BIN_DIR, entry), { force: true });
  }

  const target = path.join(BIN_DIR, name);
  rmSync(target, { force: true });
  copyFileSync(produced, target);
  const hash = sha256(target);
  writeFileSync(path.join(BIN_DIR, `${name}.sha256`), `${hash}  ${name}\n`, 'utf8');

  if (archive) {
    copyFileSync(target, path.join(DIST_DIR, name));
    writeFileSync(path.join(DIST_DIR, `${name}.sha256`), `${hash}  ${name}\n`, 'utf8');
  }

  return { file: target, size: statSync(target).size, hash };
}

/**
 * 读取 tarball 内的文件清单（不解包，便于摘要输出与排障）。
 * 系统没有 tar 时返回空数组，不影响构建结果。
 * @param {string} tarball tarball 路径
 * @returns {string[]} 包内条目
 */
function listTarball(tarball) {
  const result = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

/**
 * 主流程：编译 → 换装 → 打包 → 分发 → 摘要。
 * 任何一步抛错都会以非 0 退出，避免半成品被误当成发布物。
 */
function main() {
  const version = readVersion();
  log(`版本 ${version} · 根目录 ${ROOT}`);

  if (skipRust) {
    // --skip-rust 的语义是「不编译、也不换装」：直接把 bin/ 里现有的二进制打进包，
    // 这样在没有 cargo 产物的机器（例如只拿了仓库的离线环境）也能出包。
    if (!existsSync(EXEC_BIN)) {
      throw new Error(`--skip-rust 需要 packages/dsh-rust-exec/bin/${WORKER_NAME} 已存在`);
    }
    log(`沿用现有二进制：${humanSize(statSync(EXEC_BIN).size)} · sha256 ${sha256(EXEC_BIN).slice(0, 16)}…`);
  } else {
    buildRust();
    installWorker(version);
  }

  const produced = packTarball(version);
  const outcome = publish(produced, !noArchive);
  rmSync(produced, { force: true });

  const files = listTarball(outcome.file);
  log('构建完成');
  log(`  安装包：${path.relative(ROOT, outcome.file)}`);
  log(`  大小  ：${humanSize(outcome.size)}`);
  log(`  sha256：${outcome.hash}`);
  log(`  文件数：${files.length}`);
  if (noArchive) log('  归档  ：已跳过（--no-archive）');
  log('提示：bin/ 恒为最新一份；dist/ 按版本归档。');
}

try {
  main();
} catch (error) {
  console.error(`[build] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
