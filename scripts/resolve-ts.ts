// Lets Node run a script that imports the plugin's own modules. The sources import each other
// without an extension (`./instances`), as Orca loads them; Node needs one. Loaded with
// `node --import ./scripts/resolve-ts.ts …`: a relative import with no extension that Node cannot
// find is tried again with `.ts`, and nothing else changes.
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (!/^\.\.?\//.test(specifier) || /\.[a-z]+$/i.test(specifier)) throw error
      return nextResolve(`${specifier}.ts`, context)
    }
  }
})
