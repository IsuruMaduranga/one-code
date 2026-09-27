/**
 * An artifact's viewer page, `<id>/view.html` (pure, no fs): the stored page in
 * a frame under a slim bar, One Code's version of the header Claude Code's web
 * viewer puts over an artifact. The bar keeps what works without a server: a
 * home link to the gallery, a title menu (details, Download HTML, Copy file
 * path, Reload, the page without the bar, the version list, All artifacts) and
 * a Download button. Share, Chat, Rename, Duplicate and Pin need claude.ai and
 * are left out.
 *
 * `view.html#v<N>` shows an earlier version with a banner back to the latest.
 * Download loads the version's payload script (`download.js`, or
 * `versions/v<N>.js`) and saves it through a `blob:` link, for the same reason
 * the gallery does (gallery.ts).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { tildify } from "../lib/paths.ts";
import { CLIENT_RUNTIME, escapeHtml, THEME_TOKENS, utcStamp } from "./gallery.ts";
import type { ArtifactMeta } from "./store.ts";

/** Inline SVG icons; `currentColor` so they follow the theme. */
const HOME_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.5 8 3l5.5 4.5V13a.5.5 0 0 1-.5.5H9.5V10h-3v3.5H3a.5.5 0 0 1-.5-.5z"/></svg>`;
const CHEVRON_ICON = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg>`;
const DOWNLOAD_ICON = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 2v7m-3-3 3 3 3-3M2.5 11.5h9"/></svg>`;

/** `<id>/view.html` for `meta`, whose folder is `dir`. */
export function renderViewer(meta: ArtifactMeta, dir: string, home: string = homedir()): string {
	const title = escapeHtml(meta.title);
	const versions: string[] = [`<a role="menuitem" href="#" data-version="latest">Version ${meta.version} (latest)</a>`];
	for (let n = meta.version - 1; n >= 1; n--) versions.push(`<a role="menuitem" href="#v${n}" data-version="${n}">Version ${n}</a>`);
	const details = [
		`Version ${meta.version}`,
		`Updated <time datetime="${escapeHtml(meta.updatedAt)}">${escapeHtml(utcStamp(meta.updatedAt))}</time>`,
		meta.project ? escapeHtml(tildify(meta.project, home)) : "",
	].filter(Boolean);
	// The page paths the script copies, for the current version and each earlier one.
	const paths = JSON.stringify({ latest: join(dir, "index.html"), versions: join(dir, "versions") }).replace(/</g, "\\u003c");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${THEME_TOKENS}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg); color: var(--text);
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  display: flex; flex-direction: column;
}
.bar {
  display: flex; align-items: center; gap: 6px; padding: 6px 16px; min-height: 44px;
  background: var(--surface); border-bottom: 1px solid var(--line); position: relative; z-index: 2;
}
.icon-link, .title-button, .primary, .menu [role="menuitem"] {
  font: inherit; color: var(--text); background: transparent; border: 0; border-radius: 6px; cursor: pointer; text-decoration: none;
}
.icon-link { display: inline-flex; padding: 6px; color: var(--muted); }
.icon-link:hover, .title-button:hover, .title-button[aria-expanded="true"] { background: var(--hover); color: var(--text); }
.title-button { display: inline-flex; align-items: center; gap: 6px; padding: 5px 8px; max-width: min(60vw, 480px); }
.title-button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spacer { flex: 1; }
.primary {
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; font-weight: 600; font-size: 13px;
  border: 1px solid var(--line);
}
.primary:hover { background: var(--hover); }
.menu {
  position: absolute; top: calc(100% - 2px); left: 44px; min-width: 250px; max-width: calc(100vw - 32px);
  background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 6px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.18); display: flex; flex-direction: column;
}
.menu[hidden] { display: none; }
.menu .details { padding: 6px 10px 8px; color: var(--muted); font-size: 13px; display: flex; flex-direction: column; gap: 2px; font-variant-numeric: tabular-nums; }
.menu .details span:last-child { overflow-wrap: anywhere; }
.menu [role="menuitem"] { display: block; text-align: left; padding: 7px 10px; }
.menu [role="menuitem"]:hover, .menu [role="menuitem"]:focus-visible { background: var(--hover); outline: none; }
.menu [aria-current="true"] { font-weight: 600; }
.menu .label { padding: 8px 10px 2px; color: var(--muted); font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; }
.menu hr { border: 0; border-top: 1px solid var(--line); margin: 6px 4px; }
.versions { max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; }
.banner { padding: 8px 16px; background: var(--hover); border-bottom: 1px solid var(--line); font-size: 13px; }
.banner[hidden] { display: none; }
.banner a { color: var(--accent); }
.toast {
  position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 3;
  background: var(--text); color: var(--bg); padding: 8px 14px; border-radius: 6px; font-size: 13px;
}
.toast[hidden] { display: none; }
iframe { flex: 1; width: 100%; border: 0; display: block; background: var(--bg); }
a:focus-visible, button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
</style>
</head>
<body>
<header class="bar">
  <a class="icon-link" href="../index.html" title="All artifacts" aria-label="All artifacts">${HOME_ICON}</a>
  <button type="button" class="title-button" id="title-button" aria-haspopup="menu" aria-expanded="false" aria-controls="menu"><span>${title}</span>${CHEVRON_ICON}</button>
  <div class="menu" id="menu" role="menu" hidden>
    <div class="details">${details.map((line) => `<span>${line}</span>`).join("")}</div>
    <hr>
    <button type="button" role="menuitem" data-action="download">Download HTML</button>
    <button type="button" role="menuitem" data-action="copy-path">Copy file path</button>
    <button type="button" role="menuitem" data-action="reload">Reload</button>
    <a role="menuitem" id="raw-link" href="index.html">Open without this bar</a>
    ${meta.version > 1 ? `<hr><div class="label">Versions</div><div class="versions">${versions.join("")}</div>` : ""}
    <hr>
    <a role="menuitem" href="../index.html">All artifacts</a>
  </div>
  <span class="spacer"></span>
  <button type="button" class="primary" data-action="download">${DOWNLOAD_ICON}Download</button>
</header>
<div class="banner" id="banner" hidden>You are viewing version <span id="banner-version"></span> of ${meta.version}. <a href="#">Show the latest</a></div>
<iframe id="page" src="index.html" title="${title}"></iframe>
<div class="toast" id="toast" role="status" hidden></div>
<script>
(function () {
  var LATEST = ${meta.version};
  var PATHS = ${paths};
  var SEP = PATHS.latest.indexOf("\\\\") !== -1 ? "\\\\" : "/";
  var frame = document.getElementById("page");
  var menu = document.getElementById("menu");
  var button = document.getElementById("title-button");
  var banner = document.getElementById("banner");
  var toast = document.getElementById("toast");
  var shown = null;

  function current() {
    var match = /^#v(\\d+)$/.exec(location.hash);
    var n = match ? parseInt(match[1], 10) : NaN;
    return n >= 1 && n < LATEST ? n : null;
  }
  function show() {
    shown = current();
    var src = shown ? "versions/v" + shown + ".html" : "index.html";
    if (frame.getAttribute("src") !== src) frame.setAttribute("src", src);
    document.getElementById("raw-link").setAttribute("href", src);
    banner.hidden = !shown;
    if (shown) document.getElementById("banner-version").textContent = shown;
    menu.querySelectorAll("[data-version]").forEach(function (link) {
      var v = link.getAttribute("data-version");
      link.setAttribute("aria-current", String(v === "latest" ? !shown : Number(v) === shown));
    });
  }
  function note(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(note.timer);
    note.timer = setTimeout(function () { toast.hidden = true; }, 1800);
  }
  function setMenu(open) {
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  }
${CLIENT_RUNTIME}
  function download() {
    var script = document.createElement("script");
    script.src = shown ? "versions/v" + shown + ".js" : "download.js";
    script.onload = function () { script.remove(); };
    script.onerror = function () { script.remove(); note("Download failed. Use Open without this bar, then save the page."); };
    document.head.appendChild(script);
  }
  function copyPath() {
    var path = shown ? PATHS.versions + SEP + "v" + shown + ".html" : PATHS.latest;
    var done = function () { note("Copied " + path); };
    var fallback = function () { window.prompt("File path", path); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(path).then(done, fallback);
    else fallback();
  }

  button.addEventListener("click", function () { setMenu(menu.hidden); });
  document.addEventListener("click", function (event) {
    var action = event.target.closest && event.target.closest("[data-action]");
    if (action) {
      var name = action.getAttribute("data-action");
      if (name === "download") download();
      else if (name === "copy-path") copyPath();
      else if (name === "reload") location.reload();
      setMenu(false);
      return;
    }
    if (event.target.closest && event.target.closest("[data-version], #raw-link")) { setMenu(false); return; }
    if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) setMenu(false);
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !menu.hidden) { setMenu(false); button.focus(); }
  });
  // A click in the frame never reaches this document; losing focus to it closes the menu.
  window.addEventListener("blur", function () { setMenu(false); });
  window.addEventListener("hashchange", show);
  show();
})();
</script>
</body>
</html>
`;
}
