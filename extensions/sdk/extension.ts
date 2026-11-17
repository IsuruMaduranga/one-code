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
 *   while the extension loads. A child session ignores it. Its `render` gets
 *   a `SectionSession`: the tier, whether the task tools run, `tools` (the
 *   active tools now, which change when a deferred tool loads, so a passage
 *   keyed on them can change the prompt mid-session and miss the cache),
 *   `live` (the tools the session can have, fixed for the process) and
 *   `features` (the features that run in it, as fixed: `features.has("lsp")`
 *   for a fact a feature adds whether or not its tool is registered, such as
 *   the diagnostics after an edit). Key passages on `live` and `features`:
 *   list a tool's as `ToolPassages` and cut them with `withoutOff` (both from
 *   `extensions/sdk/profile.ts`), and test the section with `stalePassages`,
 *   `toolLeaks` and `deferralChanges` from `test/unit/helpers/tool-mentions.ts`
 *   (the last fails when its bytes move inside a session).
 * - `REMINDER_CHANNEL`: a reminder, placed by the kind of fact it states.
 * - `publishContextBlock(pi, ctx, key, text)`: project facts the model starts
 *   every epoch with (the project's layout, its running services), a block
 *   in the first message's context stack after the base's own. The base
 *   renders it into the first message when an epoch opens (the first
 *   request, a compaction, a model switch) and, inside an epoch, puts a
 *   changed text on the next request's tail: at most one per request, the
 *   latest text winning; the same text again adds nothing; `null`, or an
 *   empty or whitespace-only text, withdraws it. Publish at `session_start`
 *   and on a real change only: every change inside an epoch costs a block on
 *   the tail, so a text that changes on each file write would add one to
 *   every request. Keep it short and stable (sorted, no timestamps); past
 *   25,000 UTF-8 bytes it is saved to the session's folder and the block
 *   points there, under a name that changes only with the text. `ctx` is the
 *   session's context (required), for that folder. The key is the
 *   product's own: lowercase, and never one of the base's blocks (a clash,
 *   or a key another extension already publishes, throws). A child session
 *   sees the block only when the child loads the extension that publishes
 *   it (`Profile.childExtensions`).
 * - `DEFER_CHANNEL`: put one of its own tools behind `tool_search`.
 * - `lspRequest`: a request on a language server the profile declares, on the
 *   connection the base already keeps for diagnostics. When the server
 *   refuses it, `lspErrorDetail(error)` gives the JSON-RPC code, message and
 *   data (`instanceof` cannot work: each extension has its own module copy).
 *   `isMethodNotFound(detail)` tells a server that does not know the method
 *   from one that failed on it, for lsp4j servers' "Internal error." too.
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
 * opened (`{ reason: "ssh" | "noDisplay" }`, or `{ reason: "launchFailed",
 * command, osMessage }` when the opener did not start) so the caller can show
 * the URL instead and say what failed.
 *
 * A listener on `thinking_level_select` cannot tell pi fitting a level to the
 * model (`low` runs as `high` on a model with no `low`) from the user picking
 * it: both announce the level that runs. `thinkingLevelsFor(model)` gives
 * `{ supported, settle }`: `supported` is the levels the model reaches
 * (lowest first; the whole ladder when `model` is `undefined`), and
 * `settle(level)` the level pi runs when `level` is set. A level the extension
 * set itself, and whose `settle` differs from it, was fitted; compare the
 * event's level with `settle` of the level that was asked for. Pass the
 * model the event's context holds (`ctx.model`).
 *
 * A notice for the user by the session model's tier (a product that wants
 * a stronger model than the one chosen, say) judges the model with
 * `modelCapability(model)`: `{ tier, known }`, the capability tier the base
 * selects models and opens the permission gate's fast paths by, and whether
 * a rule that knows the model decided it (the user's `modelTiers` entry, a
 * vendor's frontier rule, a catalog entry) or it is a guess (no model, one
 * the catalogs lack, a custom provider, no price). The `*_PROMPT_TIER` knob
 * never moves it, and Haiku 5 and later sit below frontier there.
 * Pass `ctx.model` at `session_start` and `event.model` at `model_select`.
 *
 * Text that must match the session's prompt register uses
 * `sessionModelTier(pi)` instead: a reader of the tier the system prompt
 * and the tool descriptions use, fixed at `session_start` and at each
 * `model_select` (the knob and Haiku's frontier forms move it). Call it
 * while the extension loads: the first caller on the event bus classifies,
 * and every later one reads that
 * owner's value over the bus (no module state is shared between
 * extensions). The base's extensions load first, so the owner's handlers
 * have run before the product's own `session_start` and `model_select`
 * handlers read the tier; reading it before `session_start` throws.
 * `tiersBelow(tier, floor)` says how many tiers either reading sits below a
 * floor (positive when below). Show the notice with `queueNotice(pi.events,
 * ctx, level, text)` where the session has a UI, not with `ctx.ui.notify`:
 * several extensions announce at those events, and a direct info notice
 * overwrites the one before it, or is overwritten. Without a UI (print and
 * JSON modes, where `ctx.ui.notify` does nothing) `notifyOrPrint(ctx, text,
 * level)` writes it to stderr, never into the JSON event stream on stdout.
 * A notice is for the user only and never goes into the request.
 *
 * A user switches the product's behavior through a setting the profile
 * declares (`Profile.settings`: its type, whether the per-project file may
 * set it, and a description /doctor shows). `productSetting(key, cwd)` reads
 * it: from the product's user settings file, then, for a setting declared
 * with `project`, its per-project file, which wins; never a repository's
 * file, another tool's or the managed one. A missing file, malformed JSON or
 * a value of another type reads as unset (undefined), and a key the profile
 * does not declare throws. Read it where it applies, at `session_start` and
 * `model_select` (the user edits the file between sessions; nothing announces
 * a change). Deliberately not here: a writer, the files' paths, a
 * settings-changed channel, and any reader of the base's own keys (a key the
 * base reads, `permissions` or `autoMode` among them, cannot be declared).
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
export { publishContextBlock } from "../lib/request/context-block.ts";
export type { LiveFeatures } from "../lib/profile/live-tools.ts";
export type { FeatureId } from "../lib/profile/features.ts";
export { type SectionSession, SYSTEM_PROMPT_SECTION_CHANNEL, type SystemPromptSection, type SystemPromptSession } from "../request/system-prompt/text.ts";
export { MIN_SECRET_LENGTH, type SecretValue, setSecretValues } from "../lib/profile/secrets.ts";
export { type LspFileChange, type LspFilesChanged, lspFilesChanged, type LspRequest, lspRequest } from "../tools/lsp/request-channel.ts";
export { isMethodNotFound, type LspErrorDetail, lspErrorDetail } from "../tools/lsp/failure.ts";
export { type PersistOptions, persistIfLarge, sessionResultsDir } from "../lib/request/persisted-output.ts";
export { toolRenderers } from "../lib/ui/tui-render.ts";
export { productStateDir } from "../lib/profile/paths.ts";
export { type NoBrowser, openInBrowser } from "../lib/ui/open-browser.ts";
export { sessionModelTier } from "../lib/models/session-model-tier.ts";
export { type ThinkingLevels, thinkingLevelsFor } from "../lib/models/thinking-levels.ts";
export { type ModelCapability, modelCapability, tiersBelow } from "../lib/models/model-tier.ts";
export { type NoticeLevel, queueNotice } from "../lib/notify/notices.ts";
export { notifyOrPrint } from "../lib/notify/headless-output.ts";
export { productSetting, type ProductSettingValue } from "../lib/profile/declared-settings.ts";
