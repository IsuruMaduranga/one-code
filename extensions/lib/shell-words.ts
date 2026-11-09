/**
 * The profile's shell words for the modules bash and powershell share
 * (lib/shell-tool.ts, lib/shell-result.ts, lib/shell-run/bash-background.ts, the guards).
 * Both extensions check the group at load (`requireText` in their index.ts).
 */

import { requireText } from "./profile.ts";
import type { ShellText } from "./shell-text.ts";

export const shellWords = (): ShellText => requireText("shell");
