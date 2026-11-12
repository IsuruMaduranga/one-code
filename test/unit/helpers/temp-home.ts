import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, vi } from "vitest";
import { stubHome } from "./home.ts";

/**
 * A fresh temporary home for the running test, with a project folder beside
 * it. `os.homedir()` and the product's state folder move into the home
 * (`stubHome`), so code that resolves either from the environment agrees with
 * a `home` passed to it explicitly. Call it from a test or a `beforeEach`;
 * when the test finishes, the folders are removed and every stubbed
 * environment variable is restored.
 */
export function tempHome(prefix: string): { home: string; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const home = join(root, "home");
	const cwd = join(root, "project");
	mkdirSync(home);
	mkdirSync(cwd);
	stubHome(home);
	onTestFinished(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});
	return { home, cwd };
}
