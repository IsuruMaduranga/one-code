/**
 * What "Yes, and don't ask again this session" grants (pure).
 *
 * Until 2026-09-05 the option minted a bare tool rule for every tool but bash:
 * one approved in-project write granted every write to every path for the rest
 * of the process, one fetch every URL, one MCP call every argument, and in auto
 * mode the minted rule stood as a classifier bypass for that tool
 * (PERMISSIONS-REVIEW-2026-09-05 M2). Claude Code's equivalents are scoped —
 * "allow all edits during this session" is working-directory-scoped, WebFetch
 * grants a domain — and the option names what it grants. So does this: the
 * grant is scoped by the subject's kind (permissions/matcher.ts `subjectKind`),
 * the label says exactly what it covers, and there is no grant at all where a
 * rule could not matter (a protected path, the auto-mode safety floor — both are
 * checked before allow rules) or where the classifier is the boundary (auto
 * mode: session allows are never applied there).
 */

import { dirname, resolve } from "node:path";
import { toAbsolute } from "../auto-mode/paths.ts";
import { tildify, toPosixPath } from "../lib/paths.ts";
import { escapeLiteral, isAtOrInsideDir, normalizeToolName, parseRule, type PermissionMode, type PermissionRule, subjectKind, urlHost } from "./matcher.ts";

export interface SessionGrant {
	/** The rule to add to the session's allow list when the user picks this option. */
	rule: PermissionRule;
	/** The option label, naming the scope granted. */
	label: string;
}

export interface SessionGrantInput {
	toolName: string;
	/** The subject the prompt shows (the original command in a worktree session). */
	subject: string;
	/** The directory the call runs in (a worktree's path in a worktree session). */
	cwd: string;
	mode: PermissionMode;
	/** The `decide()` cause behind the prompt. */
	cause: string;
	/** The auto-mode safety floor raised this prompt — no rule can cover it. */
	floor?: boolean;
	home: string;
}

/** `~`-abbreviated path for a label. */
function displayPath(path: string, home: string): string {
	return tildify(path, home);
}

/**
 * Claude Code's `//absolute` rule form for a directory and everything under
 * it — on Windows in CC's POSIX spelling (`//c/Users/x/proj/**`), the form
 * `matchesPathPattern` matches native paths as.
 */
function absoluteDirPattern(dir: string): string {
	return `/${toPosixPath(resolve(dir)).replace(/\/+$/, "")}/**`;
}

export function sessionGrant(input: SessionGrantInput): SessionGrant | undefined {
	const { subject, cwd, mode, cause, home } = input;
	// Auto mode never applies session allows (the classifier is the boundary and
	// its prompts are resume/floor prompts, not per-action approvals); protected
	// paths and the safety floor are judged before allow rules, so a rule minted
	// here could never cover them.
	if (mode === "auto" || input.floor || cause === "protected-path") return undefined;

	const tool = normalizeToolName(input.toolName);
	const mint = (raw: string, label: string): SessionGrant | undefined => {
		const rule = parseRule(raw);
		return rule ? { rule, label } : undefined;
	};

	switch (subjectKind(tool)) {
		case "command":
			// The approved command, as an exact literal — never a glob.
			if (!subject) return undefined;
			return mint(`${tool}(${escapeLiteral(subject)})`, "Yes, and don't ask again for this exact command this session");
		case "path": {
			if (!subject) return undefined;
			const absolute = toAbsolute(cwd, subject, home);
			// Inside the working directory this is Claude Code's "allow all edits
			// during this session"; outside, the grant stops at the file's directory.
			if (isAtOrInsideDir(absolute, cwd, cwd)) {
				return mint(`${tool}(${absoluteDirPattern(cwd)})`, `Yes, and allow ${tool} anywhere in the working directory this session`);
			}
			const dir = dirname(absolute);
			return mint(`${tool}(${absoluteDirPattern(dir)})`, `Yes, and allow ${tool} under ${displayPath(dir, home)} this session`);
		}
		case "url": {
			const host = urlHost(subject);
			if (!host) return undefined;
			return mint(`${tool}(domain:${host})`, `Yes, and don't ask again for ${host} this session`);
		}
		case "text":
			return mint(tool, `Yes, and don't ask again for ${tool} this session`);
	}
}
