import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Unit tests run with an EMPTY model catalog so a fake row is never
		// classified by the real catalog entry behind the same id (and the suite
		// does not drift when the bundled catalogs are regenerated). The
		// catalog-wide snapshot test opts back into the bundled copy itself.
		setupFiles: ["test/setup.ts"],
	},
});
