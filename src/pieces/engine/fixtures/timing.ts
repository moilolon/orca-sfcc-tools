// Timing for the engine's tests (limits.test.ts, query/performance.test.ts): the processor time of
// this thread, which a busy machine does not add to. The wall clock counts the time other
// processes run and V8's helper threads collecting garbage: under a second test suite a 512 KB
// parse took ten times a 128 KB one by the wall clock, its own work four. Windows counts a thread's
// time in ticks of about 16 ms, so a time that must be precise is read around a block of runs of at
// least `BLOCK_MS`. A check is first made on one run, already timed; only when that one does not
// pass are blocks taken, the best of up to `MOST_BLOCKS`: other work only ever slows a run, so a
// best time still too slow after them is the code's. Test only: it reads Node's `process`.

/**
 * This thread's processor time, in milliseconds; the wall clock where the runtime cannot say
 * (`process.threadCpuUsage` came with Node 23.9).
 */
export const threadTime: () => number = (() => {
  const usage = (process as { threadCpuUsage?: () => { user: number; system: number } }).threadCpuUsage
  if (typeof usage !== 'function') return () => performance.now()
  return () => {
    const used = usage.call(process)
    return (used.user + used.system) / 1000
  }
})()

/** The shortest block of runs, in milliseconds of the thread's time: some ten ticks. */
export const BLOCK_MS = 150
/** The most blocks one check takes. */
export const MOST_BLOCKS = 5

/** What `run` answers, and the thread's time it took. */
export function timed<T>(run: () => T): { value: T; ms: number } {
  const started = threadTime()
  const value = run()
  return { value, ms: threadTime() - started }
}

/** The time one run of `run` takes, averaged over a block of at least `BLOCK_MS`. */
export function blockTime(run: () => unknown): number {
  const started = threadTime()
  let runs = 0
  let used = 0
  do {
    run()
    runs++
    used = threadTime() - started
  } while (used < BLOCK_MS)
  return used / runs
}

/** The time of `run`: `first` (one run, timed) when `holds` accepts it, else the best block time. */
export function settledTime(first: number, run: () => unknown, holds: (ms: number) => boolean): number {
  let best = first
  for (let i = 0; i < MOST_BLOCKS && !holds(best); i++) best = i === 0 ? blockTime(run) : Math.min(best, blockTime(run))
  return best
}

/** The times of two runs compared, as `settledTime`: blocks of each until `holds` accepts them. */
export function settledTimes(first: [number, number], runs: [() => unknown, () => unknown], holds: (a: number, b: number) => boolean): [number, number] {
  let [a, b] = first
  for (let i = 0; i < MOST_BLOCKS && !holds(a, b); i++) {
    const blockA = blockTime(runs[0])
    const blockB = blockTime(runs[1])
    a = i === 0 ? blockA : Math.min(a, blockA)
    b = i === 0 ? blockB : Math.min(b, blockB)
  }
  return [a, b]
}
