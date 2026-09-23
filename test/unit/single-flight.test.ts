import { describe, expect, it } from "vitest";
import { singleFlight } from "../../extensions/lib/single-flight.ts";

describe("singleFlight", () => {
	it("shares one pending run per key and starts fresh once it settles", async () => {
		const once = singleFlight<number>();
		let runs = 0;
		let release: (value: number) => void = () => {};
		const run = () => {
			runs++;
			return new Promise<number>((resolve) => {
				release = resolve;
			});
		};
		const first = once("server", run);
		const second = once("server", run);
		expect(second).toBe(first);
		expect(runs).toBe(1);
		release(7);
		expect(await second).toBe(7);
		await once("server", async () => {
			runs++;
			return 8;
		});
		expect(runs).toBe(2);
	});

	it("runs different keys independently and clears a key after a rejection", async () => {
		const once = singleFlight<string>();
		const a = once("a", async () => "a");
		const b = once("b", async () => "b");
		expect(await Promise.all([a, b])).toEqual(["a", "b"]);
		await expect(once("a", async () => Promise.reject(new Error("spawn failed")))).rejects.toThrow("spawn failed");
		expect(await once("a", async () => "again")).toBe("again");
	});
});
