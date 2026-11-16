/** Types for the plain-JS offline e2e harness (test/e2e/lib/harness.mjs), as far as unit tests use it. */
declare module "*/e2e/lib/harness.mjs" {
	export interface RpcClient {
		send(command: Record<string, unknown>): Promise<Record<string, unknown>>;
		write(command: Record<string, unknown>): void;
		waitFor(match: (event: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
		onEvent(listener: (event: Record<string, unknown>) => void): () => void;
	}
	export function rpcClient(
		child: { stdout: NodeJS.ReadableStream & { setEncoding(encoding: BufferEncoding): unknown }; stdin: NodeJS.WritableStream },
		onDialog?: (event: Record<string, unknown>) => { value?: unknown } | undefined,
	): RpcClient;
}
