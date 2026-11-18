/**
 * The fixture product's second profile, which a launch chooses with `--Alt`
 * (lib/profile/brand.mjs): the default one (../Main) with the notebook tool
 * off, under its own name and state folder (brand.json), running only the
 * `edition` extension of the product's two. It shows a product can ship
 * several profiles; the catalogs and extensions are the product's.
 */
import type { Profile } from "../../../extensions/sdk/profile.ts";
import { profile as base } from "../Main/index.ts";

export const profile: Profile = { ...base, features: { ...base.features, notebook: false }, extensions: ["edition"] };
