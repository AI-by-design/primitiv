// Token values are kept exactly as their source wrote them. This module only
// canonicalizes a deliberately small, provably equivalent CSS subset for
// comparisons — it must never become a general-purpose value rewriter.

const LENGTH_CATEGORIES = new Set(["spacing", "sizes", "borderRadius"])
const LENGTH_UNITS = new Set([
  "px",
  "rem",
  "em",
  "ex",
  "ch",
  "ic",
  "lh",
  "rlh",
  "vw",
  "vh",
  "vmin",
  "vmax",
  "svw",
  "svh",
  "lvw",
  "lvh",
  "dvw",
  "dvh",
  "cm",
  "mm",
  "q",
  "in",
  "pt",
  "pc"
])
const NUMERIC_UNITS = new Set([...LENGTH_UNITS, "%", "fr", "deg", "rad", "grad", "turn", "ms", "s", "x", "dpi", "dppx"])

/** Returns whether two token values have the same value in the supported Tier-1 CSS subset. */
export function valuesEquivalent(left: string, right: string, category: string): boolean {
  if (left === right) return true
  return normalizeForComparison(left, category) === normalizeForComparison(right, category)
}

/**
 * Produces a comparison key for recognised CSS values. Unsupported values are
 * deliberately byte-exact: lowercasing an arbitrary string or custom property
 * name would manufacture equivalence the contract cannot justify.
 */
export function normalizeForComparison(value: string, category: string): string {
  if (category === "colors") {
    const color = normalizeColor(value)
    if (color !== undefined) return `color:${color}`
  }

  const numeric = normalizeNumeric(value, category)
  if (numeric !== undefined) return `numeric:${numeric}`

  return `raw:${value}`
}

function normalizeColor(value: string): string | undefined {
  const hex = normalizeHex(value)
  if (hex !== undefined) return hex
  return normalizeOpaqueRgb(value)
}

function normalizeHex(value: string): string | undefined {
  const match = value.trim().match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i)
  if (!match) return undefined

  let digits = match[1].toLowerCase()
  if (digits.length === 3 || digits.length === 4) digits = [...digits].map((digit) => `${digit}${digit}`).join("")
  // #rrggbbff is exactly the opaque form of #rrggbb. Preserve non-opaque alpha.
  if (digits.length === 8 && digits.endsWith("ff")) digits = digits.slice(0, 6)
  return `#${digits}`
}

// Parse only legacy comma-separated, integer RGB forms. CSS's modern colour
// syntax has context and precision cases that this Tier-1 comparison should not guess at.
function normalizeOpaqueRgb(value: string): string | undefined {
  const match = value
    .trim()
    .match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)))?\s*\)$/i)
  if (!match) return undefined

  const channels = match.slice(1, 4).map(Number)
  if (channels.some((channel) => channel > 255)) return undefined
  // rgb() has no alpha. rgba() is equivalent only when its alpha is exactly one.
  const functionName = value.trim().slice(0, 4).toLowerCase()
  if (functionName === "rgb(" && match[4] !== undefined) return undefined
  if (functionName === "rgba" && canonicalDecimal(match[4] ?? "") !== "1") return undefined

  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
}

function normalizeNumeric(value: string, category: string): string | undefined {
  const match = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([a-z]+|%)?$/i)
  if (!match) return undefined

  const number = canonicalDecimal(match[1])
  if (number === undefined) return undefined
  const unit = match[2]?.toLowerCase() ?? ""
  if (unit !== "" && !NUMERIC_UNITS.has(unit)) return undefined

  // Unitless zero and length zero are interchangeable only in token categories
  // that unambiguously describe a CSS length. Do not hide a malformed z-index,
  // opacity, timing, or percentage value behind this rule.
  if (LENGTH_CATEGORIES.has(category) && isZero(number) && (unit === "" || LENGTH_UNITS.has(unit))) {
    return "length-zero"
  }
  return `${number}${unit}`
}

function canonicalDecimal(value: string): string | undefined {
  const match = value.match(/^([+-]?)(\d*)(?:\.(\d*))?$/)
  if (!match || (match[2] === "" && match[3] === undefined)) return undefined

  const sign = match[1] === "+" ? "" : match[1]
  const whole = (match[2] || "0").replace(/^0+(?=\d)/, "")
  const rawFraction = match[3] ?? ""
  let fractionEnd = rawFraction.length
  while (fractionEnd > 0 && rawFraction.charCodeAt(fractionEnd - 1) === 48) fractionEnd--
  const fraction = rawFraction.slice(0, fractionEnd)
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`
}

function isZero(value: string): boolean {
  return /^-?0(?:\.0+)?$/.test(value)
}
