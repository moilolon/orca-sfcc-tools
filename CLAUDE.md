# SFCC Tools for Orca

Orca plugin for working on a Salesforce Commerce Cloud (SFCC) project: ISML, cartridge
upload, sandbox status and the new errors of its log. One plugin holds everything.

`README.md` is the cover for visitors, laid out like every moilolon repo: *What this is*, *How
it works*, *Getting started* and the shared footer, with no folder tree, long code or roadmap.
The details below are for Claude. `docs/plan.md` is the build plan: phases, contracts, spikes.
Changing it needs the owner's yes.

## Structure

- The plugin follows the shape of `C:/Developer/PERSONAL/orca-obsidian-notes`: a Node worker
  and a components panel that Orca loads from source, with no build. Tests sit beside each
  module (`*.test.ts`).
    - `orca-plugin.json` is **generated**: `npm run manifest` merges `src/manifest.base.json`
      (identity, engine, access list, core settings, the panel) with every
      `src/pieces/*/manifest.json`, pieces in alphabetical order. Never edit it by hand; a test
      fails when it differs from the merge. Two branches that both changed it conflict only
      there: run `npm run manifest` again. A fragment may only hold `contributes`.
    - `src/core/`: what every piece shares. `piece.ts` (the piece contracts and `PIECE_IDS`),
      `b2c.ts` (the only module that starts a process), `dw-config.ts` (the only module that
      reads `dw.json`, called only by `b2c.ts`), `instances.ts` (the four roles and the role
      guard), `settings.ts`, `store.ts` (storage, one namespace per piece), `workspaces.ts`,
      `i18n.ts` (texts, English and Spanish). `test-support.ts` holds the invented `dw.json` and
      the fake process the tests use.
    - `src/protocol.ts`: the panel–worker contract (`core.status`), importing each piece's
      `protocol.ts`. Request names start with the piece id.
    - `src/worker/worker.ts` builds core and starts every piece of `src/worker/pieces.ts`;
      `src/panel/panel.tsx` draws the setup and one section per piece of
      `src/panel/sections.ts`; `src/panel/panel.check.ts` holds the check and capture scenarios.
    - `src/pieces/<piece>/`: `manifest.json`, `protocol.ts`, `worker.ts`, `section.tsx`,
      `i18n.ts`. Pieces: `isml` (only a manifest fragment), `sandbox`, `errors`, `debugger`,
      `engine`, `editor`. A phase works inside its own piece folder; both registries already list
      every piece.
    - `scripts/build-manifest.ts`: the manifest merge (run by Node, which strips the types).
- **Rules of the plugin:**
    - Upload, logs, the sandbox, debugging and API documentation go through the official `b2c`
      CLI. Everything else is written here: no binaries, no code from other tool repositories, no
      runtime npm dependencies.
    - The plugin reads the workspace's `dw.json` (or the main checkout's, when a worktree has
      none; a setting can name another file) for one purpose: to hand `b2c` the host and
      credentials of each role, in the environment of the child process (`SFCC_SERVER`,
      `SFCC_CLIENT_ID`, …). Never in its arguments, never stored, logged, shown or put in an error
      message. The rest of the plugin only learns whether a role is configured.
    - Roles: `sandbox` reads the plain keys; `development`, `staging` and `production` the same
      keys with their suffix (`-dev`, `-stg`, `-prd` by default), with no fallback to the plain
      ones. The guard in `b2c.ts` allows `code`, `debug` and `sandbox` only on the sandbox; the
      other roles run `logs` and nothing else. A role with no usable credentials is never started:
      `b2c` would open a browser sign-in.
    - One workspace uploads, the one picked by hand; it never follows the focused workspace.
    - **Public repo:** nothing of a project it is used on. No hosts, sandbox names, credentials
      or customer data, in code, tests, fixtures, commit messages or pull requests. Fixtures are
      invented, with hosts under `example.com`. Never open or copy a real `dw.json`.
- The plugin guide of the installed Orca: `orca skills get orca-plugin-authoring`.
- `assets/draw-images.ps1` (`powershell -NoProfile -File assets/draw-images.ps1`) draws, from
  shapes, the README cover (`cover.png`), the icon (`icon.png`, also the project's icon in Orca)
  and the GitHub social preview (`social-preview.png`, uploaded by hand in Settings). The base is
  shared by every repo (the one in `moilolon/workbench`); only the repo's own part changes here.
  It is saved as UTF-8 with BOM, or PowerShell 5.1 breaks the accents; redraw it when what it
  shows changes.

## Development

- `npm install`, then `npm run types` (writes `.orca/types`, ignored; `tsconfig.json` extends
  it). Node 22.18 or later.
- `npm run typecheck`, `npm test` (`orca plugin test .`), `npm run check`
  (`orca plugin check .`), `npm run validate` (`orca plugin validate .`) and
  `npm run manifest -- --check`: all five must exit 0 before a pull request, with their output
  in it. There is no hosted CI: the checks need Orca.
- `orca plugin inspect . --json` shows the access list. It is fixed: `storage:own`,
  `settings:own`, `workspace:read`, `workspace:write`, `notifications:show`. A change to it, or
  to the commands, needs the owner's approval in Orca again; a phase that needs more stops.
- **Captures:** `orca plugin shot . --scenario <name> --json` draws a scenario of
  `src/panel/panel.check.ts` (`found`, `wrongPath`, `configured`, `missing`) with the worker on a
  stand-in host, without loading the plugin, into `.orca/shots/`. It needs Orca's window hidden
  or minimized and fails otherwise: never bring the window forward or change what the owner
  sees; report the error. Open the PNG and say what it shows. Spanish needs Orca's own language
  set to Spanish: scenarios cannot set the locale.
- **Loading the plugin** (`orca plugin dev load` / `dev watch`) runs its code with its access
  list, so only the owner approves it; never pass `--approve` on their behalf. Every worktree
  holds a copy with the same id, and a folder load is keyed `local.sfcc-tools`, so Orca treats
  the copies as one development plugin: load one copy at a time. Before loading another,
  `orca plugin dev unload <the other folder>`; `orca plugin list --json` shows which folder is
  loaded.

## Git

- **Commits:** English, imperative, sentence case, one line of at most 72 characters with no
  prefix and no trailing period (`Add the settings page`). A body only when the why is not
  obvious: a blank line, then lines wrapped at 72. No `Co-Authored-By` or other attribution.
- **Branches:** `<type>/<short-description>`, lowercase kebab-case, off `main`. Types: `feature`,
  `bugfix`, `docs`, `refactor`, `chore`.
- **`gh`:** always as `GH_TOKEN=$(gh auth token --user moilolon) gh …`, command by command. gh's
  active account is the work one, which must not act on this repo; do not switch it. `git`
  already uses `moilolon` through the `includeIf` of `C:/Developer/PERSONAL/`.
- **Pull requests:** title like a commit; body with *What changes*, *Why* and *How to check it*.
  Merged by squash, with the PR title and body as the commit.
