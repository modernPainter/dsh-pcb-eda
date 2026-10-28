import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { KicadIpcExecutor } from '../src/kicad-ipc-executor.ts'

test('KicadIpcExecutor：name 为 ipc', () => {
  assert.equal(new KicadIpcExecutor('python3').name, 'ipc')
})

test('KicadIpcExecutor.probe：解释器不存在时返回不可用而不是抛错', async () => {
  const executor = new KicadIpcExecutor(join(tmpdir(), 'no-such-python-xyz.exe'))
  const health = await executor.probe()
  assert.equal(health.available, false)
  assert.match(String(health.reason), /无法启动 Python/)
})

test('KicadIpcExecutor.probe：失败结果在冷却期内复用（不重复起进程）', async () => {
  const executor = new KicadIpcExecutor(join(tmpdir(), 'no-such-python-xyz.exe'))
  const first = await executor.probe()
  const second = await executor.probe()
  assert.deepEqual(second, first)
})

test('KicadIpcExecutor.run：解释器不可用时抛 ExecutorError', async () => {
  const executor = new KicadIpcExecutor(join(tmpdir(), 'no-such-python-xyz.exe'))
  await assert.rejects(
    executor.run({ pcbPath: join(tmpdir(), 'x.kicad_pcb') }),
    /无法启动 Python/,
  )
})
