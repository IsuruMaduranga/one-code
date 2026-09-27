/**
 * The artifact gallery page, `~/.onecode/artifacts/index.html` (pure, no fs).
 * It lists every artifact with links to open it and each earlier version, and
 * a Download button.
 *
 * Download goes through a script payload rather than `<a download>` on the page
 * file: a browser ignores the `download` attribute on a cross-origin link, and
 * Firefox treats every `file:` URL as its own origin. A classic `<script src>`
 * loads across `file:` URLs in every browser, so the button loads
 * `<id>/download.js`, which hands the page's HTML back to the gallery; the
 * gallery saves it through a same-origin `blob:` link, where `download` always
 * works. When the script cannot load, the button falls back to opening the page.
 */

import { homedir } from "node:os";
import { tildify } from "../lib/paths.ts";
import type { ArtifactMeta } from "./store.ts";

/** The light and dark palettes, as tokens; shared with the viewer (viewer.ts). */
export const THEME_TOKENS = `:root {
  color-scheme: light;
  --bg: #f5f6f8;
  --surface: #ffffff;
  --text: #1b2230;
  --muted: #5b6577;
  --line: #dde1e8;
  --accent: #2a4fb8;
  --accent-text: #ffffff;
  --focus: #2a4fb8;
  --hover: #edf0f5;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #13161c;
    --surface: #1b1f27;
    --text: #e4e8f0;
    --muted: #97a1b3;
    --line: #2c3340;
    --accent: #8fb0ff;
    --accent-text: #0f1420;
    --focus: #8fb0ff;
    --hover: #252b36;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #13161c;
  --surface: #1b1f27;
  --text: #e4e8f0;
  --muted: #97a1b3;
  --line: #2c3340;
  --accent: #8fb0ff;
  --accent-text: #0f1420;
  --focus: #8fb0ff;
  --hover: #252b36;
}`;

/** The global the gallery defines and every `download.js` calls. */
export const DOWNLOAD_GLOBAL = "oneCodeArtifactDownload";

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Script both the gallery and the viewer run: the download global every
 * payload calls, saving through a `blob:` link, and each `<time datetime>`
 * rewritten in the viewer's local time.
 */
export const CLIENT_RUNTIME = `  window.${DOWNLOAD_GLOBAL} = function (payload) {
    var url = URL.createObjectURL(new Blob([payload.html], { type: "text/html" }));
    var link = document.createElement("a");
    link.href = url;
    link.download = payload.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  };
  document.querySelectorAll("time[datetime]").forEach(function (node) {
    var date = new Date(node.getAttribute("datetime"));
    if (!isNaN(date)) node.textContent = date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  });`;

/** `<id>/download.js`: the page's HTML as a call into the gallery or viewer. */
export function renderDownloadPayload(filename: string, html: string): string {
	return `window.${DOWNLOAD_GLOBAL} && window.${DOWNLOAD_GLOBAL}(${JSON.stringify({ filename, html })});\n`;
}

/** `2026-09-27 14:05 UTC`: the at-rest text a script replaces with local time. */
export function utcStamp(iso: string): string {
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function renderEntry(meta: ArtifactMeta, home: string): string {
	const id = escapeHtml(meta.id);
	const versions: string[] = [];
	for (let n = meta.version - 1; n >= 1; n--) versions.push(`<li><a href="${id}/view.html#v${n}">Version ${n}</a></li>`);
	const facts = [
		meta.project ? `<span class="project">${escapeHtml(tildify(meta.project, home))}</span>` : "",
		`<time datetime="${escapeHtml(meta.updatedAt)}">${escapeHtml(utcStamp(meta.updatedAt))}</time>`,
		`<span>v${meta.version}</span>`,
	].filter(Boolean);
	const search = escapeHtml([meta.title, meta.description ?? "", meta.project ?? "", meta.id].join(" ").toLowerCase());
	return `<li class="entry" data-search="${search}">
  <div class="main">
    <h2><a href="${id}/view.html">${escapeHtml(meta.title)}</a></h2>
    ${meta.description ? `<p class="desc">${escapeHtml(meta.description)}</p>` : ""}
    <p class="facts">${facts.join('<span class="sep" aria-hidden="true">·</span>')}</p>
    ${
			versions.length
				? `<details><summary>${versions.length} earlier version${versions.length === 1 ? "" : "s"}</summary><ul class="versions">${versions.join("")}</ul></details>`
				: ""
		}
  </div>
  <div class="actions">
    <a class="button" href="${id}/view.html">Open</a>
    <button type="button" class="button" data-download="${id}/download.js" data-fallback="${id}/index.html">Download</button>
  </div>
  <p class="id"><code>${id}</code></p>
</li>`;
}

export function renderGallery(artifacts: ArtifactMeta[], home: string = homedir()): string {
	const count = artifacts.length;
	const body = count
		? `<ul class="list" id="list">\n${artifacts.map((meta) => renderEntry(meta, home)).join("\n")}\n</ul>
<p class="empty" id="no-match" hidden>No artifact matches that filter.</p>`
		: `<p class="empty">No artifacts yet. Ask One Code for a page, a report or a small tool, and it lands here.</p>`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>One Code Artifacts</title>
<style>
${THEME_TOKENS}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  padding: 0 16px;
}
.wrap { max-width: 880px; margin: 0 auto; padding-block: 40px 64px; display: flex; flex-direction: column; gap: 24px; }
header { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 16px; }
h1 { margin: 0; font-size: 26px; line-height: 1.2; letter-spacing: -0.01em; text-wrap: balance; }
.count { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
input[type="search"] {
  font: inherit; color: var(--text); background: var(--surface);
  border: 1px solid var(--line); border-radius: 6px; padding: 7px 10px; width: min(280px, 100%);
}
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; border-top: 1px solid var(--line); }
.entry {
  display: grid; grid-template-columns: 1fr auto; gap: 4px 16px; align-items: start;
  padding: 16px 0; border-bottom: 1px solid var(--line);
}
.entry[hidden] { display: none; }
.main { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
h2 { margin: 0; font-size: 17px; line-height: 1.3; text-wrap: balance; }
h2 a { color: var(--text); text-decoration: none; }
h2 a:hover { color: var(--accent); text-decoration: underline; }
.desc { margin: 0; max-width: 65ch; }
.facts { margin: 0; color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; display: flex; flex-wrap: wrap; gap: 0 8px; }
.project { overflow-wrap: anywhere; }
.id { grid-column: 1 / -1; margin: 0; }
code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted); }
details { font-size: 13px; color: var(--muted); }
summary { cursor: pointer; width: fit-content; }
.versions { margin: 6px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 2px; }
.versions a { color: var(--accent); }
.actions { display: flex; gap: 8px; }
.button {
  font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; text-decoration: none;
  border-radius: 6px; padding: 6px 12px; border: 1px solid var(--line);
  background: var(--surface); color: var(--text);
}
.actions a.button { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
a:focus-visible, button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.empty { margin: 0; color: var(--muted); }
@media (max-width: 480px) {
  .entry { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div>
    <h1>One Code Artifacts</h1>
    <p class="count">${count} ${count === 1 ? "artifact" : "artifacts"}, newest first. Stored in this folder.</p>
  </div>
  ${count ? '<input type="search" id="filter" placeholder="Filter by title or project" aria-label="Filter artifacts">' : ""}
</header>
${body}
</div>
<script>
(function () {
${CLIENT_RUNTIME}
  document.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest("[data-download]");
    if (!button) return;
    var script = document.createElement("script");
    script.src = button.getAttribute("data-download");
    script.onload = function () { script.remove(); };
    script.onerror = function () { script.remove(); location.href = button.getAttribute("data-fallback"); };
    document.head.appendChild(script);
  });
  var filter = document.getElementById("filter");
  if (filter) filter.addEventListener("input", function () {
    var query = filter.value.trim().toLowerCase();
    var shown = 0;
    document.querySelectorAll(".entry").forEach(function (entry) {
      var match = !query || entry.getAttribute("data-search").indexOf(query) !== -1;
      entry.hidden = !match;
      if (match) shown++;
    });
    document.getElementById("no-match").hidden = shown !== 0;
  });
})();
</script>
</body>
</html>
`;
}
