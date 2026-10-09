import type { MatchResult } from "./types";

export const SAP_TERMS = {
  grpo: "GRPO",
  grpos: "GRPOs",
  goodsReceiptPos: "Goods Receipt POs",
  apInvoice: "A/P Invoice",
  draft: "A/P Invoice Draft",
  postingDate: "Posting Date",
  documentDate: "Document Date",
  vendorRef: "Vendor Ref. No.",
  openQty: "Open Qty.",
  openAmount: "Open Amount",
  allocateQty: "Allocate Qty.",
  allocatedQty: "Allocated Qty.",
  invoiceQty: "Invoice Qty.",
  invoiceAmount: "Invoice Amount",
} as const;

/** Display adapter for generated messages, including older saved comparisons.
 * Never apply this to user-entered reasons, notes or SAP identity fields.
 */
export function sapMessage(
  value: string,
  protectedValues: string[] = [],
): string {
  let text = value;
  const protectedText = [...new Set(protectedValues.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  protectedText.forEach((value, index) => {
    text = text.split(value).join(`\u0000${index}\u0000`);
  });
  const phrases: Array<[string, string]> = [
    [
      "Sent back to the vendor for correction",
      "Marked for supplier correction",
    ],
    ["Return to vendor", "Mark for supplier correction"],
    [
      "Ask the vendor for a corrected invoice",
      "Contact the supplier separately; no notification is sent.",
    ],
    [
      "Posting it again would pay the vendor twice.",
      "Posting again would create a duplicate A/P Invoice.",
    ],
    [
      "Stores must record the receipt in SAP before a stock invoice can be paid. Otherwise SAP would add stock nobody checked.",
      "A Goods Receipt PO must exist in SAP before this item invoice can be posted against it.",
    ],
    [
      "that this invoice could be paid against",
      "that can be used as the base document for this A/P Invoice",
    ],
    ["Pay freight separately?", "Exclude freight from this A/P Invoice?"],
    ["Yes, pay freight separately", "Yes, exclude freight"],
    [
      "Your rule says freight is paid separately against a freight PO.",
      "Your rule allocates freight to a separate freight PO; it is excluded from this A/P Invoice.",
    ],
    [
      "Pay more than the PO allows?",
      "Post an invoice above the PO Open Amount?",
    ],
    ["Pay the full amount", "Post the full invoice amount"],
    ["same PO", "PO reference matches"],
    [
      "stores wrote this invoice number on it",
      "Vendor invoice reference matches",
    ],
    [
      "stores linked it to another invoice",
      "Different vendor invoice reference",
    ],
    ["same truck", "Vehicle No. matches"],
    ["different truck", "Different Vehicle No."],
    ["truck number", "Vehicle No."],
    ["invoice number that confirms", "vendor invoice reference that confirms"],
    ["same e-way bill", "E-Way Bill No. matches"],
    ["different e-way bill", "Different E-Way Bill No."],
    ["same lorry receipt", "Lorry Receipt No. matches"],
    ["different lorry receipt", "Different Lorry Receipt No."],
    [
      "received before the invoice date",
      "GRPO Posting Date precedes the Document Date",
    ],
    ["Accept the vendor's rate", "Accept Vendor Invoice Unit Price"],
    ["Use the invoice rate", "Use Vendor Invoice Unit Price"],
    ["same quantity", "Invoice Qty. matches GRPO Open Qty."],
    ["Not billed before in SAP", "No existing A/P Invoice or draft found"],
    [
      "Quantity billed = quantity received",
      "Invoice Qty. matches allocated GRPO Qty.",
    ],
    ["More selected than billed", "Allocated GRPO Qty. exceeds Invoice Qty."],
    [
      "Book it in the current month instead?",
      "Use the current Posting Period?",
    ],
    ["Booking month is open", "Posting Period is open"],
    ["GST date unchanged", "Document Date unchanged"],
    ["Only the booking date moves", "Only the Posting Date changes"],
    ["The booking date", "The Posting Date"],
    ["the booking date", "the Posting Date"],
    ["the GST date", "the Document Date"],
    ["Book it today instead", "Use today's Posting Date instead"],
    ["Go back to the automatic match", "Restore automatic allocation"],
    ["Use the receipt we suggested", "Use the automatically allocated GRPO"],
    ["Is a part bill expected here?", "Confirm partial GRPO invoicing?"],
    ["Yes, a part bill is expected", "Confirm partial invoicing"],
    ["Final AP invoice", "A/P Invoice"],
    ["Final AP Invoice", "A/P Invoice"],
    ["final AP invoice", "A/P Invoice"],
  ];
  for (const [old, replacement] of phrases)
    text = text.split(old).join(replacement);
  text = text
    .replace(
      /^The truck(?: .*?)? has not been received yet$/,
      "No matching open GRPO found for this invoice",
    )
    .replace(
      /Billed (.+?) of the (.+?) received/g,
      "Allocated GRPO Qty. $1 of GRPO Open Qty. $2",
    )
    .replace(
      /billed (.+?) more than was received/g,
      "Invoice Qty. exceeds allocated GRPO Qty. by $1",
    )
    .replace(
      /billed (.+?) that never arrived/g,
      "Invoice Qty. exceeds allocated GRPO Qty. by $1",
    )
    .replace(/Only (.+?) was received,/g, "Allocated GRPO Qty. is $1,")
    .replace(
      /Bill is (.+?) more than the PO allows/g,
      "Invoice Amount exceeds PO Open Amount by $1",
    )
    .replace(/\bAP invoice draft\b/gi, SAP_TERMS.draft)
    .replace(/\bAP invoice\b/gi, SAP_TERMS.apInvoice)
    .replace(/\bA\/P invoice draft\b/gi, SAP_TERMS.draft)
    .replace(/\bA\/P invoice\b/gi, SAP_TERMS.apInvoice)
    .replace(/\bgoods receipt(?: PO)?(s?)\b/gi, (_, plural) =>
      plural ? SAP_TERMS.goodsReceiptPos : "Goods Receipt PO",
    )
    .replace(/(?<!lorry |Lorry )\breceipts\b/g, SAP_TERMS.grpos)
    .replace(/(?<!lorry |Lorry )\breceipt\b/g, SAP_TERMS.grpo)
    .replace(/(?<!lorry |Lorry )\bReceipt (?=\d)/g, `${SAP_TERMS.grpo} `)
    .replace(/\bBook on /g, "Post on ")
    .replace(/\bBook (?=₹)/g, "Unit Price ")
    .replace(/\bPay (?=₹)/g, "Post ");
  protectedText.forEach((value, index) => {
    text = text.split(`\u0000${index}\u0000`).join(value);
  });
  return text;
}

/** Clone display text only; retain check IDs, decisions, allocations and payload. */
export function sapMatchPresentation(
  result: MatchResult,
  protectedValues: string[] = [],
): MatchResult {
  const identities = [
    ...protectedValues,
    ...result.lines.flatMap((line) => [
      line.itemName ?? "",
      ...line.candidates.flatMap((candidate) => [
        candidate.note ?? "",
        candidate.vehicle ?? "",
        candidate.poRef ?? "",
      ]),
    ]),
  ];
  const message = (text: string) => sapMessage(text, identities);
  const checks = result.checks.map((check) => ({
    ...check,
    title: message(check.title),
    help: check.help ? message(check.help) : check.help,
    ask: check.ask ? message(check.ask) : check.ask,
    waitNote: check.waitNote ? message(check.waitNote) : check.waitNote,
    options: check.options?.map((option) => ({
      ...option,
      title: message(option.title),
      lines: option.lines.map(message),
    })),
    itemSuggestions: check.itemSuggestions?.map((item) => ({
      ...item,
      why: message(item.why),
    })),
  }));
  const openIds = new Set(result.open.map((check) => check.id));
  return {
    ...result,
    summary: message(result.summary),
    checks,
    open: checks.filter((check) => openIds.has(check.id)),
    lines: result.lines.map((line) => ({
      ...line,
      candidates: line.candidates.map((candidate) => ({
        ...candidate,
        good: candidate.good.map(message),
        bad: candidate.bad
          .filter(
            (text) =>
              !/different (?:lorry receipt|Lorry Receipt No\.) \(0+\)/i.test(
                text,
              ),
          )
          .map(message),
        rejected: candidate.rejected
          ? message(candidate.rejected)
          : candidate.rejected,
      })),
    })),
  };
}
