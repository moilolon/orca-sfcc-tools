// The editor's debugger side against a fake debugger (a store of lines, a session that verifies
// some of them and halts in a file): the gutter sets and removes breakpoints through the one store,
// shows what the store holds with how the session took it, moves marks with edits and writes them
// where they are seen on the editor's save, and shows the stopped line while a thread is halted in
// the file. The script and its paths are invented.
import { assert, test } from 'orca/testing'
import { t, LANGUAGES } from '../../../core/i18n'
import { NOTICE_MAX_CHARS } from '../../../panel/ui'
import type { DebuggerFileInput, DebuggerFileState, StoppedLine } from '../../debugger/protocol'
import { EditorModel } from '../surface/model'
import type { LineHighlight, LineMark } from '../surface/view'
import { DebugController, type DebugRequests } from './controller'
import { debugMessages } from './i18n'

const PATH = 'cartridges/app_example/cartridge/controllers/Page.js'
const FILE: DebuggerFileInput = { workspaceId: 'w1', path: PATH }
const SCRIPT = ['var a = 1;', 'var b = 2;', 'function show() {', '  return a + b;', '}', 'module.exports.show = show;'].join('\n')

/** The debugger as the worker answers it: one store, a session that verifies odd lines, a halt. */
class FakeDebugger implements DebugRequests {
  lines = new Map<string, number[]>()
  session: DebuggerFileState['session'] = 'none'
  stopped: StoppedLine | null = null
  scriptable = true
  calls: string[] = []
  failNext: string | null = null

  async file(input: DebuggerFileInput): Promise<DebuggerFileState> {
    const lines = this.lines.get(input.path) ?? []
    return {
      scriptable: this.scriptable,
      session: this.session,
      lines: lines.map((line) => ({ line, verified: this.session === 'none' ? null : line % 2 === 1 })),
      stopped: this.stopped
    }
  }

  async breakpoint(input: DebuggerFileInput & { line: number; on: boolean }): Promise<unknown> {
    this.calls.push(`breakpoint ${input.line} ${input.on}`)
    if (this.failNext) {
      const code = this.failNext
      this.failNext = null
      throw Object.assign(new Error(code), { code })
    }
    const lines = new Set(this.lines.get(input.path) ?? [])
    if (input.on) lines.add(input.line)
    else lines.delete(input.line)
    this.lines.set(
      input.path,
      [...lines].sort((a, b) => a - b)
    )
    return {}
  }

  async setBreakpoints(input: DebuggerFileInput & { lines: number[] }): Promise<unknown> {
    this.calls.push(`set ${input.lines.join(',')}`)
    this.lines.set(input.path, [...input.lines])
    return {}
  }

  async hover(): Promise<null> {
    return null
  }
}

function setup(stored: number[] = []) {
  const debug = new FakeDebugger()
  debug.lines.set(PATH, stored)
  const model = new EditorModel(SCRIPT)
  const drawn = { marks: new Map<number, LineMark>(), clickable: false, highlight: null as LineHighlight | null, revealed: [] as number[], notices: [] as string[] }
  const controller = new DebugController(
    debug,
    {
      setMarks: (marks) => (drawn.marks = marks),
      setClickable: (clickable) => (drawn.clickable = clickable),
      setHighlight: (highlight) => (drawn.highlight = highlight),
      reveal: (line) => drawn.revealed.push(line),
      notify: (text) => drawn.notices.push(text)
    },
    (key, vars) => t(debugMessages, 'en', key, vars),
    () => model.buffer.lineCount
  )
  model.buffer.onChange((fromLine, oldEnd, newEnd, change) => controller.bufferChanged(fromLine, oldEnd, newEnd, change))
  /** The gutter as drawn: 1-based line and the classes of its mark. */
  const gutter = () => [...drawn.marks].map(([line, mark]) => `${line + 1}:${mark.kinds.join('+')}`).sort((a, b) => parseInt(a) - parseInt(b))
  return { debug, model, controller, drawn, gutter }
}

test('an unnamed file shows nothing and the gutter takes no click; a named script shows the store’s marks', async () => {
  const { debug, controller, drawn, gutter } = setup([2, 4])
  await controller.toggle(0)
  assert.deepEqual(debug.calls, [], 'no file named: nothing asked')
  assert.equal(drawn.clickable, false)
  controller.setFile(FILE)
  await controller.refresh()
  assert.equal(drawn.clickable, true)
  assert.deepEqual(gutter(), ['2:bp-idle', '4:bp-idle'])
  assert.equal(drawn.marks.get(1)?.title, 'Breakpoint, no debugging session')
})

test('a file that is not a script of a cartridge takes no click', async () => {
  const { debug, controller, drawn } = setup()
  debug.scriptable = false
  controller.setFile({ workspaceId: 'w1', path: 'cartridges/app_example/cartridge/templates/default/page.isml' })
  await controller.refresh()
  assert.equal(drawn.clickable, false)
  await controller.toggle(1)
  assert.deepEqual(debug.calls, [])
})

test('a click sets and removes through the store; the session’s verdict shows by shape and words', async () => {
  const { debug, controller, drawn, gutter } = setup([])
  controller.setFile(FILE)
  await controller.refresh()
  await controller.toggle(2)
  assert.deepEqual(debug.calls, ['breakpoint 3 true'])
  assert.deepEqual(debug.lines.get(PATH), [3])
  assert.deepEqual(gutter(), ['3:bp-idle'])
  // A session starts on the workspace and verifies odd lines: line 3 verified, line 4 not.
  debug.session = 'attached'
  await controller.toggle(3)
  assert.deepEqual(gutter(), ['3:bp', '4:bp-unverified'])
  assert.equal(drawn.marks.get(2)?.title, 'Breakpoint, verified by the session')
  assert.equal(drawn.marks.get(3)?.title, 'Breakpoint, not verified by the session')
  // A second click removes it.
  await controller.toggle(2)
  assert.deepEqual(debug.lines.get(PATH), [4])
  assert.deepEqual(gutter(), ['4:bp-unverified'])
})

test('a change of the store elsewhere (the debugger’s view, an error’s frame) shows once the state is asked again', async () => {
  const { debug, controller, gutter } = setup([])
  controller.setFile(FILE)
  await controller.refresh()
  debug.lines.set(PATH, [5])
  await controller.refresh()
  assert.deepEqual(gutter(), ['5:bp-idle'])
})

test('a refused change says so in one line and shows the store as it is', async () => {
  const { debug, controller, drawn, gutter } = setup([2])
  controller.setFile(FILE)
  await controller.refresh()
  debug.failNext = 'not_script'
  await controller.toggle(4)
  assert.deepEqual(drawn.notices, ['Breakpoints go only in scripts of a cartridge.'])
  assert.deepEqual(gutter(), ['2:bp-idle'])
})

test('marks follow edits, and the editor’s save writes them where they are seen', async () => {
  const { debug, model, controller, gutter } = setup([4])
  controller.setFile(FILE)
  await controller.refresh()
  model.setSelection({ line: 0, col: 0 })
  model.paste('// one\n// two\n')
  assert.deepEqual(gutter(), ['6:bp-idle'])
  assert.deepEqual(debug.lines.get(PATH), [4], 'the store keeps the saved file’s line until the save')
  // A click on a written line waits for the save.
  await controller.toggle(1)
  assert.deepEqual(gutter(), ['2:bp-pending', '6:bp-idle'])
  assert.deepEqual(debug.calls, [])
  controller.flushed()
  await controller.saved()
  assert.deepEqual(debug.calls, ['set 2,6'])
  assert.deepEqual(debug.lines.get(PATH), [2, 6])
  assert.deepEqual(gutter(), ['2:bp-idle', '6:bp-idle'])
})

test('the stopped line shows with its frame’s name while halted here, comes into view once, and goes on continue', async () => {
  const { debug, model, controller, drawn, gutter } = setup([4])
  controller.setFile(FILE)
  debug.session = 'halted'
  debug.stopped = { line: 4, name: 'show()', frameId: 70000, top: true }
  await controller.refresh()
  assert.deepEqual(drawn.highlight, { line: 3, kind: 'stopped', label: 'Stopped here: show()' })
  assert.deepEqual(gutter(), ['4:bp-unverified+stopped'])
  assert.equal(drawn.marks.get(3)?.title, 'Breakpoint, not verified by the session. Stopped here: show()')
  assert.deepEqual(drawn.revealed, [3])
  assert.equal(controller.stopped?.frameId, 70000)
  // Edits above move it; asking again does not scroll again.
  model.setSelection({ line: 0, col: 0 })
  model.enter()
  assert.equal(drawn.highlight?.line, 4)
  await controller.refresh()
  assert.deepEqual(drawn.revealed, [3])
  // The thread continues: the line goes.
  debug.session = 'attached'
  debug.stopped = null
  await controller.refresh()
  assert.equal(drawn.highlight, null)
  assert.equal(controller.stopped, null)
  assert.deepEqual(gutter(), ['5:bp-unverified'])
})

test('a caller’s frame in this file shows as such; a halt in another file shows nothing here', async () => {
  const { debug, controller, drawn } = setup([])
  controller.setFile(FILE)
  debug.session = 'halted'
  debug.stopped = { line: 6, name: '', frameId: 70001, top: false }
  await controller.refresh()
  assert.deepEqual(drawn.highlight, { line: 5, kind: 'caller', label: 'Called from here' })
  debug.stopped = null
  await controller.refresh()
  assert.equal(drawn.highlight, null)
})

test('an answer that comes after a newer request, or during a write, is dropped', async () => {
  const { debug, controller, gutter } = setup([2])
  controller.setFile(FILE)
  await controller.refresh()
  let release: () => void = () => {}
  const slow = debug.file.bind(debug)
  debug.file = (input) => new Promise((resolve) => (release = () => void slow(input).then(resolve)))
  debug.lines.set(PATH, [5])
  const old = controller.refresh()
  debug.file = slow
  await controller.refresh()
  debug.lines.set(PATH, [6])
  release()
  await old
  assert.deepEqual(gutter(), ['5:bp-idle'])
})

test('every text fits a notice line in both languages', () => {
  for (const language of LANGUAGES) {
    for (const [key, text] of Object.entries(debugMessages[language])) assert.ok(text.length <= NOTICE_MAX_CHARS, `${language}.${key} is ${text.length} characters`)
  }
})
