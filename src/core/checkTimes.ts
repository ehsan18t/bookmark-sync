/** Chrome fires alarms at most every 30 seconds; Firefox documents no floor and uses the same one. */
export const MIN_CHECK_SECONDS = 30;
export const MAX_CHECK_SECONDS = 60 * 60;
/** A browser with none of its windows focused for this long checks at the slower interval. */
export const AWAY_AFTER_MINUTES = 10;

export const clampCheckSeconds = (s: number) => Math.min(MAX_CHECK_SECONDS, Math.max(MIN_CHECK_SECONDS, Math.round(s)));
