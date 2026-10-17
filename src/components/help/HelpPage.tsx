import { Boxes, ClipboardList, Info } from "lucide-react";
import type { ReactNode } from "react";
import { AppShell } from "@/components/dashboard/AppShell";

type Guide = {
  id: string;
  icon: ReactNode;
  name: string;
  tag: string;
  when: string;
  badge: string;
  steps: Array<[string, string]>;
  terms: Array<[string, string]>;
  note: string;
  sample?: ReactNode;
};

/** A static picture of the PO-line table, so people know what to look for. */
function PoTableSample() {
  const rows: Array<[string, string, string]> = [
    ["1", "RCP - A4 · 450 × ₹8.25", "Choose PO line"],
    ["2", "RCP - A3 · 450 × ₹13", "✓ PO 475 · Line 2"],
  ];
  return (
    <figure
      aria-label="Example of the PO line table"
      className="mt-5 overflow-hidden rounded-xl border border-[#e0d8cc] text-xs"
    >
      <div className="border-b border-[#e0d8cc] bg-[#fbfaf8] px-3 py-2 font-semibold text-[#111827]">
        Choose the PO line for each invoice line
      </div>
      {rows.map(([n, line, action]) => (
        <div
          key={n}
          className="flex items-center justify-between gap-3 border-b border-[#efe9e1] px-3 py-2 last:border-b-0"
        >
          <span className="text-[#3d3530]">
            <span className="mr-2 text-[#8a7f72]">{n}</span>
            {line}
          </span>
          <span
            className={
              action.startsWith("✓")
                ? "font-medium text-[#24583e]"
                : "rounded-md border border-[#ded8d0] px-2 py-1 font-medium text-[#111827]"
            }
          >
            {action}
          </span>
        </div>
      ))}
      <figcaption className="bg-[#fbfaf8] px-3 py-2 text-[#6b5d50]">
        Line 1 still needs a PO line. Line 2 is done.
      </figcaption>
    </figure>
  );
}

const GUIDES: Guide[] = [
  {
    id: "material",
    icon: <Boxes className="h-5 w-5" aria-hidden="true" />,
    name: "Material case",
    tag: "Goods you keep in stock",
    when: "Physical goods that are stock items in SAP, like steel or coils. They arrive and are received in SAP first.",
    badge: "Material",
    steps: [
      [
        "Issues tab",
        "Go through what does not agree between the documents. Accept it if it is fine, reject it if not.",
      ],
      [
        "SAP tab: link items",
        "A line that says “Item not linked” needs its SAP item. Search for it and link it once.",
      ],
      [
        "SAP tab: choose receipts",
        "Pick the goods receipts this invoice is for. The app checks quantity, price and tax.",
      ],
      [
        "Approve",
        "Approves the case. Then create the A/P Invoice Draft; someone posts it in SAP.",
      ],
    ],
    terms: [
      ["Confirm receipts", "Choose which goods receipts this invoice covers."],
      ["Ready for SAP draft", "Nothing is left to decide."],
    ],
    note: "Transport document and weight proof are required, because goods travel and are weighed.",
  },
  {
    id: "non-material",
    icon: <ClipboardList className="h-5 w-5" aria-hidden="true" />,
    name: "Non-material case",
    tag: "Services and non-stock items",
    when: "Printing, events, trophies, advertising. Nothing goes into the warehouse, so there is no goods receipt.",
    badge: "Non-material or Service",
    steps: [
      [
        "Issues tab",
        "Same as a material case, but transport document and weight proof are not asked for.",
      ],
      [
        "SAP tab: check the PO",
        "The invoice is matched to the supplier's open PO. The one the invoice cites comes first. Use “Change PO” for another.",
      ],
      [
        "SAP tab: choose PO lines",
        "On each row press “Choose PO line” and pick the line it belongs to. Nothing is chosen for you.",
      ],
      [
        "Approve",
        "Approves the case. Then create the A/P Invoice Draft against those PO lines; someone posts it in SAP.",
      ],
    ],
    terms: [
      ["Confirm PO lines", "Each invoice line still needs a PO line."],
      ["₹ left", "What is still unbilled on that PO."],
    ],
    note: "Transport document and weight proof are not needed. The app settles that issue itself once it knows the case is non-material.",
    sample: <PoTableSample />,
  },
];

const BADGES: Array<[string, string]> = [
  ["Material · goods receipt", "Reviewed against goods receipts."],
  ["Non-material · PO line", "Reviewed against PO lines."],
  ["Service · PO line", "A service invoice, reviewed against PO lines."],
  ["Mixed lines", "Some lines are goods, some are not."],
  ["Already in SAP", "Already recorded, so nothing is created."],
  [
    "… · invoice reads as goods",
    "Looks like goods, but its items are not stock in SAP. Check the PO lines.",
  ],
];

const WORDS: Array<[string, string]> = [
  ["PO", "Purchase Order: what you ordered from the supplier."],
  ["Goods receipt (GRPO)", "The record that the goods arrived."],
  ["A/P Invoice Draft", "The supplier bill, ready in SAP for someone to post."],
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

      <p className="mt-4 min-h-[3.75rem] text-sm leading-relaxed text-[#3d3530]">
        {guide.when}
      </p>

      <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-[#8a7f72]">
        What you do
      </h3>
      <ol className="mt-3 space-y-3">
        {guide.steps.map(([title, body], index) => (
          <li key={title} className="flex gap-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#111827] text-xs font-semibold text-white">
              {index + 1}
            </span>
            <p className="text-sm leading-relaxed text-[#5a5046]">
              <b className="font-semibold text-[#111827]">{title}.</b> {body}
            </p>
          </li>
        ))}
      </ol>

      {guide.sample}

      <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-[#8a7f72]">
        You may see
      </h3>
      <dl className="mt-2 space-y-1.5">
        {guide.terms.map(([term, meaning]) => (
          <div key={term} className="text-sm text-[#5a5046]">
            <dt className="inline font-semibold text-[#111827]">{term}</dt>
            <dd className="inline"> · {meaning}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-auto flex gap-2 rounded-xl bg-[#f7f4ef] p-3 text-sm text-[#5a5046] [&:not(:first-child)]:mt-5">
        <Info
          className="mt-0.5 h-4 w-4 shrink-0 text-[#8a7f72]"
          aria-hidden="true"
        />
        <p>{guide.note}</p>
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
            them, matches the invoice to SAP, and prepares a draft for you to
            approve. It never posts to SAP by itself.
          </p>

          <section
            aria-labelledby="help-which"
            className="mt-5 rounded-2xl border border-[#e0d8cc] bg-white p-5 sm:p-6"
          >
            <h2
              id="help-which"
              className="text-base font-bold tracking-tight text-[#111827]"
            >
              Which one is my case?
            </h2>
            <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-[#5a5046]">
              <li>
                <b className="text-[#111827]">Look at the badge</b> next to the
                case name. It says Material, Non-material, Service, Mixed or
                Already in SAP.
              </li>
              <li>
                <b className="text-[#111827]">No badge?</b> Open the SAP tab.
                The badge appears once the SAP check has run. Press the refresh
                button there if it has not.
              </li>
              <li>
                <b className="text-[#111827]">Still unsure?</b> Goods that go
                into your warehouse are material. Everything else is
                non-material.
              </li>
            </ul>
            <dl className="mt-4 grid gap-3 border-t border-[#efe9e1] pt-4 sm:grid-cols-3">
              {WORDS.map(([word, meaning]) => (
                <div key={word} className="text-sm">
                  <dt className="font-semibold text-[#111827]">{word}</dt>
                  <dd className="text-[#5a5046]">{meaning}</dd>
                </div>
              ))}
            </dl>
          </section>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            {GUIDES.map((guide) => (
              <GuideCard key={guide.id} guide={guide} />
            ))}
          </div>

          <section
            aria-labelledby="help-badges"
            className="mt-5 rounded-2xl border border-[#e0d8cc] bg-white p-5 sm:p-6"
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
              Every case has two tabs. <b>Issues</b> lists what does not agree
              between the documents. <b>SAP</b> is where you match the invoice
              and approve. Approve stays off until no issue is open.
            </p>
            <p className="mt-2 text-sm text-[#5a5046]">
              If the badge looks wrong for your invoice, do not approve it.
              Check the SAP tab, then ask whoever manages the SAP items.
            </p>
          </section>
        </div>
      </div>
    </AppShell>
  );
}
