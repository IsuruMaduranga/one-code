/** Whether a process is alive, and a bounded wait for a condition on processes. */
export const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Poll every 50 ms, at most `tries` times (3 s by default); the condition's last value. */
export const until = async (condition: () => boolean, tries = 60): Promise<boolean> => {
	for (let i = 0; i < tries && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
	return condition();
};
