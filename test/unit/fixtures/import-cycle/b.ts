import { a } from "./a.ts";
import type { Unused } from "./c.ts";

export const b = (): string => (a.name as Unused);
