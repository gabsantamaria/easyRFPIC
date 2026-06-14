// Middle-truncation used by the PARAMS panel's resizable name column.
import { describe, it, expect } from 'vitest';
import { middleTruncate, charsForWidthPx, PARAM_NAME_CHAR_PX } from '../src/ui/text-truncate.js';

describe('middleTruncate', () => {
  it('returns the string unchanged when it already fits', () => {
    expect(middleTruncate('w_wg', 10)).toBe('w_wg');
    expect(middleTruncate('exactly_ten', 11)).toBe('exactly_ten');
  });

  it('keeps the head and tail joined by an ellipsis, within the budget', () => {
    const out = middleTruncate('cap_sep_outer_signal_finger', 13);
    expect(out).toContain('…');
    expect(out.startsWith('cap_')).toBe(true);      // family prefix preserved
    expect(out.endsWith('finger')).toBe(true);      // distinguishing tail preserved
    expect([...out].length).toBeLessThanOrEqual(13); // glyph budget (… counts as 1)
  });

  it('splits head/tail deterministically', () => {
    // maxChars 7 → head ceil(6/2)=3, tail floor(6/2)=3 → "abc…xyz"
    expect(middleTruncate('abcdefghijklmnopqrstuvwxyz', 7)).toBe('abc…xyz');
    // maxChars 6 → head 3, tail 2 → "abc…yz"
    expect(middleTruncate('abcdefghijklmnopqrstuvwxyz', 6)).toBe('abc…yz');
  });

  it('does not truncate when the budget is too small to be meaningful (<4)', () => {
    expect(middleTruncate('cap_sep_outer', 3)).toBe('cap_sep_outer');
    expect(middleTruncate('cap_sep_outer', 0)).toBe('cap_sep_outer');
  });

  it('passes non-strings through untouched', () => {
    expect(middleTruncate(undefined, 10)).toBe(undefined);
    expect(middleTruncate(42, 10)).toBe(42);
  });
});

describe('charsForWidthPx', () => {
  it('converts a pixel width into a character budget at the panel font size', () => {
    expect(charsForWidthPx(80)).toBe(Math.floor(80 / PARAM_NAME_CHAR_PX)); // 12
    expect(charsForWidthPx(200)).toBe(Math.floor(200 / PARAM_NAME_CHAR_PX)); // 30
  });

  it('clamps to a minimum of 4 and tolerates bad input', () => {
    expect(charsForWidthPx(10)).toBe(4);
    expect(charsForWidthPx(0)).toBe(4);
    expect(charsForWidthPx(undefined)).toBe(4);
    expect(charsForWidthPx(-50)).toBe(4);
  });

  it('a wider column shows more of the name (fewer truncations)', () => {
    const name = 'cap_sep_outer_signal_finger'; // 27 chars
    const narrow = middleTruncate(name, charsForWidthPx(80));   // ~12 chars
    const wide = middleTruncate(name, charsForWidthPx(220));    // ~33 → no truncation
    expect(narrow).toContain('…');
    expect(wide).toBe(name);
  });
});
