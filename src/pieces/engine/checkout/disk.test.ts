// The watcher of a checkout's folder, on the real disk of a temporary folder: it reports a change
// as a path inside the folder, and stops once the folder itself is removed. On Windows, Node goes
// on reporting a removed folder many thousands of times a second without failing, so a watcher
// that missed it kept a worker busy for good.
import { assert, test } from 'orca/testing'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchCheckout } from './disk'

/** Waits until `done` holds, up to `ms`, at the pace of the disk's events. */
async function until(done: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (!done() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10))
  return done()
}

test('the watcher reports a change inside the folder, and stops once the folder is removed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sfcc-tools-watch-'))
  mkdirSync(join(root, 'cartridges', 'app_x'), { recursive: true })
  const changes: string[] = []
  let stopped = 0
  let calls = 0
  const watcher = watchCheckout(
    root,
    (path) => {
      calls++
      changes.push(path)
    },
    () => stopped++
  )
  try {
    if (watcher === null) return // The platform cannot watch a tree: nothing to stop.
    writeFileSync(join(root, 'cartridges', 'app_x', 'a.js'), 'var a = 1;')
    assert.ok(await until(() => changes.includes('cartridges/app_x/a.js'), 10_000), `a change inside the folder: ${changes.join(', ')}`)
    assert.ok(changes.every((path) => !/^[a-z]:|^\/|^\\\\|\.\./i.test(path)), 'only paths inside the folder')

    rmSync(root, { recursive: true, force: true })
    if (process.platform === 'win32') assert.ok(await until(() => stopped > 0, 10_000), 'the watcher says it stopped')
    else await until(() => stopped > 0, 2_000)
    assert.ok(stopped <= 1, 'it says so once')
    // Whatever the platform reports of the removal, nothing goes on firing.
    const before = calls
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.ok(calls - before < 50, `${calls - before} changes after the folder was removed`)
  } finally {
    watcher?.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('the watcher stops when its folder is removed and made again before it could see it gone', async () => {
  // Only Windows reports the removed folder itself, and goes on reporting it after it is made again.
  if (process.platform !== 'win32') return
  const root = mkdtempSync(join(tmpdir(), 'sfcc-tools-watch-'))
  const changes: string[] = []
  let stopped = 0
  const watcher = watchCheckout(root, (path) => changes.push(path), () => stopped++)
  try {
    assert.ok(watcher)
    writeFileSync(join(root, 'a.js'), 'var a = 1;')
    assert.ok(await until(() => changes.includes('a.js'), 10_000), 'the watcher sees a change first')
    // In one turn of the event loop: by the time an event is handled, the folder is there again.
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root)
    assert.ok(await until(() => stopped > 0, 10_000), 'the watcher says it stopped, so the caller watches again')
    assert.equal(stopped, 1)
    const before = changes.length
    writeFileSync(join(root, 'b.js'), 'var b = 1;')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(changes.length, before, 'a stopped watcher reports nothing more')
  } finally {
    watcher?.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
