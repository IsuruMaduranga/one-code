import { beforeEach } from "vitest";
import { setCapabilitySnapshotForTest } from "../extensions/lib/capability-index.ts";
import { setModelFactsForTest } from "../extensions/lib/model-facts.ts";

// Hermetic by default: no bundled model facts (see vitest.config.ts). A test
// that wants the real table calls `setModelFactsForTest(undefined)` itself and
// gets reset before the next test.
setModelFactsForTest({});
beforeEach(() => setModelFactsForTest({}));

// Likewise no Artificial Analysis snapshot: every capability verdict is
// "unscored" unless a test pins one with setCapabilitySnapshotForTest.
setCapabilitySnapshotForTest(undefined);
beforeEach(() => setCapabilitySnapshotForTest(undefined));
