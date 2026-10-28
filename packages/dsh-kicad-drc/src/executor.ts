/**
 * 执行器接口 + 结果类型。
 * 实现：本地 subprocess（LocalExecutor）、远程 cli-runner（RemoteExecutor）、
 * 运行中 KiCad 的 IPC（KicadIpcExecutor）；由 AdaptiveExecutor 做选择与回退。
 */

/** 后端标识。 */
export type DrcBackendName = 'local' | 'remote' | 'ipc'

/** 请求的执行模式：auto 交给 AdaptiveExecutor 决策，其余强制指定后端。 */
export type DrcMode = 'auto' | DrcBackendName

/** 后端健康状态（探测结果；不产生 DRC 副作用）。 */
export interface BackendHealth {
  backend: DrcBackendName
  available: boolean
  /** 实际使用的端点：本地为 kicad-cli 绝对路径，远程为服务地址。 */
  endpoint: string
  /** 不可用原因（available=false 时有值）。 */
  reason?: string
}

/** DRC 执行结果。 */
export interface DrcRunResult {
  exitCode: number
  stdout: string
  stderr: string
  /** drc.json 原始 JSON 字符串；null 表示未生成。 */
  drcJson: string | null
  elapsedMs: number
  timedOut: boolean
  /** 实际使用的 kicad-cli 可执行文件绝对路径。 */
  kicadCliPath: string
  /** 实际执行的完整命令行（含参数）。 */
  command: string
  /** drc.json 文件持久化保存的绝对路径（供用户直接打开/下载）。 */
  drcJsonPath: string | null
  /** 本次执行是否使用了隔离的 KICAD_CONFIG_HOME（仅本地后端会设置）。 */
  isolatedConfig?: boolean
}

/** 执行器选项。 */
export interface DrcRunOptions {
  /** .kicad_pcb 文件绝对路径。 */
  pcbPath: string
  /** 启用所有严重级别。 */
  severityAll?: boolean
  /** DRC 前重绘填充区。 */
  refillZones?: boolean
  /** 报告所有走线错误。 */
  allTrackErrors?: boolean
  /** 超时秒数。 */
  timeoutSeconds?: number
  /**
   * 请求的执行模式。仅 AdaptiveExecutor 读取；单个执行器忽略该字段
   * （显式指定模式时由调用方直接选中对应执行器）。
   */
  mode?: DrcMode
}

/** 执行器抽象接口。 */
export interface DrcExecutor {
  /** 执行 kicad-cli pcb drc 并返回结果。 */
  run(options: DrcRunOptions): Promise<DrcRunResult>
  /** 后端标识（AdaptiveExecutor 按此排序与标注）。 */
  readonly name?: DrcBackendName
  /** 能力探测：只判断可用性，不跑 DRC。 */
  probe?(): Promise<BackendHealth>
}

export class ExecutorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecutorError'
  }
}
