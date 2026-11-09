/**
 * What the base hands a profile's guide agent (subagents/guide-agent.ts
 * `GuideInput`), for guide-agent and its One Code sibling: an app install
 * with every doc folder found and an empty setup.
 */
import { brand } from "../../../extensions/lib/profile/brand.mjs";
import type { GuideInput } from "../../../extensions/subagents/guide-agent.ts";

/** A setup with nothing configured. */
export const emptySetup: GuideInput["setup"] = { skills: [], agents: [], plugins: [], mcpServers: [], packages: [], extensions: [], settingsKeys: [] };

/** The guide's input, with `over` replacing whole fields. */
export const guideInput = (over: Partial<GuideInput> = {}): GuideInput => ({
	docs: { guide: "/pkg/docs/guide", piDocs: "/pi/docs", piExamples: "/pi/examples" },
	install: { shape: "app", method: "npm", agentDir: `/home/u/${brand.stateDir}/agent`, version: "0.4.1" },
	setup: emptySetup,
	config: { instructionFiles: ["CLAUDE.md"], configDir: ".claude" },
	...over,
});
