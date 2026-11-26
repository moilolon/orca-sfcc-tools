// Shared by the tests: a fake process, an invented dw.json and settings over plain values. Every
// host and credential here is invented; hosts are under example.com.
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonValue } from 'orca'
import type { ChildLike, SpawnOptions, Spawner } from './b2c'
import { createSettings, type Settings } from './settings'

/** An invented dw.json: a sandbox, a development and a staging instance; production has no host. */
export const INVENTED_DW = {
  hostname: 'sandbox-01.example.com',
  username: 'sandbox.user@example.com',
  password: 'Invented-Sandbox-Password-1',
  'client-id': 'invented-sandbox-client-id',
  'client-secret': 'invented-sandbox-client-secret',
  'short-code': 'inventedshort',
  'tenant-id': 'invented_tenant_001',
  'hostname-dev': 'development-01.example.com',
  'client-id-dev': 'invented-dev-client-id',
  'client-secret-dev': 'invented-dev-client-secret',
  'hostname-stg': 'staging-01.example.com',
  'client-id-stg': 'invented-stg-client-id',
  'client-secret-stg': '',
  'client-id-prd': 'invented-prd-client-id',
  'client-secret-prd': 'invented-prd-client-secret',
  'code-version': 'invented_version',
  realm: 'invented-realm'
}

/** Every value of the invented file that must never leave the child's environment. */
export const SECRET_VALUES = Object.values(INVENTED_DW).filter((value) => value.length > 0)

/** A temporary workspace folder holding the invented dw.json. */
export function makeWorkspace(dw: Record<string, string> | string = INVENTED_DW): string {
  const root = mkdtempSync(join(tmpdir(), 'sfcc-tools-'))
  writeFileSync(join(root, 'dw.json'), typeof dw === 'string' ? dw : JSON.stringify(dw, null, 2))
  return root
}

export function plainSettings(values: Record<string, JsonValue> = {}): Settings {
  return createSettings({ get: async () => values, onDidChange: () => ({ dispose() {} }) })
}

/** A fake stdin that keeps what it was given. */
export class FakeStdin extends EventEmitter {
  readonly written: (string | Uint8Array)[] = []
  ended = false
  write(data: string | Uint8Array): boolean {
    this.written.push(data)
    return true
  }
  end(): void {
    this.ended = true
  }
}

export class FakeChild extends EventEmitter implements ChildLike {
  readonly pid = 4242
  readonly stdin = new FakeStdin()
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
  /** Writes output, then exits with `code` and closes its pipes. */
  finish(code: number, stdout = '', stderr = ''): void {
    if (stdout) this.stdout.emit('data', Buffer.from(stdout))
    if (stderr) this.stderr.emit('data', Buffer.from(stderr))
    this.emit('exit', code)
    this.emit('close', code)
  }
}

export type SpawnCall = { file: string; args: readonly string[]; options: SpawnOptions; child: FakeChild }

/** A spawner that records each call and lets `script` drive the fake process. */
export function fakeSpawner(script: (call: SpawnCall) => void = (call) => call.child.finish(0, '{}')) {
  const calls: SpawnCall[] = []
  const spawn: Spawner = (file, args, options) => {
    const call = { file, args, options, child: new FakeChild() }
    calls.push(call)
    queueMicrotask(() => script(call))
    return call.child
  }
  return { spawn, calls }
}

/** Fails when any invented value appears in `text`. */
export function assertNoSecrets(text: string, where: string): void {
  for (const value of SECRET_VALUES) {
    if (text.includes(value)) throw new Error(`${where} holds a value read from dw.json`)
  }
}
