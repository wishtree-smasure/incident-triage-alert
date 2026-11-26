/**
 * Number formatting that matches Python's, so the dashboard reads exactly as before:
 * Python rounds a tie to the even neighbour (round(2.5) == 2), JavaScript rounds it up.
 */

/** Python's round(x) for 0 digits: banker's rounding. */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Python's f"{x:.{digits}f}". */
export function fixed(x: number, digits: number): string {
  const scaled = x * 10 ** digits;
  if (Math.abs(scaled % 1) === 0.5) {
    return (roundHalfEven(scaled) / 10 ** digits).toFixed(digits);
  }
  return x.toFixed(digits);
}

/** Python's f"{x:,.{digits}f}" (thousands separators). */
export function comma(x: number, digits = 0): string {
  const [int, frac] = fixed(x, digits).split(".");
  const sign = int.startsWith("-") ? "-" : "";
  const grouped = int.replace("-", "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + grouped + (frac !== undefined ? `.${frac}` : "");
}

/** Python's f"{x:.{digits}%}". */
export function percent(x: number, digits = 1): string {
  return `${fixed(x * 100, digits)}%`;
}

/** Python's f"{n:02d}". */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
