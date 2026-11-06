/** What `/init` needs from a profile (types only): the prompt it submits as a user turn, for the file it writes. */
export interface InitText {
	prompt(file: string): string;
}
