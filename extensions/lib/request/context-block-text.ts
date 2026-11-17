/**
 * The base's words for a product's context block (context-block.ts): the
 * note that a block an epoch told no longer applies. The block's own text
 * is the product's.
 */

export const contextBlockText = {
	withdrawn: (key: string) => `The "${key}" context shown earlier in this conversation no longer applies.`,
};
