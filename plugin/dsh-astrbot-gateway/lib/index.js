// dsh-astrbot-gateway —— dsh 侧桥接插件（宿主平面 / Host plane）
//
// 职责（对应 docs/message-rules.md「中转规则 v2」）：
//   下行：轮询 cache/inbox/*.json 取 **闸门筛选后转达** 的指令，
//         结果写进 cache/outbox/<id>.json（source/ref/status/summary/content 必须齐全）。
//   上行：**只落盘，不直发用户**。桥接通道只到闸门为止，由闸门整理后再转给用户。
//         所以本插件默认 uplinkMode='off'，一次 QQ 消息都不发（见下面「下行通道」注释）。
//
// 历史：v1 是「写 outbox + 上行接口直接给用户发消息」。用户与闸门于 2026-09-12
// 共同确认改成 v2（唯一闸门），docs/message-rules.md 是权威规范，本文件的
// DEFAULT_SOURCE / OUTBOX_SPEC_FIELDS / writeResultJson / deliver 都按它实现。
//
// 为什么用 node: 内建模块：本插件是宿主组合里的一行（由 cordis.patch.yml 挂载），
// 不是沙箱里的 agent 工具，所以可以直接用 node:fs / node:path / 全局 fetch。
//
// 依赖策略：严格注入，所以 inject 必须声明全部用到的服务；
// 但**不把「取不到服务」变成静默**——能力探测结果会写进 bridge_status.json，
// 缺什么一眼可见（历史上就吃过「整行挂起、什么都不写」的亏）。
// 定时器优先用宿主 `timer` 服务，万一 ctx.interval 不可用则退回 Node 全局并记明。
//
// 设计取舍（有意为之）：
//   - 轮询发现新指令后：**自动拉起一个 DSH 会话去处理**（autoDispatch，默认开），
//     并同时通知用户一次。自动拉起失败只降级成「只通知」，绝不影响插件本身。
//   - 不擅自把任务标成 running：认领仍由 agent 调 bridge_claim 完成。这样重复轮询、
//     反复拉起、无人在场时，任务都不会被悄悄吞掉。
//   - 已通知/已拉起的任务各写一个标记（cache/.notified-<id>、cache/.dispatched-<id>），
//     保证重启后不会重复打扰用户、也不会重复拉起。

import { readFile, writeFile, mkdir, readdir, rename, stat } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

/** 默认桥接数据根目录（docs 里的约定路径）。 */
const DEFAULT_ROOT = join(homedir(), 'dsh-astrbot-gateway', 'cache')
/** 文案里对「闸门」的称呼（可配）。 */
const DEFAULT_GATEKEEPER = 'AstrBot 闸门'
/** 访问文件名（两边必须一致，可配 accessFile 覆盖）。 */
const DEFAULT_ACCESS_FILE = 'bridge_access.json'

/** 默认轮询间隔（毫秒）。 */
const DEFAULT_POLL_MS = 4000
/** 消息/摘要里正文的截断长度。 */
const DEFAULT_PREVIEW_CHARS = 120
/** 上行前缀（可配 prefix 覆盖）。 */
const DEFAULT_PREFIX = '[dsh]'
/** 完成/失败文案的头（可配 doneTitle / failedTitle 覆盖）。 */
const DEFAULT_DONE_TITLE = '任务完成'
const DEFAULT_FAILED_TITLE = '任务失败'
/** 自动拉起相关文案（可配 dispatchedText / dispatchFailedText 覆盖）。 */
const DEFAULT_DISPATCHED_TEXT = '已自动拉起会话'
const DEFAULT_DISPATCH_FAILED_TEXT = '自动拉起失败'
/** 单次 bridge_inbox 最多返回多少条未完结任务。 */
const DEFAULT_INBOX_LIMIT = 50
/** 自动拉起最多重试几次（含首次），超过就放弃并如实告诉用户。 */
const DEFAULT_MAX_DISPATCH_ATTEMPTS = 3
/** 下行通道标识：写进 bridge_status.json，一眼看出「只落盘、不直发」。 */
const DOWNLINK_MODE = 'outbox-only'
/** v2 规范的默认 source（docs/message-rules.md：source=dsh）。 */
const DEFAULT_SOURCE = 'dsh'
/** v2 规范要求 outbox 结果必须齐全的字段。 */
const OUTBOX_SPEC_FIELDS = ['id', 'source', 'ref', 'status', 'summary', 'content']
/** 巡检通知文件名后缀：`<id>.notice.json`，与任务结果同目录，闸门侧一次扫目录全能看见。 */
const NOTICE_SUFFIX = '.notice.json'
/** 落盘文本里正文最多保留多少字符（超出会留一行显式说明，不静默丢弃）。 */
const DEFAULT_OUTBOX_TEXT_LIMIT = 100000
/** 两次自动拉起尝试之间的最小间隔（毫秒），避免轮询间隔短时几秒内就烧完重试次数。 */
const DEFAULT_DISPATCH_RETRY_MS = 60000
/**
 * 认领后多久没回报就算「卡死」，自动回收成 failed（毫秒；0 = 关闭回收）。
 *
 * 为什么需要：bridge_claim 只把 inbox 标成 running，如果那次会话被中断（用户重启 DSH、
 * 在 GUI 里点了停止、宿主动手掐掉），agent 就再也没机会调 bridge_complete，
 * 这条记录会永远停在 running，队列里一直显示「有 1 条在跑」，看着像桥断了。
 * 默认 30 分钟：正常指令远用不到这么久，真跑超了也会落一条失败结果给闸门转述。
 */
const DEFAULT_RUNNING_TIMEOUT_MS = 30 * 60 * 1000

// ───────────────────────── 提示词模板 ─────────────────────────
//
// 投给新会话的那段话（提示词）**不写死在代码里**，而是从 markdown 模板读：
//   1. 配置 dispatchPromptFile 指定的文件；
//   2. 没配就找 <桥接目录>/../config/dispatch-prompt.md（仓库里的 config/ 就是它）；
//   3. 再找插件目录下的 config/dispatch-prompt.md；
//   4. 都没有就用下面的内置兜底模板，保证零配置也能跑。
//
// 模板里可用的占位符：{{id}} {{content}} {{source}} {{gatekeeper}} {{preset}} {{workspace}}
/** 模板文件的默认相对路径。 */
const DEFAULT_PROMPT_RELATIVE = join('config', 'dispatch-prompt.md')

/** 内置兜底提示词模板（占位符同外部模板）。 */
const BUILTIN_PROMPT = [
  '【桥接指令 {{id}}】来自用户，经闸门转达。',
  '',
  '{{content}}',
  '',
  '请按桥接流程处理这条指令：',
  '1. 先调用 bridge_claim，id = {{id}}（认领，把状态改成 running）；',
  '2. 执行上面的指令内容；',
  '3. 完成后调用 bridge_complete，id = {{id}}，result 写完整结果，summary 写一句话摘要。' +
    '每次完成都必须汇报，不许默默结束。',
  '',
  '注意：结果写进 outbox/<id>.json 就行，不要自己想办法直接给用户发消息，' +
    '交付给闸门、由它转述。',
].join('\n')

/** 把 {{key}} 占位符换成实际值（不用正则，免得转义踩坑）。 */
function renderTemplate(tpl, vars) {
  let out = String(tpl)
  for (const [key, value] of Object.entries(vars)) {
    out = out.split('{{' + key + '}}').join(String(value ?? ''))
  }
  return out
}

async function loadDispatchPrompt(runtime) {
  if (runtime.promptTemplate !== undefined) return runtime.promptTemplate
  const candidates = runtime.dispatchPromptFile
    ? [runtime.dispatchPromptFile]
    : [
        join(runtime.paths.root, '..', DEFAULT_PROMPT_RELATIVE),
        join(runtime.pluginDir, DEFAULT_PROMPT_RELATIVE),
      ]
  for (const file of candidates) {
    try {
      const text = await readFile(file, 'utf8')
      if (text.trim()) {
        runtime.promptSource = file
        runtime.promptTemplate = text
        runtime.log?.('[dsh-gateway] 已加载提示词模板: ' + file)
        return text
      }
    } catch {
      // 找不到就试下一个候选
    }
  }
  runtime.promptSource = '(内置默认)'
  runtime.promptTemplate = null
  runtime.log?.('[dsh-gateway] 没找到提示词模板，用内置默认')
  return null
}

// ───────────────────────────── 小工具 ─────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function truncate(text, max = DEFAULT_PREVIEW_CHARS) {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 统一错误转字符串。 */
function errText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 递归丢掉对象里的 `undefined`，让返回值成为 lossless JSON。
 *
 * 为什么必须有：dsh-tools 会用 isJsonValue 校验**每个工具的输出**，带 undefined
 * 的对象不是合法 JSON 值，于是运行时报：
 *   tool "bridge_inbox" returned invalid output: value is not lossless JSON
 * （队列为空时恰好没有 undefined 字段，所以这个 bug 只在真有任务时才现形。）
 */
function jsonSafe(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(jsonSafe)
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    out[key] = jsonSafe(item)
  }
  return out
}

/** 拼 URL 时避免出现 `//`。 */
function joinUrl(base, suffix) {
  return `${String(base).replace(/\/+$/, '')}${suffix}`
}

/**
 * 取一个**可选**宿主服务。
 *
 * cordis 里 `ctx.get(name)` 只是查表：取不到返回 undefined，**不会抛**。
 * 会抛的是 `ctx.<name>` 这种属性访问（`cannot get property "x" without inject`）。
 * 所以可选能力一律 get + 判空，绝不能写进 inject —— 否则宿主没这个服务时
 * 整个插件树都加载不起来（这个坑真踩过：inject 里的服务必须存在）。
 */
function safeGet(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** 标记文件是否存在。 */
async function markerExists(file) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/** 只接受安全的文件名片段，挡住 `..\` 之类的路径穿越。 */
const SAFE_ID = /^[A-Za-z0-9._-]+$/

function assertSafeId(id) {
  const s = String(id ?? '').trim()
  if (!s || !SAFE_ID.test(s)) {
    throw new Error(`unsafe or empty task id: ${JSON.stringify(id)}`)
  }
  return s
}

/** JSON 落盘统一走「临时文件 + rename」，读者永远看不到半截文件。 */
async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/** 超长文本落盘时留一行显式说明，绝不静默截断。 */
function clampText(text, limit = DEFAULT_OUTBOX_TEXT_LIMIT) {
  const s = String(text ?? '')
  if (s.length <= limit) return s
  return `${s.slice(0, limit)}\n…（正文过长，已截断 ${s.length - limit} 字符；完整原文见 bridge_status.json 与日志）`
}

/**
 * 写**结果**文件（outbox/<id>.json）——形状由 docs/message-rules.md 第二节钉死：
 *
 *   id / from / to / source / time / type / ref / status / summary / content 缺一不可
 *
 * 其中 `source`（信息来源）与 `status`（当前状态）是用户明确点名的必备字段：
 * 少了任何一个，闸门侧就无法判断这条该不该转、转的是谁的话。
 * `to` 固定 `gateway`（v2 起桥接通道只到闸门，不再写用户）。
 */
async function writeResultJson(paths, { textLimit, id, status, summary, content, source, extra }) {
  const now = new Date().toISOString()
  const file = join(paths.outbox, `${id}.json`)
  await mkdir(paths.outbox, { recursive: true })
  const payload = {
    id,
    from: 'dsh',
    to: 'gateway',
    source: String(source || DEFAULT_SOURCE),
    time: now,
    type: 'result',
    ref: id,
    status,
    summary: String(summary ?? ''),
    content: clampText(content, textLimit ?? DEFAULT_OUTBOX_TEXT_LIMIT),
    ...(extra && typeof extra === 'object' ? extra : {}),
  }
  await writeJsonAtomic(file, payload)
  return { file, payload }
}

/**
 * 写**巡检通知**文件（outbox/<id>.notice.json）。
 *
 * 为什么是文件而不是 QQ 消息：v2 规定「若确有必要即时告知，也只能走闸门这条路」。
 * dsh 侧唯一的对外通道就是闸门的账号，而那是发给用户本人的私聊 —— 用它发就等于
 * 绕过闸门直连用户。所以通知一律落盘，由闸门取件后用自己的话转述。
 */
async function writeNoticeJson(paths, { textLimit, id, summary, content, status = 'notice', source }) {
  const now = new Date().toISOString()
  const file = join(paths.outbox, `${id}${NOTICE_SUFFIX}`)
  await mkdir(paths.outbox, { recursive: true })
  const payload = {
    id: `${id}${NOTICE_SUFFIX}`,
    from: 'dsh',
    to: 'gateway',
    source: String(source || DEFAULT_SOURCE),
    time: now,
    type: 'notice',
    ref: id,
    status,
    summary: String(summary ?? ''),
    content: clampText(content, textLimit ?? DEFAULT_OUTBOX_TEXT_LIMIT),
    notice: true,
  }
  await writeJsonAtomic(file, payload)
  return { file, payload }
}

/** 读 JSON；文件不存在返回 undefined，解析失败抛错。 */
async function readJson(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  return JSON.parse(text)
}

// ───────────────────────── 路径与访问文件 ─────────────────────────

function pathsFor(root, accessFile = DEFAULT_ACCESS_FILE) {
  const base = resolve(root)
  return {
    root: base,
    inbox: join(base, 'inbox'),
    outbox: join(base, 'outbox'),
    access: join(base, accessFile),
    status: join(base, 'bridge_status.json'),
    lock: join(base, '.bridge.lock'),
    notified: (id) => join(base, `.notified-${id}`),
    dispatched: (id) => join(base, `.dispatched-${id}`),
  }
}

/**
 * 读访问文件并退回到安全默认值。
 * 容错是故意的：访问文件缺失或字段不全时，插件要能起来并如实报错，
 * 而不是让整个 harness 启动失败。
 */
async function loadAccess(paths) {
  let raw = {}
  try {
    raw = (await readJson(paths.access)) ?? {}
  } catch (error) {
    return { access: null, error: `读取访问文件失败: ${errText(error)}` }
  }
  if (!raw.token) {
    return {
      access: null,
      error:
        `访问文件缺少 token（${paths.access}）。` +
        '请在 AstrBot 里重载 astrbot_plugin_dsh_gateway 以重新签发。',
    }
  }
  const baseUrl = String(raw.base_url || 'http://127.0.0.1:6185').replace(/\/+$/, '')
  return {
    access: {
      baseUrl,
      token: String(raw.token),
      pingUrl: String(raw.ping_url || joinUrl(baseUrl, '/api/plug/astrbot_plugin_dsh_gateway/ping')),
      sendUrl: String(raw.send_url || joinUrl(baseUrl, '/api/plug/astrbot_plugin_dsh_gateway/send')),
      defaultTarget: raw.default_target ? String(raw.default_target) : undefined,
    },
    error: null,
  }
}

/** 上行自检：GET ping_url。 */
async function pingUplink(access) {
  try {
    const res = await fetch(access.pingUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${access.token}` },
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, body: truncate(text, 300) }
  } catch (error) {
    return { ok: false, status: 0, body: `ping 失败: ${errText(error)}` }
  }
}

/**
 * 上行：借闸门的账号发一条文本。
 * 成功返回 { ok: true, ... }；失败返回 { ok: false, message }。
 *
 * ⚠️ v2 起本函数**默认不会被调用**：它到达的是闸门的 QQ 账号，也就是用户本人的私聊，
 * 用它发消息等于绕过闸门直连用户。只有显式把 uplinkMode 设成 'on'（紧急开闸）才会走这里。
 * 保留它是为了「哪天桥接彻底断了、需要人工救火」时改一个配置项即可恢复，而不是改代码。
 */
async function sendUplink(runtime, text, options = {}) {
  const { access } = runtime
  if (!access) {
    return { ok: false, message: runtime.accessError ?? '访问文件不可用，无法上行' }
  }
  const body = { text: String(text) }
  if (options.target) body.target = String(options.target)
  if (options.type) body.type = String(options.type)

  try {
    const res = await fetch(access.sendUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const raw = await res.text()
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    if (!res.ok) {
      const message = parsed?.message ?? truncate(raw, 300)
      return { ok: false, status: res.status, message: `上行失败(${res.status}): ${message}` }
    }
    if (parsed?.ok === false) {
      return { ok: false, status: res.status, message: `上行被拒绝: ${parsed.message ?? raw}` }
    }
    return { ok: true, status: res.status, result: parsed ?? truncate(raw, 300) }
  } catch (error) {
    return { ok: false, status: 0, message: `上行请求异常: ${errText(error)}` }
  }
}

const withPrefix = (text, prefix = DEFAULT_PREFIX) => `${prefix} ${text}`

/**
 * 统一出口：按 v2 只落盘，绝不直发用户。
 *
 * 返回形状固定为 { channel, ok, file, message }，且**只含 schema 里声明过的字段**：
 * dsh-tools 会拿 output.schema 严格校验工具返回值（additionalProperties: false），
 * 多带一个未声明字段就会让整次调用报 invalid output（真踩过）。
 */
/**
 * 把一份汇报推进闸门的中转箱（= AstrBot 侧的 relay），等闸门取件转述。
 *
 * 为什么需要它：v2 定的是「结果只落盘、等闸门取件」，可那样用户要等闸门
 * 主动去扫才知道任务完了。用户于 2026-09-12 19:40 补了规矩 —— 每次完成都要
 * 汇报、且只能经闸门，所以落盘之外再主动推一次。推的是给闸门看的原文，
 * 不直发用户，主动权始终在闸门那边。
 */
/**
 * 从宿主 roster.list() 的返回值里刮出预设 id 列表。
 *
 * 为什么要这么啰嗦：dsh-agent-presets 的 list() 返回形状在不同版本/调用面上
 * 不完全一致（数组、{presets}、{items}，元素是字符串或 {id}）。早先只认
 * `listed.presets`，形状一变就刮出空数组，于是**任何点名的预设都被判成
 * 「不在花名册」而回退到配置值** —— 2026-09-12 晚上 minimal 点名失效就是这么来的。
 * 这里把已知形状全认下来，认不出就返回 null（= 不校验），宁可不拦也不要误拦。
 */
function presetIdsOf(listed) {
  const candidates = []
  if (Array.isArray(listed)) candidates.push(listed)
  if (listed && typeof listed === 'object') {
    for (const key of ['presets', 'items', 'list', 'rows', 'entries']) {
      if (Array.isArray(listed[key])) candidates.push(listed[key])
    }
  }
  const rows = candidates.find((rows) => rows.length > 0) ?? candidates[0]
  if (!Array.isArray(rows)) return null
  const ids = rows
    .map((row) => {
      if (typeof row === 'string') return row
      if (row && typeof row === 'object') {
        for (const key of ['id', 'presetId', 'preset', 'name']) {
          if (typeof row[key] === 'string' && row[key]) return row[key]
        }
      }
      return undefined
    })
    .filter(Boolean)
  return ids.length ? ids : null
}

async function pushToGatekeeper(runtime, { id, status, summary, content, source, notice = false }) {
  const kind = notice ? '通知' : status === 'failed' ? '任务失败' : '任务完成'
  const text = [
    `[dsh·${kind}] ${id}`,
    '',
    summary || truncate(content, 400) || '（没有摘要）',
    '',
    `来源: ${source || DEFAULT_SOURCE}`,
  ].join('\n')
  try {
    const res = await sendUplink(runtime, text)
    if (!res.ok) runtime.log?.(`[dsh-gateway] 推给闸门失败: ${res.message}`)
    return res
  } catch (error) {
    runtime.log?.(`[dsh-gateway] 推给闸门出错: ${errText(error)}`)
    return { ok: false, message: errText(error) }
  }
}

async function deliver(runtime, { id, summary, content, status = 'notice', source, notice = false }) {
  // 只有显式 'on' 才开闸。默认 'off' —— 少一个字段、写错大小写都不会误发。
  if (runtime.uplinkMode === 'on') {
    const res = await sendUplink(runtime, withPrefix(content, runtime.prefix))
    return {
      channel: 'qq-uplink',
      ok: res.ok === true,
      file: null,
      message: res.ok
        ? '已按 uplinkMode=on 直发（注意：这是 v1 行为，v2 规范下不该用）'
        : `直发失败: ${res.message}`,
    }
  }
  let written
  try {
    written = notice
      ? await writeNoticeJson(runtime.paths, { id, summary, content, status, source })
      : await writeResultJson(runtime.paths, { id, status, summary, content, source })
  } catch (error) {
    return {
      channel: DOWNLINK_MODE,
      ok: false,
      file: null,
      message: `落盘失败: ${errText(error)}`,
    }
  }

  // v2.1（2026-09-12 19:40 定的新规矩）：**每次完成都必须汇报，且只能经闸门转述**。
  // 落盘是权威交付物（闸门随时能取件），但光落盘用户不会立刻知道，
  // 所以在落盘之后，再把同一份摘要推进闸门的中转箱（AstrBot 的 /send → dsh_relay），
  // 由闸门取件后用自己的话转给用户。仍然不直发用户，主动权始终在闸门那边。
  const pushed = await pushToGatekeeper(runtime, { id, status, summary, content, source, notice })
  return {
    channel: pushed.ok ? 'outbox+gateway' : DOWNLINK_MODE,
    ok: true,
    file: written.file,
    message: pushed.ok
      ? '已落盘 outbox，并已推给闸门汇报（由闸门转述给用户）'
      : `已落盘 outbox，但推给闸门失败（闸门仍会取件）: ${pushed.message}`,
  }
}

// ───────────────────────── 队列读写 ─────────────────────────

/**
 * 取指令里点名的 agent 预设（`preset` 优先，也认 `agentPreset`）。
 * 只判断「有没有给、是不是非空字符串」，**不校验存在性** —— 那是 pickDispatchPreset 的事。
 */
function taskPreset(task) {
  const value = task?.preset ?? task?.agentPreset
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

async function listTasks(paths, wanted) {
  let names
  try {
    names = await readdir(paths.inbox)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }

  const tasks = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json') || name.startsWith('.')) continue
    const file = join(paths.inbox, name)
    let json
    try {
      json = await readJson(file)
    } catch {
      // 半截文件或坏 JSON：跳过，等闸门写完下一轮再读。
      continue
    }
    if (!json || typeof json !== 'object') continue
    const status = String(json.status ?? 'pending')
    if (wanted && !wanted.includes(status)) continue
    tasks.push({
      id: String(json.id ?? name.replace(/\.json$/i, '')),
      from: json.from ? String(json.from) : '用户',
      to: json.to ? String(json.to) : 'dsh',
      time: json.time ? String(json.time) : '',
      type: json.type ? String(json.type) : 'task',
      content: String(json.content ?? ''),
      status,
      ref: json.ref ? String(json.ref) : undefined,
      // 指令点名的 agent 预设（闸门按这条指令的性质选「模式」；
      // HOI4 任务写 preset: "teyvat-hoi4"，不写就走插件配置/宿主默认）。
      preset: taskPreset(json),
      // 逐条点名的工作区组别：'none' / 'ungrouped' / '未分组' 表示这次故意落「未分组」，
      // 给具体路径就以该路径为组别；都没给就退回插件配置里的 dispatchCwd。
      workspace:
        typeof json.workspace === 'string' && json.workspace.trim()
          ? json.workspace.trim()
          : typeof json.cwd === 'string' && json.cwd.trim()
            ? json.cwd.trim()
            : undefined,
      file,
      raw: json,
    })
  }
  tasks.sort((a, b) => String(a.time).localeCompare(String(b.time)))
  return tasks
}

/**
 * 认领一个任务：把 inbox 里那一条的 status 改成 running。
 * 已经是 running 的也允许重复认领（幂等），避免插件重启后卡死。
 */
async function claimTask(runtime, id) {
  const { paths } = runtime
  const safe = assertSafeId(id)
  const file = join(paths.inbox, `${safe}.json`)
  let json
  try {
    json = await readJson(file)
  } catch (error) {
    return { ok: false, message: `任务文件无法解析: ${errText(error)}` }
  }
  if (!json) return { ok: false, message: `任务不存在: ${safe}` }

  const status = String(json.status ?? 'pending')
  if (status === 'done' || status === 'failed') {
    return { ok: false, message: `任务已结束（${status}），不再认领: ${safe}` }
  }

  const updated = {
    ...json,
    id: json.id ?? safe,
    status: 'running',
    claimed_at: new Date().toISOString(),
  }
  await writeJsonAtomic(file, updated)
  await writeStatus(paths, runtime)
  return { ok: true, task: { ...updated, id: String(updated.id) }, path: file }
}

/**
 * 完成任务：写 outbox/<id>.json（v2 全字段），回写 inbox 状态，再按 v2 交付给闸门。
 * 返回每一步的真实结果——交付失败不会让「结果已落盘」这件事变成失败。
 */
async function completeTask(runtime, args) {
  const { paths } = runtime
  const id = assertSafeId(args.id)
  const status = args.status === 'failed' ? 'failed' : 'done'
  const summary = String(args.summary ?? '')
  const result = String(args.result ?? summary)
  const now = new Date().toISOString()
  // source 默认 dsh（v2 规范）；调用方显式给了就用它。
  const source = String(args.source ?? DEFAULT_SOURCE)

  await mkdir(paths.outbox, { recursive: true })

  // outbox 里**只留规范内的字段**：闸门只认 source/ref/status/summary/content，
  // 加料（比如 uplink 的返回值）会让「字段必须齐全」这条规矩变成噪音。
  const written = await writeResultJson(paths, { textLimit: runtime.outboxTextLimit,
    id,
    status,
    summary,
    content: result,
    source,
  })
  const outboxFile = written.file

  // ── 交付：只落盘，不直发用户 ──
  const head = status === 'done' ? runtime.doneTitle : runtime.failedTitle
  const notice = summary || result
  const delivered = await deliver(runtime, {
    id,
    // summary 是「给闸门转述用的一句话」；content 必须是**完整结果**，
    // 绝不能拿 notice（截断后的预览）去顶替它 —— v2 要求 content 是完整内容。
    summary: `${head}：${id}${notice ? ` — ${truncate(notice, 200)}` : ''}`,
    content: result,
    status,
    source,
    notice: false,
  })


  // 回写 inbox 的状态，让闸门侧也能看到进展（失败只记日志，不算整体失败）。
  // ⚠️ 必须写在交付**之后**：delivery 要如实记下这一趟到底走没走中转箱。
  //    早先它写在交付之前，于是 inbox 永远显示 outbox-only、跟实际不符（自测逮到过）。
  let inboxUpdated = true
  try {
    const inboxFile = join(paths.inbox, `${id}.json`)
    const current = await readJson(inboxFile)
    if (current) {
      await writeJsonAtomic(inboxFile, {
        ...current,
        status,
        finished_at: now,
        outbox: outboxFile,
        source,
        delivery: delivered.channel,
      })
    }
  } catch (error) {
    inboxUpdated = false
    runtime.log?.(`[dsh-gateway] 回写 inbox 状态失败: ${errText(error)}`)
  }

  await writeStatus(paths, runtime)

  return jsonSafe({
    id,
    status,
    outboxFile,
    inboxUpdated,
    delivery: jsonSafe({
      channel: delivered.channel,
      ok: delivered.ok,
      file: delivered.file,
      message: delivered.message,
    }),
    // v1 兼容字段：老读者（含 v1 时代的自测断言）读到的仍是「上行怎么样」。
    // v2 下它会被归一化成 { ok:true, message:'落盘...' }，因为交付本身成功了。
    uplink: jsonSafe({
      ok: delivered.ok,
      message: delivered.message,
    }),
  })
}

/** 汇总队列快照，方便自检和 status 文件。 */
function snapshotOf(all) {
  const count = (s) => all.filter((t) => t.status === s).length
  return {
    total: all.length,
    pending: count('pending'),
    running: count('running'),
    done: count('done'),
    failed: count('failed'),
  }
}

/**
 * AstrBot 侧还没装好、或者装好了但连不上时，用一句人话告诉用户下一步做什么。
 * 为什么要写：桥断的时候最怕「什么都没写」，用户看到「去面板装插件、填转达账号」
 * 就知道该动哪一步，而不是盯着 accessError 猜。
 * 上行自检通过时返回 null，什么都不提示。
 */
function peerHint(runtime) {
  if (runtime.uplinkOk === true) return null
  const err = String(runtime.accessError ?? '')
  if (/ENOENT|no such file/i.test(err)) {
    return (
      'AstrBot 侧还没装好：找不到访问文件 bridge_access.json。' +
      '请在 AstrBot 面板装「大肥鱼桥」（astrbot_plugin_dsh_gateway），' +
      '在配置里填上转达账号，然后重启 AstrBot。'
    )
  }
  if (err) {
    return (
      `AstrBot 侧连不上或还没装好（${err}）：` +
      '先确认面板里的「大肥鱼桥」已启用、转达账号已填，再重启 AstrBot 试试。'
    )
  }
  return 'AstrBot 侧还没回应自检：确认它已装好「大肥鱼桥」并正在运行。'
}

/** 写一份状态快照，方便闸门侧或人肉排查。 */
async function writeStatus(paths, runtime) {
  let snapshot = { total: 0, pending: 0, running: 0, done: 0, failed: 0, promptSource: runtime.promptSource ?? null }
  let error = null
  try {
    snapshot = snapshotOf(await listTasks(paths, null))
  } catch (err) {
    error = errText(err)
  }
  const status = {
    time: new Date().toISOString(),
    access: runtime.access
      ? { baseUrl: runtime.access.baseUrl, target: runtime.access.defaultTarget ?? null }
      : null,
    accessError: runtime.accessError ?? null,
    // 人话提示：装好/连通时是 null，否则告诉用户「该去 AstrBot 那边做哪一步」。
    hint: peerHint(runtime),
    uplink: runtime.uplinkOk ?? null,
    // v2：让「有没有可能直发用户」在状态文件里一眼可见，不用去读代码。
    uplinkMode: runtime.uplinkMode ?? 'off',
    downlink: DOWNLINK_MODE,
    // 超时回收阈值：0 表示关着。写进快照，免得「为什么 running 被标失败了」要翻代码。
    runningTimeoutMs: runtime.runningTimeoutMs ?? null,
    capabilities: runtime.capabilities,
    // 自动拉起的三个选择也落进快照：想知道「桥接会话跑哪种模式 / 归哪个工作区」
    // 时直接看这个文件，不用真去拉一个会话。改了 profile 补丁后也靠它验证是否生效。
    dispatch: {
      autoDispatch: runtime.autoDispatch ?? null,
      cwd: runtime.dispatchCwd ?? null,
      preset: runtime.dispatchPreset ?? null,
      // 宿主实际可用的 agent 预设（= 可点名的「模式」）：点名一个不在册的会回退到 preset。
      availablePresets: await listPresetIds(runtime),
      presetRosterShape: runtime.presetRosterShape ?? null,
    },
    queue: snapshot,
    error,
  }
  try {
    await writeJsonAtomic(paths.status, status)
  } catch (error2) {
    runtime.log?.(`[dsh-gateway] 写状态文件失败: ${errText(error2)}`)
  }
  runtime.lastStatus = status
  return status
}

// ───────────────────────── 轮询 ─────────────────────────

/** 自动拉起时投给新会话的首条用户消息：模板来自 config 文件夹，见 loadDispatchPrompt。 */
async function dispatchPrompt(runtime, task) {
  const template = (await loadDispatchPrompt(runtime)) ?? BUILTIN_PROMPT
  return renderTemplate(template, {
    id: task.id,
    content: task.content || '（这条指令没有正文）',
    source: runtime.sourceName,
    gatekeeper: runtime.gatekeeper,
    preset: task.preset ?? runtime.dispatchPreset ?? '',
    workspace: task.workspace ?? runtime.dispatchCwd ?? '',
  })
}

/**
 * 选本次拉起用的工作目录（= 会话归属的工作区组别）。
 *
 * 规矩（用户定的）：**能挂上工作区就带上组别；挂不上就落「未分组」，但不能因此失败**。
 * 所以这里只做"可用性判断"，不可用就返回 undefined —— 调用方会走"不传 cwd"的路径，
 * 会话照样建、照样干活，只是显示在未分组里。
 */
async function pickDispatchCwd(runtime, task) {
  const asked =
    typeof task?.workspace === 'string' && task.workspace.trim()
      ? task.workspace.trim()
      : typeof task?.cwd === 'string' && task.cwd.trim()
        ? task.cwd.trim()
        : ''
  if (asked) {
    if (asked === 'none' || asked === 'ungrouped' || asked === '未分组') {
      runtime.log?.('[dsh-gateway] 指令点名「未分组」，本次会话不挂工作区')
      return undefined
    }
    try {
      if ((await stat(asked)).isDirectory()) return asked
      runtime.log?.(`[dsh-gateway] 指令点名的工作区不是目录，本次会话落「未分组」: ${asked}`)
    } catch {
      runtime.log?.(`[dsh-gateway] 指令点名的工作区不存在，本次会话落「未分组」: ${asked}`)
    }
    return undefined
  }
  const wanted = runtime.dispatchCwd
  if (!wanted) return undefined
  try {
    if ((await stat(wanted)).isDirectory()) return wanted
    runtime.log?.(`[dsh-gateway] dispatchCwd 不是目录，本次会话落「未分组」: ${wanted}`)
  } catch {
    runtime.log?.(`[dsh-gateway] dispatchCwd 不存在，本次会话落「未分组」: ${wanted}`)
  }
  return undefined
}

/**
 * 选本次拉起用哪个 agent 预设（= 新会话以哪种「模式」跑）。
 *
 * 为什么需要它：`sessionController.create()` 不传 `agentPreset` 时用的是**宿主默认预设**，
 * 而本机 `$DSH_HOME/settings.yaml` 的 `agent-presets.default` 是 `teyvat-hoi4`（提瓦特黎明
 * HOI4 项目专用，persona 强制每个回合先读 `E:\teyvatdaybreak\PROJECT_RULES.md` + SKILL 索引）。
 * 桥接指令大多跟那个项目无关，于是每条自动拉起的会话都白跑几轮读规则 —— 实测三条桥接会话的
 * header 全是 `"agentPreset":"teyvat-hoi4"`。用户定的规矩：
 *   **桥接默认走「标准模式」（standard），需要 HOI4 模式的指令由闸门点名。**
 *
 * 优先级（高 → 低）：
 *   1. 指令自带 `preset` / `agentPreset` —— 闸门按这条指令的性质指定（如 teyvat-hoi4 / hoi4-mod）；
 *   2. 插件配置 `dispatchPreset`（本机 desktop profile 的补丁层设成 standard）；
 *   3. 都给不出 → undefined，交宿主默认（settings.yaml 的 agent-presets.default）。
 *
 * 点名的预设不存在时**不让指令失败**：记一行日志后按 2/3 回退 —— 一条指令不该因为预设名
 * 写错就跑不动。花名册读不到（宿主没这服务/读失败）时也不拦，直接交给 create 判定。
 */
async function pickDispatchPreset(runtime, task) {
  const asked = taskPreset(task)
  if (!asked) return runtime.dispatchPreset
  if (asked === runtime.dispatchPreset) return asked

  try {
    const roster = safeGet(runtime.ctx, 'agentPresets')
    if (roster && typeof roster.list === 'function') {
      const ids = presetIdsOf(await roster.list())
      if (ids && !ids.includes(asked)) {
        const fallback = runtime.dispatchPreset ?? '宿主默认预设'
        runtime.log?.(
          `[dsh-gateway] 指令 ${task.id} 点名的预设 "${asked}" 不在花名册` +
            `（可用: ${ids.join(', ') || '无'}），回退到 ${fallback}`,
        )
        return runtime.dispatchPreset
      }
    }
  } catch (error) {
    // 花名册读不到不算错：create 自己会用 `agent-preset/not-found` 说话。
    runtime.log?.(`[dsh-gateway] 读 agent 预设花名册失败（不校验，交给宿主判定）: ${errText(error)}`)
  }
  return asked
}

/**
 * 读宿主的 agent 预设花名册，把可用的预设 id 列出来（写进状态文件用）。
 * 读不到就返回 null —— 花名册读不到不代表出错，只是没法校验点名的模式。
 */
async function listPresetIds(runtime) {
  try {
    const roster = safeGet(runtime.ctx, 'agentPresets')
    if (roster && typeof roster.list === 'function') {
      const listed = await roster.list()
      // 诊断用：把原始形状留一份，形状再变时不用重启也能看出问题。
      runtime.presetRosterShape = Array.isArray(listed)
        ? `array(${listed.length})`
        : listed && typeof listed === 'object'
          ? `object(${Object.keys(listed).join(',').slice(0, 160)})`
          : typeof listed
      return presetIdsOf(listed)
    }
    runtime.presetRosterShape = 'no-roster-service'
  } catch (error) {
    runtime.presetRosterShape = `error: ${errText(error)}`
    runtime.log?.(`[dsh-gateway] 读 agent 预设花名册失败: ${errText(error)}`)
  }
  return null
}

/**
 * 自动拉起：为一条新指令创建一个 DSH 会话，并把指令作为用户消息投进去，
 * 让 agent 自己跑完整条桥接流程（认领 → 执行 → 回报），不用用户手动叫。
 *
 * 机制照抄部署里现成的 @agents-anywhere/dsh-bridge-next（它就是「外部事件 → DSH 会话」
 * 的官方实现）：
 *   await sessionController.create(request)            // 建会话。⚠️ 不传 cwd 会拿到宿主的
 *                                                     // process.cwd()（= DSH 安装目录），
 *                                                     // 那个路径不属于任何工作区，会话就落
 *                                                     // 「未分组」——真踩过。
 *   await sessionController.prompt(request, signal)   // 投一条用户消息；按 requestId 幂等去重。
 *                                                     // ⚠️ signal 是**必需的第二参数**：
 *                                                     // SessionController.prompt 第一行就是
 *                                                     // `signal.throwIfAborted()`，不传会抛
 *                                                     // Cannot read properties of undefined
 *                                                     // (reading 'throwIfAborted') —— 也真踩过。
 *   await workspaceRegistry.create(cwd).attachSession(id)
 *                                                     // 把会话挂进对应工作区，GUI 侧边栏读的
 *                                                     // 就是工作区的 sessionIds。attachSession
 *                                                     // 会校验会话 header 的 cwd 必须等于工作区
 *                                                     // 路径，所以 create 的 cwd 要与这里一致。
 * 三个服务都用 ctx.get 取（可选取），缺了就让调用方降级成「只通知不自动处理」。
 *
 * `create()` 的 `agentPreset` 交给 pickDispatchPreset 决定（指令点名 > dispatchPreset > 宿主默认）。
 * 返回 `{ sessionId, preset }`：调用方要把「这条指令最终跑在哪种模式」如实写进 outbox 通知。
 */
async function dispatchTask(runtime, task) {
  const controller = safeGet(runtime.ctx, 'sessionController')
  if (!controller || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
    throw new Error('宿主没有提供 sessionController（或它此刻还没就绪）')
  }
  const cwd = await pickDispatchCwd(runtime, task)
  const preset = await pickDispatchPreset(runtime, task)
  const created = await controller.create({
    ...(cwd ? { cwd } : {}),
    ...(preset ? { agentPreset: preset } : {}),
  })
  const sessionId = created?.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('sessionController.create 没有返回 sessionId')
  }
  // 挂到工作区组别。挂不上不算致命：会话照样能干活，只是显示在「未分组」。
  if (cwd) {
    try {
      const registry = safeGet(runtime.ctx, 'workspaceRegistry')
      if (registry && typeof registry.create === 'function') {
        const workspace = await registry.create(cwd)
        if (workspace && typeof workspace.attachSession === 'function') {
          await workspace.attachSession(sessionId)
        }
      }
    } catch (error) {
      runtime.log?.(
        `[dsh-gateway] 会话 ${sessionId} 挂到工作区 ${cwd} 失败（落未分组，不影响执行）: ${errText(error)}`,
      )
    }
  }
  await controller.prompt(
    {
      sessionId,
      requestId: `bridge-${task.id}`,
      mode: 'queue',
      content: [{ type: 'text', text: await dispatchPrompt(runtime, task) }],
    },
    // 必需的取消信号：宿主不关心"谁取消"，但会先 throwIfAborted() 检查它存在。
    new AbortController().signal,
  )
  return { sessionId, preset }
}

/**
 * 一轮轮询：发现 pending 指令 → 自动拉起会话处理 → 通知**落盘给闸门** → 刷新状态文件。
 *
 * v2 起通知不再直发用户：`deliver()` 把「收到指令 / 已拉起 / 拉起失败」写成
 * `outbox/<id>.notice.json`，由闸门取件后用自己的话转述。这里**不写实时 QQ 消息**，
 * 因为那等于绕过闸门（见 writeNoticeJson 的注释）。
 *
 * 有意不去改任务状态：认领仍由 agent 显式调用 bridge_claim 完成，
 * 这样重复轮询或没人干活时，指令都不会被悄悄标成 running 而永久卡住。
 */
async function runPollCycle(runtime) {
  const { paths } = runtime
  await mkdir(paths.inbox, { recursive: true })
  await mkdir(paths.outbox, { recursive: true })

  const pending = await listTasks(paths, ['pending'])
  let notified = 0
  let dispatched = 0
  let deliverFailed = 0

  for (const task of pending) {
    // ── 1) 自动拉起（先做，通知里才能如实报告结果） ──
    let dispatchNote = '等我处理。'
    if (runtime.autoDispatch && !(await markerExists(paths.dispatched(task.id)))) {
      // 两次尝试之间至少隔 dispatchRetryMs：否则轮询间隔 4s 时，3 次重试会在
      // 十几秒内烧完，遇到需要人工修的问题会立刻"放弃"，很误导。
      const lastAttemptAt = runtime.dispatchLastAt.get(task.id) ?? 0
      const waitMore = Date.now() - lastAttemptAt < runtime.dispatchRetryMs
      const attempts = runtime.dispatchAttempts.get(task.id) ?? 0
      if (waitMore) {
        if (attempts > 0) dispatchNote = `${runtime.dispatchFailedText}，等待重试。`
      } else {
        const nextAttempt = attempts + 1
        runtime.dispatchAttempts.set(task.id, nextAttempt)
        runtime.dispatchLastAt.set(task.id, Date.now())
        try {
          const launched = await dispatchTask(runtime, task)
          const { sessionId, preset } = launched
          dispatched += 1
          runtime.capabilities.dispatch = 'ready'
          // 如实报出「这条跑在哪种模式」：用户一眼就能看出桥接会话有没有被 HOI4 persona 接管。
          dispatchNote = `${runtime.dispatchedText} ${sessionId} 处理（模式 ${preset ?? '宿主默认'}）。`
          runtime.log?.(
            `[dsh-gateway] 已为 ${task.id} 自动拉起会话 ${sessionId}（预设 ${preset ?? '宿主默认'}）`,
          )
          try {
            await writeFile(paths.dispatched(task.id), `${new Date().toISOString()} ${sessionId}\n`, 'utf8')
          } catch {
            // 标记写不下去最多下轮重复拉起；prompt 按 requestId 幂等，不会重复执行。
          }
        } catch (error) {
          runtime.capabilities.dispatch = 'failed'
          dispatchNote =
            nextAttempt >= runtime.maxDispatchAttempts
              ? `${runtime.dispatchFailedText}（${errText(error)}），不再重试，需要你叫我处理。`
              : `${runtime.dispatchFailedText}（${errText(error)}），稍后重试。`
          runtime.log?.(
            `[dsh-gateway] 自动拉起 ${task.id} 失败（第 ${nextAttempt} 次）: ${errText(error)}`,
          )
          if (nextAttempt >= runtime.maxDispatchAttempts) {
            // 记下放弃标记，避免每轮都重试、每轮都打扰用户。
            try {
              await writeFile(paths.dispatched(task.id), `giveup ${new Date().toISOString()}\n`, 'utf8')
            } catch {
              // 忽略
            }
          }
        }
      }
    }

    // ── 2) 通知（只通知一次）：落盘给闸门，不直发用户 ──
    if (await markerExists(paths.notified(task.id))) continue

    const res = await deliver(runtime, {
      id: task.id,
      summary: `收到指令 ${task.id}：${truncate(task.content, runtime.previewChars)}`,
      content: `收到转达的指令（${task.id}）：\n${truncate(task.content, 300)}\n\n${dispatchNote}`,
      status: 'notice',
      notice: true,
    })
    if (res.ok) {
      notified += 1
      try {
        await writeFile(paths.notified(task.id), `${new Date().toISOString()}\n`, 'utf8')
      } catch {
        // 标记写不下去只会在下轮重复通知，不算致命。
      }
    } else {
      deliverFailed += 1
      runtime.log?.(`[dsh-gateway] 通知 ${task.id} 落盘失败: ${res.message}`)
    }
  }

  // ── 3) 超时回收：认领了却再也没回报的 running ──
  //
  // 有意放在通知循环之后：本轮的 pending 先照常处理，回收只碰「早就认领过、现在没人管」的。
  // 回收动作复用 completeTask（写 outbox 失败结果 + 回写 inbox），所以闸门会收到一条
  // 「任务失败：超时未回报」的交付，而不是让这条永远挂在队列里当 running。
  // 如果那条会话其实还活着、事后才调 bridge_complete，后写的 done 会覆盖这次 failed，无害。
  let reaped = 0
  if (runtime.runningTimeoutMs > 0) {
    let running = []
    try {
      running = await listTasks(paths, ['running'])
    } catch (error) {
      runtime.log?.(`[dsh-gateway] 读取 running 任务失败，本轮跳过超时回收: ${errText(error)}`)
    }
    for (const task of running) {
      const claimedAt = Date.parse(String(task.raw?.claimed_at ?? ''))
      if (!Number.isFinite(claimedAt)) continue
      const age = Date.now() - claimedAt
      if (age < runtime.runningTimeoutMs) continue
      const minutes = Math.max(1, Math.round(age / 60000))
      try {
        await completeTask(runtime, {
          id: task.id,
          status: 'failed',
          summary: `超时回收：指令 ${task.id} 认领后 ${minutes} 分钟没回报，已标失败`,
          result: [
            `【超时回收】指令 ${task.id} 在 ${new Date(claimedAt).toISOString()} 被认领后，`,
            `${minutes} 分钟没有调用 bridge_complete。`,
            '常见原因：DSH 重启、会话在 GUI 里被停止、或 agent 中途被杀，来不及汇报。',
            `原指令内容：${task.content || '（无正文）'}`,
            '已按 failed 结清，避免这条永远挂在队列里冒充 running。要重跑就再投一次同名指令。',
          ].join('\
'),
          source: DEFAULT_SOURCE,
        })
        reaped += 1
        runtime.log?.(`[dsh-gateway] 超时回收 ${task.id}（认领后 ${minutes} 分钟未回报）`)
      } catch (error) {
        runtime.log?.(`[dsh-gateway] 超时回收 ${task.id} 失败: ${errText(error)}`)
      }
    }
  }

  const status = await writeStatus(paths, runtime)
  runtime.lastPollAt = status.time
  return { pending: status.queue.pending, notified, dispatched, deliverFailed, reaped }
}

// ───────────────────────── 工具输出渲染 ─────────────────────────

const textRender =
  (makeText) =>
  (_args, value) => [{ type: 'text', text: makeText(value) }]

function renderInbox(value) {
  const { summary, tasks, note } = value
  const lines = [
    `inbox: 共 ${summary.total} 条，pending ${summary.pending}，running ${summary.running}，done ${summary.done}，failed ${summary.failed}`,
  ]
  for (const t of tasks) {
    lines.push('')
    lines.push(`- id=${t.id} [${t.status}] from=${t.from} type=${t.type} time=${t.time || '?'}`)
    lines.push(`  ${truncate(t.content, 200)}`)
  }
  if (!tasks.length) lines.push('（没有未完结的指令）')
  if (note) lines.push('', note)
  return lines.join('\n')
}

function renderComplete(value) {
  const d = value.delivery
  return [
    `任务 ${value.id} 已标记为 ${value.status}`,
    `结果文件: ${value.outboxFile}`,
    `回写 inbox: ${value.inboxUpdated ? '成功' : '失败（见日志）'}`,
    `交付闸门: ${d?.ok ? `${d.channel}${d.file ? ` → ${d.file}` : ''}` : `失败 — ${d?.message ?? '未知原因'}`}`,
  ].join('\n')
}

// ───────────────────────── 插件主体 ─────────────────────────

export const name = 'dsh-astrbot-gateway'

// cordis 0811 是**严格注入**：ctx.get / ctx.<service> 用到的服务必须在 inject 里声明，
// 否则 apply 一开头就抛 `cannot get property without inject`，整个插件不注册。
// 所以这里必须老实列出用到的两个服务：tools（注册工具）、timer（轮询定时器）。
export const inject = ['tools', 'timer']

// ⚠️ 这里**不能**导出 `Config`。
//
// cordis 解析插件配置走 Standard Schema 协议，实现是
//   entry.plugin.Config['~standard'].validate(rawConfig)
// （@deepseek-ai/cordis lib/index.js 的 resolveConfig）。所以 `Config` 必须是
// schemastery 的 `z.object({...})` 实例，**不是**描述字段的普通对象。
// 写成普通对象时 `Config['~standard']` 是 undefined，读 `.validate` 立刻抛：
//   TypeError: Cannot read properties of undefined (reading 'validate')
// 后果是整个插件树加载失败，DSH Desktop 还会因此进恢复模式去回滚 profile。
//
// 本插件刻意保持**零依赖**（只 import node: 内置模块），拿不到
// @deepseek-ai/schemastery（desktop profile 的 node_modules 里没有它，装它要走 pnpm/联网），
// 所以不导出 Config：组合里那一行不给 config 也照常跑，全部走 apply 里的默认值。
// 需要覆盖时在 profile 的行里写 config，apply 会照常读到（无校验，有默认）。
//
//   键默认说明
//   root            <项目目录>\cache    桥接缓存根目录
//   pollMs          4000                                轮询间隔毫秒；0 关闭轮询
//   autoDispatch    true                                扫到 pending 就自动拉起会话处理
//   dispatchPreset  ''                                  自动拉起用哪个 agent 预设；空=宿主默认。
//                                                       本机 desktop profile 的补丁层设成
//                                                       'standard'（标准模式），免得每条桥接
//                                                       指令都继承 settings.yaml 里那个
//                                                       HOI4 项目预设（teyvat-hoi4）。
//                                                       单条指令可用 inbox JSON 的 preset 覆盖。
//   dispatchCwd     <桥接目录的上一级>                  自动拉起的会话工作目录（= 它归属的工作区）
//                                                      必须与 GUI 里能看到的工作区一致，否则会话
//                                                      会被归到别的工作区、侧边栏看不到
//   dispatchRetryMs 60000                               两次拉起尝试的最小间隔；失败最多重试 3 次
//   runningTimeoutMs 1800000                            认领后多久没回报就回收成 failed（0=关）
//   autoClaim       false                               发现新指令是否自动标 running（仍由 agent 认领）
//   uplinkMode      'off'                               'off'=只落盘交付闸门（v2 默认，不直发用户）；
//                                                       'on'=恢复 v1 直发用户（仅救火用）
//   defaultTarget   ''                                  上行目标；空则用 access 文件里的
//   targetType      'PrivateMessage'                    AstrBot 只接受 Private/GroupMessage

export function apply(ctx, config) {
  const cfg = config ?? {}
  const paths = pathsFor(cfg.root ?? DEFAULT_ROOT, cfg.accessFile ? String(cfg.accessFile) : DEFAULT_ACCESS_FILE)
  const pollMs = Number.isFinite(cfg.pollMs) ? Math.max(0, Number(cfg.pollMs)) : DEFAULT_POLL_MS
  // 自动拉起：默认开（用户明确要求「扫到 pending 就自动处理，别等我手动叫」）。
  // 关掉它就退回「只通知」的旧行为。
  const autoDispatch = cfg.autoDispatch === undefined ? true : Boolean(cfg.autoDispatch)

  const pluginDir = dirname(fileURLToPath(import.meta.url))
  const runtime = {
    ctx,
    paths,
    pluginDir,
    access: null,
    accessError: null,
    uplinkOk: null,
    defaultTarget: cfg.defaultTarget ? String(cfg.defaultTarget) : undefined,
    targetType: cfg.targetType ? String(cfg.targetType) : 'PrivateMessage',
    // v2（唯一闸门）：**默认 'off'** —— 一次 QQ 消息都不发，结果只落 outbox。
    // 只有显式写 'on' 才恢复 v1 的直发行为；写错任何值都按 'off' 处理（宁可少发不可多发）。
    uplinkMode: String(cfg.uplinkMode ?? 'off').toLowerCase() === 'on' ? 'on' : 'off',
    autoDispatch,
    dispatchCwd: cfg.dispatchCwd ? String(cfg.dispatchCwd) : resolve(paths.root, '..'),
    dispatchPreset: cfg.dispatchPreset ? String(cfg.dispatchPreset) : undefined,
    // 提示词模板：不给就用 <root>/../config/dispatch-prompt.md 或插件目录下的同名文件
    dispatchPromptFile: cfg.dispatchPromptFile ? String(cfg.dispatchPromptFile) : undefined,
    promptTemplate: undefined,
    promptSource: null,
    // 文案里怎么称呼「信息来源」和「闸门」，都可由配置改
    sourceName: cfg.source ? String(cfg.source) : DEFAULT_SOURCE,
    gatekeeper: cfg.gatekeeper ? String(cfg.gatekeeper) : DEFAULT_GATEKEEPER,
    // ── 下面这些都可由配置改；不写就用默认值，也就是改造前的行为 ──
    prefix: cfg.prefix === undefined ? DEFAULT_PREFIX : String(cfg.prefix),
    doneTitle: cfg.doneTitle === undefined ? DEFAULT_DONE_TITLE : String(cfg.doneTitle),
    failedTitle: cfg.failedTitle === undefined ? DEFAULT_FAILED_TITLE : String(cfg.failedTitle),
    dispatchedText:
      cfg.dispatchedText === undefined ? DEFAULT_DISPATCHED_TEXT : String(cfg.dispatchedText),
    dispatchFailedText:
      cfg.dispatchFailedText === undefined
        ? DEFAULT_DISPATCH_FAILED_TEXT
        : String(cfg.dispatchFailedText),
    maxDispatchAttempts:
      Number.isFinite(cfg.maxDispatchAttempts) && Number(cfg.maxDispatchAttempts) > 0
        ? Number(cfg.maxDispatchAttempts)
        : DEFAULT_MAX_DISPATCH_ATTEMPTS,
    previewChars:
      Number.isFinite(cfg.previewChars) && Number(cfg.previewChars) > 0
        ? Number(cfg.previewChars)
        : DEFAULT_PREVIEW_CHARS,
    inboxLimit:
      Number.isFinite(cfg.inboxLimit) && Number(cfg.inboxLimit) > 0
        ? Number(cfg.inboxLimit)
        : DEFAULT_INBOX_LIMIT,
    outboxTextLimit:
      Number.isFinite(cfg.outboxTextLimit) && Number(cfg.outboxTextLimit) > 0
        ? Number(cfg.outboxTextLimit)
        : DEFAULT_OUTBOX_TEXT_LIMIT,
    dispatchAttempts: new Map(),
    dispatchLastAt: new Map(),
    dispatchRetryMs:
      Number.isFinite(cfg.dispatchRetryMs) && Number(cfg.dispatchRetryMs) >= 0
        ? Number(cfg.dispatchRetryMs)
        : DEFAULT_DISPATCH_RETRY_MS,
    // 认领后迟迟不回报的 running 会被回收成 failed（0 或负数 = 关闭回收）。
    runningTimeoutMs:
      Number.isFinite(cfg.runningTimeoutMs) && Number(cfg.runningTimeoutMs) >= 0
        ? Number(cfg.runningTimeoutMs)
        : DEFAULT_RUNNING_TIMEOUT_MS,
    lastStatus: null,
    lastPollAt: null,
    polling: false,
    capabilities: {
      tools: false,
      timer: false,
      interval: false,
      poller: 'none',
      dispatch: 'unknown',
      report: 'skipped',
    },
    log: (msg) => ctx.logger?.info?.(msg),
  }

  const inboxLimit = runtime.inboxLimit
  const outboxTextLimit = runtime.outboxTextLimit

  ctx.logger?.info?.(`[dsh-gateway] 桥接目录: ${paths.root}`)

  // 严格注入下 ctx.tools 一定有（inject 声明过）；这里只探测定时器形态，
  // 结果进 status 文件，避免「静默什么都没发生」。
  const hostInterval = typeof ctx.interval === 'function' ? ctx.interval.bind(ctx) : undefined
  runtime.capabilities.tools = typeof ctx.tools?.register === 'function'
  runtime.capabilities.timer = typeof ctx.timer !== 'undefined'
  runtime.capabilities.interval = Boolean(hostInterval)

  // 自动拉起依赖宿主的 sessionController（可选取：没它就降级成"只通知"，
  // 绝不能写进 inject，否则没这个服务的宿主连插件都加载不了）。
  //
  // 注意：这里只是**快照探测**。插件的行可能比 session-controller 那一行先激活，
  // 此时 ctx.get 会返回 undefined（cordis 对未运行的服务返回 undefined），
  // 但真正的拉起发生在轮询里，那时服务通常已经就绪 —— 所以失败了也不算数，
  // 真正的判定放在 dispatchTask 里。实测就撞到过这个顺序问题。
  const sessionController = safeGet(ctx, 'sessionController')
  const controllerUsable = typeof sessionController?.create === 'function'
    && typeof sessionController?.prompt === 'function'
  runtime.capabilities.dispatch = !autoDispatch
    ? 'disabled'
    : controllerUsable
      ? 'ready'
      : 'lazy'
  if (autoDispatch && !controllerUsable) {
    ctx.logger?.info?.(
      '[dsh-gateway] sessionController 此刻还没就绪（激活顺序）：自动拉起时会在轮询里重新取，不影响通知。',
    )
  }

  ctx.logger?.info?.(
    `[dsh-gateway] 能力探测: tools=${runtime.capabilities.tools} ` +
      `timer=${runtime.capabilities.timer} ctx.interval=${runtime.capabilities.interval} ` +
      `autoDispatch=${runtime.capabilities.dispatch} cwd=${runtime.dispatchCwd ?? '(宿主默认)'} ` +
      `preset=${runtime.dispatchPreset ?? '(宿主默认)'}`,
  )

  // 工具：让 agent 能查看/认领/完成指令。
  //
  // ⚠️ 传进去的必须是**编译后的原始 JSON Schema**，不是作者描述符 DSL。原因：
  //
  //   dsh-tools 的作者向 API 是 defineTool({ parameters: 描述符DSL, output: { schema, render } })。
  //   defineTool 内部做两件事：
  //     parameters    = parameterSchemaSpecToJsonSchema(描述符DSL)  // {id:{...}} → {type:'object',properties:{...},required:[...]}
  //     output.schema = valueSchemaSpecToJsonSchema(作者值schema)    // 逐字段 required:true → 编译成合法原始 schema
  //   然后把**编译结果**交给 ctx.tools.register()。
  //
  //   而 register() 本身**不编译任何东西**，它只做三件事：
  //     1. 要求 output 里有 render 函数；
  //     2. assertSupportedJsonSchema(output.schema) —— 把 output.schema 当成**已是原始 JSON Schema** 校验；
  //     3. 把 definition **原样**塞进工具表。
  //   所以裸调 register(裸定义) 会连踩两个坑（都真踩过）：
  //     · 描述符 DSL 被当原始 schema 校验 → JsonSchemaError（required 只能出现在 object 上等），
  //       整个插件树加载失败 → 桌面端回滚 profile；
  //     · parameters 原样发给模型 → 根节点没有 type → 模型 API 报
  //       Invalid schema for function 'bridge_claim': schema must be a JSON Schema of
  //       'type: "object"', got 'type: null' → 本轮对话直接失败。
  //
  //   本插件刻意零依赖（只 import node: 内置模块），拿不到 @deepseek-ai/dsh-tools 的 defineTool，
  //   所以这里直接写**编译后**的形态，与 defineTool 的产物一致：
  //     parameters    : { type:'object', properties:{...}, required:[...] }（没有必填参数时省略 required）
  //     output.schema : object 根、落在受支持子集内的原始 JSON Schema
  //   受支持子集：type / oneOf / properties / required / additionalProperties / items / enum / const
  //   + 注解（description 等）；properties/required/additionalProperties 只能挂 object 上，
  //   items 只能挂 array 上，enum/const 只能挂标量上，type 必须是单个字符串，additionalProperties 必须是 boolean。
  const registerTool = (definition) => {
    if (!runtime.capabilities.tools) {
      runtime.capabilities.report = 'tools-service-missing'
      ctx.logger?.warn?.('[dsh-gateway] ctx.tools.register 不可用，工具不会注册。')
      return
    }
    ctx.tools.register(definition)
  }

  registerTool({
    name: 'bridge_inbox',
    description:
      '查看闸门桥接队列里的指令（cache/inbox）。这些指令都由闸门筛选后转达（v2 起不直收用户原文），' +
      '默认只列未完结的（pending/running）。只读，不改变任何状态。',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: '按状态过滤，逗号分隔：pending,running,done,failed。留空=未完结。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: {
            type: 'object',
            additionalProperties: false,
            properties: {
              total: { type: 'number' },
              pending: { type: 'number' },
              running: { type: 'number' },
              done: { type: 'number' },
              failed: { type: 'number' },
            },
          },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                from: { type: 'string' },
                to: { type: 'string' },
                time: { type: 'string' },
                type: { type: 'string' },
                content: { type: 'string' },
                status: { type: 'string' },
                ref: { type: 'string' },
                file: { type: 'string' },
              },
            },
          },
          queue: {
            type: 'object',
            additionalProperties: false,
            properties: {
              total: { type: 'number' },
              pending: { type: 'number' },
              running: { type: 'number' },
              done: { type: 'number' },
              failed: { type: 'number' },
            },
          },
          note: { type: 'string' },
        },
      },
      render: textRender(renderInbox),
    },
    async execute(args) {
      try {
        const all = await listTasks(paths, null)
        const wanted = String(args?.status ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const filter = wanted.length ? wanted : ['pending', 'running']
        const tasks = all.filter((t) => filter.includes(t.status)).slice(0, inboxLimit)
        // jsonSafe：任务没有 ref 时 t.ref 是 undefined，直接返回会被 dsh-tools 判成
        // 「不是 lossless JSON」而整次调用失败。
        return jsonSafe({
          summary: snapshotOf(tasks),
          tasks: tasks.map((t) => ({
            id: t.id,
            from: t.from,
            to: t.to,
            time: t.time,
            type: t.type,
            content: t.content,
            status: t.status,
            ref: t.ref,
            file: t.file,
          })),
          queue: snapshotOf(all),
          note:
            '处理流程：bridge_claim 认领（改 running）→ 干活 → bridge_complete 写 outbox 交付闸门。' +
            '（v2：结果只落 outbox，不直发用户。）' +
            (runtime.uplinkOk === false
              ? `\n注意：上行自检未通过（${runtime.accessError ?? 'HTTP 失败'}）—— v2 下这不影响交付，交付走文件。`
              : '') +
            (peerHint(runtime) ? `\n提示：${peerHint(runtime)}` : '') +
            (tasks.length === 0 ? '\n（没有未完结的指令）' : ''),
        })
      } catch (error) {
        return jsonSafe({
          summary: { total: 0, pending: 0, running: 0, done: 0, failed: 0 },
          tasks: [],
          queue: { total: 0, pending: 0, running: 0, done: 0, failed: 0 },
          note: `读 inbox 失败: ${errText(error)}`,
        })
      }
    },
  })

  registerTool({
    name: 'bridge_claim',
    description:
      '认领一条桥接指令：把 cache/inbox/<id>.json 的 status 改成 running。' +
      '开始执行某条指令前先调用它，避免重复处理。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '指令 id（bridge_inbox 里的 id）' },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          id: { type: 'string' },
          status: { type: 'string' },
          content: { type: 'string' },
          path: { type: 'string' },
        },
      },
      render: textRender((v) => v.message),
    },
    async execute(args) {
      try {
        const res = await claimTask(runtime, args?.id)
        if (!res.ok) return jsonSafe({ ok: false, message: res.message })
        return jsonSafe({
          ok: true,
          message: `已认领 ${res.task.id}（running）。指令内容：\n${truncate(res.task.content, 2000)}`,
          id: res.task.id,
          status: 'running',
          content: res.task.content,
          path: res.path,
        })
      } catch (error) {
        return jsonSafe({ ok: false, message: `认领失败: ${errText(error)}` })
      }
    },
  })

  registerTool({
    name: 'bridge_complete',
    description:
      '完成一条桥接指令：把结果写进 cache/outbox/<id>.json（source/ref/status/summary/content 齐全），' +
      '并回写 inbox 状态。按中转规则 v2，结果只交付给闸门、由它转述，' +
      '**不直发用户**（uplinkMode=off）。执行完指令后必须调用它。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '指令 id' },
        result: { type: 'string', description: '给闸门的完整结果文本（写进 content）' },
        summary: { type: 'string', description: '一句话摘要（闸门转述时用，可省略）' },
        source: {
          type: 'string',
          description: '信息来源，默认 dsh（v2 规范要求带这个字段）',
        },
        status: {
          type: 'string',
          description: 'done（默认）或 failed',
          enum: ['done', 'failed'],
        },
      },
      required: ['id', 'result'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          status: { type: 'string' },
          outboxFile: { type: 'string' },
          inboxUpdated: { type: 'boolean' },
          delivery: {
            type: 'object',
            additionalProperties: false,
            properties: {
              channel: { type: 'string' },
              ok: { type: 'boolean' },
              file: { type: 'string' },
              message: { type: 'string' },
            },
          },
          uplink: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
            },
          },
        },
      },
      render: textRender(renderComplete),
    },
    async execute(args) {
      try {
        return jsonSafe(await completeTask(runtime, args ?? {}))
      } catch (error) {
        return jsonSafe({
          id: String(args?.id ?? ''),
          status: 'failed',
          outboxFile: '',
          inboxUpdated: false,
          delivery: { channel: DOWNLINK_MODE, ok: false, message: `完成流程出错: ${errText(error)}` },
          uplink: { ok: false, message: `完成流程出错: ${errText(error)}` },
        })
      }
    },
  })

  // 生命周期：读访问文件 → 上行自检 → 起轮询；返回的清理函数交给 Cordis 托管。
  // 注意：这里绝不能 return 清理函数以外的东西。
  // ctx.effect 本身也做存在性判断：宿主没提供它时，插件照样要激活并写出诊断。
  const lifecycle = () => {
    let stopped = false
    let disposeTimer = null

    const boot = async () => {
      try {
        await mkdir(paths.inbox, { recursive: true })
        await mkdir(paths.outbox, { recursive: true })

        const loaded = await loadAccess(paths)
        runtime.access = loaded.access
        runtime.accessError = loaded.error

        if (loaded.access) {
          const pong = await pingUplink(loaded.access)
          runtime.uplinkOk = pong.ok
          ctx.logger?.info?.(
            `[dsh-gateway] 上行自检: ${pong.ok ? 'OK' : 'FAILED'} ` +
              `${pong.ok ? `(HTTP ${pong.status})` : `— ${pong.body}`}`,
          )
          if (!pong.ok) runtime.accessError = pong.body
        } else {
          runtime.uplinkOk = false
          ctx.logger?.warn?.(`[dsh-gateway] ${loaded.error}`)
        }

        runtime.capabilities.report = 'ok'
        await writeStatus(paths, runtime)
      } catch (error) {
        runtime.uplinkOk = false
        runtime.accessError = errText(error)
        runtime.capabilities.report = 'boot-failed'
        ctx.logger?.warn?.(`[dsh-gateway] 初始化失败: ${errText(error)}`)
        // 启动失败也要留下痕迹，否则外面看到的又是「什么都没发生」。
        try {
          await writeStatus(paths, runtime)
        } catch {
          // 连状态都写不下去就只能靠日志了。
        }
      }

      if (stopped) return

      if (pollMs > 0) {
        const beat = () => {
          if (runtime.polling || stopped) return
          runtime.polling = true
          runPollCycle(runtime)
            .catch((error) => ctx.logger?.warn?.(`[dsh-gateway] 轮询出错: ${errText(error)}`))
            .finally(() => {
              runtime.polling = false
            })
        }

        // 起定时器本身也别让异常逃出去：boot 是 fire-and-forget 的，
        // 抛出去只会变成未处理拒绝，反而更难查。
        try {
          if (hostInterval) {
            disposeTimer = hostInterval(beat, pollMs)
            runtime.capabilities.poller = 'host-timer'
          } else {
            const handle = setInterval(beat, pollMs)
            disposeTimer = () => clearInterval(handle)
            runtime.capabilities.poller = 'node-timer'
          }
          ctx.logger?.info?.(
            `[dsh-gateway] 轮询已启动（${runtime.capabilities.poller}），间隔 ${pollMs}ms`,
          )
        } catch (error) {
          runtime.capabilities.poller = 'timer-failed'
          runtime.accessError = runtime.accessError ?? errText(error)
          ctx.logger?.warn?.(`[dsh-gateway] 轮询启动失败: ${errText(error)}`)
        }
      } else {
        runtime.capabilities.poller = 'disabled'
        ctx.logger?.info?.('[dsh-gateway] 轮询已关闭（pollMs=0）')
      }
    }

    // 让出当前 tick：apply/effect 期间不阻塞宿主启动。
    // boot 自己已经吞掉大部分异常，这里再兜一层，保证不会有未处理拒绝。
    void sleep(0)
      .then(boot)
      .catch((error) => ctx.logger?.warn?.(`[dsh-gateway] 启动流程异常: ${errText(error)}`))

    return () => {
      stopped = true
      try {
        disposeTimer?.()
      } catch {
        // 已经释放过就忽略。
      }
      ctx.logger?.info?.('[dsh-gateway] 插件已停用')
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(lifecycle)
  } else {
    lifecycle()
  }
}

// ─────────── 供离线自测使用的内部导出（宿主不消费） ───────────
export const __test = {
  pathsFor,
  loadAccess,
  pingUplink,
  sendUplink,
  deliver,
  writeResultJson,
  writeNoticeJson,
  listTasks,
  claimTask,
  completeTask,
  snapshotOf,
  writeStatus,
  peerHint,
  runPollCycle,
  pickDispatchPreset,
  taskPreset,
  withPrefix,
  truncate,
  DEFAULT_ROOT,
  DEFAULT_SOURCE,
  OUTBOX_SPEC_FIELDS,
  DOWNLINK_MODE,
  NOTICE_SUFFIX,
}
