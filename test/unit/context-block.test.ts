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

/** A session's bus with the live stack it would render at an epoch, and the facts that epoch would tell; `dir` is the session's folder. */
function session(dir?: string) {
	const fake = createFakePi();
	const live = new LiveReminders();
	const payloads: ReminderPayload[] = [];
	fake.events.on(REMINDER_CHANNEL, (data) => {
		payloads.push(data as ReminderPayload);
		live.apply(data as ReminderPayload);
	});
	const ctx = dir ? { cwd: dir, sessionManager: { getSessionDir: () => dir, getSessionId: () => "s" } } : createFakeCtx({});
	/** What an epoch opened now would tell: the facts of the stack's blocks. */
	const epochFacts = (): ToldFact[] => live.stackEntries().flatMap((entry) => entry.facts ?? []);
	return { fake, live, payloads, ctx, epochFacts, publish: (key: string, text: string | null) => publishContextBlock(fake.pi as never, ctx as never, key, text) };
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

	it("is withdrawn on an empty or whitespace-only text, as on null: nothing empty on the tail, nothing in the next epoch", () => {
		for (const empty of ["", "  \n\t "]) {
			const s = session();
			s.publish("layout", "A");
			const told = s.epochFacts();
			s.publish("layout", empty);
			expect(s.live.stackEntries()).toEqual([]);
			const withdrawal = { text: contextBlockText.withdrawn("layout"), facts: [toldBlockFact("product:layout", "")] };
			expect(renderRequest(s.fake.events, { facts: told })).toEqual([withdrawal]);
			// The next epoch's stack has no block, and its tail adds nothing.
			expect(s.epochFacts()).toEqual([]);
			expect(renderRequest(s.fake.events, { epoch: true })).toEqual([]);
			expect(renderRequest(s.fake.events, { facts: s.epochFacts() })).toEqual([]);
			expect(s.payloads.filter((payload) => payload.text === empty)).toEqual([]);
		}
	});

	it("is told again when republished after a withdrawal", () => {
		const s = session();
		s.publish("layout", "A");
		const told = s.epochFacts();
		s.publish("layout", null);
		const withdrawal = renderRequest(s.fake.events, { facts: told });
		expect(withdrawal).toEqual([{ text: contextBlockText.withdrawn("layout"), facts: [toldBlockFact("product:layout", "")] }]);
		s.publish("layout", "A");
		expect(s.live.stackEntries().map((entry) => entry.text)).toEqual(["A"]);
		expect(renderRequest(s.fake.events, { facts: [...told, ...withdrawal[0].facts!] })).toEqual([{ text: "A", facts: [toldBlockFact("product:layout", "A")] }]);
		// Republished before any request told the withdrawal: the epoch still holds "A", so nothing is added.
		s.publish("layout", null);
		s.publish("layout", "A");
		expect(renderRequest(s.fake.events, { facts: told })).toEqual([]);
	});

	describe(`past ${CONTEXT_BLOCK_MAX_BYTES} UTF-8 bytes`, () => {
		const big = (fill: string) => `${fill.repeat(CONTEXT_BLOCK_MAX_BYTES)} tail`;
		/** The file a pointer names, found by its name under the session's tool-results folder (a temp path may hold spaces). */
		const pointerFile = (text: string, dir: string) => {
			const name = text.match(/context-layout-[0-9a-f]+\.txt/)?.[0];
			const file = name && join(dir, "tool-results", name);
			return file && text.includes(file) ? file : undefined;
		};

		it("is persisted to the session's folder and the block carries the pointer, never a slice", () => {
			const { home } = tempHome("context-block-");
			const s = session(home);
			s.publish("layout", big("x"));
			const text = s.live.stackEntries()[0].text;
			expect(text).toContain("<persisted-output>");
			const file = pointerFile(text, home);
			expect(file?.startsWith(home)).toBe(true);
			expect(readFileSync(file!, "utf8")).toBe(big("x"));
		});

		it("counts bytes, not characters", () => {
			const { home } = tempHome("context-block-");
			const s = session(home);
			// Fewer characters than the bound, more bytes: a two-byte character, half the bound plus one.
			const text = "é".repeat(CONTEXT_BLOCK_MAX_BYTES / 2 + 1);
			expect(text.length).toBeLessThan(CONTEXT_BLOCK_MAX_BYTES);
			s.publish("layout", text);
			expect(s.live.stackEntries()[0].text).toContain("<persisted-output>");
			s.publish("layout", "é".repeat(CONTEXT_BLOCK_MAX_BYTES / 2));
			expect(s.live.stackEntries()[0].text).not.toContain("<persisted-output>");
		});

		it("gives the same pointer for the same text, so republishing it adds nothing", () => {
			const { home } = tempHome("context-block-");
			const s = session(home);
			s.publish("layout", big("x"));
			const first = s.live.stackEntries()[0].text;
			const told = s.epochFacts();
			s.publish("layout", big("x"));
			expect(s.live.stackEntries()[0].text).toBe(first);
			expect(renderRequest(s.fake.events, { facts: told })).toEqual([]);
			// A resumed session (a fresh bus, the same folder) points at the same file.
			const resumed = session(home);
			resumed.publish("layout", big("x"));
			expect(resumed.live.stackEntries()[0].text).toBe(first);
		});

		it("puts the new pointer on the tail when the text changes inside an epoch", () => {
			const { home } = tempHome("context-block-");
			const s = session(home);
			s.publish("layout", "A");
			const told = s.epochFacts();
			s.publish("layout", big("y"));
			const pointer = s.live.stackEntries()[0].text;
			expect(pointerFile(pointer, home)).toBeDefined();
			expect(renderRequest(s.fake.events, { facts: told })).toEqual([{ text: pointer, facts: [toldBlockFact("product:layout", pointer)] }]);
		});
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
		const unresolved: string[] = [];
		for (const file of sourceFiles(EXTENSIONS_DIR, EXTENSIONS_DIR)) {
			if (file.endsWith("context-block.ts")) continue;
			const source = readFileSync(join(EXTENSIONS_DIR, file), "utf8");
			const lines = source.split("\n");
			lines.forEach((line, index) => {
				if (!line.includes('placement: "first-prepend"')) return;
				const near = lines.slice(Math.max(0, index - 6), index + 3).join("\n");
				const found = new Set<string>();
				for (const match of near.matchAll(/\bkey: "([^"]+)"/g)) found.add(match[1]);
				// A key named by an identifier (`key: NAME`, or a typed parameter `key: Type` the shorthand `key` reads): its literal value or values.
				for (const match of near.matchAll(/\bkey: ([A-Za-z_]\w*)/g)) {
					const values = identifierValues(source, match[1]);
					if (values.length === 0) unresolved.push(`${file}:${index + 1} key: ${match[1]}`);
					for (const value of values) found.add(value);
				}
				if (found.size === 0) unresolved.push(`${file}:${index + 1} (no key found near it)`);
				for (const key of found) keys.add(key);
			});
		}
		expect(unresolved).toEqual([]);
		expect([...keys].filter((key) => !BASE_BLOCK_KEYS.has(key))).toEqual([]);
		// Every listed key is one the base uses, so the list cannot drift the other way either.
		expect([...BASE_BLOCK_KEYS].filter((key) => !keys.has(key))).toEqual([]);
	});
});

/** The literal values `name` holds in `source`: a `const` string (the brand's prefix filled in), or a `type` union of string literals. */
function identifierValues(source: string, name: string): string[] {
	const constant = source.match(new RegExp(`const ${name} = ["\`]([^"\`]+)["\`]`))?.[1];
	if (constant) return [constant.replace("${brand.idPrefix}", brand.idPrefix)];
	const union = source.match(new RegExp(`type ${name} = ((?:\\s*\\|?\\s*"[^"]+")+);`))?.[1];
	return union ? [...union.matchAll(/"([^"]+)"/g)].map((match) => match[1]) : [];
}
