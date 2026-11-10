/**
 * Read-only commands a profile declares for its own tools (pure;
 * working-docs/decisions/bi-fork.md): a command name, its read-only
 * subcommands, and for each the options it may carry, in the same
 * option-table form as the base's own (read-only-options.ts). `bal discover`
 * and `bal search` read a package registry and write nothing in the project.
 *
 * The shell pre-gate then treats `<command> <subcommand> …` with only the
 * listed options as a read: it runs in plan mode and skips the classifier
 * in auto mode. The profile is trusted product configuration, like its
 * classifier ruleset, and the pre-gate's rule holds: an option outside the
 * table, another subcommand or a bare command escalates, so a gap costs one
 * classifier call, never a bypass. A declared command's operands are names
 * (a package, a keyword), never read as files; each must be one short word
 * (`isNameOperand`), since such a command may reach the network.
 *
 * Bash only: the PowerShell pre-gate clears no external program by name.
 */

import { type OptionSpec, READ_ONLY_SPECS, table } from "./read-only-options.ts";

/** The options one read-only subcommand may carry, as space-separated lists. */
export interface ReadOnlySubcommand {
	/** Options that take no value (`--refresh`). */
	none?: string;
	/** Options that take a value, attached or as the next word (`--filter`, `-m`). */
	required?: string;
}

/** Command name, then subcommand name. */
export type ReadOnlyCommands = Readonly<Record<string, Readonly<Record<string, ReadOnlySubcommand>>>>;

const NAME = /^[a-z][a-z0-9_-]*$/;
/** `-m` or `--module`: the pre-gate reads a single dash followed by letters as a cluster of short options, so `-module` could never match. */
const OPTION = /^(-[A-Za-z0-9]|--[A-Za-z0-9][A-Za-z0-9-]*)$/;

/**
 * An operand of a declared subcommand is a name (a package, a keyword, a
 * selector): one short word. The command may reach the network, so a long
 * or multi-word operand, which could carry a file's contents out, is not
 * cleared and goes to the classifier.
 */
export const MAX_NAME_OPERAND = 100;
export function isNameOperand(value: string): boolean {
	return value.length <= MAX_NAME_OPERAND && !/\s/.test(value);
}

/** Commands the base judges itself: a profile entry could only weaken that judgement. */
const BASE_JUDGED = new Set([...Object.keys(READ_ONLY_SPECS), "git", "find"]);

/** A subcommand's option table, parsed the way the pre-gate will read it. */
const subcommandTable = (options: ReadOnlySubcommand): OptionSpec => table({ none: options.none ?? "", required: options.required ?? "" });

/** The problems in a profile's read-only commands, for the resolver to report with the rest. */
export function readOnlyCommandProblems(commands: ReadOnlyCommands): string[] {
	const problems: string[] = [];
	for (const [command, subcommands] of Object.entries(commands)) {
		if (!NAME.test(command)) problems.push(`read-only command "${command}" must be a bare lowercase command name`);
		if (BASE_JUDGED.has(command)) problems.push(`read-only command "${command}" is one the base judges itself`);
		const entries = Object.entries(subcommands ?? {});
		if (entries.length === 0) problems.push(`read-only command "${command}" lists no subcommand: a whole command is never read-only by name`);
		for (const [subcommand, options] of entries) {
			if (!NAME.test(subcommand)) problems.push(`read-only subcommand "${command} ${subcommand}" must be a bare lowercase name`);
			for (const option of Object.keys(subcommandTable(options).options)) {
				if (!OPTION.test(option)) problems.push(`"${option}" is not an option of "${command} ${subcommand}"`);
			}
		}
	}
	return problems;
}

/** The option table of each declared subcommand, by command then subcommand. */
export function readOnlyCommandSpecs(commands: ReadOnlyCommands): ReadonlyMap<string, ReadonlyMap<string, OptionSpec>> {
	return new Map(
		Object.entries(commands).map(([command, subcommands]) => [
			command,
			new Map(Object.entries(subcommands).map(([subcommand, options]) => [subcommand, subcommandTable(options)])),
		]),
	);
}
