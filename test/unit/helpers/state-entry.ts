import { makeRecord, RECORD } from "../../../extensions/lib/ledger/records.ts";

/** A `one-code:state` entry on a branch, as `recordState` writes one (lib/ledger/state.ts). */
export const stateEntry = (key: string, value: unknown) => ({ type: "custom", id: `s-${key}`, parentId: null, customType: RECORD.state, data: makeRecord("state", "0.6.0", { key, value }) });
