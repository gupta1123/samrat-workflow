import type { DocType, FieldKey } from "@/types/pipeline";

export function applyInvoicePoReferenceFallback(
  fields: Partial<Record<FieldKey, string>>,
  docType: DocType,
  visibleText: string,
) {
  if (docType !== "Invoice" && docType !== "Tax Invoice") return fields;
  const compact = (value: string) =>
    value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const invoice = compact(fields.invoiceNumber ?? "");
  const source = visibleText.replace(/[*_`]/g, "");
  const labelPattern =
    /(?<![A-Z0-9/.-])(?:(?:REFERENCE\s+)?(?:PURCHASE\s+ORDER|P\.?\s*O\.?(?![-/.][A-Z0-9])|BUYER'?S?\s+(?:PURCHASE\s+)?ORDER|BUYER\s+PO)(?:\s+(?:NUMBER|NO\.?|REF(?:ERENCE)?))?|ORDER\s+(?:NUMBER|NO\.?))\s*[:#|=-]?\s*/gi;
  const labelMatches = [...source.matchAll(labelPattern)];
  const candidates = labelMatches
    .map((match, index) => {
      const start = (match.index ?? 0) + match[0].length;
      const nextLabel = labelMatches[index + 1]?.index ?? source.length;
      const nextLine = source.indexOf("\n", start);
      const end = Math.min(
        start + 100,
        nextLabel,
        nextLine < 0 ? source.length : nextLine,
      );
      const bounded = source
        .slice(start, end)
        .split(
          /\s+(?=(?:DATE|ADDRESS|STATE|GSTIN|DELIVERY|DESTINATION|D\.?\s*O\.?|S\.?\s*O\.?)\b)/i,
        )[0]
        .split(/[;|]/)[0]
        .trim();
      const tokens = bounded.split(/\s+/).filter(Boolean);
      const first = tokens[0]?.replace(/[.,;:]+$/, "") ?? "";
      if (!first) return "";

      // Most coded references are one token. Some legitimate explicit PO
      // references are textual (for example "EMAIL-TG Regular"); accept those
      // only when the first token contains reference punctuation, then retain a
      // short textual suffix from the same labelled row.
      if (/\d/.test(first)) return first;
      if (!/[\/.-]/.test(first)) return "";
      const suffix = tokens
        .slice(1, 4)
        .map((token) => token.replace(/[.,;:]+$/, ""))
        .filter((token) => /^[A-Z0-9][A-Z0-9/._-]*$/i.test(token));
      return [first, ...suffix].join(" ");
    })
    .filter(
      (value) =>
        value.length >= 3 &&
        /[\d\/.-]/.test(value) &&
        compact(value) !== invoice,
    )
    .filter((value) => !/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(value));
  const unique = [
    ...new Map(candidates.map((value) => [compact(value), value])).values(),
  ];
  const nonPoReferenceLabels =
    /\b(?:D\.?\s*O\.?|DELIVERY\s+ORDER|DELIVERY|S\.?\s*O\.?|SALES\s+ORDER)\s*(?:NUMBER|NO\.?|#)?\s*[:#|=-]?\s*([A-Z0-9][A-Z0-9/.-]*)/gi;
  const explicitlyNonPoValues = [...source.matchAll(nonPoReferenceLabels)]
    .map((match) => compact(match[1]))
    .filter(Boolean);

  // Remove an extracted PO only when the same visible value is explicitly
  // labelled as another reference type. This is evidence-based and applies to
  // any invoice layout; it does not depend on a supplier or document number.
  if (
    fields.referencePoNumber &&
    compact(fields.referencePoNumber) !== invoice
  ) {
    const existing = compact(fields.referencePoNumber);
    if (unique.some((value) => compact(value) === existing)) return fields;
    if (explicitlyNonPoValues.includes(existing)) {
      const next = { ...fields };
      delete next.referencePoNumber;
      return next;
    }
    // Keep a supplied reference when the visible OCR does not provide enough
    // layout evidence to prove that it came from a different field.
    return fields;
  }

  if (unique.length !== 1) return fields;
  return { ...fields, referencePoNumber: unique[0] };
}
