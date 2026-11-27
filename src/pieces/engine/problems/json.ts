// A JSON reader that keeps where each value is, for `steptypes.json`: what `JSON.parse` accepts,
// read into values with their ranges, or the place and reason of the first fault. An explicit
// stack, so a deep file never overflows; linear; never throws. Pure: no Node, no Orca.

export type JsonFault = 'unexpected' | 'unclosed' | 'bad_string' | 'bad_number' | 'trailing' | 'too_deep'

export const JSON_FAULTS: readonly JsonFault[] = ['unexpected', 'unclosed', 'bad_string', 'bad_number', 'trailing', 'too_deep']

export type JsonValue =
  | { kind: 'object'; start: number; end: number; members: JsonMember[] }
  | { kind: 'array'; start: number; end: number; items: JsonValue[] }
  | { kind: 'string'; start: number; end: number; value: string }
  | { kind: 'number' | 'boolean' | 'null'; start: number; end: number }

export type JsonMember = { key: string; keyStart: number; keyEnd: number; value: JsonValue }

export type JsonRead = { value: JsonValue; fault: null } | { value: null; fault: { reason: JsonFault; start: number; end: number } }

/** How deep objects and arrays may nest. */
export const MAX_JSON_NESTING = 256

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y
const SPACE = /[ \t\r\n]*/y

type Frame = { value: Extract<JsonValue, { kind: 'object' | 'array' }>; key: { key: string; keyStart: number; keyEnd: number } | null; expect: 'first' | 'value' | 'next' | 'key' }

export function readJson(text: string): JsonRead {
  const n = text.length
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const fail = (reason: JsonFault, start: number, end = start + 1): JsonRead => ({ value: null, fault: { reason, start: Math.min(start, n), end: Math.min(Math.max(end, start), n) } })
  const skip = () => {
    SPACE.lastIndex = i
    SPACE.exec(text)
    i = SPACE.lastIndex
  }
  const stack: Frame[] = []
  let result: JsonValue | null = null

  /** Hands a finished value to the frame that holds it, or makes it the result. */
  const place = (value: JsonValue) => {
    const frame = stack[stack.length - 1]
    if (!frame) result = value
    else if (frame.value.kind === 'array') frame.value.items.push(value)
    else if (frame.key) frame.value.members.push({ ...frame.key, value })
    if (frame) frame.expect = 'next'
  }

  while (true) {
    skip()
    const frame = stack[stack.length - 1]
    if (frame && frame.value.kind === 'object' && (frame.expect === 'first' || frame.expect === 'key')) {
      if (frame.expect === 'first' && text[i] === '}') {
        stack.pop()
        frame.value.end = i + 1
        i++
        place(frame.value)
        if (stack.length === 0) break
        continue
      }
      if (text[i] !== '"') return i >= n ? fail('unclosed', frame.value.start) : fail('unexpected', i)
      STRING.lastIndex = i
      const match = STRING.exec(text)
      if (!match) return fail('bad_string', i)
      const keyStart = i
      i += match[0].length
      frame.key = { key: JSON.parse(match[0]) as string, keyStart: keyStart + 1, keyEnd: i - 1 }
      skip()
      if (text[i] !== ':') return i >= n ? fail('unclosed', frame.value.start) : fail('unexpected', i)
      i++
      frame.expect = 'value'
      continue
    }
    if (frame && frame.expect === 'next') {
      const close = frame.value.kind === 'object' ? '}' : ']'
      if (text[i] === ',') {
        i++
        frame.expect = frame.value.kind === 'object' ? 'key' : 'value'
        continue
      }
      if (text[i] === close) {
        stack.pop()
        frame.value.end = i + 1
        i++
        place(frame.value)
        if (stack.length === 0) break
        continue
      }
      return i >= n ? fail('unclosed', frame.value.start) : fail('unexpected', i)
    }
    if (frame && frame.value.kind === 'array' && frame.expect === 'first' && text[i] === ']') {
      stack.pop()
      frame.value.end = i + 1
      i++
      place(frame.value)
      if (stack.length === 0) break
      continue
    }
    // A value.
    if (i >= n) return fail(frame ? 'unclosed' : 'unexpected', frame ? frame.value.start : i)
    const c = text[i]
    if (c === '{' || c === '[') {
      if (stack.length >= MAX_JSON_NESTING) return fail('too_deep', i)
      const value: Frame['value'] = c === '{' ? { kind: 'object', start: i, end: i, members: [] } : { kind: 'array', start: i, end: i, items: [] }
      stack.push({ value, key: null, expect: 'first' })
      i++
      continue
    }
    let value: JsonValue
    if (c === '"') {
      STRING.lastIndex = i
      const match = STRING.exec(text)
      if (!match) return fail('bad_string', i)
      value = { kind: 'string', start: i, end: i + match[0].length, value: JSON.parse(match[0]) as string }
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      NUMBER.lastIndex = i
      const match = NUMBER.exec(text)
      if (!match) return fail('bad_number', i)
      value = { kind: 'number', start: i, end: i + match[0].length }
    } else if (text.startsWith('true', i) || text.startsWith('false', i)) {
      value = { kind: 'boolean', start: i, end: i + (text.startsWith('true', i) ? 4 : 5) }
    } else if (text.startsWith('null', i)) {
      value = { kind: 'null', start: i, end: i + 4 }
    } else {
      return fail('unexpected', i)
    }
    i = value.end
    place(value)
    if (stack.length === 0) break
  }
  skip()
  if (i < n) return fail('trailing', i)
  return result ? { value: result, fault: null } : fail('unexpected', 0)
}

/** A member of an object by its key; the last one when written twice, as `JSON.parse` keeps. */
export function member(value: JsonValue | null | undefined, key: string): JsonMember | null {
  if (!value || value.kind !== 'object') return null
  for (let i = value.members.length - 1; i >= 0; i--) if (value.members[i].key === key) return value.members[i]
  return null
}
