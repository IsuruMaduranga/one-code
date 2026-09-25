import { describe, expect, it } from "vitest";
import { AGENT_CRON_CHANNEL, type AgentCronRequest, agentCronTools, BLOCKING_RUN_REFUSAL } from "../../extensions/lib/agent-cron.ts";

/** A bus whose background extension schedules every create. */
function bus() {
	const requests: AgentCronRequest[] = [];
	const events = {
		emit(channel: string, data: unknown) {
			if (channel !== AGENT_CRON_CHANNEL) return;
			const request = data as AgentCronRequest;
			requests.push(request);
			request.result = { text: `handled ${request.op}` };
		},
	};
	return { events, requests };
}

const tool = (tools: ReturnType<typeof agentCronTools>, name: string) => tools.find((t) => t.name === name)!;

describe("agentCronTools", () => {
	it("sends a create with the agent's id and working directory", async () => {
		const { events, requests } = bus();
		const tools = agentCronTools(events, { agentId: "a1", cwd: "/agent-tree", resident: true });
		const result = await (tool(tools, "cron_create").execute as (id: string, p: object) => Promise<{ content: { text: string }[] }>)("c", { cron: "*/5 * * * *", prompt: "tick" });
		expect(result.content[0].text).toBe("handled create");
		expect(requests).toMatchObject([{ op: "create", agentId: "a1", cwd: "/agent-tree", cron: "*/5 * * * *", prompt: "tick" }]);
	});

	it("keeps all three tools in a run that is not resident, where cron_create refuses and schedules nothing", async () => {
		const { events, requests } = bus();
		const tools = agentCronTools(events, { agentId: "a1", cwd: "/project", resident: false });
		expect(tools.map((t) => t.name)).toEqual(["cron_create", "cron_list", "cron_delete"]);
		const result = await (tool(tools, "cron_create").execute as (id: string, p: object) => Promise<{ content: { text: string }[]; isError?: boolean }>)("c", { cron: "*/5 * * * *", prompt: "tick" });
		expect(result).toMatchObject({ content: [{ text: BLOCKING_RUN_REFUSAL }], isError: true });
		expect(requests).toEqual([]);
		await tool(tools, "cron_list").execute("c", {} as never);
		expect(requests).toMatchObject([{ op: "list", agentId: "a1" }]);
	});
});
