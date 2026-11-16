/**
 * A product's context block (lib/request/context-block.ts): live state in the
 * first message's stack, rendered when an epoch opens; inside an epoch, at
 * most one block per request on the tail when its text changed, nothing when
 * it did not, a withdrawal when it is gone.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToldFact } from "../../extensions/lib/request/ledger/records.ts";
import { BASE_BLOCK_KEYS, CONTEXT_BLOCK_MAX_BYTES, CONTEXT_BLOCK_OWNER_CHANNEL, type OwnerProbe, publishContextBlock } from "../../extensions/lib/request/context-block.ts";
import { contextBlockText } from "../../extensions/lib/request/context-block-text.ts";
import { CONTEXT_ORDER, LiveReminders, movesToSystemRole, REMINDER_CHANNEL, type ReminderPayload, toldBlockFact } from "../../extensions/lib/request/reminders.ts";
import { EXTENSIONS_DIR } from "../../extensions/lib/core/package-root.ts";
import { brand } from "../../extensions/lib/profile/brand.mjs";
import { createFakeCtx, createFakePi, renderRequest } from "./helpers/fake-pi.ts";
import { sourceFiles } from "./helpers/import-graph.ts";
import { tempHome } from "./helpers/temp-home.ts";

/** A session's bus with the live stack it would render at an epoch, and the facts that epoch would tell. */
function session() {
	const fake = createFakePi();
	const live = new LiveReminders();
	const payloads: ReminderPayload[] = [];
	fake.events.on(REMINDER_CHANNEL, (data) => {
		payloads.push(data as ReminderPayload);
		live.apply(data as ReminderPayload);
	});
	const ctx = createFakeCtx({});
	/** What an epoch opened now would tell: the facts of the stack's blocks. */
	const epochFacts = (): ToldFact[] => live.stackEntries().flatMap((entry) => entry.facts ?? []);
	return { fake, live, payloads, ctx, epochFacts, publish: (key: string, text: string | null) => publishContextBlock(fake.pi as never, ctx, key, text) };
}

describe("a product's context block", () => {
	it("is rendered into the first message when an epoch opens, at the product slot, and adds nothing to that request's tail", () => {
		const s = session();
		s.publish("layout", "src/ main.bal");
		expect(s.live.stackEntries()).toEqual([{ key: "product:layout", text: "src/ main.bal", order: CONTEXT_ORDER.productContext, facts: [toldBlockFact("product:layout", "src/ main.bal")] }]);
		// The slot stays on the user message on a model that takes a mid-conversation system message.
		expect(movesToSystemRole(CONTEXT_ORDER.productContext)).toBe(false);
		expect(CONTEXT_ORDER.productContext).toBeGreaterThan(CONTEXT_ORDER.context);
		expect(CONTEXT_ORDER.productContext).toBeLessThan(CONTEXT_ORDER.date);
		expect(renderRequest(s.fake.events, { epoch: true })).toEqual([]);
	});

	it("adds nothing inside an epoch while its text is what the epoch told, republished or not", () => {
		const s = session();
		s.publish("layout", "A");
		const told = s.epochFacts();
		expect(renderRequest(s.fake.events, { facts: told })).toEqual([]);
		s.publish("layout", "A");
		s.publish("layout", "A");
		expect(renderRequest(s.fake.events, { facts: told })).toEqual([]);
	});

	it("puts one block on the tail when the text changed, the latest text winning however often it was republished", () => {
		const s = session();
		s.publish("layout", "A");
		const told = s.epochFacts();
		s.publish("layout", "B");
		s.publish("layout", "C");
		const blocks = renderRequest(s.fake.events, { facts: told });
		expect(blocks).toEqual([{ text: "C", facts: [toldBlockFact("product:layout", "C")] }]);
		// Once that request told it, the next one adds nothing; back to the told text adds nothing either.
		expect(renderRequest(s.fake.events, { facts: [...told, ...blocks[0].facts!] })).toEqual([]);
		s.publish("layout", "A");
		expect(renderRequest(s.fake.events, { facts: told })).toEqual([]);
	});

	it("is withdrawn on null: gone from the stack, and a note on the tail of an epoch that told it", () => {
		const s = session();
		expect(() => s.publish("layout", null)).not.toThrow();
		expect(renderRequest(s.fake.events, { facts: [] })).toEqual([]);
		s.publish("layout", "A");
		const told = s.epochFacts();
		s.publish("layout", null);
		expect(s.live.stackEntries()).toEqual([]);
		expect(renderRequest(s.fake.events, { facts: told })).toEqual([{ text: contextBlockText.withdrawn("layout"), facts: [toldBlockFact("product:layout", "")] }]);
	});

	it("survives a compaction: the epoch it opens renders the latest text, and tells it", () => {
		const s = session();
		s.publish("layout", "A");
		s.publish("layout", "B");
		// A compaction opens an epoch: the stack is rendered again, with the latest text and its fact.
		expect(s.live.stackEntries().map((entry) => entry.text)).toEqual(["B"]);
		expect(renderRequest(s.fake.events, { epoch: true })).toEqual([]);
		expect(renderRequest(s.fake.events, { facts: s.epochFacts() })).toEqual([]);
	});

	it("persists a text past the memory index's load bound and carries the pointer, never a slice", () => {
		const { home } = tempHome("context-block-");
		const s = session();
		const big = `${"x".repeat(CONTEXT_BLOCK_MAX_BYTES)} tail`;
		publishContextBlock(s.fake.pi as never, { cwd: home, sessionManager: { getSessionDir: () => home } }, "layout", big);
		const text = s.live.stackEntries()[0].text;
		expect(text).toContain("<persisted-output>");
		const file = text.match(/(\S+context-layout-[0-9a-f]+\.txt)/)?.[1];
		expect(file).toBeDefined();
		expect(readFileSync(file!, "utf8")).toBe(big);
	});

	it("refuses a malformed key, a key of the base's own blocks, and a key another extension publishes", () => {
		const s = session();
		expect(() => s.publish("Layout", "A")).toThrow(/lowercase letters, digits and hyphens/);
		expect(() => s.publish("skills", "A")).toThrow(/"skills" is the key of one of the base's own context blocks/);
		// The same extension republishing its own key is fine.
		s.publish("layout", "A");
		expect(() => s.publish("layout", "B")).not.toThrow();
		// Another extension has its own copy of the module (jiti) and answers for its keys on the bus.
		const t = session();
		t.fake.events.on(CONTEXT_BLOCK_OWNER_CHANNEL, (data) => {
			const probe = data as OwnerProbe;
			if (probe.key === "product:layout") probe.owned = true;
		});
		expect(() => t.publish("layout", "A")).toThrow(/the context block "layout" is already published by another extension in this session/);
	});

	it("knows every key the base's own first-prepend blocks use", () => {
		const keys = new Set<string>();
		for (const file of sourceFiles(EXTENSIONS_DIR, EXTENSIONS_DIR)) {
			if (file.endsWith("context-block.ts")) continue;
			const source = readFileSync(join(EXTENSIONS_DIR, file), "utf8");
			const lines = source.split("\n");
			lines.forEach((line, index) => {
				if (!line.includes('placement: "first-prepend"')) return;
				const near = lines.slice(Math.max(0, index - 6), index + 3).join("\n");
				for (const match of near.matchAll(/key: "([^"]+)"/g)) keys.add(match[1]);
				// A key named by a constant: its literal value, the brand's prefix filled in.
				for (const match of near.matchAll(/key: ([A-Z_]+)/g)) {
					const value = source.match(new RegExp(`const ${match[1]} = ["\`]([^"\`]+)["\`]`))?.[1];
					if (value) keys.add(value.replace("${brand.idPrefix}", brand.idPrefix));
				}
			});
		}
		expect(keys.size).toBeGreaterThanOrEqual(10);
		expect([...keys].filter((key) => !BASE_BLOCK_KEYS.has(key))).toEqual([]);
	});
});
