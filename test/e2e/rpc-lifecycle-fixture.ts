/** A deterministic notification producer for rpc-lifecycle-test.mjs. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTaskNotifier, taskNotification } from "../../extensions/lib/notifications.ts";

export default function rpcLifecycleFixture(pi: ExtensionAPI) {
	const notify = createTaskNotifier(pi, { coalesceMs: 0 });
	pi.registerCommand("rpc-lifecycle-notify", {
		description: "Emit the RPC lifecycle test notification",
		handler: async () => {
			notify("rpc-lifecycle", taskNotification({
				kind: "shell", taskId: "rpc-fixture", status: "completed",
				summary: "RPC notification fixture completed", result: "NOTIFICATION_MARKER",
			}), { taskId: "rpc-fixture" });
		},
	});
}
