/**
 * 插件级配置解析：只放纯函数，便于单测，不依赖 Cordis 或 DSH 服务。
 *
 * 目前只有 kicad-ipc 后端的 Python 解释器解析。之所以单独给 DRC 插件一个
 * 配置项（而不是复用 `@huaqiu/dsh-kicad` 的 `DSH_KICAD_PYTHON`）：
 * 两个插件可以装在不同机器上、对着不同的 KiCad 版本，共用一份解释器配置
 * 会让"DRC 插件单独部署"变得不可能。
 *
 * @module
 */

/** kicad-ipc 后端 Python 解释器的环境变量覆盖点。 */
export const IPC_PYTHON_ENV = 'DSH_KICAD_DRC_PYTHON'

/**
 * 解析 kicad-ipc 后端要用的 Python 解释器。
 *
 * 优先级：插件配置 `ipcPythonPath` → 环境变量 `DSH_KICAD_DRC_PYTHON` → `python3`。
 * 该解释器需要装有官方 `kicad-python`（`import kipy`）。
 */
export function resolveIpcPython(
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromConfig = configured?.trim()
  if (fromConfig) return fromConfig
  const fromEnv = env[IPC_PYTHON_ENV]?.trim()
  if (fromEnv) return fromEnv
  return 'python3'
}
