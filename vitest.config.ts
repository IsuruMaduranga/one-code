import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Unit tests run with an EMPTY model-facts table so a fake catalog row is
		// never classified by the real release date behind the same id (and the
		// suite does not drift when the bundled facts are regenerated). The
		// catalog-wide snapshot test opts back into the bundled table itself.
		setupFiles: ["test/setup.ts"],
	},
});
