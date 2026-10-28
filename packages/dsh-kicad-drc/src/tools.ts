/**
 * DSH 工具定义：kicad_drc_run。
 *
 * AI agent 调用此工具，传入 .kicad_pcb 文件路径，
 * 工具在 Host 端执行 kicad-cli pcb drc（本地 subprocess 或远程 pcblint-java）
 * 并返回结构化结果。
 */
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parseDrcSummary, formatSummaryText, type DrcSummary, type JsonValue } from './drc-summary.ts'
import type { BackendHealth, DrcExecutor, DrcMode } from './executor.ts'
import type { VerifiedBy } from './adaptive-executor.ts'

/** 工具名（唯一来源；注册/卸载日志与 dispose 均使用它）。 */
export const TOOL_NAME = 'kicad_drc_run'

/** 后端探测工具名。 */
export const BACKENDS_TOOL_NAME = 'kicad_drc_backends'

/** 工具输出结构。未生成报告的字段直接省略（drcJsonPath/drcJson/drcSummary）。 */
interface KicadDrcOutput {
  success: boolean
  exitCode: number
  timedOut: boolean
  elapsedMs: number
  stdout: string
  stderr: string
  /** 本次执行使用的 kicad-cli（local 模式为可执行文件绝对路径，remote 模式为 remote:<baseUrl> 标识）。 */
  kicadCliPath: string
  /** 实际执行的完整命令行（含参数）。 */
  command: string
  /** drc.json 持久化保存的绝对路径（PCB 文件同目录，可直接打开）。 */
  drcJsonPath?: string
  /** drc.json 原始 JSON 字符串（可能很大；仅 includeFullJson=true 时返回）。 */
  drcJson?: string
  /** 解析后的紧凑摘要。 */
  drcSummary?: DrcSummary
  /** 本次验证由哪个后端执行、为什么选它（跨后端结果不可直接比较，务必读这个字段）。 */
  verifiedBy?: Record<string, JsonValue>
  /** Web GUI 报告查看器地址（浏览器半边经此拉取报告 JSON 并分页渲染；无 webServer 时省略）。 */
  viewUrl?: string
}

/**
 * 创建 kicad_drc_run 工具。
 *
 * @param registerReport 可选的报告登记回调：DRC 成功生成报告后，把 drc.json
 *   路径登记到 webServer 路由的 key 上，供浏览器半边拉取渲染（无 webServer 时传 undefined）。
 */
export function createDrcTool(
  executor: DrcExecutor,
  defaultTimeoutSeconds = 600,
  registerReport?: (key: string, reportPath: string) => void,
  options: { defaultMode?: DrcMode } = {},
) {
  const defaultMode: DrcMode = options.defaultMode ?? 'auto'
  return defineTool({
    name: TOOL_NAME,
    description:
      '对 KiCad PCB 文件执行 DRC（设计规则检查）。\n\n'
      + '【工作原理】插件在 Host 端执行如下格式的命令：\n\n'
      + '  kicad-cli pcb drc <pcb文件> --output drc.json --format json --severity-all --refill-zones\n\n'
      + '有两种后端（mode 参数可强制指定，默认 auto 自动选择）：\n'
      + '  - local:  本地 subprocess 直接调 kicad-cli（需本机安装 KiCad；'
      + '可执行文件按 插件配置 → 环境变量 KICAD_CLI_PATH → PATH → Windows 注册表 → 常见安装目录 自动探测）。'
      + '约 1~2 秒，且能读取工程级规则，优先选它\n'
      + '  - remote: PCB 文件上传到 pcblint-java 服务，由其转发 cli-runner 执行（本机无需 KiCad）。'
      + '需上传与排队，约 8~20 秒；只上传单个 .kicad_pcb，工程级 DRC 规则可能丢失\n\n'
      + 'auto 模式按「可用性 → 预期耗时 → 工程规则完整性」选择后端，失败会自动回退到下一个，'
      + '并在结果的 verifiedBy 字段标注实际执行的后端。'
      + '同一块板在会话内会保持在首次成功的后端上，保证多次结果可比。\n\n'
      + '传入 .kicad_pcb 文件的绝对路径（文件必须存在于本机文件系统），'
      + '工具返回 stdout、drcSummary（错误/警告数量、按类型分类、示例错误等）'
      + '和 drcJsonPath（完整报告持久化在 PCB 文件同目录，可直接读取该文件查看明细）。'
      + '如果只关心概况，优先读 drcSummary；需要完整明细时传 includeFullJson=true 或直接读 drcJsonPath 指向的文件。\n\n'
      + '【注意】默认输出不含 drc.json 原始 JSON（可能数百 KB），避免撑爆上下文。'
      + 'success 表示 DRC 运行是否正常完成，不代表板子没有违规——有无违规请判断 drcSummary.totalIssues。',

    parameters: {
      pcbPath: {
        type: 'string',
        required: true,
        description: 'KiCad PCB 文件的绝对路径（.kicad_pcb）。',
      },
      mode: {
        type: 'string',
        description:
          `执行后端。默认 ${defaultMode}（auto 按优先序列选择：默认 remote → local → ipc，`
          + '前一个不可用或执行失败才降级到下一个）；'
          + 'local 强制本地 kicad-cli；remote 强制走在线服务；'
          + 'ipc 直接让正在运行的 KiCad 执行 DRC 并取回结构化结果'
          + '（作用于未保存的板、不产生 marker，需要华秋定制版 KiCad）。'
          + '需要可复现的固定环境时显式指定，其余情况留空即可。',
      },
      severityAll: {
        type: 'boolean',
        description: '启用所有严重级别（error/warning/exclusion）。默认 true。',
      },
      refillZones: {
        type: 'boolean',
        description: 'DRC 前重绘填充区。默认 true。',
      },
      allTrackErrors: {
        type: 'boolean',
        description: '报告所有走线错误（不仅是第一个）。默认 false。',
      },
      includeFullJson: {
        type: 'boolean',
        description: '在输出中包含 drc.json 原始 JSON 字符串（可能很大）。默认 false；需要完整明细时传 true，或直接读取 drcJsonPath 指向的文件。',
      },
      timeoutSeconds: {
        type: 'number',
        description: `超时秒数。默认 ${defaultTimeoutSeconds}（插件配置 defaultTimeoutSeconds）。`,
      },
    },

    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          exitCode: { type: 'number', required: true },
          timedOut: { type: 'boolean', required: true },
          elapsedMs: { type: 'number', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          kicadCliPath: {
            type: 'string',
            required: true,
            description: '本次执行使用的 kicad-cli（local 模式为可执行文件绝对路径，remote 模式为 remote:<baseUrl> 标识）。',
          },
          command: {
            type: 'string',
            required: true,
            description: '实际执行的完整命令行。',
          },
          drcJsonPath: {
            type: 'string',
            description:
              'drc.json 报告文件在本机持久化保存的绝对路径，与 PCB 文件同目录，'
              + '可直接读取查看完整明细。若 DRC 未生成报告，该字段不存在。',
          },
          drcSummary: {
            type: 'object',
            additionalProperties: true,
            description:
              'DRC 摘要：错误/警告数量、按类型分类、示例错误等。若未生成报告，该字段不存在。',
          },
          drcJson: {
            type: 'string',
            description:
              'drc.json 原始 JSON 字符串（可能很大，数百 KB）。仅当调用时传 includeFullJson=true 才返回；'
              + '通常只需读 drcSummary 或 drcJsonPath 指向的文件。若未生成报告，该字段不存在。',
          },
          verifiedBy: {
            type: 'object',
            additionalProperties: true,
            description:
              '本次验证实际由哪个后端执行（backend: local/remote）、端点、耗时、选择原因，'
              + '以及发生回退时的 fallbackFrom。跨后端结果不可直接比较，比较两次 DRC 前请先看本字段。',
          },
          viewUrl: {
            type: 'string',
            description:
              'Web GUI 报告查看器地址（/drc-report/api/report?key=…）。'
              + '浏览器半边会自动拉取该地址并在对话尾部渲染分页报告卡片，调用方无需处理。'
              + '无 webServer 环境时该字段不存在。',
          },
        },
      },
      render: (args, value) => {
        const vb = value.verifiedBy as
          | { backend?: string; endpoint?: string; elapsedMs?: number }
          | undefined
        const backend = vb?.backend
        const summary = value.drcSummary
          ? formatSummaryText(value.drcSummary as DrcSummary)
          // ipc 正常会带回结构化结果；走到这里说明结果没取到，文案要和"没跑出报告"区分开
          : backend === 'ipc'
            ? '已在 KiCad 中执行 DRC，但没取回结构化结果（RunDrcResponse 为空），请改用 local 后端复核。'
            : 'DRC 未生成报告'
        const pathLine = value.drcJsonPath
          ? `\n\n📄 完整 DRC 报告已保存到: ${value.drcJsonPath}`
          : ''
        // 模型只能看到 render 返回的文本块，看不到结构化 verifiedBy；
        // 后端身份必须落在正文里，否则无法判断本次结果来自哪条通路（ipc / local / remote）。
        const backendLine = backend
          ? `\n\n执行后端: ${backend}${vb?.endpoint ? ` (${vb.endpoint})` : ''} · ${vb?.elapsedMs ?? '?'} ms`
          : ''
        const blocks: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: summary + pathLine + backendLine }]
        // 第二块：客户端预览载荷。浏览器半边（src/client）逐块 JSON.parse 工具结果，
        // 找到 {ok:true, viewUrl} 即在该轮尾部渲染分页报告卡片。
        if (value.viewUrl) {
          blocks.push({
            type: 'text',
            text: JSON.stringify({
              ok: true,
              viewUrl: value.viewUrl,
              key: /key=([\w.-]+)$/.exec(value.viewUrl)?.[1] ?? '',
              name: typeof args.pcbPath === 'string' && args.pcbPath ? basename(args.pcbPath) : '',
            }),
          })
        }
        return blocks
      },
    },

    async execute(args, exec) {
      exec.signal.throwIfAborted()

      // mode 是自由字符串，这里收敛到合法取值，避免拼错导致静默走默认
      const mode = normalizeMode(args.mode)

      let result
      try {
        result = await executor.run({
          pcbPath: args.pcbPath,
          severityAll: args.severityAll,
          refillZones: args.refillZones,
          allTrackErrors: args.allTrackErrors,
          // 调用方未指定时回退到插件配置的默认超时
          timeoutSeconds: args.timeoutSeconds ?? defaultTimeoutSeconds,
          mode,
        })
      } catch (e) {
        // 把执行器错误（PCB 不存在、kicad-cli 未找到、HTTP 失败等）转成结构化输出，
        // 让 AI 能统一处理，而不是收到裸异常。
        const message = e instanceof Error ? e.message : String(e)
        return {
          success: false,
          exitCode: -1,
          timedOut: false,
          elapsedMs: 0,
          stdout: '',
          stderr: message,
          kicadCliPath: 'unknown',
          command: '',
        }
      }

      // 解析摘要
      let drcSummary: DrcSummary | null = null
      if (result.drcJson) {
        try {
          drcSummary = parseDrcSummary(result.drcJson)
        } catch { /* ignore parse errors */ }
      }

      // 注意：drcJsonPath / drcJson / drcSummary 缺失时不放入返回对象，
      // 因为 DSH 的 schema 不支持 type: ['string', 'null']，而这些字段没有 required，
      // 省略即可（AI 侧用 in 检查或可选链访问）。
      const output: KicadDrcOutput = {
        success: result.exitCode === 0 && !result.timedOut,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        elapsedMs: result.elapsedMs,
        stdout: result.stdout,
        stderr: result.stderr,
        kicadCliPath: result.kicadCliPath,
        command: result.command,
      }
      if (result.drcJsonPath) output.drcJsonPath = result.drcJsonPath
      // 默认不回传原始 JSON，避免大报告撑爆 AI 上下文；仅在显式请求时包含
      if (result.drcJson && args.includeFullJson) output.drcJson = result.drcJson
      if (drcSummary) output.drcSummary = drcSummary

      // 自适应执行器会带回来源标注；直接用单执行器时补一个最小标注，
      // 保证 AI 任何时候都知道这次结果是哪个后端跑出来的。
      const verifiedBy = (result as { verifiedBy?: VerifiedBy }).verifiedBy
      output.verifiedBy = (verifiedBy ?? {
        backend: result.kicadCliPath.startsWith('remote:') ? 'remote' : 'local',
        endpoint: result.kicadCliPath,
        elapsedMs: result.elapsedMs,
        reasons: ['由固定后端执行（未启用自适应选择）'],
      }) as unknown as Record<string, JsonValue>

      // 登记报告到 webServer 路由，供浏览器半边拉取渲染（无 webServer 时跳过）
      if (result.drcJsonPath && registerReport) {
        const key = `drc-${randomUUID()}`
        registerReport(key, result.drcJsonPath)
        output.viewUrl = `/drc-report/api/report?key=${key}`
      }

      return output
    },

    presentCall: (args) => ({
      card: 'generic',
      title: `KiCad DRC: ${args.pcbPath ?? '?'}`,
      kind: 'other',
      rawInput: args.pcbPath,
    }),
  })
}

/** 把调用方传入的 mode 收敛到合法取值；非法值退回 auto 并留一条日志。 */
function normalizeMode(raw: unknown): DrcMode {
  if (raw === 'local' || raw === 'remote' || raw === 'ipc' || raw === 'auto') return raw
  if (raw !== undefined && raw !== null && raw !== '') {
    console.warn(`[@huaqiu/dsh-kicad-drc] 未知 mode="${String(raw)}"，回退 auto`)
  }
  return 'auto'
}

/**
 * 后端探测工具：让 AI 在执行 DRC 前先看清有哪些后端、各自是否可用、预计多快，
 * 从而有依据地决定要不要显式指定 mode（而不是盲选或盲信默认值）。
 */
export function createBackendsTool(
  describe: () => Promise<Array<BackendHealth & { estimatedMs: number }>>,
) {
  return defineTool({
    name: BACKENDS_TOOL_NAME,
    description:
      '列出 KiCad DRC 的可用执行后端及其状态（不执行 DRC，也不产生副作用）。\n\n'
      + '返回每个后端的 available、endpoint、预计耗时 estimatedMs 与不可用原因。'
      + '典型用途：跑 DRC 前确认本机是否有可用的本地 kicad-cli；'
      + '或在上一次远程调用失败后确认它是否处于降级冷却期。'
      + '一般情况下直接调用 kicad_drc_run（mode 留空）即可，无需先调本工具。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          backends: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
            description: '每个后端的状态：backend / available / endpoint / estimatedMs / reason。',
          },
        },
      },
      render: (_args, value) => {
        const rows = Array.isArray(value.backends) ? value.backends : []
        const lines = rows.map((b) => {
          const rec = b as Record<string, unknown>
          const flag = rec.available ? '可用' : '不可用'
          const extra = rec.available ? `约 ${rec.estimatedMs}ms` : String(rec.reason ?? '')
          return `  - ${rec.backend}: ${flag}（${extra}）`
        })
        return [{ type: 'text', text: ['KiCad DRC 后端状态', ...lines].join('\n') }]
      },
    },
    async execute() {
      try {
        return { backends: (await describe()) as unknown as Record<string, JsonValue>[] }
      } catch (e) {
        return {
          backends: [],
          error: e instanceof Error ? e.message : String(e),
        }
      }
    },
    presentCall: () => ({
      card: 'generic',
      title: 'KiCad DRC 后端探测',
      kind: 'other',
    }),
  })
}
