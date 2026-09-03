/**
 * Wire probe: dump every provider request AFTER this package's mutations.
 * debug-capture.ts records requests before them (findings §8); this one hooks
 * `before_provider_request`, so it shows exactly what the model receives —
 * where each <system-reminder> block landed, tool schemas, message order.
 *
 *   WIRE_DUMP=/tmp/wire.jsonl pi -e test/e2e/dump-requests.ts --mode json -p "…"
 *
 * One JSON line per request. Used 2026-09-04 to verify the sticky-append
 * reminder placement (docs/decisions/tools.md, "Three reminder placements").
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function dump(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) => {
		const out = process.env.WIRE_DUMP ?? "/tmp/wire-dump.jsonl";
		appendFileSync(out, JSON.stringify(event.payload) + "\n");
	});
}
