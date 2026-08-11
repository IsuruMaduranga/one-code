/**
 * The `/init` prompt — adapted from Claude Code's `/init`, kept provider-neutral
 * (One Code writes a CLAUDE.md that any Claude Code-compatible agent reads) and
 * self-contained (no dependency on CC-internal skills like `update-config`).
 *
 * Submitted verbatim as a user turn by extensions/init/index.ts; the model does
 * the work with the normal tool set (subagent survey, ask_user_question, write).
 */
export const INIT_PROMPT = `Analyze this codebase and set up a concise CLAUDE.md at the repository root, to be loaded into every future session working here. Keep it minimal — every line must earn its place: include only what an agent would get wrong or waste time rediscovering without it.

## 1. Survey the codebase
Launch an Explore subagent (or read directly if the repo is small) to gather:
- Build, test, and lint commands — especially non-standard scripts, flags, or how to run a *single* test.
- Languages, frameworks, package manager, and whether this is a monorepo/multi-module or single project.
- High-level architecture that requires reading several files to grasp (the "big picture", not a file listing).
- Non-obvious gotchas, required env vars, or workflow quirks.
- Existing AI-tool config to fold in: an existing CLAUDE.md, AGENTS.md, .cursor/rules or .cursorrules, .github/copilot-instructions.md, .windsurfrules, .clinerules — and the important parts of README.md.

## 2. Fill the gaps
Use ask_user_question only for things the code cannot answer — branch/PR conventions, required setup, testing quirks, communication preferences. Skip anything already obvious from manifests or the README. Do not mark options as "recommended": this is how their team works, not best practices.

## 3. Write CLAUDE.md
Prefix the file with:

\`\`\`
# CLAUDE.md

This file gives guidance to AI coding agents (Claude Code and compatible tools) working in this repository.
\`\`\`

Include: build/test/lint commands an agent can't guess; code-style rules that DIFFER from language defaults; testing instructions and quirks; repo etiquette (branch naming, PR/commit conventions); required env vars or setup; non-obvious gotchas and architectural decisions; the important parts of any existing AI-tool config.

Exclude: file-by-file structure or component lists (discoverable by reading); standard language conventions; generic advice ("write clean code", "handle errors"); long references or API docs (link them with \`@path/to/file\` import syntax instead of inlining); anything that changes frequently (reference the source with \`@path\`).

Be specific — "Use 2-space indentation in TypeScript" beats "format code properly." Do not repeat yourself and do not invent sections like "Common Development Tasks" — only include what you actually found.

If a CLAUDE.md already exists: read it, propose concrete improvements as diffs, and explain each. Do NOT silently overwrite. For projects with distinct subdirectories (monorepos), mention that per-directory CLAUDE.md files are loaded automatically when working in those directories, and offer to create them.

## 4. Recap
Summarize which file(s) you wrote and the key points in each. Remind the user this is a starting point to review and tweak, and that they can run \`/init\` again anytime to re-scan.`;
