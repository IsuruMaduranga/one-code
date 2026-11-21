/**
 * The one sensitive-path denylist (pure).
 *
 * The upstream sandbox this is derived from kept three divergent copies of this
 * list (one for the shell classifier, one for file tools, one for PowerShell);
 * they drifted, and the drift *was* the vulnerability — the shell path blocked
 * `~/.kube/config` while the file path did not (review findings F3, F10, N13,
 * N25). There is exactly one list here, it is case-folded, and every consumer
 * calls these functions rather than re-deriving membership.
 */

import { basename } from "node:path";

/**
 * Directory names that mean "credentials live under here". Matched as a *path
 * segment*, so `~/.aws/credentials`, `/Users/x/.aws`, and a bare `.aws` in a
 * command all hit. `.config/gcloud` is two segments and handled separately.
 */
const SENSITIVE_DIR_SEGMENTS = new Set([
	".aws",
	".azure",
	".docker",
	".gnupg",
	".kube",
	".m2", // Maven settings.xml holds plaintext repository credentials
	".npm",
	".password-store", // pass: one GPG-encrypted file per secret
	".ssh",
	".terraform.d",
	"gcloud", // under .config/
	".gcloud",
	".config/gcloud",
]);

/** Runs of two or more folder names that are sensitive together, wherever they sit in the resolved path. */
const SENSITIVE_DIR_PAIRS = [
	[".config", "gcloud"],
	[".config", "gh"],
	[".config", "hub"], // GitHub's older CLI: an OAuth token
	[".config", "op"], // 1Password CLI: account and device keys
	[".config", "rclone"], // rclone.conf: remote passwords and tokens
	[".config", "sops"], // sops/age/keys.txt: age private keys
	[".config", "google-chrome"], // browser profiles: cookies, saved logins
	[".config", "chromium"],
	["application support", "google", "chrome"], // macOS: ~/Library/Application Support/Google/Chrome (a bare google/chrome is any project's folder)
	// A project's own gradle.properties is ordinary; the user-level one holds signing and repository credentials.
	[".gradle", "gradle.properties"],
	[".local", "share"],
	[".huggingface", "token"],
	["library", "keychains"], // macOS keychain databases
] as const;

const SENSITIVE_BASENAMES = new Set([
	// The harness's own credential stores: pi's / One Code's `agent/auth.json`
	// and Claude Code's `~/.claude/.credentials.json` (PERMISSIONS-REVIEW-2026-09-05
	// H2 — the classifier's own API key was readable unclassified).
	"auth.json",
	".credentials.json",
	"credentials.json",
	"credentials.toml", // cargo
	".vault-token",
	".gitconfig", // credential helpers, embedded tokens
	".boto", // gsutil and boto: access keys
	".my.cnf", // MySQL client password
	".s3cfg", // s3cmd access keys
	"oauth_creds.json", // Gemini CLI's login
	"rclone.conf",
	".bash_history",
	".bash_profile",
	".bashrc",
	".git-credentials",
	".netrc",
	".npmrc",
	".pgpass",
	".profile",
	".pypirc",
	".zprofile",
	".zsh_history",
	".zshrc",
	"authorized_keys",
	"credentials",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
	"id_rsa",
	"known_hosts",
	"settings.xml",
]);

/**
 * Filesystem roots that expose process state — `/proc/self/environ` hands over
 * every environment variable, which defeats any path-based secret protection
 * (review finding N23). Anything under these is sensitive regardless of name.
 */
const SENSITIVE_ROOTS = ["/proc", "/sys"];

function fold(value: string): string {
	return value.trim().toLowerCase().replace(/\\/g, "/");
}

/** Whether a basename names a secret file (`.env`, `.env.local`, keys, …). */
export function isSensitiveBasename(name: string): boolean {
	const folded = fold(name);
	if (!folded) return false;
	if (folded === ".env" || folded.startsWith(".env.")) return true;
	if (SENSITIVE_BASENAMES.has(folded)) return true;
	// Private keys and certificates by extension, plus the id_* key family.
	if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(folded)) return true;
	if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(folded)) return true;
	return false;
}

/**
 * Whether a path (resolved or not) touches anything on the denylist. Callers
 * pass resolved paths where they have them; the raw-token form is still checked
 * so a bare `.kube` argument is caught before resolution.
 */
export function isSensitivePath(candidate: string): boolean {
	const folded = fold(candidate);
	if (!folded) return false;

	for (const root of SENSITIVE_ROOTS) {
		if (folded === root || folded.startsWith(`${root}/`)) return true;
	}

	const segments = folded.split("/").filter(Boolean);
	for (const segment of segments) {
		if (SENSITIVE_DIR_SEGMENTS.has(segment)) return true;
	}
	for (const run of SENSITIVE_DIR_PAIRS) {
		for (let i = 0; i + run.length <= segments.length; i++) {
			if (run.every((name, offset) => segments[i + offset] === name)) return true;
		}
	}

	return isSensitiveBasename(basename(folded));
}

/**
 * Paths inside the project that are code-execution primitives: writing them
 * plants code that runs later without any further approval (review finding
 * N20 — `.git/hooks/pre-commit` fires on the next commit, `.git/config` can
 * carry an `[alias]` shelling out). Containment inside the working directory
 * says nothing about whether a write is safe, so these are called out as
 * evidence for the classifier even when they are in-project.
 */
export function isExecutionPrimitivePath(candidate: string): boolean {
	const folded = fold(candidate);
	if (!folded) return false;
	const segments = folded.split("/").filter(Boolean);
	const hasGitDir = segments.includes(".git");
	if (hasGitDir) {
		const gitIndex = segments.lastIndexOf(".git");
		const tail = segments.slice(gitIndex + 1);
		if (tail[0] === "hooks" || tail[0] === "config") return true;
	}
	// Editor/tooling auto-run configuration.
	if (segments.includes(".vscode") && /\.json$/.test(segments[segments.length - 1] ?? "")) return true;
	if (/^(\.envrc|makefile|dockerfile|\.mvn)$/.test(segments[segments.length - 1] ?? "")) return true;
	if (segments.includes(".mvn") || segments.includes(".github")) return true;
	if (/^mvnw(\.cmd)?$/.test(segments[segments.length - 1] ?? "")) return true;
	return false;
}
