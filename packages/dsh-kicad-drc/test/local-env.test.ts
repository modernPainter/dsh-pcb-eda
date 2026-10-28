import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { buildChildEnv, resolveConfigHome } from '../src/local-executor.ts'

test('buildChildEnv：未启用隔离时原样返回 base 环境', () => {
  const base = { FOO: '1' }
  assert.equal(buildChildEnv(undefined, base), base)
})

test('buildChildEnv：启用隔离时注入 KICAD_CONFIG_HOME 且不污染 base', () => {
  const base: Record<string, string | undefined> = { FOO: '1' }
  const env = buildChildEnv('/tmp/kicad-config', base)
  assert.equal(env.KICAD_CONFIG_HOME, '/tmp/kicad-config')
  assert.equal(env.FOO, '1')
  assert.equal(base.KICAD_CONFIG_HOME, undefined)
})

test('resolveConfigHome：关闭隔离时返回 undefined', () => {
  assert.equal(resolveConfigHome(false, {}), undefined)
})

test('resolveConfigHome：用户已显式设置 KICAD_CONFIG_HOME 时不覆盖', () => {
  assert.equal(resolveConfigHome(true, { KICAD_CONFIG_HOME: '/custom/kicad' }), undefined)
})

test('resolveConfigHome：开启隔离时返回已创建的目录', () => {
  const dir = resolveConfigHome(true, {})
  assert.ok(dir)
  assert.ok(dir.includes('dsh-kicad-drc'))
  assert.ok(existsSync(dir))
})
