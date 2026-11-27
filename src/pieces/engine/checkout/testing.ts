// What the checkout index's tests share: the invented checkout of `fixtures/checkout/` read into
// memory with LF line breaks, a generated checkout of any size, and a fake git ref.
import { readdirSync, readFileSync } from 'node:fs'
import { GitError, type RefReader } from './checkout'
import { MemoryFiles } from './memory'

export const FIXTURE_ROOT = new URL('../fixtures/checkout/', import.meta.url)

/** Every file of the invented checkout, by relative path, with LF line breaks. */
export function fixtureEntries(): Record<string, string> {
  const entries: Record<string, string> = {}
  const walk = (url: URL, prefix: string) => {
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, url), `${prefix}${entry.name}/`)
      else entries[`${prefix}${entry.name}`] = readFileSync(new URL(entry.name, url), 'utf8').replace(/\r\n?/g, '\n')
    }
  }
  walk(FIXTURE_ROOT, '')
  return entries
}

export function fixtureFiles(time = 1): MemoryFiles {
  return new MemoryFiles(fixtureEntries(), time)
}

/**
 * A generated checkout of about `files` files: `cartridges` cartridges, each with controllers,
 * scripts that require each other along the path, models with `module.superModule`, templates and
 * bundles, and one site archive naming them all.
 */
export function generatedCheckout(files: number, cartridges = 6): MemoryFiles {
  const memory = new MemoryFiles()
  const names = Array.from({ length: cartridges }, (_, i) => `app_gen_${i}`)
  const perCartridge = Math.max(5, Math.floor(files / cartridges / 4))
  for (const [c, name] of names.entries()) {
    const root = `cartridges/${name}`
    memory.set(`${root}/.project`, `<projectDescription><name>${name}</name></projectDescription>\n`)
    for (let i = 0; i < perCartridge; i++) {
      memory.set(
        `${root}/cartridge/scripts/lib/module${i}.js`,
        [
          "'use strict';",
          `var next = require('*/cartridge/scripts/lib/module${(i + 1) % perCartridge}');`,
          "var Site = require('dw/system/Site');",
          `/** @returns {string} the label */`,
          `function label${i}(value) { return Resource.msg('key.${i % 50}', 'generated', null) + value; }`,
          `module.exports = { label${i}: label${i}, next: next };`,
          ''
        ].join('\n')
      )
      memory.set(`${root}/cartridge/models/model${i}.js`, `'use strict';\nvar base = module.superModule;\nmodule.exports = function Model${i}() { if (base) { base.call(this); } };\n`)
      memory.set(
        `${root}/cartridge/templates/default/page/page${i}.isml`,
        `<isinclude template="page/page${(i + 1) % perCartridge}"/>\n<div>\${Resource.msg('key.${i % 50}', 'generated', null)}</div>\n`
      )
      memory.set(`${root}/cartridge/static/default/images/image${i}.png`, 'not read')
      if (i % 10 === 0) {
        memory.set(
          `${root}/cartridge/controllers/Page${i}.js`,
          [
            "'use strict';",
            "var server = require('server');",
            c < cartridges - 1 ? 'server.extend(module.superModule);' : '',
            c < cartridges - 1 ? `server.append('Show', function (req, res, next) { next(); });` : `server.get('Show', function (req, res, next) { res.render('page/page${i}'); next(); });`,
            'module.exports = server.exports();',
            ''
          ].join('\n')
        )
      }
    }
    memory.set(`${root}/cartridge/templates/resources/generated.properties`, Array.from({ length: 50 }, (_, k) => `key.${k}=Text ${k} of ${name}`).join('\n') + '\n')
  }
  memory.set('modules/.project', '<projectDescription><name>modules</name></projectDescription>\n')
  memory.set('modules/server.js', 'module.exports = {};\n')
  memory.set('sites/site_template/sites/GenSite/site.xml', `<site site-id="GenSite"><custom-cartridges>${names.join(':')}</custom-cartridges></site>\n`)
  return memory
}

/** A git ref in memory: `commits` maps a ref to a commit, `trees` a commit to its files. */
export class FakeRef implements RefReader {
  readonly calls: string[] = []
  commits: Record<string, string>
  trees: Record<string, Record<string, string>>
  failure: GitError | null
  constructor(commits: Record<string, string>, trees: Record<string, Record<string, string>>, failure: GitError | null = null) {
    this.commits = commits
    this.trees = trees
    this.failure = failure
  }

  async commit(ref: string): Promise<string | null> {
    this.calls.push(`commit ${ref}`)
    if (this.failure) throw this.failure
    return this.commits[ref] ?? null
  }

  async list(ref: string, path: string): Promise<string[]> {
    this.calls.push(`list ${ref} ${path}`)
    if (this.failure) throw this.failure
    return Object.keys(this.trees[ref] ?? {}).filter((file) => path === '' || file.startsWith(path + '/'))
  }

  async read(ref: string, path: string): Promise<string | null> {
    this.calls.push(`read ${ref} ${path}`)
    if (this.failure) throw this.failure
    return this.trees[ref]?.[path] ?? null
  }
}
