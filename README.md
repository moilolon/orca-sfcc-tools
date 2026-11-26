<div align="center">

# <img src="assets/icon.png" alt="" width="40" align="absmiddle"> SFCC Tools for Orca

**Orca plugin for Salesforce Commerce Cloud work: ISML syntax, cartridge upload and sandbox errors.**

[![Orca plugin](https://img.shields.io/badge/Orca-plugin-D9466B?style=for-the-badge)](https://github.com/stablyai/orca)
[![No build](https://img.shields.io/badge/TypeScript-no%20build-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](#-how-it-works)
[![Salesforce Commerce Cloud](https://img.shields.io/badge/Salesforce-Commerce%20Cloud-00A1E0?style=for-the-badge)](https://developer.salesforce.com/docs/commerce/b2c-commerce/overview)

<img src="assets/cover.png" alt="The plugin name beside a panel with the sandbox status, the upload of each cartridge, the new errors of the log and a line of ISML" width="820">

</div>

---

## ✨ What this is

What it takes to work on a Salesforce Commerce Cloud project from
[Orca](https://github.com/stablyai/orca), in one plugin. The repository has just started:
today it holds only the base, and the pieces in the table are added one at a time.

| | Piece | What it does |
|---|---|---|
| 🧩 | **ISML** | `.isml` templates in Orca's editor |
| ⬆️ | **Upload** | Uploads the cartridges to the sandbox on save, from one workspace at a time |
| 🚦 | **Sandbox** | Its status and the active code version, in the status bar |
| 🪵 | **Errors** | The new errors of the sandbox log, apart from the ones already seen |

---

## 🧭 How it works

- **On the official CLI.** Upload, logs and the sandbox go through `b2c`, Salesforce's CLI.
  It is the only thing the plugin needs installed: it ships no binaries of its own.
- **One workspace uploads.** With several worktrees and one sandbox, the workspace that
  uploads is picked by hand; switching tabs never changes what the sandbox runs.
- **No build.** Orca loads the `.ts` and `.tsx` files as written; `node_modules` only holds
  the development typings.

---

## 🔐 What is public

This repo is **public** and holds only the plugin: nothing of any project it is used on.
No hosts, sandbox names, credentials or customer data are written here. The plugin never
reads credentials either: the `b2c` CLI resolves them from the workspace's own `dw.json`.

---

## 🚀 Getting started

```bash
npm install
npm test
```

---

<div align="center">
<sub><a href="https://moilolon.com">moilolon.com</a> · <a href="https://github.com/moilolon">@moilolon</a></sub>
</div>
