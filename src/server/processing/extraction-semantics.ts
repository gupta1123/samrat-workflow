// Shared by initial extraction and source review. These describe field roles;
// they never infer values or depend on a supplier, invoice or number format.
export const SOURCE_VALUE_INSTRUCTION =
  "Read each value from its own printed or handwritten label, column and row. Preserve every digit and decimal place in quantities, weights, rates, amounts and identifiers; never round or complete a partly readable value. " +
  "itemQuantity and line quantity describe the actual goods quantity, never a diameter, size, grade, HSN code or number of an item row. A certificate's Total Qty belongs to the goods quantity, not its product dimension. Distinguish quantity unit from weight unit and preserve both in logistics rows when they differ. " +
  "Read the whole identifier across wrapped lines. Keep uncertainty as an unreadable-source finding rather than inventing characters. Blank labelled cells stay absent. " +
  "materialValue is explicitly labelled MATERIAL VALUE on an invoice. goodsValue records an unqualified Value of Goods under its own meaning; it does not imply a pre-tax amount. freightAmount is the separately printed freight charge. totalTaxableAmount is the explicitly printed document-wide amount before tax; totalAmount is the invoice total including tax. Use the page's explicit labels to determine its role, and leave the tax basis undecided if the page does not establish it. " +
  "subtotal is only an explicitly printed subtotal, never a replacement label for MATERIAL VALUE or an unqualified Value of Goods. If an explicitly printed TAXABLE VALUE is the document subtotal, preserve it as totalTaxableAmount. " +
  "A product row's taxableAmount is that product's printed pre-tax amount, never the document total, material-plus-freight subtotal or a tax-summary total. lineTotal is only the total explicitly belonging to that row; omit it when only a document total is shown. Do not allocate document tax or freight to goods rows. " +
  "A goods block may list material value, freight, combined taxable value and tax one below another. That layout does not make every component a product amount: retain the separately labelled merchandise value as materialValue, combined goods-plus-freight tax basis as totalTaxableAmount, and combined tax components as document fields. Do not repeat the combined basis or combined taxes on the merchandise line. If no goods-only line amount is explicitly supplied, omit that line amount rather than calculating it. " +
  "Keep printed CGST, SGST and IGST amounts distinct from their percentages. Save document tax components in fields and row tax components in lineItems only when the page explicitly supplies them at that level. Never calculate an extracted amount or rate. Arithmetic may be used to identify a review question, never to rewrite the printed source. " +
  "taxRate is ONLY an explicitly printed combined GST/tax percentage. A CGST or SGST percentage belongs only to its named component; never copy one component into taxRate or add component percentages to invent a combined rate. If no combined rate is printed, mark a previous taxRate proposal unsupported and omit that field. " +
  "paymentTerms describes payment timing or settlement; deliveryTerms describes delivery obligations; freightTerms describes who pays freight. Preserve their separate printed clauses. " +
  "Delivery Note/Delivery No is deliveryNoteNumber; Delivery Order/DO No is deliveryOrderNumber; a BIS/CML licence is bisLicenseNumber, not certificateNumber. Judge the label and layout, not the shape of the number. ";

export const LOGISTICS_SOURCE_ROLES_INSTRUCTION =
  "Allowed values keys are vehicleNumber, transportMode, transporterName, documentDate, lorryReceiptNumber, deliveryNoteNumber, deliveryOrderNumber, referenceInvoiceNumber, referencePoNumber, itemCode, description, quantity, unit, grossWeight, tareWeight, netWeight, weightUnit. Values are literal strings from this source; omit absent cells. " +
  "For transport tables such as E-Way Bill Part-B, capture EVERY visible transport entry, including road and rail entries, retaining their individual dates and document references. Do not discard entries because another vehicle exists. " +
  "For weighment tables, capture EVERY visible row with its own item/quantity/unit and gross/tare/net weights and printed weight unit. Do not total rows or collapse different units. Keep logistics rows separate from invoice goods rows. " +
  "Top-level vehicle/weight fields may describe a single explicitly identified entry or explicitly printed total; do not choose an arbitrary row or compute a total when multiple entries exist. ";

export const LOGISTICS_ROWS_INSTRUCTION =
  "Return logisticsRows separately from commercial lineItems. Use [] if there are no transport entries or weighment rows. Each logistics row is {kind:transport|weighment, values:{...}, sourcePage:original page number}. " +
  LOGISTICS_SOURCE_ROLES_INSTRUCTION;

/** Literal evidence validation, including complete numeric tokens. No values
 * are inferred, reformatted or substituted from a pattern or another page. */
export function sourceQuoteContainsValue(quote: string, value: string) {
  const whitespace = (text: string) =>
    text
      .replaceAll("\n", " ")
      .replaceAll("\r", " ")
      .replaceAll("\t", " ")
      .split(" ")
      .filter(Boolean)
      .join(" ");
  quote = whitespace(quote);
  value = whitespace(value);
  if (!value) return false;
  const numericCharacters = new Set("0123456789.,");
  const numeric =
    value.length > 0 &&
    [...value].every((character) => numericCharacters.has(character));
  const digits = new Set("0123456789");
  const canonicalDecimal = (literal: string) => {
    const parts = literal.replaceAll(",", "").split(".");
    if (
      parts.length > 2 ||
      !parts[0] ||
      ![...(parts[0] + (parts[1] || ""))].every((character) =>
        digits.has(character),
      )
    )
      return null;
    let integer = parts[0];
    let fraction = parts[1] || "";
    while (integer.length > 1 && integer[0] === "0") integer = integer.slice(1);
    while (fraction.endsWith("0")) fraction = fraction.slice(0, -1);
    return fraction ? `${integer}.${fraction}` : integer;
  };
  if (!numeric) return quote.includes(value);
  const expected = canonicalDecimal(value);
  if (expected === null) return false;
  // Compare complete decimal tokens rather than first searching for a literal
  // substring. Commas and trailing zeroes are presentation, not lost digits.
  // The original value is preserved; this comparison never rewrites it.
  for (let start = 0; start < quote.length; start++) {
    if (!digits.has(quote[start])) continue;
    let end = start + 1;
    while (
      end < quote.length &&
      (digits.has(quote[end]) ||
        ((quote[end] === "." || quote[end] === ",") &&
          digits.has(quote[end + 1])))
    )
      end++;
    if (canonicalDecimal(quote.slice(start, end)) === expected) return true;
    start = end - 1;
  }
  return false;
}

/** Compare date punctuation/zero padding with the SAME ordered components.
 * Never guesses day/month order, century, or a missing digit. */
export function sourceFieldQuoteContainsValue(
  field: string,
  quote: string,
  value: string,
) {
  if (sourceQuoteContainsValue(quote, value)) return true;
  if (
    ![
      "documentDate",
      "certificateDate",
      "ackDate",
      "transactionDate",
      "dateOfBirth",
      "statementDate",
    ].includes(field)
  )
    return false;
  const digits = new Set("0123456789");
  const parts = (text: string) => {
    const values = text
      .replaceAll("/", "|")
      .replaceAll(".", "|")
      .replaceAll("-", "|")
      .split("|");
    if (
      values.length !== 3 ||
      values.some(
        (part) =>
          !part || ![...part].every((character) => digits.has(character)),
      )
    )
      return null;
    return values.map((part) => BigInt(part).toString()).join("|");
  };
  const expected = parts(value);
  if (!expected) return false;
  let token = "";
  for (const character of quote + " ") {
    if (
      digits.has(character) ||
      character === "/" ||
      character === "." ||
      character === "-"
    )
      token += character;
    else {
      if (parts(token) === expected) return true;
      token = "";
    }
  }
  return false;
}
