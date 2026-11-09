/**
 * This package's root (the `one-code-extension` directory) and its
 * `extensions/` folder, for modules that read files shipped beside the code:
 * the profile, the user guide, `package.json`, the extension entries. The one
 * place that counts folders up from a source file, so a module that moves
 * changes no path (`package-root.test.ts`).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const EXTENSIONS_DIR = join(PACKAGE_ROOT, "extensions");
