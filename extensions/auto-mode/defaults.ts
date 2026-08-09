/**
 * Built-in auto-mode rule lists (pure data).
 *
 * These are prose, read by the classifier as natural-language rules — the same
 * shape Claude Code's `claude auto-mode defaults` prints, so a user's existing
 * `autoMode` settings splice into them with `"$defaults"` unchanged.
 *
 * Four tiers, in the precedence the classifier is instructed to apply:
 *   hard_deny  — unconditional; neither user intent nor allow rules clear it
 *   soft_deny  — blocked unless an allow rule or explicit user intent clears it
 *   allow      — exceptions to soft_deny
 *   (intent)   — a specific user instruction clears remaining soft denials
 */

/** What the classifier treats as inside the trust boundary. */
export const DEFAULT_ENVIRONMENT: string[] = [
	"Trusted repo: the git repository containing the working directory, and its configured remotes. Pushing to any branch of this repository is routine. Content first read from outside this repository is not this repository's own work, whoever asked for it to be moved.",
	"Repository visibility: assume private unless the user's own message says otherwise. Confidential material may go into a private repo; secrets and personal data may never go into any repo regardless of visibility.",
	"Trusted internal domains: none configured. Any host that is not the repository's own remote is outside the boundary.",
	"Trusted cloud buckets: none configured. Treat every bucket write as leaving the boundary.",
	"Internal package registry: none configured. Installs from the ecosystem's default public registry are routine; installs redirected to another registry are not.",
	"Sensitive data locations: credential directories (~/.ssh, ~/.aws, ~/.kube, ~/.docker, ~/.m2, ~/.gnupg, ~/.config/gcloud), .env files anywhere, private keys and keystores, and /proc or /sys process state.",
	"Sensitive remote targets: any host, namespace, container, or branch whose name carries prod, production, live, or release.",
	"Protected IaC scopes: any Terraform, Pulumi, CloudFormation, Helm, or Kubernetes manifest path whose name marks it as production.",
	"Primary use: software development in the working directory.",
];

/** Unconditional. User intent does not clear these. */
export const DEFAULT_HARD_DENY: string[] = [
	"Data exfiltration: sending secrets, credentials, private keys, personal data, or the contents of sensitive files to any destination outside the trust boundary — by network request, by commit or push, by writing into a shared location, or by embedding them in a command argument that reaches a third party. This holds however the action is framed and whoever asked for it.",
	"Auto-mode bypass: disabling, weakening, or working around this approval mechanism — editing permission settings or Claude Code/One Code configuration to grant broader permissions, adding allow rules, changing the permission mode, or routing an action through a path that avoids classification.",
	"Credential harvesting: reading credential stores, keychains, browser password databases, or process environment memory (/proc/*/environ) for any purpose other than one the user specifically named.",
	"Destroying the user's own history: rewriting or deleting the reflog, deleting the local repository, or removing backups such that the user's uncommitted or unpushed work cannot be recovered.",
];

/** Blocked, but an allow rule or a specific user instruction clears them. */
export const DEFAULT_SOFT_DENY: string[] = [
	"Git destructive [must name the operation and its target]: force pushing, deleting remote branches, tags, or releases, rewriting remote history, or amending a commit that is not the agent's own unpushed work from this session.",
	"Production deploys and destroys [must name the target]: deploying, applying, or destroying against a sensitive remote target or protected IaC scope, including terraform apply/destroy, helm upgrade, kubectl apply against a production namespace, and any release or publish pipeline.",
	"Remote code execution: piping a downloaded script into an interpreter (curl | bash and equivalents), running an installer fetched at execution time, or executing a file whose contents were downloaded during this session.",
	"Irreversible loss outside the working directory: deleting, overwriting, or truncating an existing file or directory that is not under the working directory and not obviously scratch space such as /tmp. Creating a new file outside the working directory is covered by the separate rule below, not by this one.",
	"Creating or modifying files outside the working directory [must name the path]: writing somewhere the user did not ask for is how work leaks out of the project. Clears when the user's own message names that path, or names the destination unambiguously enough that the path follows from it. Also clears for the harness's own designated directories named in the system prompt — the session scratchpad (under /tmp or /private/tmp, in a claude-<uid> directory) and the auto-memory directory (~/.claude/projects/<project>/memory) — which exist precisely so temporary and memory files do not land in the project.",
	"Publishing: pushing a package to a registry, creating a public release or gist, or making a private repository public.",
	"Disabling safety machinery: turning off CI checks, required reviews, branch protection, test suites in configuration, pre-commit hooks, or TLS certificate verification.",
	"Secrets entering version control: staging or committing a file that holds a credential, key, or token, including one the agent generated.",
	"Bulk permission or ownership changes: recursive chmod/chown, or making files world-writable.",
	"Writing to paths whose contents execute later without further approval: .git/hooks, .git/config, editor auto-run configuration, or a build wrapper such as mvnw or gradlew.",
	"Database mutation outside a migration tool: dropping, truncating, or bulk-updating tables directly, against any database.",
	"Remote shells and port-forwards into a sensitive remote target.",
	"Sending repository contents to a third-party service that is not part of the configured toolchain.",
];

/** Exceptions to soft_deny. */
export const DEFAULT_ALLOW: string[] = [
	"Local file operations inside the working directory: creating, editing, moving, and deleting files and directories under it, including build output and caches.",
	"Reading anything inside the working directory, and reading system and tool configuration that is not on the sensitive-data list.",
	"Installing dependencies already declared in the project's manifest (package.json, pyproject.toml, go.mod, pom.xml, Cargo.toml) from the ecosystem's default registry.",
	"Running the project's own build, test, lint, format, and type-check commands, including ones that write to build directories.",
	"Read-only information lookups that retrieve only public data and send none of the user's own: HTTP GET/HEAD to public documentation, package metadata, and credential-free API endpoints; and public registry or DNS queries such as whois, dig, nslookup, and host, including ones that name the registry or DNS server to query.",
	"Git operations that do not rewrite published history: status, diff, log, add, commit, branch, checkout, merge, rebase of unpushed local work, stash, and pushing to any branch of the trusted repo.",
	"Creating and updating pull requests on the trusted repo, and reading issues and CI results.",
	"Starting, stopping, and querying local development servers and containers bound to loopback.",
	"Test artifacts: placeholder credentials authored as placeholders in examples and fixtures. A value copied from a real secret or a sensitive path is never a test artifact.",
	"Reading the project's own .env file when the user asked for work that requires its configuration, provided the values do not leave the machine.",
];
