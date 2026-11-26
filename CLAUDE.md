# SFCC Tools for Orca

Orca plugin for working on a Salesforce Commerce Cloud (SFCC) project: ISML colors, cartridge
upload, sandbox status and the new errors of its log. One plugin holds everything.

`README.md` is the cover for visitors, laid out like every moilolon repo: *What this is*, *How
it works*, *Getting started* and the shared footer, with no folder tree, long code or roadmap.
The details below are for Claude.

## Structure

- The repo holds only the base (`package.json`, `assets/`). The plugin follows the shape of
  `C:/Developer/PERSONAL/orca-obsidian-notes`: `orca-plugin.json`, `src/protocol.ts` (the
  contract between panel and worker), `src/panel/` and `src/worker/`, with each module's tests
  beside it.
- **Rules of the plugin:**
    - Upload, logs and the sandbox go through the official `b2c` CLI. Everything else is written
      here: no binaries and no code from other tool repositories.
    - The plugin never reads `dw.json` or any credential: `b2c` resolves them.
    - One workspace uploads, the one picked by hand; it never follows the focused workspace.
    - **Public repo:** nothing of a project it is used on. No hosts, sandbox names, credentials
      or customer data, in code, tests, fixtures or commit messages.
- The plugin guide of the installed Orca: `orca skills get orca-plugin-authoring`.
- `assets/draw-images.ps1` (`powershell -NoProfile -File assets/draw-images.ps1`) draws, from
  shapes, the README cover (`cover.png`), the icon (`icon.png`, also the project's icon in Orca)
  and the GitHub social preview (`social-preview.png`, uploaded by hand in Settings). The base is
  shared by every repo (the one in `moilolon/workbench`); only the repo's own part changes here.
  It is saved as UTF-8 with BOM, or PowerShell 5.1 breaks the accents; redraw it when what it
  shows changes.

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
