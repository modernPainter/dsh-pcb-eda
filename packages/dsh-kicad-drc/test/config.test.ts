import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveIpcPython, IPC_PYTHON_ENV } from '../src/config.ts'

test('resolveIpcPython：插件配置优先于环境变量', () => {
  assert.equal(
    resolveIpcPython('C:/py/python.exe', { [IPC_PYTHON_ENV]: 'D:/other/python.exe' }),
    'C:/py/python.exe',
  )
})

test('resolveIpcPython：没有配置时读专用环境变量', () => {
  assert.equal(resolveIpcPython('', { [IPC_PYTHON_ENV]: 'D:/env/python.exe' }), 'D:/env/python.exe')
  assert.equal(resolveIpcPython(undefined, { [IPC_PYTHON_ENV]: 'D:/env/python.exe' }), 'D:/env/python.exe')
})

test('resolveIpcPython：都未设置时兜底 python3', () => {
  assert.equal(resolveIpcPython('', {}), 'python3')
  assert.equal(resolveIpcPython(undefined, {}), 'python3')
})

test('resolveIpcPython：空白字符串视为未配置', () => {
  assert.equal(resolveIpcPython('   ', {}), 'python3')
  assert.equal(resolveIpcPython('', { [IPC_PYTHON_ENV]: '  ' }), 'python3')
})

test('IPC_PYTHON_ENV 与 dsh-kicad 的变量名刻意区分', () => {
  assert.equal(IPC_PYTHON_ENV, 'DSH_KICAD_DRC_PYTHON')
  assert.notEqual(IPC_PYTHON_ENV, 'DSH_KICAD_PYTHON')
})
