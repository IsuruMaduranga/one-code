/** The first 16 hex characters of a text's SHA-256: the short hash the wording tests lock a long text with. */
import { createHash } from "node:crypto";

export const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
