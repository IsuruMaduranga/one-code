import { describe, expect, it } from "vitest";
import { toolStyleText } from "../../profile/tool-style/index.ts";
import { ALL_LIVE } from "./helpers/live.ts";

const toolStyle = toolStyleText(ALL_LIVE);

describe("One Code's tool-style text", () => {
	it("picks Write's short or long description by form", () => {
		expect(toolStyle.writeDescription("short")).toMatch(/^Writes a file to the local filesystem, overwriting if one exists\./);
		expect(toolStyle.writeDescription("long")).toMatch(/^Writes a file to the local filesystem\.\n\nUsage:/);
	});

	it("keeps pi's edit description and appends the read rule", () => {
		const text = toolStyle.editDescription({ base: "Edit a file." });
		expect(text.startsWith("Edit a file. The file must have been read in this conversation")).toBe(true);
		expect(text).toContain("if it changed on disk since, read it again first.");
	});
});
