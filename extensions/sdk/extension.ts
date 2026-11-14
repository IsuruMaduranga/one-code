/**
 * The one module a product's own extension imports from the base
 * (working-docs/decisions/bi-fork.md): the channels a product extension
 * announces on, with their payload types. A product extension lives in
 * `profile/extensions/<name>/`; the main session loads its `index.ts` after
 * every base extension, and a child session loads the entries the profile
 * lists (`Profile.childExtensions`). Everything else in `extensions/` is
 * internal and may move between releases (`profile-import-surface.test.ts`).
 *
 * A product extension loads after the request pipeline, so it never shapes a
 * request in a `context` or payload hook. It registers tools and commands
 * through pi, and reaches the request only through these channels:
 *
 * - `SYSTEM_PROMPT_SECTION_CHANNEL`: a section of the system prompt, announced
 *   while the extension loads. A child session ignores it.
 * - `REMINDER_CHANNEL`: a reminder, placed by the kind of fact it states.
 * - `DEFER_CHANNEL`: put one of its own tools behind `tool_search`.
 * - `lspRequest`: a request on a language server the profile declares, on the
 *   connection the base already keeps for diagnostics. When the server
 *   refuses it, `lspErrorDetail(error)` gives the JSON-RPC code, message and
 *   data (`instanceof` cannot work: each extension has its own module copy).
 * - `lspFilesChanged`: files that changed on disk outside the session's
 *   `edit` and `write` tools (the shell, a build tool, the user's editor),
 *   reported to that server so its answers and diagnostics follow the disk.
 *   The base watches no files; the product's watcher calls this.
 * - `setSecretValues`: register the secret values the product knows, so the
 *   base redacts them from every tool result and task notification.
 *
 * Two helpers keep a product extension from copying base code:
 * `productStateDir` is the product's state folder (the state-dir variable
 * when set, else the home folder's entry for the profile in force), and
 * `openInBrowser` hands a URL to the desktop's browser, returning why none
 * opened (an SSH session, no display, no opener) so the caller can show the
 * URL instead.
 *
 * A product tool registers through pi like any tool. Two helpers keep it in
 * line with the base's own tools: `persistIfLarge` bounds a large text result
 * (the full text goes to a file the model can read back; never truncate),
 * and `toolRenderers` gives it the base's call and result rows in the
 * terminal. The profile's tool switch for its name (`deferred`, `autoAllow`,
 * `readOnly`, `enabled`) applies as it does to a base tool.
 *
 * Re-export only what a product extension uses, by name.
 */
export { DEFER_CHANNEL, type DeferRequest } from "../lib/request/deferred-channel.ts";
export { REMINDER_CHANNEL, type ReminderPayload, type ReminderPlacement } from "../lib/request/reminders.ts";
export { SYSTEM_PROMPT_SECTION_CHANNEL, type SystemPromptSection, type SystemPromptSession } from "../request/system-prompt/text.ts";
export { MIN_SECRET_LENGTH, type SecretValue, setSecretValues } from "../lib/profile/secrets.ts";
export { type LspFileChange, type LspFilesChanged, lspFilesChanged, type LspRequest, lspRequest } from "../tools/lsp/request-channel.ts";
export { type LspErrorDetail, lspErrorDetail } from "../tools/lsp/failure.ts";
export { type PersistOptions, persistIfLarge, sessionResultsDir } from "../lib/request/persisted-output.ts";
export { toolRenderers } from "../lib/ui/tui-render.ts";
export { productStateDir } from "../lib/profile/paths.ts";
export { type NoBrowserReason, openInBrowser } from "../lib/ui/open-browser.ts";
