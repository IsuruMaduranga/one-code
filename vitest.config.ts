import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Unit tests run with an EMPTY model catalog so a fake row is never
		// classified by the real catalog entry behind the same id (and the suite
		// does not drift when the bundled catalogs are regenerated). The
		// catalog-wide snapshot test opts back into the bundled copy itself.
		// The profile in force adds its own setup (One Code's: the source
		// provider and its config mode); the base suite runs without it.
		setupFiles: ["test/setup.ts", ...(existsSync("profile/test/setup.ts") ? ["profile/test/setup.ts"] : [])],
	},
});
