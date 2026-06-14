// Middle-truncation for long identifiers shown in fixed-width fields.
//
// CSS text-overflow can only ellipsize at the END of a string; parameter
// names like "cap_sep_outer_signal_finger" lose their most distinguishing
// part (the suffix) that way. middleTruncate keeps both ends:
//   "cap_sep_outer_signal_finger" → "cap_se…finger"
// so the family prefix AND the specific tail stay visible. The full name
// is always available via the field's hover tooltip.

// Approx width (px) of one monospace character at the PARAMS panel's
// 11px font. Used to turn a pixel column width into a character budget.
export const PARAM_NAME_CHAR_PX = 6.6;

export function charsForWidthPx(px) {
  const n = Number(px);
  if (!Number.isFinite(n) || n <= 0) return 4;
  return Math.max(4, Math.floor(n / PARAM_NAME_CHAR_PX));
}

// Keep the first ~half and last ~half of `str`, joined by an ellipsis, so
// the result is at most `maxChars` glyphs (the '…' counts as one). Returns
// the string unchanged when it already fits or maxChars is too small to be
// meaningful (< 4).
export function middleTruncate(str, maxChars) {
  if (typeof str !== 'string') return str;
  if (!Number.isFinite(maxChars) || maxChars < 4 || str.length <= maxChars) return str;
  const head = Math.ceil((maxChars - 1) / 2);
  const tail = Math.floor((maxChars - 1) / 2);
  return str.slice(0, head) + '…' + str.slice(str.length - tail);
}
