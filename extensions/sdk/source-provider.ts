/**
 * What a profile's source provider imports from the base (lib/sources.ts): the
 * settings and instruction-file helpers a provider builds its view from. It
 * loads with the provider, which the base loads on first use, apart from the
 * profile's text (`profile.ts`), so a profile without a provider never loads
 * these helpers. Keep it free of pi value imports (`shared-module-graph.test.ts`).
 */
export { readJsonFile } from "../lib/atomic-write.ts";
export { envName } from "../lib/brand.mjs";
export { readExternalIncludesApproval } from "../lib/claude-external-includes.ts";
export { discoverRules, readRuleInstructions, type RuleFile, type RuleOptions } from "../lib/claude-rules.ts";
export { claudeUserSettingsPath, managedSettingsPaths, readSettingsFile } from "../lib/claude-settings.ts";
export type { InstructionSource } from "../lib/context-text.ts";
export { AGENTS_DESCRIPTOR, AGENTS_GLOBAL_DESCRIPTOR, AGENTS_SOURCES, GLOBAL_DESCRIPTOR, GLOBAL_SOURCES, LOCAL_DESCRIPTOR, MANAGED_DESCRIPTOR, PRODUCT_DESCRIPTOR, PRODUCT_GLOBAL_DESCRIPTOR, PROJECT_DESCRIPTOR, ancestorDirs, basePaths, expandWithImports, firstProductFile, importReaders, isPresentFile, nestedDirs, readFileIfPresent, type ClassifierFile, type ContextFile, type ContextFilePath, type InstructionView, type NestedFile } from "../lib/instructions.ts";
export { isClaudeFamilyModel } from "../lib/model-family.ts";
export { absoluteFrom, claudeJsonPath, claudeManagedDir, claudeUserDir, isClaudeLocation, isPathAtOrUnder, productStateDir, tildify, tryRealpath } from "../lib/paths.ts";
export { productSettingsPath, readSettingsForWrite, writeSettings } from "../lib/product-settings.ts";
export type { EnvAlias, McpFile, SettingsFile, SourceProvider, SourceSwitch } from "../lib/sources.ts";
export { findProjectConfigs } from "../mcp/config.ts";
