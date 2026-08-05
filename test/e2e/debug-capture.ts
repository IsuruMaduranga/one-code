/**
 * E2E helper — appends every raw provider request payload (one JSON per line)
 * to the file named by CC_E2E_LOG. Load with `pi -e`.
 */

import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function debugCapture(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) => {
		const logPath = process.env.CC_E2E_LOG;
		if (logPath) {
			appendFileSync(logPath, `${JSON.stringify(event.payload)}\n`);
		}
	});
}
