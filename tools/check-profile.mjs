#!/usr/bin/env node
/**
 * 组合预检：复刻 DSH Desktop 启动时的 profile 组合 + id 唯一性检查。
 *
 * 为什么需要它
 * ------------
 * DSH Desktop 启动时会：
 *   1. 读 profile 的 package.json → dsh.profile.bundles（每个 bundle 一层 patch）
 *   2. 再叠加 profile 自己的 cordis.patch.yml（再一层 patch）
 *   3. 把各层 patch 的 insert 行拼成 loader 行，然后 assertUniqueEntryIds()
 * 只要同一个 id 被两层各 insert 一次，就会在**启动时**抛：
 *   dsh-plugin-desktop: duplicate loader entry id "<id>" in the composed profile
 * 桌面端随即进恢复模式（尝试 dsh plugin remove，而 remove 会跑 pnpm；一旦
 * 离线/私有 git 依赖拉不动，恢复也会失败），最后只能人工回滚 profile。
 *
 * 本脚本在**重启之前**离线跑一遍同样的组合，把冲突提前暴露出来。
 *
 * 用法：
 *   node tools/check-profile.mjs                 # 默认检查 desktop profile
 *   node tools/check-profile.mjs --profile web
 *   node tools/check-profile.mjs --dsh-home "C:/Users/用户/.dsh"
 *
 * 退出码：0 = 无冲突；1 = 有重复 id / 有致命问题；2 = 用法或环境问题。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
function argValue(flag, fallback) {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const PROFILE = argValue('--profile', 'desktop')
const DSH_HOME = argValue(
  '--dsh-home',
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
)
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE)
const PROFILE_PATCH = path.join(PROFILE_DIR, 'cordis.patch.yml')
// asar 里 @deepseek-ai/* 的抽取位置（tools/validate-tool-schemas.mjs 生成）。
const ASAR_SCOPE = argValue(
  '--asar-scope',
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cache', '_dsh-asar', 'node_modules'),
)

// ── js-yaml（DSH 同款解析器，从 profile 的 node_modules 里借） ──────────────
function loadYaml() {
  // js-yaml 装在真实的 DSH home 里；--dsh-home 可能指向临时目录，所以两条线都找。
  const homes = new Set([DSH_HOME, process.env.DSH_HOME, path.join(os.homedir(), '.dsh')])
  const candidates = []
  for (const home of homes) {
    if (!home) continue
    for (const profile of [PROFILE, 'web', 'desktop']) {
      candidates.push(path.join(home, 'profiles', profile, 'node_modules', 'js-yaml'))
    }
  }
  candidates.push('js-yaml')
  const tried = []
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch (error) {
      tried.push(`${candidate} (${error.code ?? error.message})`)
    }
  }
  console.error('找不到 js-yaml，试过：')
  for (const line of tried) console.error(`  - ${line}`)
  process.exit(2)
}
const YAML = loadYaml()

// 内置 bundle 的 patch 里有 `!!js` 表达式（dsh-base 11 处、dsh-web-app 6 处），
// 默认 schema 会因未知标签直接抛。这里注册成占位值——咱们只要 id。
const JS_TAGS = [
  'tag:yaml.org,2002:js',
  'tag:yaml.org,2002:js/function',
  'tag:yaml.org,2002:js/regexp',
  'tag:yaml.org,2002:js/undefined',
].map((tag) => new YAML.Type(tag, { kind: 'scalar', construct: (data) => ({ $js: data }) }))
const PATCH_SCHEMA = YAML.FAILSAFE_SCHEMA.extend(JS_TAGS)

// ── 解析一个 patch 文件 → insert 行 ─────────────────────────────────────────
/** 读文本并去掉 BOM（PowerShell 5.1 的 Set-Content -Encoding UTF8 会带 BOM）。 */
function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
}

function parsePatchFile(file, layerName) {
  if (!fs.existsSync(file)) {
    return { layer: layerName, file, rows: [], error: null, missing: true }
  }
  const text = readText(file)
  let doc
  try {
    doc = YAML.load(text, { schema: PATCH_SCHEMA })
  } catch (error) {
    try {
      doc = YAML.load(text)
    } catch (inner) {
      return { layer: layerName, file, rows: [], error: inner.message, missing: false }
    }
  }
  if (doc === null || doc === undefined) return { layer: layerName, file, rows: [], error: null }
  if (!Array.isArray(doc)) {
    return { layer: layerName, file, rows: [], error: '顶层不是 YAML 数组（loader patch 必须是数组）' }
  }
  const rows = []
  for (const patch of doc) {
    if (patch && typeof patch === 'object' && Array.isArray(patch.insert)) {
      collect(patch.insert, rows)
    }
  }
  return { layer: layerName, file, rows, error: null }
}

/** 递归收集 insert 行（group 行把子行放在 config 数组里）。 */
function collect(entries, out) {
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    out.push({ id: typeof entry.id === 'string' ? entry.id : null, name: entry.name ?? null })
    if (entry.group === true && Array.isArray(entry.config)) collect(entry.config, out)
  }
}

// ── 组装：bundles 各一层 + profile patch 一层（与 Desktop 顺序一致） ───────
if (!fs.existsSync(path.join(PROFILE_DIR, 'package.json'))) {
  console.error(`profile 不存在：${PROFILE_DIR}`)
  process.exit(2)
}

const manifest = JSON.parse(readText(path.join(PROFILE_DIR, 'package.json')))
const bundles = manifest?.dsh?.profile?.bundles ?? []
const patchReload = manifest?.dsh?.profile?.patchReload

console.log(`profile   : ${PROFILE_DIR}`)
console.log(`bundles   : ${bundles.length} 个，patchReload=${JSON.stringify(patchReload)}`)
console.log('')

const layers = []
for (const name of bundles) {
  let pkgPath = path.join(PROFILE_DIR, 'node_modules', name, 'package.json')
  let origin = name
  if (!fs.existsSync(pkgPath)) {
    // 官方/桌面内置 bundle 由 app.asar 提供，不在 profile node_modules 里。
    // 如果 validate-tool-schemas.mjs 已经把 asar 里的 @deepseek-ai 抽出来
    // （cache/_dsh-asar），就一并读进来做**全量**组合检查，别再跳过。
    const fromAsar = path.join(ASAR_SCOPE, name, 'package.json')
    if (fs.existsSync(fromAsar)) {
      pkgPath = fromAsar
      origin = `${name} (asar)`
    } else {
      layers.push({
        layer: name,
        file: '(内置 bundle，未抽取，跳过)',
        rows: [],
        error: null,
        builtin: true,
      })
      continue
    }
  }
  const pkg = JSON.parse(readText(pkgPath))
  const declared = pkg?.dsh?.bundle?.patch
  if (typeof declared !== 'string' || declared.length === 0) {
    layers.push({
      layer: origin,
      file: pkgPath,
      rows: [],
      error: 'package.json 里没有 dsh.bundle.patch（放进了 bundles 却不是 bundle 插件）',
    })
    continue
  }
  layers.push(parsePatchFile(path.join(path.dirname(pkgPath), declared), origin))
}
layers.push(parsePatchFile(PROFILE_PATCH, `${PROFILE}/cordis.patch.yml (profile 层)`))

// ── 插件契约检查：真去 import 每个 bundle 的入口，验证 cordis 契约 ─────────
// 这一步抓的是「id 不重复、但插件本身挂不上」的失败，其中一个真实崩溃是：
// cordis 用 Standard Schema 协议解析配置（Config['~standard'].validate(raw)），
// 插件却导出了描述字段的普通对象 → TypeError: Cannot read properties of undefined
// (reading 'validate') → 整个插件树加载失败 + 桌面端回滚 profile。
const contractIssues = []
for (const name of bundles) {
  const pkgPath = path.join(PROFILE_DIR, 'node_modules', name, 'package.json')
  if (!fs.existsSync(pkgPath)) continue // 内置 bundle，跳过
  const pkg = JSON.parse(readText(pkgPath))
  const entry = typeof pkg.main === 'string'
    ? pkg.main
    : (typeof pkg.exports?.['.'] === 'string' ? pkg.exports['.'] : null)
  if (entry === null) {
    contractIssues.push(`${name}: package.json 里没有可用的 main / exports["."]`)
    continue
  }
  const entryPath = path.resolve(path.dirname(pkgPath), entry)
  if (!fs.existsSync(entryPath)) {
    contractIssues.push(`${name}: 入口文件不存在 ${entryPath}`)
    continue
  }
  let mod
  try {
    mod = await import(`${pathToFileURL(entryPath).href}?preflight=${Date.now()}`)
  } catch (error) {
    // 宿主导入的包（@deepseek-ai/* 等）由 DSH 自己的安装提供，裸跑 node 解析不到——
    // 那是本脚本的环境局限，不是插件的故障，只记为「跳过」。
    // 相对/绝对路径导入失败、语法错误等，是真问题，照旧致命。
    const missing = /Cannot find (?:package|module) '([^']+)'/.exec(error.message)?.[1]
    const bareHarnessDep = error.code === 'ERR_MODULE_NOT_FOUND'
      && typeof missing === 'string'
      && !missing.startsWith('.')
      && !missing.startsWith('/')
    if (bareHarnessDep) {
      contractIssues.push({ soft: true, text: `${name}: 跳过（${missing} 由宿主提供，离线解析不到）` })
    } else {
      contractIssues.push({ soft: false, text: `${name}: 入口 import 失败 — ${error.message}` })
    }
    continue
  }
  if (typeof mod.name !== 'string') contractIssues.push({ soft: false, text: `${name}: 未导出 name（字符串）` })
  if (!Array.isArray(mod.inject)) contractIssues.push({ soft: false, text: `${name}: 未导出 inject（数组）` })
  if (typeof mod.apply !== 'function') contractIssues.push({ soft: false, text: `${name}: 未导出 apply（函数）` })
  const schema = mod.Config
  if (schema !== undefined && typeof schema?.['~standard']?.validate !== 'function') {
    contractIssues.push({
      soft: false,
      text: `${name}: Config 不是 Standard Schema（缺 '~standard'.validate）——cordis 挂载时会抛 `
        + `"Cannot read properties of undefined (reading 'validate')"。`
        + `要么删掉 Config 导出，要么用 schemastery 的 z.object({...})。`,
    })
  }
}

// ── 报告 ───────────────────────────────────────────────────────────────────
let fatal = false
const owner = new Map()
const occurrences = new Map()

for (const layer of layers) {
  if (layer.builtin) {
    console.log(`  [内置] ${layer.layer}`)
    continue
  }
  if (layer.error) {
    console.log(`  [错误] ${layer.layer} — ${layer.error}`)
    if (!layer.missing) fatal = true
    continue
  }
  if (layer.rows.length === 0) {
    console.log(`  [空]   ${layer.layer}`)
    continue
  }
  for (const row of layer.rows) {
    const label = row.id ?? '(无 id)'
    if (row.id === null) {
      console.log(`  [警告] ${layer.layer} 插入了一行没有 id 的条目（name=${row.name}）`)
      continue
    }
    if (owner.has(row.id)) {
      fatal = true
      occurrences.set(row.id, (occurrences.get(row.id) ?? 1) + 1)
      console.log(`  [重复] id "${row.id}"`)
      console.log(`           ← ${owner.get(row.id)}`)
      console.log(`           ← ${layer.layer}`)
    } else {
      owner.set(row.id, layer.layer)
      occurrences.set(row.id, 1)
      console.log(`  [行]   ${row.id}  ← ${layer.layer}`)
    }
  }
}

console.log('')
for (const issue of contractIssues) {
  if (issue.soft) {
    console.log(`  [跳过] ${issue.text}`)
  } else {
    fatal = true
    console.log(`  [契约] ${issue.text}`)
  }
}
if (contractIssues.length > 0) console.log('')

const gatewayCount = occurrences.get('dsh-astrbot-gateway') ?? 0
if (gatewayCount === 1) {
  console.log(`✓ dsh-astrbot-gateway 恰好一行，来源：${owner.get('dsh-astrbot-gateway')}`)
} else if (gatewayCount === 0) {
  console.log('· dsh-astrbot-gateway 没有出现在组合里（未安装）')
} else {
  console.log(`✗ dsh-astrbot-gateway 出现了 ${gatewayCount} 行 —— 这就是本次崩溃的直接原因。`)
}

if (fatal) {
  console.log('')
  console.log('✗ 组合有问题：DSH Desktop 启动会失败并进恢复模式（恢复要跑 pnpm，离线时连恢复都会失败）。')
  if (contractIssues.some(issue => !issue.soft)) {
    console.log('  · 契约问题见上面的 [契约] 行：id 组合没问题，但插件本身挂不上。')
  }
  if (occurrences.get('dsh-astrbot-gateway') > 1) {
    console.log('  · 重复 id：同一个 id 只留一层。bundle 插件靠 dsh.profile.bundles 挂载，')
    console.log(`    就不要再往 ${path.basename(PROFILE_PATCH)} 里额外写一行同样的 insert。`)
  }
  process.exit(1)
}
console.log('')
console.log('✓ 组合无重复 id，插件契约检查通过。')
