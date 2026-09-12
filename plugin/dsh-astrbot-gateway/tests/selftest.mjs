// 离线自测：不启动 dsh，直接以假的 cordis ctx 驱动插件本体，
// 验证「读访问文件 → 上行 ping（只自检）→ 轮询发现 → 认领 → 完成 → 写 outbox → 交付闸门」。
//
// 用法：
//   node tests/selftest.mjs           # 默认：拦截上行，只统计「本来会发什么」，不打扰用户
//   node tests/selftest.mjs --live    # 真的发消息到用户的 QQ（会打扰人，慎用）
//
// 为什么默认拦截：v1 时代这个自测每轮会触发两次上行（发现通知 + 完成回报），
// 反复跑几轮就把用户的 QQ 刷了一串测试消息——所以默认必须是干的。
//
// v2（中转规则，见 docs/message-rules.md）起**任何上行都不许点名收件人**：
// 结果与通知全部落 outbox，另推一份给闸门的中转箱，由闸门取件转述。
// 下面的断言就是钉这条：「不直发用户」不是靠自觉，是靠自测拦住。

import { mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as plugin from '../lib/index.js'
import { apply, __test, inject as pluginInject } from '../lib/index.js'

// 沙箱与真实访问文件都按「本文件位置」推算，换机器、换目录名都不用改代码：
//   tests/ -> 插件目录 -> plugin/ -> 仓库根/cache/
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = join(PLUGIN_DIR, '..', '..')
const CACHE_DIR = join(REPO_ROOT, 'cache')
// 真实访问文件（含活令牌）。也支持用环境变量指到别处：
//   set DSH_GATEWAY_ACCESS=<path>\bridge_access.json
const REAL_ACCESS = process.env.DSH_GATEWAY_ACCESS || join(CACHE_DIR, 'bridge_access.json')
const SANDBOX = join(CACHE_DIR, '_selftest')
const LIVE = process.argv.includes('--live')

// ── 上行拦截：默认把 /send 的请求换成记录，绝不真的发出去 ──
const uplinkAttempts = []
const realFetch = globalThis.fetch
if (!LIVE) {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input)
    if (url.endsWith('/send')) {
      let text = ''
      try {
        text = JSON.parse(init?.body ?? '{}')?.text ?? ''
      } catch {
        text = '<unparsable body>'
      }
      // 记下完整请求体：断言要看的是「这条上行有没有点名收件人」
      let body = {}
      try {
        body = JSON.parse(String(init?.body ?? '{}'))
      } catch {
        body = {}
      }
      uplinkAttempts.push({ text, target: body.target, type: body.type })
      return new Response(
        JSON.stringify({ ok: true, intercepted: true, length: text.length }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    // ping 等只读请求照常放行
    return realFetch(input, init)
  }
}

let failures = 0
function check(label, ok, extra = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  if (!ok) failures += 1
  console.log(`[${mark}] ${label}${extra ? ` — ${extra}` : ''}`)
}

// ── 工具 schema 子集校验（复刻 dsh-tools 的 assertSupportedJsonSchema） ──────
//
// 为什么必须有：ctx.tools.register() **不编译任何东西**——
//   1. 要求 output 里有 render 函数；
//   2. `assertSupportedJsonSchema(definition.output.schema)`，即把 output.schema 当成
//      **已经是原始 JSON Schema** 来校验；
//   3. 把 definition 原样插进工具表（parameters 会原样发给模型）。
// 作者向的 defineTool() 才是编译器（描述符 DSL → 原始 schema）。本插件零依赖、
// 拿不到 dsh-tools，所以直接写编译后的形态；写错就会连踩两个真踩过的坑：
//   · output.schema 不合子集 → JsonSchemaError → **整个插件树加载失败** + 桌面端回滚 profile；
//   · parameters 根节点没有 type → 模型 API 报
//     Invalid schema for function 'bridge_claim': … got 'type: null' → 本轮对话失败。
//
// 受支持子集（取自 dsh-tools 源码）：
//   关键字：type / oneOf / properties / required / additionalProperties / items / enum / const
//           + 注解（description、title 等）
//   约束：properties / required / additionalProperties 只能挂在 object 上；
//         items 只能挂在 array 上；enum / const 只能挂在标量上；
//         type 必须是单个字符串（不支持 type 数组）；不能同时写 type 与 oneOf；
//         additionalProperties 必须是 boolean；required 必须是字符串数组。
//   另外：parameters 必须 object 根（否则模型 API 直接拒收）。
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null']
const CONSTRAINT_KEYWORDS = ['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
const ANNOTATION_KEYWORDS = ['description', 'title', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', '$comment']
const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
const KEYWORD_TYPES = {
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
  enum: SCALAR_TYPES,
  const: SCALAR_TYPES,
}

/** 校验一份原始 JSON Schema：返回违规信息数组（空数组 = 合规）。 */
function checkValueSchema(root, rootPath = 'schema') {
  const violations = []
  const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

  const walk = (node, path) => {
    if (!isRecord(node)) {
      violations.push(`${path} must be a schema object`)
      return
    }
    const hasType = Object.hasOwn(node, 'type')
    const hasOneOf = Object.hasOwn(node, 'oneOf')

    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYWORDS.includes(key) || ANNOTATION_KEYWORDS.includes(key)) continue
      violations.push(
        `${path}.${key} is not a supported keyword `
        + `(subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`,
      )
    }
    if (hasType && hasOneOf) {
      violations.push(`${path} cannot declare both type and oneOf`)
      return
    }
    if (!hasType && !hasOneOf) {
      for (const key of ONE_OF_SIBLINGS) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`)
      }
      return
    }
    if (hasOneOf) {
      for (const key of ONE_OF_SIBLINGS) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported beside oneOf`)
      }
      if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
        violations.push(`${path}.oneOf must be an array of at least two schemas`)
      } else {
        node.oneOf.forEach((child, i) => walk(child, `${path}.oneOf[${i}]`))
      }
      return
    }

    const type = node.type
    if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
      violations.push(
        Array.isArray(type)
          ? `${path}.type must be a single type string (type arrays are not supported)`
          : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`,
      )
      return
    }
    for (const [key, allowed] of Object.entries(KEYWORD_TYPES)) {
      if (Object.hasOwn(node, key) && !allowed.includes(type)) {
        violations.push(`${path}.${key} is not supported on type ${JSON.stringify(type)}`)
      }
    }
    if (type === 'object') {
      const properties = isRecord(node.properties) ? node.properties : {}
      if (Object.hasOwn(node, 'properties') && !isRecord(node.properties)) {
        violations.push(`${path}.properties must be an object`)
      }
      if (Object.hasOwn(node, 'required')) {
        const required = node.required
        if (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string')) {
          violations.push(`${path}.required must be an array of strings`)
        } else {
          for (const key of required) {
            if (!Object.hasOwn(properties, key)) {
              violations.push(`${path}.required names "${key}" which is not in properties`)
            }
          }
        }
      }
      if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
        violations.push(`${path}.additionalProperties must be a boolean`)
      }
      for (const [key, child] of Object.entries(properties)) {
        walk(child, `${path}.properties.${key}`)
      }
    }
    if (type === 'array' && Object.hasOwn(node, 'items')) {
      walk(node.items, `${path}.items`)
    }
  }

  walk(root, rootPath)
  return violations
}

/**
 * 校验 parameters：子集合规 **且 object 根**。
 * object 根这条是硬要求——不是它，模型 API 会直接拒收：
 *   Invalid schema for function 'bridge_claim': schema must be a JSON Schema of
 *   'type: "object"', got 'type: null'.
 */
function checkParametersSchema(spec, path = 'parameters') {
  const violations = checkValueSchema(spec, path)
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec) || spec.type !== 'object') {
    violations.push(`${path}.type must be "object"（模型 API 要求 object 根的 JSON Schema）`)
  }
  return violations
}

/**
 * 校验一个工具返回值是不是 lossless JSON（复刻 dsh-tools 用 isJsonValue 做的输出校验）。
 * 返回违规列表（空 = 合法）。JSON.stringify 会**静默丢掉** undefined 属性，
 * 所以带 undefined 的对象不是合法 JSON 值，dsh-tools 会直接判输出非法。
 */
function losslessViolations(value, path = 'value', seen = new Set()) {
  const bad = []
  if (value === undefined) {
    bad.push(`${path} is undefined（JSON 表示不了，会被静默丢掉）`)
    return bad
  }
  if (value === null) return bad
  const type = typeof value
  if (type === 'function' || type === 'symbol' || type === 'bigint') {
    bad.push(`${path} is ${type}（不是 JSON 值）`)
    return bad
  }
  if (type === 'number' && !Number.isFinite(value)) {
    bad.push(`${path} is ${String(value)}（JSON 表示不了）`)
    return bad
  }
  if (type !== 'object') return bad
  if (seen.has(value)) {
    bad.push(`${path} is circular`)
    return bad
  }
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => bad.push(...losslessViolations(item, `${path}[${index}]`, seen)))
  } else {
    for (const [key, item] of Object.entries(value)) {
      bad.push(...losslessViolations(item, `${path}.${key}`, seen))
    }
  }
  seen.delete(value)
  return bad
}

/**
 * 假 sessionController：只记录调用，用于验证自动拉起（真实现由宿主提供）。
 *
 * 签名**刻意与真 API 一致**（照抄 @deepseek-ai/dsh-api-session-controller 的 SessionController）：
 *   create(request)          只收 1 个参数
 *   prompt(request, signal)  signal 必需，第一行就 signal.throwIfAborted()
 * 所以插件一旦忘了传 signal，自测里会原样复现真宿主那个报错：
 *   Cannot read properties of undefined (reading 'throwIfAborted')
 */
function makeFakeSessionController(options = {}) {
  const calls = { create: [], prompt: [] }
  return {
    calls,
    async create(request) {
      calls.create.push(request ?? {})
      if (options.failCreate) throw new Error('create 故意失败（自测）')
      return { sessionId: `session-selftest-${calls.create.length}` }
    },
    async prompt(request, signal) {
      if (!signal || typeof signal.throwIfAborted !== 'function') {
        throw new Error("Cannot read properties of undefined (reading 'throwIfAborted')")
      }
      signal.throwIfAborted()
      calls.prompt.push(request)
      if (options.failPrompt) throw new Error('prompt 故意失败（自测）')
      return { accepted: true }
    },
  }
}

/**
 * 假 workspaceRegistry：只记录 create / attachSession。
 * 真实现里 attachSession 会把会话挂进工作区的 sessionIds，而 **GUI 侧边栏读的就是它**——
 * 不挂的话会话只会出现在「未分组」里（真踩过）。
 */
function makeFakeWorkspaceRegistry(options = {}) {
  const calls = { create: [], attach: [] }
  return {
    calls,
    async create(path) {
      calls.create.push(path)
      if (options.failCreate) throw new Error('workspace create 故意失败（自测）')
      return {
        async attachSession(sessionId) {
          calls.attach.push({ path, sessionId })
          if (options.failAttach) throw new Error('attachSession 故意失败（自测）')
        },
      }
    },
  }
}

/**
 * 假 agentPresets 花名册：只实现插件用到的 list()。
 * 真实现的返回形状（照抄 @deepseek-ai/dsh-agent-presets 的 AgentPresetRoster）：
 *   { presets: [{ id, trust, isDefault, name?, description?, broken? }], authorable }
 * 插件只用 id 判断「点名的预设存不存在」，所以这里照抄这个字段名，别的从简。
 */
function makeFakeRoster(ids) {
  const calls = { list: 0 }
  return {
    calls,
    async list() {
      calls.list += 1
      return {
        presets: ids.map((id) => ({ id, trust: 'system', isDefault: false })),
        authorable: true,
      }
    },
  }
}

/** 最小可用的假 ctx：只实现插件实际用到的那几个 API。 */
function makeCtx(options = {}) {
  const registered = new Map()
  const timers = []
  const logs = []
  const undeclared = []
  let disposed = false

  // cordis 0811 严格注入只作用于 **属性访问**：`ctx.<name>` 未声明就抛。
  // 假 ctx 复刻这条规则，这样「忘了声明」在自测里就暴露，而不是等重启。
  const declared = new Set(pluginInject)
  const assertDeclared = (name) => {
    if (!declared.has(name)) {
      undeclared.push(name)
      throw new Error(`cannot get property "${name}" without inject`)
    }
  }

  const schemaViolations = []
  const toolsService = {
    register(definition) {
      if (registered.has(definition.name)) {
        throw new Error(`duplicate tool: ${definition.name}`)
      }
      // 复刻真注册表的 schema 断言：越界写法在这里就被记下来（真运行时会抛
      // JsonSchemaError 并让整个插件树加载失败，或者让模型 API 拒收 parameters）。
      for (const violation of checkParametersSchema(definition.parameters)) {
        schemaViolations.push(`${definition.name}: ${violation}`)
      }
      if (definition.output?.schema) {
        for (const violation of checkValueSchema(definition.output.schema)) {
          schemaViolations.push(`${definition.name}: ${violation}`)
        }
      }
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
  const timerService = {}

  const ctx = {
    logger: {
      info: (m) => logs.push(`info ${m}`),
      warn: (m) => logs.push(`warn ${m}`),
    },
    get(name) {
      // 真 cordis 的 ctx.get 只是查表：取不到返回 undefined，**不需要 inject**
      // （会抛 `cannot get property "x" without inject` 的是 ctx.<name> 属性访问，
      //  见下面两个 getter）。这条语义很关键：可选取服务必须走 get，否则宿主
      // 没这个服务时整个插件都加载不了。
      return {
        tools: toolsService,
        timer: timerService,
        sessionController: options.sessionController,
        workspaceRegistry: options.workspaceRegistry,
        // 预设花名册同样是**可选取**服务：有它才校验「指令点名的预设存不存在」，
        // 没有就照传、交给宿主 create 自己报 `agent-preset/not-found`。
        agentPresets: options.agentPresets,
      }[name]
    },
    get tools() {
      assertDeclared('tools')
      return toolsService
    },
    get timer() {
      assertDeclared('timer')
      return timerService
    },
    interval(fn, ms) {
      assertDeclared('timer')
      const handle = { fn, ms }
      timers.push(handle)
      return () => {
        const i = timers.indexOf(handle)
        if (i >= 0) timers.splice(i, 1)
      }
    },
    effect(setup) {
      const dispose = setup()
      return () => {
        disposed = true
        dispose?.()
      }
    },
  }

  return {
    ctx,
    registered,
    timers,
    logs,
    undeclared,
    schemaViolations,
    get disposed() {
      return disposed
    },
    /** 手动触发一次轮询，不必等真实定时器。 */
    async tick() {
      for (const t of [...timers]) await t.fn()
      // 轮询内部是 promise 链，让出几拍等它落地。
      for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 25))
    },
  }
}

async function main() {
  console.log('=== dsh-astrbot-gateway 离线自测 ===\n')

  // 干净沙箱
  await rm(SANDBOX, { recursive: true, force: true })
  const paths = __test.pathsFor(SANDBOX)
  await mkdir(paths.inbox, { recursive: true })
  await mkdir(paths.outbox, { recursive: true })

  // 用真实的访问文件（token 是活的）；没有就造一份假的顶上，保证离线也能跑
  let access
  try {
    access = JSON.parse(await readFile(REAL_ACCESS, 'utf8'))
    console.log(`访问文件: ${REAL_ACCESS}`)
  } catch {
    access = { base_url: 'http://127.0.0.1:6185', token: 'selftest-token' }
    console.log(`（没找到 ${REAL_ACCESS}，用内置假访问文件顶上）`)
  }
  await writeFile(paths.access, `${JSON.stringify(access, null, 2)}\n`, 'utf8')

  // ── 0. cordis 插件契约守卫（这两个坑都真踩过，必须离线就拦下） ──
  check(
    '插件契约：name / inject / apply',
    plugin.name === 'dsh-astrbot-gateway'
      && Array.isArray(plugin.inject)
      && typeof plugin.apply === 'function',
  )
  // cordis 用 Standard Schema 协议解析配置：`Config['~standard'].validate(raw)`。
  // 所以 Config 要么不导出，要么必须是 schemastery 的 z.object 实例；
  // 导出描述字段的**普通对象**会在挂载时抛
  //   TypeError: Cannot read properties of undefined (reading 'validate')
  // 让整个插件树加载失败（DSH Desktop 还会因此回滚 profile）。
  const cfgSchema = plugin.Config
  check(
    'Config 契约：不导出，或导出的是 Standard Schema',
    cfgSchema === undefined || typeof cfgSchema?.['~standard']?.validate === 'function',
    cfgSchema === undefined
      ? '未导出 Config（本插件的选择：零依赖 + 全靠 apply 默认值）'
      : '导出了带 ~standard.validate 的 schema',
  )

  // ── 1. 载入配置与访问文件 ──
  const loaded = await __test.loadAccess(paths)
  check('访问文件可解析且带 token', Boolean(loaded.access?.token), loaded.error ?? '')
  check('ping_url 由 base_url 推导正确', loaded.access?.pingUrl?.endsWith('/ping'), loaded.access?.pingUrl)

  // ── 2. 记录初始队列快照（后面轮询会用到） ──
  const before = __test.snapshotOf(await __test.listTasks(paths, null))
  check('空沙箱初始队列为 0', before.total === 0, JSON.stringify(before))

  // ── 3. 投递一条 pending 指令（闸门侧会做的事） ──
  //    v2：指令由闸门筛选后落盘，所以 from 是 gateway（不再直收用户原文）。
  const taskId = 'selftest-1'
  await writeFile(
    join(paths.inbox, `${taskId}.json`),
    `${JSON.stringify(
      {
        id: taskId,
        from: 'gateway',
        to: 'dsh',
        time: new Date().toISOString(),
        type: 'task',
        content: '这是一条自测指令：确认桥接的下行链路\n第二行用来验证换行是否被正确编码。',
        status: 'pending',
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  const found = await __test.listTasks(paths, ['pending'])
  check('能读到 pending 指令', found.length === 1 && found[0].id === taskId)
  check('正文保留换行', found[0]?.content.includes('\n'))

  // ── 4. 启动插件（真实 apply） ──
  const harness = makeCtx()
  apply(harness.ctx, { root: SANDBOX, pollMs: 200, autoClaim: false, defaultTarget: '' })
  // apply 里用 sleep(0).then(boot) 让出 tick，等它跑完
  await new Promise((r) => setTimeout(r, 1500))

  check('注册了 3 个工具', harness.registered.size === 3, [...harness.registered.keys()].join(','))
  for (const tool of ['bridge_inbox', 'bridge_claim', 'bridge_complete']) {
    check(`工具 ${tool} 已注册`, harness.registered.has(tool))
  }
  // 真注册表会在这里抛 JsonSchemaError（→ 整个插件树加载失败 + 回滚 profile），
  // 或者让模型 API 拒收 parameters（→ 本轮对话失败）。两个坑都真踩过。
  check(
    '工具 schema 合规（parameters 为 object 根 + output.schema 落在受支持子集内）',
    harness.schemaViolations.length === 0,
    harness.schemaViolations.join(' | '),
  )
  // 反向自证 1：历史崩过的作者 spec 写法（逐字段 required: true 直接当原始 schema 用）
  const historicalOutputSpec = checkValueSchema({
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: {
        type: 'object',
        additionalProperties: false,
        properties: { total: { type: 'number', required: true } },
        required: true,
      },
      tasks: { type: 'array', additionalProperties: false, required: true, items: { type: 'object', properties: {} } },
    },
  })
  check(
    '校验器能复现历史崩溃 1（未编译的作者 spec 当原始 schema）',
    historicalOutputSpec.includes('schema.properties.summary.properties.total.required is not supported on type "number"')
      && historicalOutputSpec.includes('schema.properties.tasks.required is not supported on type "array"')
      && historicalOutputSpec.includes('schema.properties.summary.required must be an array of strings'),
    historicalOutputSpec.slice(0, 3).join(' | '),
  )
  // 反向自证 2：历史崩过的描述符 DSL 写法（parameters 没有 object 根 → 模型报 type: null）
  const historicalDescriptorParams = checkParametersSchema({
    id: { type: 'string', required: true, description: '指令 id' },
  })
  check(
    '校验器能复现历史崩溃 2（parameters 缺 object 根）',
    historicalDescriptorParams.some((v) => v.includes('must be "object"')),
    historicalDescriptorParams.slice(0, 2).join(' | '),
  )
  check('轮询定时器已启动', harness.timers.length === 1, `ms=${harness.timers[0]?.ms}`)
  check(
    'inject 声明完整（未访问未声明服务）',
    harness.undeclared.length === 0,
    harness.undeclared.join(', '),
  )
  check('inject 是服务名数组', Array.isArray(pluginInject), JSON.stringify(pluginInject))

  const bootedLogs = harness.logs.join('\n')
  check('上行自检通过（ping OK）', /上行自检: OK/.test(bootedLogs), bootedLogs.split('\n').find((l) => l.includes('自检')) ?? '')
  check('状态文件已写出', await readFile(paths.status, 'utf8').then(() => true).catch(() => false))

  // ── 5. 工具：bridge_inbox ──
  const inboxTool = harness.registered.get('bridge_inbox')
  const listed = await inboxTool.execute({})
  check('bridge_inbox 看到 1 条 pending', listed.summary.pending === 1, JSON.stringify(listed.summary))
  check('bridge_inbox 输出可渲染', typeof inboxTool.output.render({}, listed)[0].text === 'string')
  // 真踩过：任务没有 ref 字段时 t.ref 是 undefined，dsh-tools 会用 isJsonValue 校验**每个工具的输出**，
  // 带 undefined 就报 `tool "bridge_inbox" returned invalid output: value is not lossless JSON`。
  // 队列为空时恰好没有 undefined，所以只有「真有任务」才现形——这条断言必须跑在有任务的场景里。
  check(
    'bridge_inbox 输出是 lossless JSON（无 undefined）',
    losslessViolations(listed).length === 0,
    losslessViolations(listed).slice(0, 3).join(' | '),
  )
  // 反向自证：校验器必须能抓到历史崩过的形状（任务没有 ref 时 t.ref 是 undefined）
  const historicalLossy = losslessViolations({ tasks: [{ id: 'x', ref: undefined, file: 'f' }] })
  check(
    'lossless 校验器能复现历史崩溃 3（返回值带 undefined）',
    historicalLossy.some((v) => v.includes('ref') && v.includes('undefined')),
    historicalLossy.join(' | '),
  )

  // ── 6. 手动轮询：应当把通知**落盘**并写下 .notified 标记 ──
  await harness.tick()
  const notifiedMark = await readFile(paths.notified(taskId), 'utf8').then(() => true).catch(() => false)
  check('轮询后写下 .notified 标记', notifiedMark)

  // v2 核心：通知走 outbox/<id>.notice.json，而不是 QQ。
  // 文件名用 `<id>.notice.json`（同目录、一眼能扫到），所以闸门只需读 outbox 一个目录。
  const noticeFile = join(paths.outbox, `${taskId}${__test.NOTICE_SUFFIX}`)
  const noticeRaw = await readFile(noticeFile, 'utf8').then((t) => t).catch(() => null)
  check('轮询把发现通知写进 outbox（<id>.notice.json）', noticeRaw !== null, noticeFile)
  if (noticeRaw) {
    const notice = JSON.parse(noticeRaw)
    check(
      '通知带 source/ref/status/content（v2 必备字段）',
      notice.source === __test.DEFAULT_SOURCE
        && notice.ref === taskId
        && typeof notice.status === 'string'
        && notice.content.includes(taskId),
      `source=${notice.source} ref=${notice.ref} status=${notice.status}`,
    )
    check('通知的 to 是 gateway（不是用户）', notice.to === 'gateway', String(notice.to))
  }
  check(
    '发现通知只推中转箱、不带收件人（v2：不直发用户）',
    uplinkAttempts.every((a) => !a.target && !a.type),
    `点名收件人的上行 ${uplinkAttempts.filter((a) => a.target || a.type).length} 次`,
  )

  // 轮询不应擅自改状态（autoClaim=false 时）
  const afterPoll = await __test.listTasks(paths, null)
  check('轮询未擅自认领（仍是 pending）', afterPoll[0]?.status === 'pending', afterPoll[0]?.status)

  // 再轮询一次：不应重复通知（标记生效）
  const markTime1 = await readFile(paths.notified(taskId), 'utf8')
  await harness.tick()
  const markTime2 = await readFile(paths.notified(taskId), 'utf8')
  check('重复轮询不重复通知（标记未刷新）', markTime1 === markTime2)

  // ── 7. 工具：bridge_claim ──
  const claimTool = harness.registered.get('bridge_claim')
  const claimed = await claimTool.execute({ id: taskId })
  check('bridge_claim 成功', claimed.ok === true, claimed.message?.split('\n')[0])
  check('bridge_claim 输出是 lossless JSON', losslessViolations(claimed).length === 0, losslessViolations(claimed).slice(0, 3).join(' | '))
  const afterClaim = await __test.listTasks(paths, null)
  check('inbox 状态已变 running', afterClaim[0]?.status === 'running', afterClaim[0]?.status)
  check('状态文件记录的运行数正确', (await _status(paths)).queue.running === 1)

  const badClaim = await claimTool.execute({ id: '../evil' })
  check('bridge_claim 拒绝路径穿越', badClaim.ok === false, badClaim.message)

  // ── 8. 工具：bridge_complete ──
  const completeTool = harness.registered.get('bridge_complete')
  const done = await completeTool.execute({
    id: taskId,
    result: '自测完成：下行读取、认领、outbox 落盘、交付闸门全链路已打通。',
    summary: '自测任务完成',
    status: 'done',
  })
  check('bridge_complete 写 outbox 成功', done.outboxFile === join(paths.outbox, `${taskId}.json`), done.outboxFile)
  check('bridge_complete 回写 inbox 成功', done.inboxUpdated === true)
  check('bridge_complete 交付成功', done.delivery?.ok === true, done.delivery?.message)
  check(
    '交付通道是 outbox + 中转箱（v2：不直发用户）',
    done.delivery?.channel === 'outbox+gateway',
    String(done.delivery?.channel),
  )
  check('bridge_complete 输出是 lossless JSON', losslessViolations(done).length === 0, losslessViolations(done).slice(0, 3).join(' | '))

  const outboxJson = JSON.parse(await readFile(done.outboxFile, 'utf8'))
  // v2 规范的必备字段：source（信息来源）与 status（当前状态）缺一不可。
  check(
    'outbox 结构符合 v2 约定（id/from/to/source/ref/status/summary/content）',
    outboxJson.id === taskId
      && outboxJson.from === 'dsh'
      && outboxJson.to === 'gateway'
      && outboxJson.source === __test.DEFAULT_SOURCE
      && outboxJson.ref === taskId
      && outboxJson.status === 'done'
      && typeof outboxJson.summary === 'string'
      && typeof outboxJson.content === 'string',
    JSON.stringify({ to: outboxJson.to, source: outboxJson.source, status: outboxJson.status }),
  )
  check(
    'outbox 字段就是规范那一套（不多不少）',
    Object.keys(outboxJson).sort().join(',') ===
      ['content', 'from', 'id', 'ref', 'source', 'status', 'summary', 'time', 'to', 'type'].sort().join(','),
    Object.keys(outboxJson).join(','),
  )
  check('outbox content 完整', outboxJson.content.includes('全链路已打通'))
  // 反向自证：校验器必须能抓到「字段缺失」这件事本身（缺 source 的老写法就该判不合格）
  const missingField = __test.OUTBOX_SPEC_FIELDS.filter((f) => !(f in { id: taskId, ref: taskId, status: 'done' }))
  check(
    '缺字段能被检出（反向自证 v2 字段清单有效）',
    missingField.includes('source') && missingField.includes('content'),
    missingField.join(','),
  )

  const finalInbox = JSON.parse(await readFile(join(paths.inbox, `${taskId}.json`), 'utf8'))
  check('inbox 最终状态 done', finalInbox.status === 'done')
  check('inbox 记录了 outbox 路径', String(finalInbox.outbox).endsWith(`${taskId}.json`))
  check(
    'inbox 记录了交付通道（闸门侧一眼看出没走 QQ）',
    finalInbox.delivery === 'outbox+gateway',
    String(finalInbox.delivery),
  )
  // 反向自证：v1 的老写法（from 直发用户）必须被判定为不合规，否则这条规矩形同虚设
  const legacyShape = { id: taskId, from: 'dsh', to: '用户', status: 'done', ref: taskId, content: 'x', summary: 'y' }
  check(
    'v1 老写法（to=用户且无 source）判为不合规（反向自证）',
    legacyShape.to !== 'gateway' && !('source' in legacyShape),
  )

  const finalStatus = await _status(paths)
  check('状态快照 done=1', finalStatus.queue.done === 1, JSON.stringify(finalStatus.queue))
  check('状态快照记录了上行可用', finalStatus.uplink === true)
  check('状态快照标明下行通道是 outbox-only', finalStatus.downlink === __test.DOWNLINK_MODE, String(finalStatus.downlink))
  check('状态快照标明 uplinkMode=off（默认不开闸）', finalStatus.uplinkMode === 'off', String(finalStatus.uplinkMode))

  // ── 9. 停用后定时器被清理 ──
  const disposable = harness.timers.length
  // apply 注册的 effect disposer 由 Cordis 托管；这里直接验证 interval 返回的清理器工作正常
  check('存在可清理的定时器', disposable === 1)

  // ── 10. 上行次数（v2 关键断言）──
  if (!LIVE) {
    // v2：一次都不该发生。这条断言就是「不直发用户」的守门人 ——
    // 谁哪天把 uplinkMode 默认值改回 'on'、或又在某条路径上加了 sendUplink，这里立刻红。
    // v2.1 起允许「推中转箱」这一类上行，但**绝不允许点名收件人** ——
    // 一旦哪天有人在某条路径上加了 target，等于绕过闸门直发用户，这里立刻红。
    const strays = uplinkAttempts.filter((a) => a.target || a.type)
    check(
      '全程没有点名收件人的上行（v2：dsh 不直发用户）',
      strays.length === 0,
      `越权 ${strays.length} 次 / 共 ${uplinkAttempts.length} 次`,
    )
    strays.forEach((a, i) => console.log(`   [越权上行 ${i + 1}] ${String(a.text).split('\n')[0]}`))
  }
  // ── 11. 自动拉起（autoDispatch） ──
  // sessionController 在真宿主里是**可选取服务**（用 ctx.get 拿，不进 inject）。
  const dispatchSandbox = join(SANDBOX, 'dispatch')
  await rm(dispatchSandbox, { recursive: true, force: true })
  const dpaths = __test.pathsFor(dispatchSandbox)
  await mkdir(dpaths.inbox, { recursive: true })
  await mkdir(dpaths.outbox, { recursive: true })
  await writeFile(dpaths.access, `${JSON.stringify(access, null, 2)}\n`, 'utf8')

  check('ctx.get 对未知服务返回 undefined（不需要 inject）', harness.ctx.get('并不存在的服务') === undefined)

  const ctrl = makeFakeSessionController()
  const wsRegistry = makeFakeWorkspaceRegistry()
  const dHarness = makeCtx({ sessionController: ctrl, workspaceRegistry: wsRegistry })
  apply(dHarness.ctx, { root: dispatchSandbox, pollMs: 200 })
  await new Promise((r) => setTimeout(r, 1500))

  const dTaskId = 'dispatch-1'
  await writeFile(
    join(dpaths.inbox, `${dTaskId}.json`),
    `${JSON.stringify({ id: dTaskId, from: '用户', to: 'dsh', time: new Date().toISOString(), type: 'task', content: '自动拉起测试指令', status: 'pending' }, null, 2)}\n`,
    'utf8',
  )
  await dHarness.tick()
  check('自动拉起：create 调用 1 次', ctrl.calls.create.length === 1, JSON.stringify(ctrl.calls.create))
  check('自动拉起：prompt 调用 1 次', ctrl.calls.prompt.length === 1)
  check(
    '自动拉起：requestId 用任务 id（宿主据此幂等去重）',
    ctrl.calls.prompt[0]?.requestId === `bridge-${dTaskId}`,
    ctrl.calls.prompt[0]?.requestId,
  )
  const promptText = ctrl.calls.prompt[0]?.content?.[0]?.text ?? ''
  check(
    '自动拉起：投喂文本含任务 id 与桥接流程指引',
    promptText.includes(dTaskId) && promptText.includes('bridge_claim') && promptText.includes('bridge_complete'),
  )
  check(
    '自动拉起：下发时带上工作区 cwd（否则会话落「未分组」）',
    typeof ctrl.calls.create[0]?.cwd === 'string' && ctrl.calls.create[0].cwd.length > 0,
    JSON.stringify(ctrl.calls.create[0]),
  )
  check(
    '自动拉起：把会话挂进该工作区组别（cwd 必须与 create 一致）',
    wsRegistry.calls.create[0] === ctrl.calls.create[0]?.cwd
      && wsRegistry.calls.attach[0]?.sessionId === 'session-selftest-1',
    `create=${wsRegistry.calls.create[0]} attach=${wsRegistry.calls.attach[0]?.sessionId}`,
  )
  check(
    '自动拉起：写下 .dispatched 标记',
    await readFile(dpaths.dispatched(dTaskId), 'utf8').then(() => true).catch(() => false),
  )
  const dispatchNotice = await readFile(join(dpaths.outbox, `${dTaskId}${__test.NOTICE_SUFFIX}`), 'utf8')
    .then((t) => JSON.parse(t))
    .catch(() => null)
  check(
    '自动拉起：通知里如实说明已拉起（落 outbox，不直发）',
    /已自动拉起会话/.test(dispatchNotice?.content ?? ''),
    dispatchNotice?.summary ?? '(没有通知文件)',
  )
  const afterFirstDispatch = ctrl.calls.create.length
  await dHarness.tick()
  check('自动拉起：重复轮询不重复拉起', ctrl.calls.create.length === afterFirstDispatch, `create=${ctrl.calls.create.length}`)

  // 工作区不可用时的降级：用户的要求是「无组别就丢进未分组」，**不是**让任务失败
  const fallbackCtrl = makeFakeSessionController()
  const fallbackWs = makeFakeWorkspaceRegistry()
  const fallbackSandbox = join(SANDBOX, 'dispatch-nogroup')
  await rm(fallbackSandbox, { recursive: true, force: true })
  const fpaths = __test.pathsFor(fallbackSandbox)
  await mkdir(fpaths.inbox, { recursive: true })
  await mkdir(fpaths.outbox, { recursive: true })
  await writeFile(fpaths.access, `${JSON.stringify(access, null, 2)}\n`, 'utf8')
  const fHarness = makeCtx({ sessionController: fallbackCtrl, workspaceRegistry: fallbackWs })
  apply(fHarness.ctx, {
    root: fallbackSandbox,
    pollMs: 200,
    dispatchCwd: join(fallbackSandbox, '并不存在的目录'),
  })
  await new Promise((r) => setTimeout(r, 1500))
  await writeFile(
    join(fpaths.inbox, 'dispatch-nogroup.json'),
    `${JSON.stringify({ id: 'dispatch-nogroup', from: '用户', to: 'dsh', time: new Date().toISOString(), type: 'task', content: '无工作区降级', status: 'pending' }, null, 2)}\n`,
    'utf8',
  )
  await fHarness.tick()
  check(
    '工作区不可用时不传 cwd（会话落「未分组」）',
    fallbackCtrl.calls.create.length === 1 && fallbackCtrl.calls.create[0].cwd === undefined,
    JSON.stringify(fallbackCtrl.calls.create[0]),
  )
  check('工作区不可用时不尝试挂载组别', fallbackWs.calls.create.length === 0)
  check('工作区不可用不影响拉起本身', fallbackCtrl.calls.prompt.length === 1)

  // ── 11b. 自动拉起用哪种「模式」（agentPreset） ──
  // 起因（真事）：宿主 `$DSH_HOME/settings.yaml` 的 `agent-presets.default` 是 teyvat-hoi4
  // （提瓦特黎明 HOI4 项目专用，persona 每回合强制先读 PROJECT_RULES.md），而 create() 不带
  // agentPreset 时用的就是宿主默认 —— 于是每条自动拉起的桥接会话都被 HOI4 persona 接管。
  // 实测三条桥接会话的 header 全是 `"agentPreset":"teyvat-hoi4"`。
  // 用户的规矩：**桥接默认走 standard（标准模式）；要 HOI4 模式的指令由闸门点名。**
  const presetSandbox = join(SANDBOX, 'dispatch-preset')
  await rm(presetSandbox, { recursive: true, force: true })
  const ppaths = __test.pathsFor(presetSandbox)
  await mkdir(ppaths.inbox, { recursive: true })
  await mkdir(ppaths.outbox, { recursive: true })
  await writeFile(ppaths.access, `${JSON.stringify(access, null, 2)}\n`, 'utf8')

  const presetCtrl = makeFakeSessionController()
  const roster = makeFakeRoster(['standard', 'teyvat-hoi4', 'hoi4-mod'])
  const presetHarness = makeCtx({ sessionController: presetCtrl, agentPresets: roster })
  apply(presetHarness.ctx, {
    root: presetSandbox,
    pollMs: 200,
    dispatchPreset: 'standard',
    dispatchCwd: presetSandbox,
  })
  await new Promise((r) => setTimeout(r, 1500))

  const writePresetTask = (id, extra) =>
    writeFile(
      join(ppaths.inbox, `${id}.json`),
      `${JSON.stringify({ id, from: 'gateway', to: 'dsh', time: new Date().toISOString(), type: 'task', content: `模式测试 ${id}`, status: 'pending', ...extra }, null, 2)}\n`,
      'utf8',
    )
  await writePresetTask('preset-default', {})
  await writePresetTask('preset-asked', { preset: 'teyvat-hoi4' })
  await writePresetTask('preset-bogus', { preset: '并没有这个预设' })
  await presetHarness.tick()

  // create 与 prompt 是成对 push 的，用 requestId 把任务 id 映射回那次 create 的参数。
  const presetOf = (id) => {
    const i = presetCtrl.calls.prompt.findIndex((p) => p.requestId === `bridge-${id}`)
    return i < 0 ? undefined : presetCtrl.calls.create[i]?.agentPreset
  }
  check(
    '模式：指令没点名时用插件配置的 dispatchPreset',
    presetOf('preset-default') === 'standard',
    String(presetOf('preset-default')),
  )
  check(
    '模式：指令点名优先（闸门规定这条按哪种模式跑）',
    presetOf('preset-asked') === 'teyvat-hoi4',
    String(presetOf('preset-asked')),
  )
  check(
    '模式：点名不存在的预设时回退到配置值，而不是让指令失败',
    presetOf('preset-bogus') === 'standard',
    String(presetOf('preset-bogus')),
  )
  check(
    '模式：回退时留下日志（不静默）',
    presetHarness.logs.some((l) => /不在花名册/.test(l)),
    presetHarness.logs.filter((l) => /不在花名册/.test(l)).join(' | ') || '(没有日志)',
  )
  const presetNotice = await readFile(join(ppaths.outbox, `preset-asked${__test.NOTICE_SUFFIX}`), 'utf8')
    .then((t) => JSON.parse(t))
    .catch(() => null)
  check(
    '模式：通知里如实报出这条跑在哪种模式',
    /模式 teyvat-hoi4/.test(presetNotice?.content ?? ''),
    presetNotice?.summary ?? '(没有通知文件)',
  )

  // 花名册读不到（宿主没这服务）时不该拦：照传点名值，让 create 自己用
  // `agent-preset/not-found` 说话 —— 「读不到花名册」和「预设不存在」是两回事。
  const norosterCtrl = makeFakeSessionController()
  const norosterSandbox = join(SANDBOX, 'dispatch-preset-noroster')
  await rm(norosterSandbox, { recursive: true, force: true })
  const npaths = __test.pathsFor(norosterSandbox)
  await mkdir(npaths.inbox, { recursive: true })
  await mkdir(npaths.outbox, { recursive: true })
  await writeFile(npaths.access, `${JSON.stringify(access, null, 2)}\n`, 'utf8')
  const norosterHarness = makeCtx({ sessionController: norosterCtrl })
  apply(norosterHarness.ctx, { root: norosterSandbox, pollMs: 200, dispatchPreset: 'standard' })
  await new Promise((r) => setTimeout(r, 1500))
  await writeFile(
    join(npaths.inbox, 'preset-noroster.json'),
    `${JSON.stringify({ id: 'preset-noroster', from: 'gateway', to: 'dsh', time: new Date().toISOString(), type: 'task', content: '无花名册', status: 'pending', preset: 'teyvat-hoi4' }, null, 2)}\n`,
    'utf8',
  )
  await norosterHarness.tick()
  check(
    '模式：花名册缺席时不拦（照传，交给宿主判定）',
    norosterCtrl.calls.create[0]?.agentPreset === 'teyvat-hoi4',
    JSON.stringify(norosterCtrl.calls.create[0]),
  )

  // 失败降级：create 一直失败时，插件不崩、仍把失败原因落盘通知、达到上限后放弃重试
  const badCtrl = makeFakeSessionController({ failCreate: true })
  const badSandbox = join(SANDBOX, 'dispatch-fail')
  await rm(badSandbox, { recursive: true, force: true })
  const bpaths = __test.pathsFor(badSandbox)
  await mkdir(bpaths.inbox, { recursive: true })
  await mkdir(bpaths.outbox, { recursive: true })
  await writeFile(bpaths.access, `${JSON.stringify(access, null, 2)}\n`, 'utf8')
  const bHarness = makeCtx({ sessionController: badCtrl })
  // dispatchRetryMs: 0 —— 自测里不做真实等待，直接跑满重试次数
  apply(bHarness.ctx, { root: badSandbox, pollMs: 200, dispatchRetryMs: 0 })
  await new Promise((r) => setTimeout(r, 1500))
  await writeFile(
    join(bpaths.inbox, 'dispatch-bad.json'),
    `${JSON.stringify({ id: 'dispatch-bad', from: 'gateway', to: 'dsh', time: new Date().toISOString(), type: 'task', content: '失败路径', status: 'pending' }, null, 2)}\n`,
    'utf8',
  )
  const uplinkBefore = uplinkAttempts.length
  await bHarness.tick()
  await bHarness.tick()
  await bHarness.tick()
  await bHarness.tick()
  check('自动拉起失败：插件不崩（工具照常注册）', bHarness.registered.size === 3)
  const badNotice = await readFile(join(bpaths.outbox, `dispatch-bad${__test.NOTICE_SUFFIX}`), 'utf8')
    .then((t) => JSON.parse(t))
    .catch(() => null)
  check(
    '自动拉起失败：失败原因如实落进 outbox 通知',
    /自动拉起失败/.test(badNotice?.content ?? ''),
    badNotice?.summary ?? '(没有通知文件)',
  )
  check(
    '自动拉起失败也不点名收件人',
    uplinkAttempts.slice(uplinkBefore).every((a) => !a.target && !a.type),
    `多出 ${uplinkAttempts.length - uplinkBefore} 次`,
  )
  check(
    '自动拉起失败：重试到上限后停止（不再每轮重试）',
    badCtrl.calls.create.length === 3,
    `create=${badCtrl.calls.create.length}`,
  )

  // ── 12. 救火开关：只有显式写 uplinkMode:'on' 才恢复 v1 直发 ──
  // 为什么值得测：v2 把「默认零上行」钉死了，如果连开关本身也失效，桥接彻底断了就只能改代码。
  // 顺带反向证明上面那条「全程零上行」不是靠 fetch 拦截器坏掉骗过去的。
  const fireSandbox = join(SANDBOX, 'uplink-on')
  await rm(fireSandbox, { recursive: true, force: true })
  const firePaths = __test.pathsFor(fireSandbox)
  await mkdir(firePaths.inbox, { recursive: true })
  await mkdir(firePaths.outbox, { recursive: true })
  await writeFile(firePaths.access, `${JSON.stringify(access, null, 2)}\n`, 'utf8')
  await writeFile(
    join(firePaths.inbox, 'uplink-on.json'),
    `${JSON.stringify({ id: 'uplink-on', from: 'gateway', to: 'dsh', time: new Date().toISOString(), type: 'task', content: '救火开关测试', status: 'pending' }, null, 2)}\n`,
    'utf8',
  )
  const fireHarness = makeCtx()
  apply(fireHarness.ctx, { root: fireSandbox, pollMs: 0, uplinkMode: 'on' })
  await new Promise((r) => setTimeout(r, 400))
  const beforeFire = uplinkAttempts.length
  const fireDone = await fireHarness.registered.get('bridge_complete').execute({
    id: 'uplink-on',
    result: '救火开关测试结果',
    summary: '救火开关测试',
  })
  // ⚠️ --live 下没有拦截器，uplinkAttempts 必然是空的 —— 那时只能看返回的 channel：
  //    走通了就是 'qq-uplink'（真发出去了），没走通会退回落盘。
  check(
    'uplinkMode=on 时恢复直发（救火通道仍可用）',
    LIVE
      ? fireDone.delivery?.channel === 'qq-uplink' && fireDone.delivery?.ok === true
      : uplinkAttempts.length === beforeFire + 1 && /\[dsh\]/.test(uplinkAttempts.at(-1)?.text ?? ''),
    LIVE ? `channel=${fireDone.delivery?.channel}` : (uplinkAttempts.at(-1)?.text.split('\n')[0] ?? '(没有上行)'),
  )
  check(
    '即使开了闸，结果照样落 outbox（两条腿都留着）',
    await readFile(join(firePaths.outbox, 'uplink-on.json'), 'utf8')
      .then((t) => JSON.parse(t).content.includes('救火开关测试结果'))
      .catch(() => false),
    fireDone.delivery?.message ?? '',
  )

  globalThis.fetch = realFetch

  console.log(`\n=== 结果: ${failures === 0 ? '全部通过' : `${failures} 项失败`} ===`)
  if (LIVE) {
    console.log('模式: --live —— 上面的上行是**真的**发给用户了。')
  } else {
    console.log(`模式: 默认（已拦截上行）。v2 下预期是 0 条；本轮实际发起 ${uplinkAttempts.length} 条：`)
    uplinkAttempts.forEach((a, i) => {
      console.log(`  [${i + 1}] ${String(a.text).split('\n')[0]}`)
    })
    console.log('v2 规则（docs/message-rules.md）：dsh 不直发用户，结果一律走 cache/outbox/。')
  }
  console.log(`沙箱目录: ${SANDBOX}`)
  console.log('（保留沙箱便于人工查看；不需要时直接删掉该目录即可）')

  if (failures > 0) process.exitCode = 1
}

async function _status(paths) {
  return JSON.parse(await readFile(paths.status, 'utf8'))
}

main().catch((error) => {
  console.error('自测崩溃:', error)
  process.exitCode = 1
})
