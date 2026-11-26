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
      there: run `npm run manifest` again. A fragment may only hold `contributes`. Two pieces
      may declare the same hook or event: it is emitted once, and fails when their options
      differ.
    - `src/core/`: what every piece shares. `piece.ts` (the piece contracts and `PIECE_IDS`),
      `b2c.ts` (the only module that starts a process), `dw-config.ts` (the only module that
      reads `dw.json`, called only by `b2c.ts`), `instances.ts` (the four roles, the role guard
      with `ALLOWED_COMMANDS`, and `ALLOWED_FLAGS`), `settings.ts`, `store.ts` (storage, one
      namespace per piece), `workspaces.ts`, `i18n.ts` (texts, English and Spanish).
      `test-support.ts` holds the invented `dw.json` and the fake process the tests use;
      `b2c-commands-fixture.ts` lists every command of the b2c the allow list was checked
      against, for the tests that walk it.
    - `src/protocol.ts`: the panel–worker contract (`core.status`), importing each piece's
      `protocol.ts`. Request names start with the piece id.
    - `src/worker/worker.ts` builds core and starts every piece of `src/worker/pieces.ts`;
      `src/panel/panel.tsx` draws the setup and one section per piece of
      `src/panel/sections.ts`, knowing no piece by name; `src/panel/checks.ts` merges core's
      check scenarios with every piece's, and `src/panel/panel.check.ts` hands them to Orca.
    - `src/pieces/<piece>/`: `manifest.json`, `section.tsx` (its name, `delivered`, an optional
      `setup(ctx)` for its own events, its body), `scenarios.ts` (its check scenarios, each named
      after the piece), `i18n.ts`, and `protocol.ts` and `worker.ts` unless it runs nothing
      (`isml`). Pieces: `isml`, `sandbox`, `errors`, `debugger`, `engine`, `editor`. A phase works
      inside its own piece folder: the three registries (`src/worker/pieces.ts`,
      `src/panel/sections.ts`, `src/panel/checks.ts`) and `src/protocol.ts` already list every
      piece, and a test fails when any other shared module imports one.
    - `scripts/build-manifest.ts`: the manifest merge (run by Node, which strips the types).
- **Rules of the plugin:**
    - Upload, logs, the sandbox, debugging and API documentation go through the official `b2c`
      CLI. Everything else is written here: no binaries, no code from other tool repositories, no
      runtime npm dependencies.
    - The plugin reads the workspace's `dw.json` (or the main checkout's, when a worktree has
      none; a setting can name another file) for one purpose: to hand `b2c` the host and
      credentials of each role, in the environment of the child process (`SFCC_SERVER`,
      `SFCC_CLIENT_ID`, …). Never in its arguments, never stored, logged, shown or put in an error
      message. The rest of the plugin only learns the state of the file (`ok`, `missing`,
      `invalid`) and of each role (`ready`, `incomplete`, `absent`).
    - Roles: `sandbox` reads the plain keys; `development`, `staging` and `production` the same
      keys with their suffix (`-dev`, `-stg`, `-prd` by default), with no fallback to the plain
      ones. The guard is an allow list of whole commands, `ALLOWED_COMMANDS`: the sandbox runs
      `code list`, `deploy`, `watch`, `activate` and `delete`, `sandbox list`, `start` and
      `stop`, `debug` and the three `logs` commands; the other roles run `logs get`, `list` and
      `tail` and nothing else; `docs read`, `docs search` and `--version` need no role. Anything
      else is refused for every role, the `ods` alias and the rest of each topic included
      (`sandbox delete`, `code download`). A command the plugin needs is added there, and to
      `TAKES_VALUE` beside it when it takes an argument of its own. Only a `ready` role is
      started: a host and a client id and secret (on the sandbox a user and password also
      count), none of them with a control character. Without usable credentials `b2c` would
      open a browser sign-in.
    - Arguments: a flag passes only when it is in `ALLOWED_FLAGS` (`flag_not_allowed`
      otherwise): nothing that names a host, a user, a credential, an instance, a configuration
      or `.env` file, a project folder, a certificate or a sign-in method goes in it. No
      argument may hold a value of `dw.json`, and when `b2c` is a `.cmd` or `.bat` none may hold
      `" % ^ & | < > !` or a control character (`unsafe_argument`, with the position of the
      argument): a version manager's shim would let it run another command.
    - `run()` is for one-shot commands and adds `--json`. `start()` is for long-lived ones: it
      hands over stderr line by line and stdout in raw chunks, takes `write()` and `end()` for
      stdin, always reads both streams, and adds `--jsonl` only with `jsonl: true`; its `exited`
      carries a `reason` (`b2c_not_found`, `cwd_not_found`, `b2c_failed`) when the process could
      not be started. Output is decoded as a stream, so a character cut between two chunks
      arrives whole.
    - One workspace uploads, the one picked by hand; it never follows the focused workspace. A
      workspace on another host (`hostId` other than `local`) is never read as a local folder.
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

- `npm install`. Node 22.18 or later. `tsconfig.json` extends `.orca/types`, which is ignored
  and written by `orca plugin types .`: `npm run typecheck` runs it first, so a clean clone
  needs no other step (`npm run types` writes them alone, for the editor).
- `npm run typecheck`, `npm test` (`orca plugin test .`), `npm run check`
  (`orca plugin check .`), `npm run validate` (`orca plugin validate .`) and
  `npm run manifest -- --check`: all five must exit 0 before a pull request, with their output
  in it. There is no hosted CI: the checks need Orca.
- `orca plugin inspect . --json` shows the access list. It is fixed: `storage:own`,
  `settings:own`, `workspace:read`, `workspace:write`, `notifications:show`. A change to it, or
  to the commands, needs the owner's approval in Orca again; a phase that needs more stops.
- **Captures:** `orca plugin shot . --scenario <name> --json` draws a scenario of
  `src/panel/checks.ts` (core's `found`, `wrongPath`, `configured`, `missing` and
  `invalidConfig`, plus each piece's, drawn over a ready setup) with the worker on a
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
