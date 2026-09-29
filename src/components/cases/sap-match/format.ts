const money = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

export const inr = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : `${value < 0 ? "−" : ""}₹${money.format(Math.abs(value))}`;

export const qty = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 }).format(value);

export function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
