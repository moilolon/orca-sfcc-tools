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
      `b2c.ts` (the only module that starts `b2c`), `dw-config.ts` (the only module that
      reads `dw.json`, called only by `b2c.ts`), `instances.ts` (the four roles, the role guard
      with `ALLOWED_COMMANDS`, and `ALLOWED_FLAGS`), `settings.ts`, `store.ts` (storage, one
      namespace per piece), `workspaces.ts` (the workspace list, and the uploading workspace
      with its code version: `uploading()`, `upload()`), `i18n.ts` (texts, English and Spanish),
      `open-file.ts` (opens a file of a workspace at a line through `orca file open`).
      `b2c.ts` and `open-file.ts` are the only modules that start a process: `open-file.ts`
      imports nothing of `b2c.ts` or `dw-config.ts`, starts `orca.exe` (or `orca`) directly,
      never through a shell or a `.cmd`, with the worker's environment plus `APPDATA`,
      `LOCALAPPDATA` and `USERPROFILE`, and opens only a file inside the workspace.
      `test-support.ts` holds the invented `dw.json` and the fake process the tests use;
      `b2c-commands-fixture.ts` lists every command of the b2c the allow list was checked
      against, for the tests that walk it.
    - `src/protocol.ts`: the panel–worker contract (`core.status`), importing each piece's
      `protocol.ts`. Request names start with the piece id.
    - `src/worker/worker.ts` builds core and starts every piece of `src/worker/pieces.ts`; its
      `deactivate()` awaits every piece's `dispose()` (which may be async) side by side, each
      within `DISPOSE_BOUND_MS`, then core's own handlers, logging only piece ids and codes;
      `src/panel/panel.tsx` draws a bar with one view per delivered piece of
      `src/panel/sections.ts` that has one, the status line and the setup view (the whole panel
      while no piece has a view), knowing no piece by name; `src/panel/ui.tsx` holds the blocks
      every view is built from (see *Panel look*); `src/panel/navigation.ts` keeps the view
      open and gives a view `openSetup()`, for a notice whose fix is in the setup view;
      `src/panel/checks.ts` merges core's check
      scenarios with every piece's, and `src/panel/panel.check.ts` hands them to Orca.
    - `src/pieces/<piece>/`: `manifest.json`, `section.tsx` (its name, `delivered`, `hasView`,
      an optional `setup(ctx)` for its own events, the body of its view), `scenarios.ts` (its
      check scenarios, each named after the piece), `i18n.ts`, and `protocol.ts` and `worker.ts`
      unless it runs nothing (`isml`). Pieces: `isml`, `sandbox`, `errors`, `debugger`,
      `engine`, `editor`. A phase works inside its own piece folder: the three registries
      (`src/worker/pieces.ts`, `src/panel/sections.ts`, `src/panel/checks.ts`) and
      `src/protocol.ts` already list every piece, and a test fails when any other shared module
      imports one. The shared tests (`src/panel/panel.test.tsx`, `src/worker/worker.test.ts`)
      expect nothing of what the pieces are today: keep them that way, and test a piece beside
      its own files. A section whose `setup` throws is shown as not started until the panel is
      opened again.
    - `src/pieces/sandbox/`: `ownership.ts` (who uploads: none, deploying, watching,
      uploading, failed; deletes the version of a removed workspace, deferred while active),
      `code-version.ts` (`<prefix><slug>`, kept per workspace id), `uploader.ts` (reads
      `code watch --jsonl` lines), `status.ts` (the sandbox state from `sandbox list`, start and
      stop followed on it), `status-bar.ts` (its two items' texts), `worker.ts` (requests,
      commands, `workspace.removed`; its state gives each workspace's branch and whether it is
      of a project in use, which only chooses what the view lists first: the uploading
      workspace's project; else the focused one's when it has a configuration file; else every
      project with one; else all); `testing.ts` holds the fakes its tests share.
    - `src/pieces/errors/`: `reader.ts` parses `logs get`, `signature.ts` (its rules written
      beside the code) and `seen.ts` (over a store it is given) are pure, for phase 4's command
      line; `frames.ts` finds which stack frames are files of a local cartridge (such a frame
      of a row carries its path in the workspace, for a breakpoint). A read stores per signature
      only its counters and a masked, bounded sample (the normalised first line, the logger, the
      pipeline or controller, the level and the top frames; never the site, which names the
      shop), never a raw entry; a notification says how many, never what. The workspace whose cartridges a frame is looked
      for in is chosen by `frameRoot()` in its `worker.ts`. A read passes `--level ERROR` and
      `--level FATAL`, and the parser drops any other level too. No URL host is kept: a URL is
      reduced to its path, its locale segment to `<locale>`, and a host written without a scheme
      to `<host>` (never a file name, a `dw.*` name or a Java package). Numbers become `#`, but
      an HTTP status after `status`, `statusCode` or `HTTP` and an error code after `error code`:
      an order, a gift card, a product or a one-time code is never kept, and a `LETTERS-digits`
      token becomes `<code>`. **The limit of `b2c logs get`:**
      it reads only the last 64 KB of each log file (not a flag) and keeps at most `--count`
      entries (200 here), so a busy log can hold entries no read sees. The piece cannot fix
      that; it detects it (200 entries returned, 48 KB of error entries from one file, or a file
      that `logs list`, run before each read, shows grew by more than 64 KB, whatever the level
      of its lines) and the view says "some entries may have been missed since <time>", never a
      notification.
      Phase 4's command line has the same limit.
    - `src/pieces/debugger/`: `dap-client.ts` (the debug adapter protocol's framing and
      request matching), `session.ts` (one `b2c debug` session: its states, driven by the
      adapter's events, never by its responses), `breakpoints.ts` (the single store of
      breakpoints, per workspace, paths relative to it; the editor phase reads and writes it
      too), `workspace.ts` (which workspace is debugged and how a file is opened, each in one
      function), `files.ts` (the scripts of the workspace's cartridges, and the cartridges),
      `source.ts` (one script's lines for the view's source table: read only for a script
      `files.ts` found and only inside the workspace's folder, cut, masked, never stored; the
      view shows a window of `WINDOW_LINES` of them at a time), and `fake-adapter.ts`, the
      scripted adapter its tests use. The open script and folders are kept with the id of the
      workspace they belong to and let go when another is debugged.
      `debugger.breakpoint` sets or removes one line; the Errors view calls it too, for *Add
      breakpoint here* on a frame. Every
      way out of a session disconnects first (a halted request is otherwise held), and a flag
      in its storage makes the next start run a cleanup session after an unclean end.
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
      `invalid`), of each role (`ready`, `incomplete`, `absent`), and, with `b2c.hasConfig(root)`,
      whether a workspace has a file at all (asked of `dw-config.ts` without reading it).
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
      or `.env` file, a project folder, a certificate or a sign-in method goes in it, and
      `--wait` is left out on purpose with its `--poll-interval` and `--timeout`. The one
      exception is the debugger's own client id: `--client-id orca-sfcc-tools` (or
      `--client-id=orca-sfcc-tools`, `DEBUGGER_CLIENT_ID`), once, on `debug` only, so only on
      the sandbox; any other value, form or command with it is refused. No argument
      may hold a value of `dw.json` or a base64 form of its Basic pairs, in any letter case (one
      of eight characters or more anywhere in it, a shorter one as the whole argument or the
      whole value of `--flag=value`), and when `b2c` is a
      `.cmd` or `.bat` none may hold `" % ^ & | < > !` or a control character
      (`unsafe_argument`, with the position of the argument): a version manager's shim would
      let it run another command.
    - `run()` is for one-shot commands and adds `--json`. `start()` is for long-lived ones: it
      hands over stderr line by line and stdout in raw chunks, takes `write()` and `end()` for
      stdin, always reads both streams, and adds `--jsonl` only with `jsonl: true`; its `exited`
      carries a `reason` (`b2c_not_found`, `cwd_not_found`, `b2c_failed`) when the process could
      not be started. Output is decoded as a stream, so a character cut between two chunks
      arrives whole.
    - Masking is by exact value, never by shape: guessing what looks like a host destroys
      ordinary names (`jquery.min.js`, `dw.order.calculate`, a Java package in a stack trace).
      What is masked is every value the runner has read from a `dw.json` since the worker
      started, for every role and from every file, so it does not depend on the workspace
      focused at the moment: each value as written; a host in any letter case, and its first
      label on its own when it has six characters or more and holds a digit or a hyphen
      (`abcd-005`; a plain word such as `staging` is masked only within the whole host); the
      base64 of each role's Basic pairs, `basicForms` (`user:password`,
      `client-id:client-secret` raw and form-encoded, and `user:REDACTED` and
      `client-id:REDACTED` as `b2c` redacts a header; UTF-8, and Latin-1 when it differs;
      standard and URL-safe alphabets, with and without padding); the percent-encoded and
      JSON-escaped forms of a value; the home folder as `~`. A value shorter than eight
      characters is masked only where it stands alone (a user `admin` leaves `admin-fix` whole),
      and a masked neighbour counts as an edge (`admin.<host>` gives `***.***`). Where two values
      overlap, both are masked whole (a client id that begins the secret leaves none of it). A
      host the file does not hold, or an IP address, is not masked.
    - Error details, the stderr events of `start()` (raw lines without their ANSI escape
      sequences, and the strings and keys of a JSON line, once the line is whole; a line nested
      deeper than `MAX_JSON_DEPTH` arrives as its text with each string masked as the walk
      would, so masking never throws on what `b2c` prints) and the runner's own log lines are
      already masked. `run()` results and stdout chunks are as `b2c` printed them, hosts
      included, because a piece needs the data: whatever a piece shows, logs, stores or sends to
      a panel of them goes through `b2c.mask(text)` first (it reads no file: join the rows and
      mask once; it strips ANSI escape sequences before masking, and the child is started with
      `NO_COLOR=1` and without `FORCE_COLOR` or `CLICOLOR_FORCE`, so `b2c` prints no colour that
      a chunk could cut in two). The masker builds two patterns per change of the known values
      (one for the long values, one for the short ones that must stand alone), finds every match
      of each, overlapping ones included, and masks their union, a run of it as one `***`. Its
      test keeps the per-value masker it replaced and fails if the new one ever masks less on
      thousands of seeded lines. A piece finds its own instance in a list with
      `b2c.isHost(role, value)`, never by holding the host.
    - One workspace uploads, the one picked by hand; it never follows the focused workspace. A
      workspace on another host (`hostId` other than `local`) is never read as a local folder.
      Picking deploys it whole to its own code version with `--activate`, then runs `code watch`
      in it, with the workspace as the working folder and never its path as an argument.
      Releasing leaves the version active. Every change of ownership goes through one queue, so
      there is never more than one watcher; every wait in it is bounded (host calls a few
      seconds, b2c calls their own timeout), release stops the watcher without waiting its turn,
      and after `dispose()` nothing queued starts and nothing is deployed. A version is deleted only on its workspace's
      `workspace.removed` event (once another version is active) or by a person's hand, from a
      whole list and never for a project hidden from the sidebar; a workspace missing from a
      list is never taken as removed. A worker restart restarts the
      watcher without a redeploy, but only for a version whose last full deploy ended; the
      others show that a deploy is needed and are never reloaded.
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

## Panel look

The panel is one column in Orca's sidebar, often under 320 px wide. At the top, a bar of buttons,
one per delivered piece with `hasView` and then *Setup*; it wraps onto a second line when
narrow. Under it, the status line: one chip per environment (`SBX`, `DEV`, `STG`, `PRD`), each a
small ghost button with an icon for its state (check ready, warning incomplete, minus not
configured), its state in the tooltip, opening *Setup*; a `b2c` chip only when `b2c` is missing
(its version is in *Setup*, never here); and, only when something is wrong, a badge saying what
in two or three words with a button to *Setup*. Then the open view: the piece's
`render(locale)`, or *Setup*. A piece not delivered is not shown; one with no view (`isml`) is
only listed in *Setup*. Write a view only with the blocks of `src/panel/ui.tsx` and Orca's own
components; there is no DOM or CSS, and nothing is drawn with text characters (no `●`, `→` as a
control, ASCII boxes).

- **Understood at a glance:** state first, the action beside what it acts on, and no paragraph
  under a group. One line of guidance only in an empty state.
- **Which block:** `Group` for each part of a view, with a short title and an optional action;
  `LabelledRow` for one fact (label left, a text or a `StateBadge` right); `ListRow` for an item
  of a list (a `StateMark`, a name, an optional second line: a muted text, or a `Text` holding a
  `RelativeTime` or a `Code` path; a short note; its own small buttons after the note; with
  `onPress` its name is a link that opens the item); `Actions` for the buttons of a view or
  group; `Empty` when there is nothing, with one line on what brings something; `ShowMore` at
  the end of a long list; `MaskedText` for a masked or normalised text, its placeholders (`#`,
  `<code>`, `<host>`, `***`) drawn as code.
- **Problems, the notice pattern:** `Notice` for a problem the status line does not say: an
  icon by its tone (`NOTICE_ICONS`), a title of a few words (`Upload stopped`), at most one line
  on why, and one button that fixes it or leads to the fix (`Retry`, `Deploy all`, `Open setup`,
  `Dismiss` when nothing can change it). `ErrorState` is a `Notice` for a request that failed,
  worded with `wordError`, with a retry when trying again can help. When the status line already
  says the problem (an environment not set up), a view shows only a `NoticeLine`: one line with a
  mark and at most one small button, usually *Open setup* (`openSetup()` of
  `src/panel/navigation.ts`). The line of either wraps, never cut, and its row wraps so the button
  goes under the line when it does not fit beside it. Every text a view draws is at most
  `NOTICE_MAX_CHARS` (76) characters, two lines at 300 px, in both languages: a test of each piece
  and of core holds them to it. Never a `Callout` with a paragraph, never "see Setup" in prose.
- **Orca's own:** `Button` (`size="sm"` in a bar or header, `xs` on a row; one `solid` for the
  main action, the others `outline`, `ghost` for a quiet one), `IconButton` (always with a
  `label`), `RelativeTime`, `Spinner`, `Progress` and `Skeleton` as they come; `Tree` for a
  hierarchy (scripts by cartridge and folder, variables); `Table` for many rows of the same
  shape (a script's lines: its multiple selection holds the breakpoint lines, so they are
  highlighted, and a check column marks them too; a plain click selects only the row clicked,
  which `toggledLine` turns into setting or removing that one); `Collapsible` for what is
  folded away (workspaces of other projects, seen errors, an adapter's own words).
- **A detail in place of a list:** an item with more than a row can say (an error) opens its
  detail in place of the list, with a back button (`collapse`) at its top and the bar still
  above. Orca gives a components panel no second window, dialog or editor tab to put it in. The
  item open is kept in a persisted atom, so a scenario can open it.
- **Size and paging:** Orca refuses a whole panel past 512 KiB or 5,000 nodes, and every draw
  after it. It counts each node as 32 bytes plus its props as JSON (escapes included, a handler
  as `{"$callback":"<id>"}`), and each text as 8 bytes plus its length and as a node. So:
  - what can grow is capped where it is drawn, never left to the guard:
    - a list draws `PAGE_SIZE` (25) rows, and *Show more* adds a page up to `MAX_ROWS` (100); past
      that, one muted line says how many are not drawn. The breakpoints and the left-behind
      versions are lists too.
    - an open folder of the list of scripts draws `FOLDER_ENTRIES` (50), then an item that draws
      50 more, and the whole tree holds at most `TREE_ITEMS` (600), past which it says to search.
    - a script's lines are a window of `WINDOW_LINES` (200), moved by page, by a line number or by
      a search, never a table that grows.
    - a variable's children are cut at `MAX_CHILDREN` (200), with an item saying how many more,
      and only an open variable sends its children.
  - the shell measures each view's tree by Orca's rule (`treeCost`) and, past `VIEW_BUDGET` (448
    KiB or 4,500 nodes), shows that view's error state instead, so the bar, the status line and
    the other views still draw. A section's optional `reset()` closes what is open in its view,
    kept or not (open folders, pages drawn, windows, open variables), never its data; the error
    state's one button is then *Reset view*, which resets and draws again, so a view is never
    locked by state it keeps across opens.
- **Cost:** a render reads atoms and draws; it never awaits a request. What is computed from a
  long list (a script's rows, the tree of scripts) is a `derived` atom, computed once per change
  (one per language when it holds words); a worker post or answer that changes nothing sets
  nothing.
- **States of a view:** `render` returns null until the piece has its first answer, and the
  panel draws a loading placeholder; with nothing to show, the piece draws `Empty` in its own
  words. A `render` that throws, or a component in its tree that throws, is caught: the view
  shows an error state with *Try again*, the bar and the status line stay, and the next time the
  panel opens it goes to *Setup* instead of that view.
- **Tones** (`StateTone`, drawn with `TONES`): `ok` done or ready (green); `busy` working now
  (accent; a spinner as a mark); `attention` usable but something is missing (amber); `failed`
  broken or refused (red); `off` not set up or not running (grey, a hollow ring). Tone is never
  the only sign: a mark sits beside words that say the same, a badge holds them, a notice leads
  with the icon of its tone, and each status chip has its own icon. Orca's `Button` ignores a
  warning tone, so a state goes in a badge or an icon, not in a button's colour.
- **Spacing:** a view is a `Stack gap="md"` of groups; inside a group rows are `gap="xs"`. No
  `Card` in a view and nothing nested in a card: the panel is already the frame. No `Heading`
  in a view (the bar names it) and no `Separator` between groups.
- **Words:** a label of 24 characters or fewer, a badge of one or two words, a group title of
  three, a notice title of a few words, a note of about 12 characters (`uploading…`, `3×`); long
  names are cut by `truncate`, never by code. Monospace (`Code`) only for code, paths and code
  versions, inside a `Text` so it wraps. Every text in English and Spanish in the piece's
  `i18n.ts`; the Spanish one is often longer, so check it wraps.
- **Never** a host, a path, a credential or a value of `dw.json`, in any block: whatever a view
  shows of `b2c`'s output, or of a script, goes through `b2c.mask(text)` first.
- **Check it** at a narrow width (`orca plugin shot … --width 300`) as well as the default one.
- **Scenarios name their view:** each one opens the view in its `persisted.plugin.view`. A
  piece's scenarios open its own view (*Setup* until it is delivered with a view) and core's open
  *Setup*, unless the scenario persists another (`persisted: { plugin: { view: 'setup' } }`). A
  test mounts every scenario and fails when it draws a view other than the one it names.

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
  `src/panel/checks.ts` (core's `found`, `wrongPath`, `configured`, `missing`, `invalidConfig`,
  `customConfigFile` and `workerTimeout`, plus each piece's, drawn over a ready setup, each on
  the view it names) with the worker on a stand-in host, without loading the plugin, into
  `.orca/shots/`. It needs Orca's window hidden or minimized and fails otherwise: never bring
  the window forward or change what the owner sees; report the error. Open the PNG and say what
  it shows. Spanish needs Orca's own language set to Spanish: scenarios cannot set the locale.
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
