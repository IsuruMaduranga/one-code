/**
 * The `/init` prompt: Claude Code's classic one, the prompt it sends by
 * default, submitted verbatim as a user turn by extensions/init/index.ts.
 *
 * Three adaptations. The CLAUDE.md it writes is read by every Claude
 * Code-compatible agent, One Code included, so the opening sentence and the
 * file's header name AI coding agents rather than one product (the header is
 * the one One Code's /init has always written). And the rules to fold in
 * include an AGENTS.md: One Code reads a directory's AGENTS.md only when that
 * directory has no CLAUDE.md, so once /init writes one, anything left in
 * AGENTS.md alone would stop reaching the model.
 */
export const INIT_PROMPT = `Please analyze this codebase and create a CLAUDE.md file, which will be given to future AI coding agents (Claude Code and compatible tools) to operate in this repository.

What to add:
1. Commands that will be commonly used, such as how to build, lint, and run tests. Include the necessary commands to develop in this codebase, such as how to run a single test.
2. High-level code architecture and structure so that future instances can be productive more quickly. Focus on the "big picture" architecture that requires reading multiple files to understand.

Usage notes:
- If there's already a CLAUDE.md, suggest improvements to it.
- When you make the initial CLAUDE.md, do not repeat yourself and do not include obvious instructions like "Provide helpful error messages to users", "Write unit tests for all new utilities", "Never include sensitive information (API keys, tokens) in code or commits".
- Avoid listing every component or file structure that can be easily discovered.
- Don't include generic development practices.
- If there are Cursor rules (in .cursor/rules/ or .cursorrules), Copilot rules (in .github/copilot-instructions.md) or an AGENTS.md, make sure to include the important parts.
- If there is a README.md, make sure to include the important parts.
- Do not make up information such as "Common Development Tasks", "Tips for Development", "Support and Documentation" unless this is expressly included in other files that you read.
- Be sure to prefix the file with the following text:

\`\`\`
# CLAUDE.md

This file gives guidance to AI coding agents (Claude Code and compatible tools) working in this repository.
\`\`\``;
