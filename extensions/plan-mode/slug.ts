/**
 * Three-word plan-file slugs (pure), Claude Code style: `now-snoopy-tome`.
 * Collision handling lives in index.ts — it needs the filesystem, this doesn't.
 */

const WORDS = [
	"amber", "arrow", "aspen", "atlas", "badge", "basil", "beacon", "birch",
	"bloom", "breeze", "brisk", "cedar", "chalk", "cliff", "clover", "coral",
	"crane", "crisp", "delta", "drift", "dune", "ember", "fable", "fern",
	"flint", "gale", "glade", "grove", "harbor", "hazel", "heron", "ivory",
	"jade", "juniper", "keel", "kite", "lark", "ledge", "linen", "lunar",
	"maple", "marsh", "meadow", "mesa", "mist", "moss", "north", "oak",
	"olive", "onyx", "opal", "orchard", "otter", "pebble", "pine", "plume",
	"prairie", "quill", "reef", "ridge", "river", "robin", "rowan", "sable",
	"sage", "shale", "shore", "slate", "snug", "spark", "spruce", "starling",
	"stone", "summit", "swift", "thorn", "tide", "timber", "tome", "trail",
	"tundra", "umber", "vale", "vesper", "violet", "wander", "willow", "wren",
];

/** Three distinct words joined by `-`. Inject `rng` for deterministic tests. */
export function randomSlug(rng: () => number = Math.random): string {
	const picked: string[] = [];
	while (picked.length < 3) {
		const word = WORDS[Math.floor(rng() * WORDS.length) % WORDS.length];
		if (!picked.includes(word)) picked.push(word);
	}
	return picked.join("-");
}
