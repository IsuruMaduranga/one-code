import { describe, expect, it } from "vitest";
import { sentenceLiterals } from "./helpers/sentence-literals.ts";

describe("sentenceLiterals", () => {
	it("finds prose, not identifiers, paths or comments", () => {
		const source = [
			'// A comment with many words in it.',
			'const a = "Allow reads outside the working directories?";',
			'const b = "one-code:system-reminder";',
			'const c = `${x} costs more than this model`;',
			'import x from "./some/long path name here.ts";',
		].join("\n");
		expect(sentenceLiterals(source)).toEqual(["Allow reads outside the working directories?", "${…} costs more than this model"]);
	});
});
