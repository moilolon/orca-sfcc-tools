// The editor frame's stylesheet. Chrome comes from Orca's theme variables (`--orca-*`, updated in
// place on a theme change, with `light` or `dark` on <html>); the syntax colours are the editor's
// own, one set per scheme; the font, size, weight and line height come from Orca's editor
// typography (`--ed-*`, set by the view).

export const STYLES = `
:root {
  --t-comment: #6a737d; --t-string: #0a3069; --t-keyword: #cf222e; --t-literal: #0550ae;
  --t-number: #0550ae; --t-punct: #57606a; --t-regex: #116329; --t-tag: #116329; --t-istag: #8250df;
  --t-attr: #0550ae; --t-expr: #cf222e; --t-key: #953800; --t-escape: #0550ae; --t-meta: #6e7781;
  --ed-mark-breakpoint: #d1242f; --ed-stopped: #bf8700;
  --ed-error: #d1242f; --ed-warning: #bf8700; --ed-info: #0969da;
}
html.dark {
  --t-comment: #8b949e; --t-string: #a5d6ff; --t-keyword: #ff7b72; --t-literal: #79c0ff;
  --t-number: #79c0ff; --t-punct: #8b949e; --t-regex: #7ee787; --t-tag: #7ee787; --t-istag: #d2a8ff;
  --t-attr: #79c0ff; --t-expr: #ff7b72; --t-key: #ffa657; --t-escape: #79c0ff; --t-meta: #8b949e;
  --ed-mark-breakpoint: #f85149; --ed-stopped: #d29922;
  --ed-error: #f85149; --ed-warning: #d29922; --ed-info: #58a6ff;
}
html, body { margin: 0; height: 100%; overflow: hidden; background: var(--orca-background, #fff); color: var(--orca-foreground, #1f2328); }
#app { position: absolute; inset: 0; display: flex; flex-direction: column; }
#surface { position: relative; flex: 1; min-height: 0; }

.ed-notice { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; padding: 4px 10px; font: 12px/1.4 var(--orca-font-sans, system-ui, sans-serif); color: var(--orca-muted-foreground, #59636e); background: var(--orca-muted, #f6f8fa); border-bottom: 1px solid var(--orca-border, #d1d9e0); }
.ed-notice[hidden] { display: none; }
.ed-notice .ed-notice-text { flex: 1 1 220px; min-width: 0; }
.ed-notice .ed-notice-icon { flex: none; width: 14px; height: 14px; }
.ed-notice select, .ed-notice button { font: inherit; color: var(--orca-foreground, #1f2328); background: var(--orca-background, #fff); border: 1px solid var(--orca-input, #d1d9e0); border-radius: calc(var(--orca-radius, 6px) - 2px); padding: 1px 6px; }
.ed-notice select { max-width: 100%; min-width: 0; flex: 1 1 200px; font-family: var(--orca-font-mono, ui-monospace, monospace); }
.ed-notice button { cursor: pointer; }
.ed-notice button:hover { background: var(--orca-accent, #eef1f4); color: var(--orca-accent-foreground, #1f2328); }
.ed-notice button:focus-visible, .ed-notice select:focus-visible { outline: 2px solid var(--orca-ring, #0969da); outline-offset: 1px; }

.ed { --ed-font: var(--orca-font-mono, ui-monospace, monospace); --ed-size: 13px; --ed-line: 20px; --ed-weight: normal; --ed-ligatures: normal;
  font-family: var(--ed-font); font-size: var(--ed-size); font-weight: var(--ed-weight); line-height: var(--ed-line); font-variant-ligatures: var(--ed-ligatures); }
.ed-scroller { position: absolute; inset: 0; overflow: auto; }
.ed-inner { position: relative; min-width: 100%; }
.ed-gutter { position: sticky; left: 0; top: 0; width: var(--ed-gutter); height: 100%; z-index: 3; background: var(--orca-background, #fff); color: var(--orca-muted-foreground, #8c959f); user-select: none; cursor: default; }
.ed-gutter-lines { position: absolute; left: 0; right: 0; top: 0; will-change: transform; }
.ed-gutter-line { position: relative; height: var(--ed-line); padding-right: 12px; text-align: right; font-size: 0.92em; }
.ed-gutter-line.ed-current { color: var(--orca-foreground, #1f2328); }
.ed-mark { position: absolute; left: 4px; top: 50%; width: 10px; height: 10px; margin-top: -5px; border-radius: 50%; box-sizing: border-box; }
.ed-gutter-marks .ed-mark { cursor: pointer; }
.ed-gutter-marks .ed-gutter-line:hover .ed-mark:not(.ed-mark-bp):not(.ed-mark-bp-unverified):not(.ed-mark-bp-idle):not(.ed-mark-bp-pending) { border: 1.5px solid var(--ed-mark-breakpoint); opacity: 0.35; }
/* A breakpoint: a disc when the session verified it, a ring when it did not, a ring with a dot with no session, a dashed ring until the file is saved. */
.ed-mark-bp { background: var(--ed-mark-breakpoint); }
.ed-mark-bp-unverified { border: 1.5px solid var(--ed-mark-breakpoint); }
.ed-mark-bp-idle { border: 1.5px solid var(--ed-mark-breakpoint); background: radial-gradient(circle, var(--ed-mark-breakpoint) 0 1.8px, transparent 2.3px); }
.ed-mark-bp-pending { border: 1.5px dashed var(--ed-mark-breakpoint); }
/* Where a thread is halted: a solid arrow on the line it stopped at, a chevron on a caller's. */
.ed-mark-stopped::after { content: ''; position: absolute; left: 1px; top: -1px; width: 0; height: 0; border-left: 9px solid var(--ed-stopped); border-top: 6px solid transparent; border-bottom: 6px solid transparent; }
.ed-mark-caller::after { content: ''; position: absolute; left: 0; top: 2px; width: 5px; height: 5px; border-top: 2px solid var(--ed-stopped); border-right: 2px solid var(--ed-stopped); transform: rotate(45deg); }
.ed-highlight { position: absolute; left: 0; right: 0; top: 0; height: 0; pointer-events: none; }
.ed-highlight-line { position: absolute; left: -6px; right: 0; top: 0; height: var(--ed-line); background: color-mix(in srgb, var(--ed-stopped) 24%, transparent); box-shadow: inset 2px 0 0 var(--ed-stopped); }
.ed-highlight-caller { background: color-mix(in srgb, var(--ed-stopped) 11%, transparent); }
.ed-highlight-label { position: absolute; top: 0; padding: 0 6px; white-space: nowrap; font: 11px/var(--ed-line) var(--orca-font-sans, system-ui, sans-serif); color: var(--orca-muted-foreground, #59636e); }
.ed-text { position: absolute; top: 0; bottom: 0; left: calc(var(--ed-gutter) + 6px); right: 0; cursor: text; white-space: pre; tab-size: 4; }
.ed-lines { position: absolute; left: 0; top: 0; will-change: transform; }
.ed-line { height: var(--ed-line); }
.ed-selection > div { position: absolute; left: 0; top: 0; height: var(--ed-line); background: color-mix(in srgb, var(--orca-primary, #0969da) 22%, transparent); }
.ed-focused .ed-selection > div { background: color-mix(in srgb, var(--orca-primary, #0969da) 30%, transparent); }
.ed-underlines > div { position: absolute; left: 0; top: 0; height: var(--ed-line); pointer-events: none; background-repeat: repeat-x; background-position: left bottom; background-size: 6px 3px; }
.ed-underline.ed-error { background-image: linear-gradient(135deg, transparent 33%, var(--ed-error) 33% 66%, transparent 66%); }
.ed-underline.ed-warning { background-image: linear-gradient(135deg, transparent 33%, var(--ed-warning) 33% 66%, transparent 66%); }
.ed-underline.ed-info { background-image: linear-gradient(135deg, transparent 33%, var(--ed-info) 33% 66%, transparent 66%); }
.ed-composition > div { position: absolute; left: 0; top: 0; height: var(--ed-line); border-bottom: 1px solid currentColor; box-sizing: border-box; pointer-events: none; }
.ed-caret { position: absolute; left: 0; top: 0; width: 2px; height: var(--ed-line); background: var(--orca-foreground, #1f2328); opacity: 0; pointer-events: none; }
.ed-focused .ed-caret { opacity: 1; }
.ed-focused .ed-caret.ed-blink { animation: ed-blink 1.06s steps(1) 0.5s infinite; }
@keyframes ed-blink { 50% { opacity: 0; } }
.ed-input { position: absolute; left: 0; top: 0; width: 1px; height: var(--ed-line); padding: 0; border: 0; margin: 0; outline: none; resize: none; overflow: hidden; opacity: 0; font: inherit; white-space: pre; z-index: -1; }
.ed-probe { position: absolute; visibility: hidden; white-space: pre; }
.ed-popups { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 10; font-family: var(--orca-font-sans, system-ui, sans-serif); }
.t-comment { color: var(--t-comment); font-style: italic; } .t-string { color: var(--t-string); } .t-keyword { color: var(--t-keyword); }
.t-literal { color: var(--t-literal); } .t-number { color: var(--t-number); } .t-punct { color: var(--t-punct); } .t-regex { color: var(--t-regex); }
.t-tag { color: var(--t-tag); } .t-istag { color: var(--t-istag); font-weight: 600; } .t-attr { color: var(--t-attr); } .t-expr { color: var(--t-expr); }
.t-key { color: var(--t-key); } .t-escape { color: var(--t-escape); } .t-meta { color: var(--t-meta); }
`
