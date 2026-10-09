import { describe, expect, it } from "vitest";
import { createLspTrustGate } from "../../extensions/lsp/trust.ts";

describe("createLspTrustGate: a shared trust dialog", () => {
	it("lets a caller still live ask again when the one that opened the dialog aborts", async () => {
		const persisted: string[] = [];
		const gate = createLspTrustGate({ projectRoot: () => "/proj", isTrusted: () => false, persist: (root) => persisted.push(root) });
		const answers: Array<(ok: boolean) => void> = [];
		const confirm = () => new Promise<boolean>((resolve) => answers.push(resolve));
		const aborted = new AbortController();
		const first = gate.allowed("/proj/a", confirm, aborted.signal);
		const second = gate.allowed("/proj/b", confirm);
		await Promise.resolve();
		expect(answers).toHaveLength(1);
		aborted.abort();
		answers[0](true); // A reply racing the abort is no decision.
		expect(await first).toBe(false);
		await new Promise((r) => setTimeout(r, 0));
		expect(answers).toHaveLength(2);
		expect(persisted).toEqual([]);
		answers[1](true);
		expect(await second).toBe(true);
		expect(persisted).toEqual(["/proj"]);
	});
});
