/**
 * Contract with the installed pi-ai: whatever shape its Responses adapter puts
 * on the wire, the ledger's readers (lib/ledger/wire.ts) find every declared
 * tool and the start of the conversation. pi 1.4.0 moved the starting tools
 * into an `additional_tools` item for models flagged for mid-conversation
 * system messages and additional tools (findings §78); a later pi may move
 * them again, and this test is the tripwire.
 *
 * Each case renders a request through pi-ai's real adapter (its `onPayload`
 * hook captures the body before anything is sent) for one combination of the
 * catalog flags that choose the shape, at the start of a conversation and
 * after a tool added mid-conversation. CI runs it against the oldest pi in the
 * tested range too: ONE_CODE_PI_AI names another pi-ai package directory.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { preludeLength, responsesDeclarations } from "../../extensions/lib/ledger/wire.ts";

const root = process.env.ONE_CODE_PI_AI;
const load = (subpath: string) => import(root ? pathToFileURL(join(root, "dist", `${subpath}.js`)).href : `@earendil-works/pi-ai/${subpath}`);
const { streamSimple } = await load("api/openai-responses");
const { normalizeContext } = await load("utils/transcript");

type Body = Record<string, unknown> & { input: Record<string, unknown>[] };

const tool = (name: string) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} } });
const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp });
const reply = { role: "assistant", content: [{ type: "text", text: "ok" }], api: "openai-responses", provider: "openai", model: "contract", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 };

const FLAGS: Record<string, Record<string, boolean>> = {
	"no tool flags": {},
	"tool search": { supportsToolSearch: true },
	"additional tools": { supportsAdditionalTools: true },
	"mid-conversation system messages": { supportsMidConvoSystemMessages: true },
	"mid-conversation system messages and additional tools": { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsToolSearch: true },
};

/** The body pi-ai's Responses adapter would send for this context and these flags. */
async function render(compat: Record<string, boolean>, messages: unknown[]): Promise<Body> {
	const model = { id: "contract", name: "contract", api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat };
	let body: Body | undefined;
	const context = normalizeContext({ systemPrompt: "You are the contract prompt.", tools: [tool("read"), tool("bash")], messages });
	await streamSimple(model, context, {
		apiKey: "contract-key",
		maxRetries: 0,
		onPayload: (payload: unknown) => {
			body = payload as Body;
			throw new Error("captured before dispatch");
		},
	}).result();
	if (!body) throw new Error("pi-ai never built a body");
	return body;
}

const names = (body: Body) => [...responsesDeclarations(body, "openai-responses").keys()].sort();

describe.each(Object.entries(FLAGS))("pi-ai's Responses shape with %s", (_label, compat) => {
	it("declares the starting tools where the ledger finds them, and the prelude ends at the conversation", async () => {
		const body = await render(compat, [user("hi", 1)]);
		expect(names(body)).toEqual(["bash", "read"]);
		expect(body.input[preludeLength(body.input, "openai-responses")]).toMatchObject({ role: "user" });
	});

	it("declares a tool added mid-conversation where the ledger finds it", async () => {
		const added = { role: "system", content: "", toolsAdded: [tool("web_fetch")], timestamp: 3 };
		const body = await render(compat, [user("hi", 1), reply, added, user("next", 4)]);
		expect(names(body)).toEqual(["bash", "read", "web_fetch"]);
		expect(body.input[preludeLength(body.input, "openai-responses")]).toMatchObject({ role: "user" });
	});
});
