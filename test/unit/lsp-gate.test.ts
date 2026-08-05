import { describe, expect, it } from "vitest";
import { isOneShotInvocation } from "../../extensions/lsp/index.ts";

describe("isOneShotInvocation", () => {
	it("detects print mode flags", () => {
		expect(isOneShotInvocation(["node", "pi", "-p", "hello"])).toBe(true);
		expect(isOneShotInvocation(["node", "pi", "--print", "hello"])).toBe(true);
	});

	it("detects one-shot --mode values in both syntaxes", () => {
		expect(isOneShotInvocation(["node", "pi", "--mode", "json"])).toBe(true);
		expect(isOneShotInvocation(["node", "pi", "--mode=json"])).toBe(true);
		expect(isOneShotInvocation(["node", "pi", "--mode", "print"])).toBe(true);
	});

	it("treats rpc and tui as interactive", () => {
		expect(isOneShotInvocation(["node", "pi", "--mode", "rpc"])).toBe(false);
		expect(isOneShotInvocation(["node", "pi", "--mode", "tui"])).toBe(false);
		expect(isOneShotInvocation(["node", "pi"])).toBe(false);
		expect(isOneShotInvocation(["node", "pi", "-c"])).toBe(false);
	});

	it("does not mistake a prompt containing -p for a flag", () => {
		expect(isOneShotInvocation(["node", "pi", "explain the -p flag"])).toBe(false);
	});
});
