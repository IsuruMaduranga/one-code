/** Types for the plain-JS exit probe policy (test/e2e/exit-probe-policy.mjs). */
declare module "*/exit-probe-policy.mjs" {
	export interface ProbeProcess {
		pid: number;
		ppid: number;
		command: string;
	}
	export interface Expectation {
		verdict: "gone" | "may survive" | "open";
		reason: string;
	}
	export const SPAWNERS: Array<{ id: string; what: string }>;
	export const ENDINGS: Array<{ id: string; label: string; starts: string[]; posix?: boolean; tui?: boolean; alive?: boolean; keeps?: boolean }>;
	export function expectation(spawner: string, ending: string, platform?: string): Expectation;
	export function spawnerOf(commandLine: string, tag: string): string;
	export function parsePs(output: string, tag: string): ProbeProcess[];
	export function keptOutcome(cell: { seen: boolean; before: ProbeProcess[]; after: ProbeProcess[] }): { status: string; fails: boolean; ended?: ProbeProcess[] };
	export function cellOutcome(expected: { verdict: string }, cell: { seen: boolean; survivors: ProbeProcess[] }): { status: string; fails: boolean };
}
