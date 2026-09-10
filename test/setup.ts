import { beforeEach } from "vitest";
import { setModelFactsForTest } from "../extensions/lib/model-facts.ts";

// Hermetic by default: no bundled model facts (see vitest.config.ts). A test
// that wants the real table calls `setModelFactsForTest(undefined)` itself and
// gets reset before the next test.
setModelFactsForTest({});
beforeEach(() => setModelFactsForTest({}));
