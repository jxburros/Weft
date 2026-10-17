// Per-test time budgets scale with WEFT_TEST_TIME_SCALE (default 1). CI sets a larger scale on runners whose
// synced disk writes are much slower (Windows), so hang guards stay tight elsewhere without failing there.
const scale = Math.max(1, Number(process.env.WEFT_TEST_TIME_SCALE) || 1);
export const budget = ms => Math.round(ms * scale);
