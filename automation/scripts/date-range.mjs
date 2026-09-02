// Shared validation and iteration for the explicit inclusive UTC day range
// every acquisition and transform script requires as FROM_DAY/THROUGH_DAY.
// Kept in one place so the scripts cannot drift from each other on what
// counts as a valid range — no script works out a period for itself; the
// caller always states one.
//
// Days are handled as "YYYY-MM-DD" strings wherever possible: two ISO day
// strings compare and sort correctly with plain string operators, which keeps
// every script free of local-time-zone drift from Date arithmetic.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');

// Validate that `value` is both shaped like an ISO UTC day and a real
// calendar date — rejects e.g. "2026-02-30", which Date would otherwise
// silently roll into March.
export function requireDay(name, value) {
  if (!value) throw new Error(`${name} is not set.`);
  if (!DAY_RE.test(value)) {
    throw new Error(`${name} must be an ISO UTC date (YYYY-MM-DD); got ${JSON.stringify(value)}.`);
  }
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new Error(`${name} is not a valid calendar date: ${value}.`);
  }
  return value;
}

export function addDays(day, n) {
  requireDay('day', day);
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + n));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// Validate FROM_DAY/THROUGH_DAY and return them as the canonical inclusive
// range every script requires. Throws on missing, malformed, impossible, or
// reversed dates — the caller decides how to report that (a script exits 2;
// a test asserts the thrown message).
export function requireDayRange(fromDay, throughDay) {
  requireDay('FROM_DAY', fromDay);
  requireDay('THROUGH_DAY', throughDay);
  if (fromDay > throughDay) {
    throw new Error(`FROM_DAY (${fromDay}) must not be after THROUGH_DAY (${throughDay}).`);
  }
  return { fromDay, throughDay };
}

// Every "YYYY-MM-DD" day in the inclusive range, ascending. Empty when
// fromDay is after throughDay, so callers can pass a possibly-empty window
// without a separate guard.
export function dayRange(fromDay, throughDay) {
  const days = [];
  for (let d = fromDay; d <= throughDay; d = addDays(d, 1)) days.push(d);
  return days;
}
