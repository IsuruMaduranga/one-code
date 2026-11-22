import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";
import { envName } from "../extensions/lib/profile/brand.mjs";
import { emptyCatalogSources, setCatalogSourcesForTest } from "../extensions/lib/models/model-catalog-data.ts";
import { setModelTierOverridesForTest } from "../extensions/lib/models/model-tier.ts";
import { bashParserReady } from "../extensions/lib/shell/bash-parser.ts";
import { setLaunchArgsForTest, shareShippedProfileForTest } from "../extensions/lib/profile/profile.ts";
import { profile } from "./unit/helpers/default-profile.ts";

// The shipped profile through the test run's own module graph (lib/profile/profile.ts
// loads it on demand under jiti, where vitest's import is not the one used).
shareShippedProfileForTest(profile);
// The test runner's arguments are not pi's: `vitest -t <name>` would read as `--tools <name>`.
setLaunchArgsForTest([]);
// What the profile in force needs besides this (One Code's source provider and
// config mode) is in its own profile/test/setup.ts, which vitest.config.ts adds
// when the profile has one.

// Hermetic by default: an empty model catalog (see vitest.config.ts), so every
// model takes the no-catalog rules unless a test pins sources with
// `setCatalogSourcesForTest` (test/unit/catalog-fixture.ts builds them); the
// catalog-wide snapshot test reads the bundled copy. Reset before each test.
setCatalogSourcesForTest(emptyCatalogSources());
beforeEach(() => setCatalogSourcesForTest(emptyCatalogSources()));

// Likewise no `modelTiers` from the machine's ~/.onecode/settings.json.
setModelTierOverridesForTest({});
beforeEach(() => setModelTierOverridesForTest({}));

// ~/.claude paths follow each test's own home, whatever the shell says: CLAUDE_CONFIG_DIR inherited
// from the environment (a probe harness, a user's own setup) moved every
// ~/.claude path and failed 71 tests. A test that wants it stubs it.
delete process.env.CLAUDE_CONFIG_DIR;

// The product's state folder is a fresh one per test file, whatever the shell
// says: a test that forgot to point it elsewhere wrote into the user's real
// one (and one hung retrying ids already taken there). `stubHome` moves it with
// the home folder; a test that wants it elsewhere stubs it.
const stateDir = mkdtempSync(join(tmpdir(), "state-"));
process.env[envName("STATE_DIR")] = stateDir;
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

// Likewise the live permission mode One Code publishes to child processes:
// run from a One Code shell, the suite inherited *_PERMISSION_MODE=auto and
// 16 permission-gate and workflow tests failed. A test that wants it stubs it.
delete process.env[envName("PERMISSION_MODE")];

// Git reads no configuration from the machine: the global file is an empty one
// and the system file is off, for this process and every child it spawns. A
// developer's own `user.email`, signing, hooks path or default branch changed
// what the tests saw (the instructions test expects the GIT_AUTHOR_EMAIL value,
// which a configured email overrides) and made commits fail on a signing
// program. A test that wants a setting writes it to its own repository
// (`initTestRepo`) or stubs the variable itself.
const gitConfigDir = mkdtempSync(join(tmpdir(), "git-config-"));
const emptyGitConfig = join(gitConfigDir, "empty.gitconfig");
writeFileSync(emptyGitConfig, "");
process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
// Variables that point git at another repository or identity: a suite run from
// a git hook or a rebase inherits them, and a fixture's `git init` would then
// act on the outer repository.
for (const name of [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_NAMESPACE",
	"GIT_PREFIX",
	"GIT_CEILING_DIRECTORIES",
	"GIT_CONFIG",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_PARAMETERS",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_AUTHOR_DATE",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
	"GIT_COMMITTER_DATE",
])
	delete process.env[name];
afterAll(() => rmSync(gitConfigDir, { recursive: true, force: true }));

// The bash grammar loads asynchronously; every shell parse after this is
// synchronous, as it is once a session's hooks have awaited it.
await bashParserReady();
