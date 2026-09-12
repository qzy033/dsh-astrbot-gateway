#!/usr/bin/env node
/**
 * 用 DSH 自己的 dsh-tools 校验插件的工具 schema。
 *
 * 为什么需要
 * ----------
 * 注册工具时 dsh-tools 会：
 *   parameters    → parameterSchemaSpecToJsonSchema(spec)   作者描述符 DSL，编译后再断言
 *   output.schema → valueSchemaSpecToJsonSchema(spec)       真 JSON Schema（allowRequired:false）
 * 两者都会过 assertSupportedJsonSchema；任何越界写法抛 JsonSchemaError，
 * 后果是**整个插件树加载失败**，DSH Desktop 还会进恢复模式回滚 profile。
 *
 * 官方那套代码在 app.asar 里（profile 的 node_modules 只有 dsh-tools，
 * 缺 cordis / dsh-scope / dsh-llm / dsh-session）。所以本脚本先把 asar 里的
 * node_modules/@deepseek-ai 抽到 cache/ 下，再动态 import 真身来校验——
 * 不是复刻规则，是真的调它。
 *
 * 用法：
 *   node tools/validate-tool-schemas.mjs
 *   node tools/validate-tool-schemas.mjs --plugin <插件目录> --asar <app.asar 路径>
 *
 * 退出码：0 = 全部合规；1 = 有违规；2 = 环境问题（找不到 asar / 抽不出依赖）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

const argv = process.argv.slice(2)
function argValue(flag, fallback) {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const PLUGIN_DIR = path.resolve(argValue('--plugin', path.join(REPO, 'plugin', 'dsh-astrbot-gateway')))
const ASAR = argValue('--asar', 'C:/Users/用户/AppData/Local/Programs/DSH Desktop/resources/app.asar')
const EXTRACT_ROOT = path.join(REPO, 'cache', '_dsh-asar')

// ── asar 读取 ───────────────────────────────────────────────────────────────
function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  const head = Buffer.alloc(8)
  fs.readSync(fd, head, 0, 8, 0)
  const headerSize = head.readUInt32LE(4)
  const headerBuf = Buffer.alloc(headerSize)
  fs.readSync(fd, headerBuf, 0, headerSize, 8)
  // pickle 里长度前缀的偏移随实现变化，直接定位 JSON 起点最稳（末尾可能补 NUL）。
  const text = headerBuf.toString('utf8')
  const start = text.indexOf('{')
  if (start < 0) throw new Error('asar 头里找不到 JSON')
  const header = JSON.parse(text.slice(start).replace(/\0+$/u, ''))
  return { fd, base: 8 + headerSize, header }
}

/** 把 asar 里某个子树抽到磁盘（unpacked 的从 app.asar.unpacked 拷）。 */
function extractNode(fd, base, node, rel, destRoot, unpackedRoot) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const childRel = rel === '' ? name : `${rel}/${name}`
    const dest = path.join(destRoot, name)
    if (entry.files) {
      fs.mkdirSync(dest, { recursive: true })
      extractNode(fd, base, entry, childRel, dest, unpackedRoot)
      continue
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (entry.unpacked) {
      fs.copyFileSync(path.join(unpackedRoot, childRel), dest)
      continue
    }
    const buf = Buffer.alloc(entry.size)
    fs.readSync(fd, buf, 0, entry.size, base + Number(entry.offset))
    fs.writeFileSync(dest, buf)
  }
}

/** 按路径段逐层下钻 asar 头。 */
function descend(header, segments) {
  let node = header
  for (const segment of segments) {
    node = node.files?.[segment]
    if (!node) return null
  }
  return node
}

if (!fs.existsSync(ASAR)) {
  console.error(`找不到 app.asar: ${ASAR}`)
  process.exit(2)
}

console.log(`plugin : ${PLUGIN_DIR}`)
console.log(`asar   : ${ASAR}`)

// ── 抽依赖（已抽过就复用） ─────────────────────────────────────────────────
const scopeRoot = path.join(EXTRACT_ROOT, 'node_modules', '@deepseek-ai')
const sentinel = path.join(scopeRoot, 'dsh-tools', 'lib', 'index.js')
if (!fs.existsSync(sentinel)) {
  console.log('抽取 asar 依赖 → ' + EXTRACT_ROOT)
  const { fd, base, header } = readAsarHeader(ASAR)
  try {
    const scope = descend(header, ['node_modules', '@deepseek-ai'])
    if (!scope) {
      console.error('asar 里没有 node_modules/@deepseek-ai')
      process.exit(2)
    }
    // unpacked 的真实目录：app.asar.unpacked/node_modules/...
    const unpackedRoot = path.join(path.dirname(ASAR), 'app.asar.unpacked', 'node_modules')
    fs.mkdirSync(scopeRoot, { recursive: true })
    extractNode(fd, base, scope, '@deepseek-ai', scopeRoot, unpackedRoot)
  } finally {
    fs.closeSync(fd)
  }
}

// ── 载入真 dsh-tools ───────────────────────────────────────────────────────
let tools
try {
  tools = await import(pathToFileURL(sentinel).href)
} catch (error) {
  console.error(`载入 dsh-tools 失败：${error.message}`)
  console.error('（如果缺的是某个包，把它一起抽出来即可）')
  process.exit(2)
}
const { assertSupportedJsonSchema, assertObjectJsonSchema } = tools
console.log(`dsh-tools: 已从 asar 载入（导出 ${Object.keys(tools).length} 项）`)
console.log('')

// ── 用假 ctx 跑一遍 apply，收下工具定义 ────────────────────────────────────
const captured = new Map()
const fakeCtx = {
  logger: { info() {}, warn() {}, debug() {}, error() {} },
  get: () => undefined,
  tools: {
    register(definition) {
      captured.set(definition.name, definition)
      return () => captured.delete(definition.name)
    },
  },
  timer: {},
  interval: () => () => {},
  effect: (setup) => {
    setup?.()
    return () => {}
  },
}

const entry = path.join(PLUGIN_DIR, 'lib', 'index.js')
const plugin = await import(pathToFileURL(entry).href)

// ⚠️ root 必须指向沙箱，且 pollMs=0：
// apply 会安排一次 boot（mkdir + 读 bridge_access.json + ping 上行 + 写 bridge_status.json）。
// 不传 root 就会落到插件的默认目录（真实 cache/），把这个校验脚本变成"污染现场 + 真发 HTTP"，
// 而且会写出一个 report=ok 的 bridge_status.json，让人误以为 DSH 里已经加载成功。
const SANDBOX_ROOT = path.join(REPO, 'cache', '_schema-check')
await rm(SANDBOX_ROOT, { recursive: true, force: true })
await mkdir(path.join(SANDBOX_ROOT, 'inbox'), { recursive: true })
await mkdir(path.join(SANDBOX_ROOT, 'outbox'), { recursive: true })
// 合成一份 access 文件，让上行分支真的走到成功路径（下面 fetch 被 stub）。
await writeFile(
  path.join(SANDBOX_ROOT, 'bridge_access.json'),
  `${JSON.stringify({
    base_url: 'http://127.0.0.1:1',
    token: 'schema-check-token',
    ping_url: 'http://127.0.0.1:1/ping',
    send_url: 'http://127.0.0.1:1/send',
    default_target: 'stub',
  }, null, 2)}\n`,
  'utf8',
)

// stub 掉 fetch：绝不发真请求。成功路径要**带 body**，因为正是
// sendUplink 成功时的 {ok,status,result} 触发了 value.uplink.result 那条真实故障。
const fetchCalls = []
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input)
  fetchCalls.push(url)
  const body = url.endsWith('/ping') ? { ok: true, pong: true } : { ok: true, message: 'stub', id: 'stub' }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

plugin.apply(fakeCtx, { root: SANDBOX_ROOT, pollMs: 0 })
await new Promise((resolve) => setTimeout(resolve, 300))

if (captured.size === 0) {
  console.error('没有捕获到任何工具定义（plugin.apply 没注册工具？）')
  process.exit(2)
}

// ── 用真断言校验（复刻 ctx.tools.register 与模型 API 的要求） ──────────────
// register() 只做 assertSupportedJsonSchema(output.schema) 并原样收下 definition，
// parameters 会被原样发给模型 —— 模型要求它是 object 根的 JSON Schema，
// 所以这里用 assertObjectJsonSchema（= 子集断言 + object 根）。
let bad = 0
for (const [name, definition] of captured) {
  const problems = []
  try {
    assertObjectJsonSchema(definition.parameters)
  } catch (error) {
    problems.push(`parameters → ${error.message}`)
  }
  if (definition.output?.schema !== undefined) {
    try {
      assertSupportedJsonSchema(definition.output.schema)
    } catch (error) {
      problems.push(`output.schema → ${error.message}`)
    }
  }
  if (problems.length === 0) {
    console.log(`  [OK]   ${name}`)
  } else {
    bad += 1
    console.log(`  [FAIL] ${name}`)
    for (const problem of problems) console.log(`         ${problem}`)
  }
}

// ── 行为门禁：真跑一遍三个工具，校验「返回值 vs output.schema」 ─────────────
// dsh-tools 会拿 output.schema **严格**校验返回值（含 additionalProperties: false），
// 也会用 isJsonValue 判 lossless JSON。真踩过的故障：
//   tool "bridge_inbox" returned invalid output: value is not lossless JSON
//   tool "bridge_complete" returned invalid output: "value.uplink.result" is not a declared property
// 两者都只在**真有任务/真上行成功**时才现形，光看 schema 断言查不出来。
const gateTaskId = 'schema-gate-1'
await writeFile(
  path.join(SANDBOX_ROOT, 'inbox', `${gateTaskId}.json`),
  `${JSON.stringify({
    id: gateTaskId,
    from: '用户',
    to: 'dsh',
    time: new Date().toISOString(),
    type: 'task',
    content: '门禁任务（不写 ref 字段，复刻闸门的真实格式）',
    status: 'pending',
  }, null, 2)}\n`,
  'utf8',
)
// 让 boot 先跑完（它会把 access 读进来，后面的上行分支才走得到成功路径）
await new Promise((resolve) => setTimeout(resolve, 300))

/** 复刻 dsh-tools 的 lossless JSON 判定：JSON.stringify 会静默丢掉 undefined。 */
function losslessProblems(value, at = 'value', seen = new Set()) {
  const bad = []
  if (value === undefined) return [`${at} is undefined（不是合法 JSON 值）`]
  if (value === null) return bad
  const type = typeof value
  if (type === 'function' || type === 'symbol' || type === 'bigint') return [`${at} is ${type}`]
  if (type === 'number' && !Number.isFinite(value)) return [`${at} is ${String(value)}`]
  if (type !== 'object') return bad
  if (seen.has(value)) return [`${at} is circular`]
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, i) => bad.push(...losslessProblems(item, `${at}[${i}]`, seen)))
  } else {
    for (const [key, item] of Object.entries(value)) bad.push(...losslessProblems(item, `${at}.${key}`, seen))
  }
  seen.delete(value)
  return bad
}

const gateArgs = {
  bridge_inbox: {},
  bridge_claim: { id: gateTaskId },
  bridge_complete: { id: gateTaskId, result: '门禁结果：回环已跑通。', summary: '门禁', status: 'done' },
}
// 顺序有依赖：先读、再认领、最后完成
const order = ['bridge_inbox', 'bridge_claim', 'bridge_complete'].filter((n) => captured.has(n))
let outputBad = 0
for (const name of order) {
  const definition = captured.get(name)
  const problems = []
  let value
  try {
    value = await definition.execute(gateArgs[name] ?? {}, {})
  } catch (error) {
    problems.push(`execute 抛错 → ${error.message}`)
  }
  if (value !== undefined) {
    problems.push(...losslessProblems(value))
    const violations = tools.validateJsonSchemaValue(definition.output.schema, value, '')
    problems.push(...violations.map((v) => `value ${v}`))
  }
  if (problems.length === 0) {
    console.log(`  [OK]   ${name} 输出通过（lossless + 符合 output.schema）`)
  } else {
    outputBad += 1
    console.log(`  [FAIL] ${name} 输出`)
    for (const problem of problems.slice(0, 6)) console.log(`         ${problem}`)
  }
}

console.log('')
if (bad > 0) {
  console.log(`✗ ${bad} 个工具的 schema 不合规：注册会抛 JsonSchemaError（插件树加载失败），`)
  console.log(`  或 parameters 不是 object 根被模型 API 拒收（本轮对话失败）。`)
  process.exit(1)
}
if (outputBad > 0) {
  console.log(`✗ ${outputBad} 个工具的**返回值**不符合自己的 output.schema / 不是 lossless JSON：`)
  console.log(`  真运行时工具调用会直接报 invalid output（execute 的副作用其实已经发生了）。`)
  process.exit(1)
}
console.log(`✓ ${captured.size} 个工具的 parameters（object 根）与 output.schema 都通过 dsh-tools 真断言；`)
console.log(`  且真跑一遍后，返回值全部是 lossless JSON 且符合各自的 output.schema。`)
