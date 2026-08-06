/**
 * Auto-mode pause tracking and the denial log (pure).
 *
 * Claude Code pauses auto mode after 3 consecutive or 20 total classifier
 * blocks in a session and falls back to prompting; approving a prompted action
 * resumes it. The point is that a model stuck in a loop the classifier keeps
 * refusing should reach the user rather than grinding through refusals, and
 * that a session where the classifier has fired 20 times is a session whose
 * premise the user should re-examine.
 */

export const CONSECUTIVE_BLOCK_LIMIT = 3;
export const TOTAL_BLOCK_LIMIT = 20;

export interface Denial {
	toolName: string;
	/** The command or path the call targeted, for the /permissions listing. */
	subject: string;
	/** The cited rule's own text — checked, not paraphrased. */
	reason: string;
	tier?: string;
	/** Validated rule id, so a false positive can be traced to the rule to edit. */
	ruleId?: string;
	/**
	 * The classifier's own wording. Kept so this class of failure is diagnosable
	 * rather than anecdotal: a reason that reads oddly is visible next to the rule
	 * it claimed, instead of being the only thing on record.
	 */
	raw?: string;
}

export class PauseTracker {
	private consecutive = 0;
	private total = 0;
	private paused = false;
	private readonly denials: Denial[] = [];

	/** Record a classifier block. Returns true if this one tripped the pause. */
	recordBlock(denial: Denial): boolean {
		this.consecutive++;
		this.total++;
		this.denials.push(denial);
		if (this.paused) return false;

		if (this.consecutive >= CONSECUTIVE_BLOCK_LIMIT) {
			this.paused = true;
			return true;
		}
		if (this.total >= TOTAL_BLOCK_LIMIT) {
			this.paused = true;
			// The total counter resets when it is what triggered the fallback.
			// Without this, resuming leaves it at the limit and the very next block
			// re-pauses immediately, making the resume single-use.
			this.total = 0;
			return true;
		}
		return false;
	}

	/** A classifier approval breaks a consecutive-block run. */
	recordAllow(): void {
		this.consecutive = 0;
	}

	/**
	 * The user approved a prompted call, so auto mode picks back up. The
	 * consecutive counter resets with it — otherwise the very next block would
	 * re-pause immediately and the resume would be meaningless.
	 */
	resume(): void {
		this.paused = false;
		this.consecutive = 0;
	}

	isPaused(): boolean {
		return this.paused;
	}

	/** Most recent first, for the `/permissions` "recently denied" listing. */
	recentDenials(limit = 10): Denial[] {
		return this.denials.slice(-limit).reverse();
	}

	/**
	 * `total` is the counter that drives the fallback and resets when it fires;
	 * `lifetime` is every block this session, which is what to show a user.
	 */
	stats(): { consecutive: number; total: number; lifetime: number; paused: boolean } {
		return {
			consecutive: this.consecutive,
			total: this.total,
			lifetime: this.denials.length,
			paused: this.paused,
		};
	}
}
