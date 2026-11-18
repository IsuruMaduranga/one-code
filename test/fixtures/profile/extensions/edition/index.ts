/**
 * A product extension that every profile of the fixture product runs, with
 * wording per profile, as a product's extension words its prompt section for
 * the profile it serves: it reads `productProfile()` once, at load (the
 * profile is fixed for the process), and its section's bytes never move
 * inside a session (`product-extension.test.ts`).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { productExtension, productProfile, SYSTEM_PROMPT_SECTION_CHANNEL, type SystemPromptSection } from "../../../extensions/sdk/extension.ts";

/** The section's text under the product profile `id` (undefined: a default profile at `profile/` itself). */
export const editionSection = (id: string | undefined) => `[fixture:edition ${id ?? "default"}]`;

export default productExtension("edition", (pi: ExtensionAPI) => {
	const text = editionSection(productProfile());
	pi.events.emit(SYSTEM_PROMPT_SECTION_CHANNEL, { id: "fixture-edition", place: "tail", render: () => text } satisfies SystemPromptSection);
});
