/**
 * One Code's saved artifacts call the gallery's download global by the name
 * they were written with, so the name the brand gives must not move.
 */
import { expect, it } from "vitest";
import { DOWNLOAD_GLOBAL } from "../../extensions/tools/artifacts/gallery.ts";

it("keeps the download global One Code's saved artifacts call", () => {
	expect(DOWNLOAD_GLOBAL).toBe("oneCodeArtifactDownload");
});
