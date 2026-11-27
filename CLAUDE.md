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
      `b2c.ts`, `open-file.ts` and the engine's `checkout/git.ts` are the only modules that start
      a process: `open-file.ts` imports nothing of `b2c.ts` or `dw-config.ts`, starts `orca.exe`
      (or `orca`) directly, never through a shell or a `.cmd`, with the worker's environment plus
      `APPDATA`, `LOCALAPPDATA` and `USERPROFILE`, and opens only a file inside the workspace.
      `git.ts` is held to the same (see the engine below).
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
      stop followed on it: each takes the configuration in force when it is asked, the folder
      whose `dw.json` is read and the id the list gives under it, and every call of its follow
      names that folder (`configRoot` of a call), so moving the focus never loses the sandbox;
      an answer made with another `dw.json` does not count for it), `status-bar.ts` (its two
      items' texts), `worker.ts` (requests, commands, `workspace.removed`; its state gives each
      workspace's branch and whether it is of a project in use, which only chooses what the
      view lists first: the uploading workspace's project; else the focused one's when it has a
      configuration file; else every project with one; else all); `testing.ts` holds the fakes
      its tests share.
    - `src/pieces/errors/`: `reader.ts` parses `logs get`, `signature.ts` (its rules written
      beside the code) and `seen.ts` (over a store it is given) are pure; `digest.ts` holds what
      one read becomes (its arguments, each entry's signature, the masked and normalised samples),
      shared by the worker and the command line; `frames.ts` finds which stack frames are files
      of a local cartridge (such a frame of a row carries its path in the workspace, for a
      breakpoint). **The seen list is not in Orca's storage** (spike S8: it is rewritten whole with
      no lock): it is `seen.json` in the plugin's data folder (`data-folder.ts`: `%APPDATA%`, that
      is `~\AppData\Roaming`, `~/Library/Application Support` or `~/.local/share`, then
      `orca-sfcc-tools`, from the home folder only, since the worker has no `APPDATA`;
      `ORCA_SFCC_TOOLS_DATA` overrides it: `src/core/test-support.ts` sets it to a throwaway
      folder in every test process that loads it, and **under a test runner the real folder is
      refused** (`data_folder_in_test`) unless the override is set, so no test can touch the
      owner's list; a test that does not load test-support sets it or the piece's `dataFolder`),
      `{ version: 1, roles: { <role>: table } }`, shared by every copy of the plugin, written by
      the worker only, under an exclusive lock file and an atomic rename, read by anyone. A lock
      older than 30 s is taken over atomically (under a second `wx` lock, `.lock.break`, checked
      again, renamed to a name of the writer's own, then removed), and what a killed process left
      (old temporary files, moved `.stale` locks, a `.lock.break`) is swept. A file that does not parse is refused, never read as empty or
      overwritten. On its first start the piece copies the `errors.seen.<role>` keys of storage
      into it, once (`seenMoved` in storage), only when the file does not exist, and leaves
      storage alone; every read and write of the seen list waits for that copy, and a write that
      still finds no file starts from those keys, so no mark is lost to it. Marking nothing writes
      nothing. The cursors and the state of each read stay in storage. A read
      stores per signature
      only its counters and a masked, bounded sample (the normalised first line, the logger, the
      pipeline or controller, the level and the top frames; never the site, which names the
      shop), never a raw entry; a notification says how many, never what. The workspace whose cartridges a frame is looked
      for in is chosen by `frameRoot()` in its `worker.ts`. A read passes `--level ERROR` and
      `--level FATAL`, and the parser drops any other level too. No URL host is kept: a URL is
      reduced to its path, its locale segment to `<locale>`, and a host written without a scheme
      to `<host>`, in any letter case (never a file name, a `dw.*` name or a Java package);
      where the text around says it is one, two labels do: inside brackets (in a list there
      too) or quotes, on any country or common ending but one that reads as a property
      (`(item.id)`), and after `domain`, `host`, `hostname`, `server`, `url`, `@` or `//` on
      any known ending, with a port or a path after it; a script expression stays. A read that
      cannot run with the `dw.json` read now (the role is not ready there) answers at once with
      why, keeps the time of the last read and starts nothing. A read is marked as asked in
      storage until it ends, so one a worker restart cut short runs again when the worker
      starts (within ten minutes of being asked; such a read may notify with nobody there, and
      may count again what the cut one recorded before its cursor was written). Every answer
      carries its version (the worker, and a number raised on each change of the role), and the
      view keeps only the newest, since two answers can cross. Numbers become `#`, but
      an HTTP status after `status`, `statusCode` or `HTTP` and an error code after `error code`:
      an order, a gift card, a product or a one-time code is never kept, and a `LETTERS-digits`
      token becomes `<code>`. **The limit of `b2c logs get`:**
      it reads only the last 64 KB of each log file (not a flag) and keeps at most `--count`
      entries (200 here), so a busy log can hold entries no read sees. The piece cannot fix
      that; it detects it (200 entries returned, 48 KB of error entries from one file, or a file
      that `logs list`, run before each read, shows grew by more than 64 KB, whatever the level
      of its lines) and the view says "some entries may have been missed since <time>", never a
      notification.
      The command line has the same limit, and says so per environment (`mayHaveMissed`).
    - **The command line** (`bin/errors.ts`, a shim over `src/pieces/errors/cli.ts`, the report in
      `report.ts`): `node bin/errors.ts --config-file <dw.json> --role <role>… [--json]
      [--since <time>] [--lang en|es]`, for the bot `sfcc` (its prompt is `docs/bot-prompt.md`).
      It builds the plugin's own runner with the file given as its `configFile` setting and the
      default suffixes, so `dw-config.ts` stays the only reader and values reach `b2c` only in
      the child's environment; the path is never printed. It reads `seen.json` and never writes
      it (recording there would count the panel's entries twice); its own cursor is
      `report.json` beside it (`{ version: 1, roles: { <role>: { lastReportAt, reported,
      counted } } }`, locked and atomic too), moved only after a report was printed whole and
      only for a role read. `lastReportAt` is the newest entry's own time (GMT), never the
      machine's clock and never past the run itself (a server stamping in the future cannot push
      it ahead); before any entry it is the first window's start, kept. A report reads from five
      minutes before it (an entry another server flushed late is still read) and skips what
      `counted` (signature and time of every entry at or after that start) says the last report
      already counted. It prints per role what is new since the last report and what is still unmarked:
      short signature, count, first and last time, the masked normalised message, the logger and
      the top frame's file and function (the pipeline without one); never a raw entry, the rest
      of a stack, the site or a host. Exit 0 with a report, 1 when a role, the seen list or the
      last report could not be read, 2 on wrong arguments. It runs under plain Node 22.18 or
      later: **every module it reaches imports with explicit `.ts` extensions** (a test walks
      them; an `import type` needs none, since Node erases it). Orca loads nothing of `bin/`.
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
    - `src/pieces/engine/` (phase 6, still `delivered: false`): the syntax layer and the
      checkout index (below), pure modules with no Node and no Orca imports (a test checks it)
      that the editor will load in its frame too, exported with their types by `index.ts`, the
      contract of 6.3 and 6.4.
      `js/lexer.ts` and `js/parser.ts` read SFCC scripts (ES5 plus what Rhino accepts, `for
      each` and conditional `catch` included) into an ESTree-shaped tree (`js/ast.ts`) with
      `start` and `end` offsets on every node; they never throw, report problems by code
      (`PROBLEM_CODES`, `too_deep` once per parse) and recover at statement boundaries. Their
      recursion is bounded (`MAX_DEPTH`, `MAX_TREE_DEPTH`), but an `else if` chain is not, so a
      tree can be as deep as its input: walk it with `walk` (`js/ast.ts`) or an explicit stack,
      never one recursion per level. CR, CRLF and LF are line breaks alike, positions stay
      offsets of the text as given. JSDoc rides on the next declaration as `doc`. `js/facts.ts`
      (an explicit stack too): scopes (parameters in a `params` scope around the body's, so a
      default sees earlier parameters and outer names only), declarations, the declaration of
      each use, `require` calls and their bindings, exports (`module` and `exports` only when
      unshadowed; `Object.assign` as a value or a statement) and `module.superModule`.
      `isml/parser.ts`: a template into elements, ISML and custom tags, text, `${…}`, comments
      and `<isscript>`, tolerant the same way. A `${…}` may span lines when it balances; an
      unclosed one ends with its first line, and the search for its `}` stops at a line that
      starts with a tag (bounded by `EXPRESSION_LINES`/`EXPRESSION_CHARACTERS`). A quoted value
      may hold ISML tags anywhere, a line start included; it is unclosed only before a line that
      starts with an HTML tag. Searches for a construct's end are remembered per pattern, and
      what is read and thrown away (a failed lenient `${…}` pass in a value, an unclosed value
      cut at its line) is charged to a rescan budget of about twice the text, past which only
      the cheap reading runs: any template parses in linear time (`limits.test.ts` checks every
      shape it knows at two sizes). `isml/embedded.ts` parses its JavaScript in template
      positions, where a template-level name is seen only after it is declared. Fixtures are
      invented and read with LF (`fixtures/read.ts`); `line-endings.test.ts` runs each with LF,
      CRLF and CR, and `limits.test.ts` holds the inputs that once broke a bound or took
      quadratic time. `fixtures/generate.ts` makes the large script and the seeded mutations.
    - `src/pieces/engine/checkout/` (phase 6.3): the checkout index, which 6.4 and 6.5 read.
      `checkout.ts` (`CheckoutIndex`) and the readers it uses (`xml.ts`, `properties.ts`,
      `sites.ts`, `metadata.ts`, `scan.ts`) are pure like the syntax layer (a test checks it):
      they read files only through `CheckoutFiles` (`files.ts`: list a folder, read a file, a
      file's time; paths relative, `/` between parts, never leaving the root) and a git ref only
      through `RefReader`. `memory.ts` is a checkout in memory; `disk.ts` (the real disk, no
      link followed, and the watcher) and `git.ts` are worker only. A cartridge is a folder with
      `.project` and `cartridge/` (`modules` with `.project` is SFRA's module folder); the walk
      skips dot folders and `node_modules`, within `MAX_WALK_DEPTH` and `MAX_FILES`. Server
      scripts are the `.js`/`.ds` under `cartridge/` but `static/` and `client/`; controllers
      are those directly in `controllers/`. Per file it keeps only what `scan.ts` takes (the
      literal `require`s, template and `Resource.msg`/`msgf` uses with their ranges,
      `module.superModule`, a controller's route operations, `extend` and export, what a script
      exports (each member with its place, parameters and JSDoc cut at `MAX_DOC_CHARACTERS`,
      whether it builds on `module.superModule`, the modules it re-exports) and a template's
      `<ismodule>` tags) with the
      file's time: a build reads again only a file whose time changed, `update(paths)` only the
      paths named (a folder is walked again). A change works on its own copies of the files and
      records; at its end it builds a whole new published state (cartridges, paths, bundles,
      metadata) and swaps it in synchronously, so a query during a build or an update answers
      from the last complete index, never a half-built one. After every update the cartridges
      are decided again from the files as they are then, whatever batch each event came in; when
      they changed, every file is classified again. A cartridge's change, a site archive or a
      setting rebuilds the paths. The cartridge path, per storefront: the `cartridgePath`
      setting (one path, storefront `setting`); else each `sites/<site>/site.xml`
      `<custom-cartridges>` of the checkout; else the same at the `metadataRef` ref; each
      storefront says its `source`. Metadata (custom attributes per object type, site
      preferences as `SitePreferences`', custom object types) is merged from `meta/*.xml` of the
      checkout and of the ref, per type and attribute: the checkout's definition wins where both
      have one, and each attribute says its `source`. Resolution: `*/` the first cartridge of
      each storefront's path that has it (with every copy as a candidate), `~/` the file's
      cartridge, relative, `<cartridge>/…` (and `/<cartridge>/…`), a bare name in `modules`, else
      a cartridge's name to the `main` of its `package.json`; `dw/…` a class or a package of the
      `dw.*` index; `module.superModule` the next cartridge after the file's own on each path.
      Templates and bundles go locale (`fr_FR`, `fr`, `default`) first, then cartridge; a bundle
      `x_fr` or `x_fr_FR` is a locale of `x`, `x_tile` is a bundle of its own. A route chain
      applies the deepest base first (`extend(module.superModule)` or a required controller): a
      `get`/`post`/`use` declares, `prepend` runs before and `append` after in the order applied,
      `replace` drops the chain. A controller with no `require('server')` (written before SFRA)
      declares a route by exporting it (`exports.Show = guard.ensure([…], show)`, a function, a
      name of one, `module.exports = { Show: … }`): method `export`, its `handler` the function. A
      call is a route only when it wraps a function (`guard.ensure([…], show)`), never a value
      (`exports.Total = compute()`); a plain exported function is one whether or not it sets
      `.public`. What SFRA refuses when the controller loads is a problem and not applied:
      `route_redefined` (a declaration of a name that exists) and `route_missing` (an `append`,
      `prepend` or `replace` of one that does not); `base_missing` and `not_exported`
      too, all for 6.5. `git.ts` runs only `rev-parse --verify --quiet <ref>^{commit}`, `ls-tree
      --full-tree -r --name-only <ref> -- <path>` (from the repository's root, as `show` takes
      paths, whatever folder of it the workspace is) and `show <ref>:<path>` (null for a file the
      commit lacks, told from a failure by `ls-tree` of that path), at the commit (never the
      moving ref), each refused before git starts unless the ref matches `REF_PATTERN` (no
      leading `-`, `..` or `@{`) and the path is relative with no leading `-` or `..`; `git.exe`
      only, no shell, in the workspace, with `GIT_OPTIONAL_LOCKS=0` and `GIT_NO_LAZY_FETCH=1`, a
      timeout and an output cap; stderr is never kept, a failure is a code (`GitFailure`). It
      writes nothing. The worker (`worker.ts`) indexes the uploading workspace, else the
      focused one, when local; `engine.index.status` answers at once and starts a build on its
      own when the target changed. A watcher's changes are debounced: taken in once no change
      came for `DEBOUNCE_MS`, at the latest `MAX_WAIT_MS` after the first. A change of
      `.git/HEAD`, `packed-refs` or `refs/`, and a timer every `REF_CHECK_MS` (a worktree's refs
      are outside the folder watched), ask whether the ref moved (`refreshRef`: one `rev-parse`,
      read again only when it did). Only a successful read of the ref replaces what it gave: a
      failed check keeps the last good paths and metadata of the same ref, with `gitError` saying
      why. `checkout/testing.ts` reads the invented checkout of `fixtures/checkout/` (two
      storefronts, three cartridges and `modules`, a modules template with a custom tag, a core
      helper that extends its base through `module.superModule`) and generates large ones.
    - `src/pieces/engine/query/` (phase 6.4): the queries, pure like the rest (a test checks
      it), on the two indexes (`QueryContext`), a file's text and an offset, answering in
      positions of that text. `analysis.ts` reads a text once for every query on it (the tree or
      the template's fragments, the facts, each use by offset, the values assigned to each
      declaration, each parameter's JSDoc). `types.ts`: the type of an expression (`QType`): a
      `dw.*` instance or class, a package, a method before its call, a cartridge module or one of
      its members, `x.custom` of a metadata type, or `project` (what project code builds, never
      guessed). From the initialiser (`new`, `require('dw/…')`, a method's return type, chosen
      among overloads by the number of arguments, `CustomObjectMgr.getCustomObject('T', …)`),
      then `@type`/`@param`, the globals (`request`, `session`, `customer`, `response`, global
      functions; `pdict` unknown; `Resource`, `URLUtils`, `StringUtils` in a template only), and
      the previous call in a chain; a module function's `@returns` when every copy agrees. One
      variable, one type, over the whole binding (every declaration of a name in one function,
      its parameter included: `analysis.bindings`): two types, an unknown value, a JSDoc tag that
      disagrees, any write but a plain `=`, or a name inside a pattern, make it unknown. A
      parameter is typed by its `@param` only (the caller passes anything); a name inside `with`
      is unknown. The committed index marks no
      property static, so a property is static when its getter is (`Site.current`). Statics are
      read off the class (`Object`'s own aside), the rest off an instance. `modules.ts`: the
      copies a `require` reaches and the members each exports, its re-exports and
      `module.superModule` followed (`MAX_MODULE_DEPTH`), and a member exported as another
      module's (`tax: base.tax`, `alias` in `scan.ts`; never through a name written again) read
      as that one when every copy it may reach agrees, else as the export line. A `*/` read
      resolves only for the storefronts whose path holds the reading file's cartridge
      (`storefrontsOf`); a file on no path gets every copy the paths reach, unlabelled (it may be
      loaded by name from any of them, so a storefront would be a guess). `complete.ts` decides
      where the offset is, then offers at most `MAX_COMPLETION_ITEMS` filtered by what is typed: ISML tags (custom
      ones of the template and of what it includes, one level) and their attributes
      (`isml-tags.ts`), template paths, `dw.*` members, custom attributes and site preferences,
      a module's members, resource keys and bundles, `require` paths, route ids; each item has a
      kind, a detail and an id `hoverItem` expands. A type is guessed from a name only for
      `name.custom.` with nothing else known, from `GUESSED_NAMES` (said `guessed`), and only
      for a name whose values are all read from elsewhere (`guessable`). With no storefront path,
      routes are those every cartridge's controllers declare, labelled with their cartridge
      (`routes.ts`). `hover.ts`
      answers data, not words (the editor words it from `i18n.ts`): a `dw.*` member or class with
      `describe`, a module and its copy per storefront, a member and where each copy defines it,
      `module.superModule`, a route (its steps in the order they run and the one that serves),
      a template, a resource key, a custom attribute, a tag; lists cut at `MAX_HOVER_ENTRIES`.
      `definition.ts`: where the thing at the offset is defined, one `Target` per place with the
      storefronts it serves (`null` when none can be named: the place does not depend on one,
      or the reading file is on no storefront path; never "every storefront"): a template's copy per
      storefront, a `require`'s file, a key's line in the bundle each storefront reads, a module
      member's declaration in each copy (along `module.superModule` too), the declaration that
      serves a route, a custom attribute's metadata (only from the checkout, not the ref), a
      custom tag's template, a name's declaration in the file; with no storefront path, every
      copy (for a route, every cartridge's declaration of it). `references.ts`: the references
      of a function a script exports, asked on the export, on the function it names, or on a
      read of it: every member read the index keeps per file (`MemberUse` of `scan.ts`: through
      a name bound to a `require`, `require(…).x`, a pattern's names, `module.superModule`; never
      a member assigned to) whose `require` reaches a file that defines it, labelled with the
      storefronts that reach it, the file asked on read from its text; at most
      `MAX_REFERENCES`. `signature.ts`: inside a call's parentheses (not inside a function written
      as an argument), the `dw.*` method's overloads (the one that fits the arguments chosen), a
      `dw.*` constructor, a module function per copy, a model's constructor, or a function of the
      file, with the active parameter.
      The worker answers `engine.complete`, `engine.hover`, `engine.definition`,
      `engine.references` and `engine.signature` (`{ workspaceId, path, text, offset }`, the path
      checked by `checkQuery`) with the index of the workspace indexed, else an empty one
      (`index: 'none'`), keeps `KEPT_ANALYSES` texts read, and waits up to `DESCRIBE_WAIT_MS` for
      a description read through `dw/describe.ts`. `query/performance.test.ts` times each on a
      5,000-line script and template.
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
    - A call of `run()`, `start()`, `instances()` or `isHost()` may name the folder whose
      `dw.json` it reads (`configRoot`); left out, it is the one `configRoot()` names at that
      moment. Only an operation followed over several calls names it (a sandbox start or stop,
      a deletion), so a focus change in between does not give it another file. Only the folder
      of a local workspace Orca lists (`knownRoots`), or the main checkout of one, may be named;
      any other is refused with `config_root_refused` before anything is read.
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
      list is never taken as removed. A delete that fails is checked in `code list`: Salesforce
      can answer a timeout and go on deleting, renaming the version `.deleted_<n>_<name>`, so a
      version gone or renamed counts as deleted and one still there waits for the next
      activation; a `.deleted_…` version is never shown as a workspace's or deleted again.
      A version is deleted only with the `dw.json` of its own workspace: the folder that file
      was read from when the workspace was picked (its root, or its main checkout's,
      `b2c.configFolder()`), kept with its version and named in every call of its deletion.
      When there is none, or it no longer holds a ready sandbox role (a removed worktree whose
      file went with it), nothing is deleted: the version stays queued and the view lists it as
      not deletable, for a person to forget. Never the focused workspace's file, which may name
      another sandbox holding a version of the same name. A
      worker restart restarts the
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
- **Loading the plugin for a live check:** never from the repository's checkout. Orca watches
  the whole development folder, `.claude/worktrees/` included, so a plugin loaded from the
  checkout reloads, and its worker restarts (dropping a debugger session, cutting a log read
  short and restarting `code watch`), every time an agent saves a file in any worktree. Load
  it from a clean copy of the branch outside the repository instead:
    1. `git archive <ref> | tar -x -C <dir>`, with `<dir>` a new, empty folder outside the
       repository (no `.claude/`, no worktrees, no `.git`);
    2. `npm install` in `<dir>`;
    3. `orca plugin dev unload` the copy loaded before, if any, then the owner loads `<dir>`
       (`orca plugin dev load <dir>`). It is a folder Orca has not seen, so it needs the owner's
       approval once; never pass `--approve`.
  For the next round, extract the new ref into the same `<dir>` (empty it first, keep
  `node_modules` or run `npm install` again): Orca reloads it once.
- `orca plugin inspect .` is refused in a checkout whose worktrees push the folder over its
  size limit; run it on such a clean copy (`orca plugin inspect <dir> --json`).

## Regenerating the `dw.*` index

`data/dw-api.json` is the committed `dw.*` index: classes, inheritance, constants with their
values, properties, constructors and methods with parameters and types, deprecation, and a link
per page and member. **No description of any kind**: Salesforce's terms grant no right to copy
the text, only to link to it. Descriptions are read at run time by
`src/pieces/engine/dw/describe.ts` through `b2c docs read`, kept in memory, never stored.
`src/pieces/engine/dw/index.ts` loads the file and answers the queries (pure: no Node, no Orca).

- `npm run dw-index` regenerates it, on the owner's machine only (the documentation's CDN blocks
  hosted runners after about a hundred requests). It runs `b2c docs search --list` and one
  `b2c docs read <class>` per class (about 500, four at a time, a quarter of an hour) through
  `src/core/b2c.ts` with no role: `docs` needs no instance and no credentials. Every `docs`
  command carries `--workspace all`, or `b2c` walks its working folder first (minutes in a home
  folder).
- `scripts/dw-pages.ts` parses each page's Markdown and fails, naming the class and the section,
  on any shape it does not know; `scripts/generate-dw-index.ts` then writes nothing. A failed
  read (a 403 from the CDN) stops the run. Fix the parser for the new shape, with a fixture in
  `src/pieces/engine/fixtures/dw/` that shows it, rather than loosening a check.
- The file is written whole, sorted, one member per line, so a regeneration's diff shows what
  the documentation changed. A test fails when the committed file is not in that form, and
  another when it holds anything but names, types, keys and constant values.
- Node runs the script with `--import ./scripts/resolve-ts.ts`, which lets it import the
  plugin's extensionless modules.
- `.github/workflows/check-script-api-version.yml` (once the owner approves it) reads the
  version of the public index weekly and opens an issue "Regenerate the dw.* index: <old> →
  <new>" when it differs from the file's `version`. It regenerates nothing.

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
