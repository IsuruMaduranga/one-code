/**
 * What a profile's source provider imports from the base (lib/profile/sources.ts): the
 * settings and instruction-file helpers a provider builds its view from. It
 * loads with the provider, which the base loads on first use, apart from the
 * profile's text (`profile.ts`), so a profile without a provider never loads
 * these helpers. Keep it free of pi value imports (`shared-module-graph.test.ts`).
 */
export { readJsonFile } from "../lib/core/atomic-write.ts";
export { envName } from "../lib/profile/brand.mjs";
export { readExternalIncludesApproval } from "../lib/context/claude-external-includes.ts";
export { discoverRules, readRuleInstructions, type RuleFile, type RuleOptions } from "../lib/context/claude-rules.ts";
export { claudeUserSettingsPath, managedSettingsPaths, readSettingsFile } from "../lib/profile/claude-settings.ts";
export type { InstructionSource } from "../lib/context/context-text.ts";
export { AGENTS_DESCRIPTOR, AGENTS_GLOBAL_DESCRIPTOR, AGENTS_SOURCES, GLOBAL_DESCRIPTOR, GLOBAL_SOURCES, LOCAL_DESCRIPTOR, MANAGED_DESCRIPTOR, PRODUCT_DESCRIPTOR, PRODUCT_GLOBAL_DESCRIPTOR, PROJECT_DESCRIPTOR, ancestorDirs, basePaths, expandWithImports, firstProductFile, importReaders, isPresentFile, nestedDirs, readFileIfPresent, type ClassifierFile, type ContextFile, type ContextFilePath, type InstructionView, type NestedFile } from "../lib/context/instructions.ts";
export { isClaudeFamilyModel } from "../lib/models/model-family.ts";
export { absoluteFrom, claudeJsonPath, claudeManagedDir, claudeUserDir, isClaudeLocation, isPathAtOrUnder, productStateDir, tildify, tryRealpath } from "../lib/profile/paths.ts";
export { productSettingsPath, readSettingsForWrite, writeSettings } from "../lib/profile/product-settings.ts";
export type { EnvAlias, McpFile, SettingsFile, SourceProvider, SourceSwitch } from "../lib/profile/sources.ts";
export { findProjectConfigs } from "../mcp/config.ts";
