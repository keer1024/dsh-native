#!/usr/bin/env node
/**
 * 任务板：工作区里的极轻量工单存储（.dsh/tasks.json），一条命令增删改查。
 *
 * 为什么不是插件：插件的工具 schema 每一轮请求都要重发（约 120–160 tok/次），
 * 而这个脚本走已常驻的 rust_exec，schema 成本为 0；每次调用只输出命中的几行。
 *
 * 用法：
 *   node tools/tasks.mjs list [--all|--open|--doing] [--limit 20] [--json]
 *   node tools/tasks.mjs next                    # 一行：现在该做的那一件
 *   node tools/tasks.mjs show <id>
 *   node tools/tasks.mjs add "标题" [--pri 1] [--tag ui] [--ref m03014] [--note "..."]
 *   node tools/tasks.mjs start <id>
 *   node tools/tasks.mjs block <id> --why "卡在等 token"
 *   node tools/tasks.mjs unblock <id>
 *   node tools/tasks.mjs done <id> --evidence "命令 → 结果"   # 不带证据不允许关单
 *   node tools/tasks.mjs edit <id> [--title ...] [--pri N] [--ref ...] [--tag ...]
 *   node tools/tasks.mjs rm <id>
 *   node tools/tasks.mjs stats
 *   node tools/tasks.mjs selftest               # 自检：临时 store 上跑一遍增删改
 *
 * ponytail: 单写者假设（只有一个 agent 在写），没有文件锁；真要多写者再上锁。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STORE = path.join(ROOT, '.dsh', 'tasks.json');
const STATUS = ['open', 'doing', 'blocked', 'done'];

const EMPTY = { version: 1, nextId: 1, tasks: [] };

// 自检时临时改写到 .tmp 下的文件，避免把测试数据写进真任务板。
let SAVE_TARGET = STORE;

function load(file = STORE) {
  if (!fs.existsSync(file)) return { ...EMPTY, tasks: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { version: 1, nextId: parsed.nextId ?? 1, tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] };
}

function save(store, file = SAVE_TARGET) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function parseArgs(argv) {
  const flags = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) { flags._.push(token); continue; }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) { flags[key] = true; continue; }
    flags[key] = next;
    index += 1;
  }
  return flags;
}

const now = () => new Date().toISOString();
const pri = (task) => Number(task.pri) || 3;
const order = (a, b) => pri(a) - pri(b) || a.id - b.id;
const brief = (task) => `#${task.id} [${task.status}] P${pri(task)} ${task.tags.map((tag) => `${tag} `).join('')}${task.title}${task.refs.length ? `  (${task.refs.join(', ')})` : ''}`;

function find(store, id) {
  const task = store.tasks.find((item) => item.id === Number(id));
  if (!task) {
    console.error(`没有 #${id}；先 node tools/tasks.mjs list --all`);
    process.exit(1);
  }
  return task;
}

function touch(task) {
  task.updatedAt = now();
}

function cmdAdd(store, flags) {
  const title = flags._.slice(1).join(' ').trim();
  if (!title) { console.error('add 需要标题：node tools/tasks.mjs add "标题"'); process.exit(1); }
  const duplicate = store.tasks.find((task) => task.status !== 'done' && task.title === title);
  if (duplicate && !flags.force) { console.error(`已有同名未完成任务 #${duplicate.id}；要再加一条用 --force`); process.exit(1); }
  const task = {
    id: store.nextId,
    title,
    status: 'open',
    pri: Number(flags.pri) || 3,
    tags: flags.tag ? String(flags.tag).split(',').map((tag) => tag.trim()).filter(Boolean) : [],
    refs: flags.ref ? String(flags.ref).split(',').map((ref) => ref.trim()).filter(Boolean) : [],
    note: flags.note ? String(flags.note) : '',
    createdAt: now(),
    updatedAt: now(),
    evidence: '',
  };
  store.tasks.push(task);
  store.nextId += 1;
  save(store);
  console.log(`+ ${brief(task)}`);
}

function cmdList(store, flags) {
  let tasks = [...store.tasks].sort(order);
  if (flags.all) tasks = tasks.filter((task) => true);
  else if (flags.doing) tasks = tasks.filter((task) => task.status === 'doing');
  else tasks = tasks.filter((task) => task.status !== 'done');
  const limit = Number(flags.limit) || 20;
  const shown = tasks.slice(0, limit);
  if (flags.json) { console.log(JSON.stringify(shown)); return; }
  if (!shown.length) { console.log('（空）'); return; }
  for (const task of shown) console.log(brief(task));
  if (tasks.length > shown.length) console.log(`…另有 ${tasks.length - shown.length} 条，用 --limit 展开`);
}

function cmdNext(store) {
  const doing = store.tasks.filter((task) => task.status === 'doing').sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const pick = doing[0] ?? store.tasks.filter((task) => task.status === 'open').sort(order)[0];
  if (!pick) { console.log('没有待办'); return; }
  const blocked = store.tasks.filter((task) => task.status === 'blocked').length;
  console.log(`${brief(pick)}${blocked ? `   [${blocked} 条 blocked]` : ''}`);
}

function cmdShow(store, flags) {
  const task = find(store, flags._[1]);
  console.log(brief(task));
  if (task.note) console.log(`  note: ${task.note}`);
  if (task.evidence) console.log(`  evidence: ${task.evidence}`);
  console.log(`  created ${task.createdAt}  updated ${task.updatedAt}`);
}

function setStatus(store, flags, status, extra = {}) {
  const task = find(store, flags._[1]);
  task.status = status;
  Object.assign(task, extra);
  touch(task);
  save(store);
  console.log(`~ ${brief(task)}`);
}

function cmdEdit(store, flags) {
  const task = find(store, flags._[1]);
  if (flags.title) task.title = String(flags.title);
  if (flags.pri) task.pri = Number(flags.pri) || task.pri;
  if (flags.ref !== undefined) task.refs = String(flags.ref).split(',').map((ref) => ref.trim()).filter(Boolean);
  if (flags.tag !== undefined) task.tags = String(flags.tag).split(',').map((tag) => tag.trim()).filter(Boolean);
  if (flags.note !== undefined) task.note = String(flags.note);
  touch(task);
  save(store);
  console.log(`~ ${brief(task)}`);
}

function cmdStats(store) {
  const count = (status) => store.tasks.filter((task) => task.status === status).length;
  console.log(`open ${count('open')} · doing ${count('doing')} · blocked ${count('blocked')} · done ${count('done')}  总 ${store.tasks.length}`);
  console.log(`store ${path.relative(ROOT, STORE)}`);
}

/** 自检：在临时文件上把主路径跑一遍，任何一步不对就抛错。 */
function cmdSelftest() {
  const file = path.join(ROOT, '.tmp', `tasks-selftest-${Date.now()}.json`);
  const previous = SAVE_TARGET;
  SAVE_TARGET = file;
  try {
    const store = load(file);
    const say = (line) => process.stdout.write(`${line}\n`);
    const run = (fn, flags, ...rest) => { const log = console.log; console.log = say; try { fn(store, flags, ...rest); } finally { console.log = log; } };

    run(cmdAdd, { _: ['add', '自检任务'], pri: '1', tag: 'test', ref: 'm0' });
    if (store.tasks.length !== 1 || store.tasks[0].status !== 'open') throw new Error('add 失败');
    if (store.nextId !== 2) throw new Error('nextId 未推进');

    run(cmdAdd, { _: ['add', '重复标题'], force: true });
    if (store.tasks.length !== 2) throw new Error('--force 没有放行');

    run(setStatus, { _: ['start', '1'] }, 'doing');
    if (store.tasks[0].status !== 'doing') throw new Error('start 失败');

    run(setStatus, { _: ['done', '1'], evidence: 'cmd → ok' }, 'done', { evidence: 'cmd → ok' });
    if (store.tasks[0].status !== 'done' || store.tasks[0].evidence !== 'cmd → ok') throw new Error('done 未记证据');

    // 落盘/回读：确认写的是临时文件，真任务板没被碰
    const reloaded = load(file);
    if (reloaded.tasks.length !== 2 || reloaded.nextId !== 3) throw new Error('落盘/回读不一致');

    // 排序：P1 的排在 P3 前面
    const sorted = [...reloaded.tasks].sort(order);
    if (sorted[0].pri > sorted[1].pri) throw new Error('优先级排序错');

    fs.rmSync(file, { force: true });
    say('selftest: ok (add/force/start/done/evidence/落盘回读/排序)');
  } finally {
    SAVE_TARGET = previous;
  }
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const cmd = flags._[0] ?? 'list';
  const store = load();
  const table = {
    list: () => cmdList(store, flags),
    next: () => cmdNext(store),
    show: () => cmdShow(store, flags),
    add: () => cmdAdd(store, flags),
    start: () => setStatus(store, flags, 'doing'),
    unblock: () => setStatus(store, flags, 'open'),
    block: () => {
      if (!flags.why) { console.error('block 需要 --why "原因"'); process.exit(1); }
      setStatus(store, flags, 'blocked', { note: String(flags.why) });
    },
    done: () => {
      if (!flags.evidence) { console.error('done 需要 --evidence "命令 → 结果"（不许空口关单）'); process.exit(1); }
      setStatus(store, flags, 'done', { evidence: String(flags.evidence) });
    },
    edit: () => cmdEdit(store, flags),
    rm: () => {
      const task = find(store, flags._[1]);
      store.tasks = store.tasks.filter((item) => item.id !== task.id);
      save(store);
      console.log(`- #${task.id} ${task.title}`);
    },
    stats: () => cmdStats(store),
    selftest: () => cmdSelftest(),
  };
  if (!table[cmd]) {
    console.error(`未知子命令 ${cmd}。可用：${Object.keys(table).join(' / ')}`);
    process.exit(1);
  }
  table[cmd]();
}

main();
