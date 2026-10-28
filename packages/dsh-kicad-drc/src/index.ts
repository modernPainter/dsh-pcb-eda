/**
 * DSH 插件入口：KiCad DRC 工具。
 *
 * 在 Host 端注册 kicad_drc_run 工具，AI agent 可调用它对 .kicad_pcb 文件
 * 执行 DRC 检查并获取结构化结果。
 *
 * 两个后端，由 AdaptiveExecutor 在运行时选择（mode=auto 时的默认行为）：
 *   - local:  当前机器 subprocess 调 kicad-cli（需本地安装 KiCad），
 *             默认用隔离的 KICAD_CONFIG_HOME 规避 ~5s 的默认配置发现开销
 *   - remote: HTTP 上传到 pcblint-java 服务（由其转发到 cli-runner 执行 kicad-cli），
 *             本机无需 KiCad，但只上传单个 .kicad_pcb，工程级规则可能丢失
 *
 * 选择依据：可用性 → 预期耗时 → 工程规则完整性；失败自动回退，
 * 并把实际后端写进结果的 verifiedBy 字段。
 *
 * @module @huaqiu/dsh-kicad-drc
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import pkg from '../package.json'
import { LocalExecutor, resolveConfigHome } from './local-executor.ts'
import { RemoteExecutor } from './remote-executor.ts'
import { AdaptiveExecutor } from './adaptive-executor.ts'
import { KicadIpcExecutor } from './kicad-ipc-executor.ts'
import { resolveIpcPython, IPC_PYTHON_ENV } from './config.ts'
import { createDrcTool, createBackendsTool, TOOL_NAME, BACKENDS_TOOL_NAME } from './tools.ts'
import { createReportRegistry, createDrcReportHandler } from './web-routes.ts'
import type { DrcExecutor, DrcMode, DrcBackendName } from './executor.ts'

/** 插件版本号（唯一来源：package.json），启动时打印用于确认生效版本。 */
const PLUGIN_VERSION = pkg.version

export { createDrcTool, createBackendsTool, TOOL_NAME, BACKENDS_TOOL_NAME } from './tools.ts'
export { LocalExecutor, resolveKicadCli, buildChildEnv, resolveConfigHome } from './local-executor.ts'
export { RemoteExecutor } from './remote-executor.ts'
export { KicadIpcExecutor } from './kicad-ipc-executor.ts'
export { AdaptiveExecutor, rankBackends } from './adaptive-executor.ts'
export { resolveIpcPython, IPC_PYTHON_ENV } from './config.ts'
export type { RankedCandidate, RankInput, VerifiedBy } from './adaptive-executor.ts'
export { parseDrcSummary, formatSummaryText } from './drc-summary.ts'
export type {
  BackendHealth,
  DrcBackendName,
  DrcExecutor,
  DrcMode,
  DrcRunOptions,
  DrcRunResult,
} from './executor.ts'
export type { DrcSummary, JsonValue } from './drc-summary.ts'

/** 插件配置。 */
export interface Config {
  /** 默认执行模式：auto 自动选择，local / remote / ipc 强制指定。 */
  executorMode: DrcMode
  /**
   * auto 模式下的后端优先顺序（越靠前越优先），默认 remote → local → ipc。
   * remote 不可用或执行失败时才降级，失败回退由自适应执行器完成。
   */
  backendPriority: DrcBackendName[]
  /** 本地模式：kicad-cli 路径，留空自动探测。 */
  kicadCliPath: string
  /** 本地模式：是否用隔离的 KICAD_CONFIG_HOME（实测省 ~5s，但拿不到全局封装库表）。 */
  isolatedConfig: boolean
  /**
   * kicad-ipc 后端使用的 Python 解释器绝对路径（需装 `kipy`）。
   * 留空则读环境变量 `DSH_KICAD_DRC_PYTHON`，再兜底 `python3`。
   * 与 `@huaqiu/dsh-kicad` 的 `DSH_KICAD_PYTHON` 刻意分开：两个插件可能部署在不同机器、
   * 对着不同 KiCad 版本，共用一份解释器配置会让独立部署变得不可能。
   */
  ipcPythonPath: string
  /** 远程模式：pcblint-java 服务地址（由其转发到 cli-runner 执行 kicad-cli）。 */
  pcblintBaseUrl: string
  /** 远程模式：cli-runner 工作目录根（共享磁盘上的路径，pcblint-java 和本插件均可访问）。 */
  cliRunnerWorkDirRoot: string
  /** 远程模式：静态文件服务器域名，用于把 cli-runner 返回的绝对路径（如 /data/kicad/drc/xxx/drc.json）
   *  拼接成完整下载 URL（如 http://www.fdatasheets.com/data/kicad/drc/xxx/drc.json）。
   *  配了之后插件通过 HTTP 下载 drc.json；显式设为空字符串则回退到共享磁盘 readFileSync。 */
  fileBaseUrl: string
  /** DRC 默认超时秒数。 */
  defaultTimeoutSeconds: number
}

/** 运行时配置校验和默认值。 */
export const Config: Schema<Config> = Schema.object({
  executorMode: Schema.union(['auto', 'local', 'remote', 'ipc'] as const).default('auto'),
  backendPriority: Schema.array(Schema.union(['remote', 'local', 'ipc'] as const))
    .default(['remote', 'local', 'ipc']),
  kicadCliPath: Schema.string().default(''),
  isolatedConfig: Schema.boolean().default(true),
  ipcPythonPath: Schema.string().default(''),
  pcblintBaseUrl: Schema.string().default('http://47.100.4.100:8080'),
  cliRunnerWorkDirRoot: Schema.string().default('/data/kicad/drc'),
  fileBaseUrl: Schema.string().default('http://www.fdatasheets.com'),
  defaultTimeoutSeconds: Schema.number().default(600),
})

/** 插件名，Cordis 会显示。 */
export const name = '@huaqiu/dsh-kicad-drc'

/** 依赖的 DSH 服务（webServer 用于 /drc-report 报告查看路由；headless 环境缺失时自动降级）。 */
export const inject = ['tools', 'webServer']

/**
 * 插件入口：构建全部后端、装配自适应执行器并注册工具。
 */
export function apply(ctx: Context, config: Config): void {
  console.log(`[@huaqiu/dsh-kicad-drc] 插件版本: ${PLUGIN_VERSION}`)

  const configHome = resolveConfigHome(config.isolatedConfig)

  // kicad-ipc 后端（第二阶段）要用的解释器。这里先解析并打印，便于部署时确认配置生效；
  // 未配置且未设环境变量时不打印，避免每条启动日志都出现无关信息。
  const ipcPython = resolveIpcPython(config.ipcPythonPath)
  if (config.ipcPythonPath || process.env[IPC_PYTHON_ENV]) {
    console.log(`[@huaqiu/dsh-kicad-drc] kicad-ipc Python 解释器: ${ipcPython}`)
  }

  // 两个后端都构建：mode 可以按次覆盖默认模式，所以本地/远程都需要在场。
  const local = new LocalExecutor(config.kicadCliPath || undefined, { configHome })
  const remote = new RemoteExecutor({
    baseUrl: config.pcblintBaseUrl,
    workDirRoot: config.cliRunnerWorkDirRoot,
    // 注意：必须原样传递 config.fileBaseUrl（空字符串 = 显式禁用 HTTP 下载，走共享磁盘）；
    // 若在这里转成 undefined，构造函数会兜底回硬编码默认值，导致"共享磁盘模式"永远无法启用。
    fileBaseUrl: config.fileBaseUrl,
  })

  const backends: DrcExecutor[] = [local, remote, new KicadIpcExecutor(ipcPython)]
  const adaptive = new AdaptiveExecutor(backends, {
    defaultMode: config.executorMode,
    priority: config.backendPriority,
  })

  console.log(
    `[@huaqiu/dsh-kicad-drc] 模式: ${config.executorMode}`
    + `；后端优先顺序: ${config.backendPriority.join(' → ')}`
    + `；本地配置隔离: ${configHome ? `开（${configHome}）` : '关'}`
    + `；远程: ${config.pcblintBaseUrl}`
    + `；kicad-ipc: ${ipcPython}（需要华秋定制版 KiCad 提供 RunDrc）`,
  )

  // 异步预热：探测放到启动之后，避免本机没装 KiCad 时（PowerShell 全盘搜索上限 30s）
  // 同步阻塞 host 启动。失败不致命——kicad-cli 只在真正调用工具时才需要。
  const warmup = setTimeout(() => {
    void adaptive.describe().then((list) => {
      for (const b of list) {
        if (b.available) console.log(`[@huaqiu/dsh-kicad-drc] 后端 ${b.backend} 可用: ${b.endpoint}`)
        else console.warn(`[@huaqiu/dsh-kicad-drc] 后端 ${b.backend} 不可用: ${b.reason ?? '未知原因'}`)
      }
    }).catch((e: unknown) => {
      console.warn(`[@huaqiu/dsh-kicad-drc] 后端预热失败: ${e instanceof Error ? e.message : String(e)}`)
    })
  }, 1500)
  if (typeof warmup.unref === 'function') warmup.unref()

  // /drc-report 路由：浏览器半边（src/client）经此拉取 drc.json 并渲染分页报告卡片。
  // webServer 服务缺失时（headless 环境）静默跳过，工具功能不受影响。
  let registerReport: ((key: string, reportPath: string) => void) | undefined
  const webServer = (ctx as Context & {
    webServer?: { register: (route: unknown) => void }
  }).webServer
  if (webServer && typeof webServer.register === 'function') {
    const registry = createReportRegistry()
    ctx.effect(() => {
      const reg = webServer.register({
        kind: 'prefix',
        path: '/drc-report',
        handler: createDrcReportHandler(registry),
      })
      return () => { if (typeof reg === 'function') (reg as () => void)() }
    }, '@huaqiu/dsh-kicad-drc: /drc-report routes')
    registerReport = (key, reportPath) => registry.register(key, reportPath)
  }

  // 注册工具 — inject=['tools'] 保证 tools 服务已就绪
  const registry = (ctx as Context & { tools: { register: (t: unknown) => void, dispose: (name: string) => void } }).tools
  if (!registry) {
    console.warn('[@huaqiu/dsh-kicad-drc] 未找到 tools 服务，工具未注册')
    return
  }

  const drcTool = createDrcTool(adaptive, config.defaultTimeoutSeconds, registerReport, {
    defaultMode: config.executorMode,
  })
  const backendsTool = createBackendsTool(() => adaptive.describe())

  registry.register(drcTool)
  registry.register(backendsTool)

  ctx.effect(() => {
    console.log(`[@huaqiu/dsh-kicad-drc] 已注册工具: ${TOOL_NAME}, ${BACKENDS_TOOL_NAME}`)
    return () => {
      try { registry.dispose(TOOL_NAME) } catch { /* ignore */ }
      try { registry.dispose(BACKENDS_TOOL_NAME) } catch { /* ignore */ }
      console.log(`[@huaqiu/dsh-kicad-drc] 工具已卸载: ${TOOL_NAME}, ${BACKENDS_TOOL_NAME}`)
    }
  }, '@huaqiu/dsh-kicad-drc.lifecycle')
}
