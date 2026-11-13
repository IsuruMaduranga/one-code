/**
 * The fixture product's second profile, which a launch chooses with `--Alt`
 * (lib/profile/brand.mjs): the default one with the notebook tool off, under
 * its own name and state folder (brand.json). It shows a product can ship
 * several profiles; the catalogs and extensions are the product's.
 */
import type { Profile } from "../../../extensions/sdk/profile.ts";
import { profile as base } from "../../index.ts";

export const profile: Profile = { ...base, features: { ...base.features, notebook: false } };
