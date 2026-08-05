/**
 * RPC child protocol state (pure) — line-wise parsing for a `pi --mode rpc`
 * child. RPC events are the same objects json mode emits (shared toJsonEvent),
 * interleaved with `response` acks and `extension_ui_request` dialogs. This
 * tracker accumulates per-turn output and cumulative stats, and tells the
 * caller when it must act (answer a UI request, settle a pending turn).
 */

import { addUsage, emptyUsage, type UsageTotals } from "./usage.ts";

export type RpcAction =
	| { kind: "ui_request"; id: string }
	| { kind: "stream_start" }
	| { kind: "turn_end" }
	| { kind: "progress" };

export class RpcTurnTracker {
	toolCalls = 0;
	readonly usage: UsageTotals = emptyUsage();
	/** Final assistant text of the turn in progress (or the last finished one). */
	turnText = "";
	/** Every turn's final text, for task_output on a resident agent. */
	transcript = "";
	/** A prompt has been sent and its agent_end not yet seen. */
	busy = false;
	/**
	 * The child's agent loop is actually running (its agent_start seen). Between
	 * a prompt being sent and this flipping true, the child is still booting —
	 * a steer sent in that window would miss the turn.
	 */
	streaming = false;

	beginTurn(): void {
		this.busy = true;
		this.turnText = "";
	}

	process(line: string): RpcAction | undefined {
		if (!line.trim()) return undefined;
		let event: {
			type?: string;
			id?: string;
			message?: { role?: string; content?: unknown; usage?: unknown };
		};
		try {
			event = JSON.parse(line);
		} catch {
			return undefined;
		}

		switch (event.type) {
			case "extension_ui_request":
				return typeof event.id === "string" ? { kind: "ui_request", id: event.id } : undefined;
			case "agent_start":
				this.streaming = true;
				return { kind: "stream_start" };
			case "tool_execution_start":
				this.toolCalls++;
				return { kind: "progress" };
			case "message_end": {
				if (event.message?.role !== "assistant") return undefined;
				addUsage(this.usage, event.message.usage);
				const blocks = Array.isArray(event.message.content) ? event.message.content : [];
				const text = blocks
					.filter((b): b is { type: string; text: string } => (b as { type?: string }).type === "text")
					.map((b) => b.text)
					.join("");
				if (text.trim()) this.turnText = text;
				return { kind: "progress" };
			}
			case "agent_end":
				this.busy = false;
				this.streaming = false;
				if (this.turnText.trim()) {
					this.transcript = this.transcript ? `${this.transcript}\n\n---\n\n${this.turnText}` : this.turnText;
				}
				return { kind: "turn_end" };
			default:
				return undefined;
		}
	}
}
