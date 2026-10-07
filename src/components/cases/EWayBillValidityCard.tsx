import {
  indiaCalendarDate,
  parseEWayBillValidityDate,
} from "@/lib/eway-bill-validity";

function displayDate(date: string) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

export function EWayBillValidityCard({
  printedValidity,
  billNumber,
  now = new Date(),
}: {
  printedValidity: string;
  billNumber?: string;
  now?: Date;
}) {
  const expiry = parseEWayBillValidityDate(printedValidity);
  const today = indiaCalendarDate(now);
  const expired = expiry !== null && expiry < today;
  const status = expiry ? (expired ? "Expired" : "Valid") : "Unable to check";
  return (
    <section
      aria-label="E-Way Bill validity details"
      className="rounded-lg border border-[#e0d8cc] bg-[#fbfaf8] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-[#111827]">
          E-Way Bill{billNumber ? ` ${billNumber}` : ""}
        </span>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${expired ? "bg-[#fbf0ef] text-[#8c1d18]" : expiry ? "bg-[#edf7f1] text-[#2d6a4f]" : "bg-[#fff4e5] text-[#b45309]"}`}
        >
          {status}
        </span>
      </div>
      <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-[#8a7f72]">Valid until</dt>
          <dd className="mt-1 font-medium text-[#111827]">
            {expiry ? displayDate(expiry) : printedValidity || "Not available"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[#8a7f72]">Today (India)</dt>
          <dd className="mt-1 font-medium text-[#111827]">
            {displayDate(today)}
          </dd>
        </div>
      </dl>
      <p className="mt-4 text-xs text-[#5b4b3d]">
        {expired
          ? "This e-way bill has expired. Review the warning, then accept or reject it below."
          : expiry
            ? "This e-way bill is valid for today's date."
            : "The expiry date is missing or could not be read. Check the source document before deciding."}
      </p>
    </section>
  );
}
