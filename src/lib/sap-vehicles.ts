/** Vehicle registrations found in free text, normalised (no spaces or dashes). */
export function findVehicles(value: unknown): string[] {
  const source = (
    typeof value === "string" || typeof value === "number"
      ? String(value).trim()
      : ""
  ).toUpperCase();
  return [
    ...new Set(
      (
        source.match(/\b[A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{0,3}[\s-]?\d{4}\b/g) ??
        []
      ).map((match) => match.replace(/[\s-]/g, "")),
    ),
  ];
}
