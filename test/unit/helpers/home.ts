import { vi } from "vitest";

/**
 * Point `os.homedir()` at `home` on every platform: it reads HOME on macOS and
 * Linux and USERPROFILE on Windows. Undone by `vi.unstubAllEnvs()`.
 */
export function stubHome(home: string): void {
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
}
