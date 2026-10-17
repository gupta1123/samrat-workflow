import { Boxes, ClipboardList, Info } from "lucide-react";
import type { ReactNode } from "react";
import { AppShell } from "@/components/dashboard/AppShell";

type Step = { title: string; body: string };
type Guide = {
  id: string;
  icon: ReactNode;
  name: string;
  tag: string;
  when: string;
  badge: string;
  steps: Step[];
  terms: Array<[string, string]>;
  skipped: string;
};

const GUIDES: Guide[] = [
  {
    id: "material",
    icon: <Boxes className="h-5 w-5" aria-hidden="true" />,
    name: "Material case",
    tag: "Goods you stock",
    when: "The invoice is for physical goods that are items in your SAP stock, such as steel or coils. The goods arrive and are received in SAP first.",
    badge: "Material · goods receipt",
    steps: [
      {
        title: "Check the Issues tab",
        body: "The app compares the invoice with the other documents in the packet (PO, transport document, weight proof). Anything that does not agree is listed as an issue. Accept it if it is fine, or reject it.",
      },
      {
        title: "Open the SAP tab",
        body: "The app finds the supplier in SAP and links every invoice line to a SAP item. If a line shows “Item not linked”, search for the SAP item and link it once. Next time it links itself.",
      },
      {
        title: "Choose the receipts",
        body: "Pick the goods receipts (GRPO) this invoice is for. The app shows how much of each receipt is still unbilled, and checks quantity, price and tax against the invoice.",
      },
      {
        title: "Approve",
        body: "When every check is green and no issue is open, Approve creates the A/P Invoice Draft in SAP. A person still posts the draft there.",
      },
    ],
    terms: [
      [
        "Confirm receipts",
        "You must choose which goods receipts this invoice covers.",
      ],
      [
        "Ready for SAP draft",
        "Nothing is left to decide. Approve will create the draft.",
      ],
      [
        "What goes to SAP",
        "The exact lines, quantities and amounts that will be written into the draft.",
      ],
    ],
    skipped:
      "Transport document and weight proof are required here, because goods have to travel and be weighed.",
  },
  {
    id: "non-material",
    icon: <ClipboardList className="h-5 w-5" aria-hidden="true" />,
    name: "Non-material case",
    tag: "Services and non-stock items",
    when: "The invoice is for services or items that are not stock in SAP, such as printing, events, trophies or advertising. Nothing is received into the warehouse, so there is no goods receipt.",
    badge: "Non-material · PO line (or Service · PO line)",
    steps: [
      {
        title: "Check the Issues tab",
        body: "Same as a material case. Transport document and weight proof are not asked for, so you will not see them here.",
      },
      {
        title: "Open the SAP tab",
        body: "The invoice is matched to the supplier's open Purchase Order directly. The page says “Confirm PO lines”. The PO the invoice cites is shown first.",
      },
      {
        title: "Choose the PO line for each invoice line",
        body: "Press “Choose PO line” on a row and pick the PO line it belongs to. Nothing is chosen for you. If the invoice cites another PO, use “Change PO”. When every line is chosen, the page says “PO lines matched”.",
      },
      {
        title: "Approve",
        body: "Approve creates the A/P Invoice Draft against the PO lines you chose. A person still posts the draft in SAP.",
      },
    ],
    terms: [
      ["Confirm PO lines", "Each invoice line still needs a PO line."],
      [
        "₹ left",
        "How much of that PO is not yet billed. A line cannot take more than this.",
      ],
      [
        "A line is not on this PO?",
        "Appears only when a line fits no PO line. Link it to a SAP item instead.",
      ],
    ],
    skipped:
      "Transport document and weight proof are not needed. The app accepts that issue for you once it sees the case is non-material.",
  },
];

const BADGES: Array<[string, string]> = [
  ["Material · goods receipt", "Reviewed against goods receipts."],
  ["Non-material · PO line", "Reviewed against PO lines. No goods receipt."],
  ["Service · PO line", "A service invoice, reviewed against PO lines."],
  ["Mixed lines", "Some lines are goods and some are not."],
  [
    "Already in SAP",
    "This invoice is already recorded, so nothing is created.",
  ],
  [
    "… · invoice reads as goods",
    "The invoice looks like goods, but its items are not stock in SAP. Check that the PO lines are right.",
  ],
];

function GuideCard({ guide }: { guide: Guide }) {
  return (
    <section
      aria-labelledby={`help-${guide.id}`}
      className="flex flex-col rounded-2xl border border-[#e0d8cc] bg-white p-5 shadow-[0_1px_3px_rgba(45,36,28,0.04)] sm:p-6"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#f1ebe2] text-[#5a4636]">
          {guide.icon}
        </span>
        <div>
          <h2
            id={`help-${guide.id}`}
            className="text-lg font-bold tracking-tight text-[#111827]"
          >
            {guide.name}
          </h2>
          <p className="text-xs font-medium text-[#8a7f72]">{guide.tag}</p>
        </div>
      </div>

      <p className="mt-4 text-sm leading-relaxed text-[#3d3530]">
        {guide.when}
      </p>
      <p className="mt-3 text-xs text-[#6b5d50]">
        Badge next to the case name:{" "}
        <span className="rounded-md border border-[#ded8d0] bg-[#fbfaf8] px-1.5 py-0.5 font-medium">
          {guide.badge}
        </span>
      </p>

      <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-[#8a7f72]">
        What you do
      </h3>
      <ol className="mt-3 space-y-4">
        {guide.steps.map((step, index) => (
          <li key={step.title} className="flex gap-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#111827] text-xs font-semibold text-white">
              {index + 1}
            </span>
            <div>
              <p className="text-sm font-semibold text-[#111827]">
                {step.title}
              </p>
              <p className="mt-0.5 text-sm leading-relaxed text-[#5a5046]">
                {step.body}
              </p>
            </div>
          </li>
        ))}
      </ol>

      <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-[#8a7f72]">
        What the screen says
      </h3>
      <dl className="mt-3 space-y-2.5">
        {guide.terms.map(([term, meaning]) => (
          <div key={term} className="text-sm">
            <dt className="font-semibold text-[#111827]">{term}</dt>
            <dd className="text-[#5a5046]">{meaning}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-6 flex gap-2 rounded-xl bg-[#f7f4ef] p-3 text-sm text-[#5a5046]">
        <Info
          className="mt-0.5 h-4 w-4 shrink-0 text-[#8a7f72]"
          aria-hidden="true"
        />
        <p>{guide.skipped}</p>
      </div>
    </section>
  );
}

export function HelpPage() {
  return (
    <AppShell>
      <div className="h-full overflow-y-auto bg-[#f7f4ef]">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
          <h1 className="text-2xl font-bold tracking-tight text-[#111827]">
            How this app works
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#5a5046]">
            Each case is a supplier invoice with its documents. The app checks
            the packet, matches the invoice to SAP, and prepares an A/P Invoice
            Draft for you to approve. It does not post anything to SAP for you.
            What you do depends on whether the invoice is for materials or not.
            The badge next to the case name tells you which.
          </p>

          <div className="mt-6 grid gap-5 lg:grid-cols-2">
            {GUIDES.map((guide) => (
              <GuideCard key={guide.id} guide={guide} />
            ))}
          </div>

          <section
            aria-labelledby="help-badges"
            className="mt-6 rounded-2xl border border-[#e0d8cc] bg-white p-5 sm:p-6"
          >
            <h2
              id="help-badges"
              className="text-base font-bold tracking-tight text-[#111827]"
            >
              The badge next to the case name
            </h2>
            <dl className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
              {BADGES.map(([label, meaning]) => (
                <div key={label} className="text-sm">
                  <dt className="font-semibold text-[#111827]">{label}</dt>
                  <dd className="text-[#5a5046]">{meaning}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-sm text-[#5a5046]">
              Two tabs in every case: <b>Issues</b> lists what does not agree
              between the documents. <b>SAP</b> is where you match the invoice
              and approve. Approve stays off until no issue is open.
            </p>
          </section>
        </div>
      </div>
    </AppShell>
  );
}
