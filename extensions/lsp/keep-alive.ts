/**
 * Hold the event loop open while language-server work is in flight. LspClient
 * unrefs its child process, stdio pipes, and timeout timers (so a finished
 * one-shot `pi -p` run can exit without waiting on an idle server); the flip
 * side is that when an await on the LS is the ONLY pending work — exactly the
 * case while a tool executes in a one-shot run — node's loop drains and the
 * process exits 0 mid-await, silently ending the run right after
 * tool_execution_start. Wrap each outermost LS await in this; keeping the ref
 * at the call sites (not inside the client) preserves drain-on-idle for
 * everything not actively awaited. docs/one-shot-lsp-event-loop-drain.md.
 */
export async function withKeepAlive<T>(work: () => Promise<T>): Promise<T> {
	const keepAlive = setInterval(() => {}, 1_000);
	try {
		return await work();
	} finally {
		clearInterval(keepAlive);
	}
}
