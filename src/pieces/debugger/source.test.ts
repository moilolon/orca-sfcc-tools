// A script's lines for the source view: cut to what a view can draw, never past the workspace.
import { assert, test } from 'orca/testing'
import { MAX_LINE_CHARS, MAX_LINES, readSource, type SourceFileSystem } from './source'

/** Files in memory by real path; `links` maps a path to where it really leads. */
function memory(files: Record<string, string>, links: Record<string, string> = {}): SourceFileSystem {
  return {
    realpath: async (path) => {
      const slashed = path.replace(/\\/g, '/')
      if (slashed in links) return links[slashed]
      if (slashed === '/ws' || slashed in files) return slashed
      throw new Error('ENOENT')
    },
    read: async (path, limit) => {
      const bytes = new TextEncoder().encode(files[path] ?? '')
      return { bytes: bytes.subarray(0, limit), more: bytes.length > limit }
    }
  }
}

test('lines split on either line ending, the last empty one dropped, each kept as written', async () => {
  const fs = memory({ '/ws/a/b.js': 'one\r\n  two\n\tthree\n' })
  assert.deepEqual(await readSource('/ws', 'a/b.js', fs), { lines: ['one', '  two', '\tthree'], truncated: false })
})

test('a long line is cut, and so is a long file; either says it was', async () => {
  const long = 'x'.repeat(MAX_LINE_CHARS + 10)
  let result = await readSource('/ws', 'a.js', memory({ '/ws/a.js': `${long}\nshort` }))
  assert.equal(result.lines[0], `${'x'.repeat(MAX_LINE_CHARS)}…`)
  assert.equal(result.truncated, true)
  result = await readSource('/ws', 'a.js', memory({ '/ws/a.js': Array.from({ length: MAX_LINES + 5 }, (_, i) => `l${i}`).join('\n') }))
  assert.equal(result.lines.length, MAX_LINES)
  assert.equal(result.truncated, true)
})

test('a file a link takes out of the workspace is refused; one that is not there is not found', async () => {
  const fs = memory({ '/other/secret.js': 'no' }, { '/ws/a.js': '/other/secret.js' })
  await assert.rejects(readSource('/ws', 'a.js', fs), (error: unknown) => (error as { code?: string }).code === 'outside_workspace')
  await assert.rejects(readSource('/ws', 'gone.js', fs), (error: unknown) => (error as { code?: string }).code === 'not_found')
})
