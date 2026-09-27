// Payload builders for the SAP SPAPI create endpoints (GRPO + AP Invoice).
//
// Everything the SAP team needs to map is assembled here in one place:
//  - header: vendor (CardCode/BP Code + name), dates, our PO/invoice refs
//  - baseDocument: the open SAP PO/GRPO rows the document is based on
//    (DocEntry + PO Line Num per line, warehouse, project, tax code)
//  - lines: our extracted packet lines mapped to SAP line fields
//
// If the SAP team's sample payload uses different field names, only this
// file needs to change — the route, panel, and audit trail stay untouched.

export type SapBaseRow = Record<string, unknown>;

export type SapPacketLine = {
  documentType?: string;
  itemCode?: string;
  description?: string;
  hsnSac?: string;
  quantity?: string | number;
  unit?: string;
  rate?: string | number;
  taxableAmount?: string | number;
  taxAmount?: string | number;
  lineTotal?: string | number;
};

export type SapPayloadInput = {
  kind: "GRN" | "AP";
  sapEnv: string;
  caseId: string;
  caseSlug: string;
  poNumber: string | null;
  invoiceNumber: string | null;
  baseDocNum: string | null;
  baseDocChosenBy: "reviewer" | "automatic";
  receiptEvidence: string[];
  baseRows: SapBaseRow[];
  packetLines: SapPacketLine[];
  documents: Array<{
    type: string;
    title: string;
    fields: Record<string, unknown>;
  }>;
  /** DocNum/DocEntry of the GRN created earlier in the same run (AP only). */
  createdGrnDocNum?: string | null;
};

function text(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function baseHeader(rows: SapBaseRow[]) {
  const first = rows[0] ?? {};
  return {
    // SAP Business One identities from the base document rows.
    cardCode: text(first["BP Code"]),
    cardName: text(first["BP Name"]),
    baseDocEntry:
      typeof first.DocEntry === "number" ? first.DocEntry : text(first.DocEntry),
    warehouse: text(first.WhsCode),
    project: text(first.Project),
  };
}

function mapPacketLine(line: SapPacketLine, index: number) {
  return {
    lineNumber: index + 1,
    description: text(line.description),
    hsnSac: text(line.hsnSac),
    quantity: number(line.quantity),
    unit: text(line.unit),
    rate: number(line.rate),
    taxableAmount: number(line.taxableAmount),
    taxAmount: number(line.taxAmount),
  };
}

function mapBaseLine(row: SapBaseRow, index: number) {
  return {
    lineNumber: index + 1,
    poLineNum:
      typeof row["PO Line Num"] === "number"
        ? row["PO Line Num"]
        : number(row["PO Line Num"]),
    docEntry:
      typeof row.DocEntry === "number" ? row.DocEntry : text(row.DocEntry),
    itemCode: text(row.ItemCode),
    description: text(row.Dscription),
    quantity: number(row.Quantity),
    openQuantity: number(row.OpenQty),
    unit: text(row.Uom),
    price: number(row.Price),
    taxCode: text(row.TaxCode),
    warehouse: text(row.WhsCode),
    project: text(row.Project),
  };
}

function packetTotals(lines: SapPacketLine[]) {
  let taxable = 0;
  let tax = 0;
  let hasAny = false;
  for (const line of lines) {
    const t = number(line.taxableAmount);
    const x = number(line.taxAmount);
    if (t !== null) {
      taxable += t;
      hasAny = true;
    }
    if (x !== null) {
      tax += x;
      hasAny = true;
    }
  }
  if (!hasAny) return { taxableAmount: null, taxAmount: null, totalAmount: null };
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    taxableAmount: round(taxable),
    taxAmount: round(tax),
    totalAmount: round(taxable + tax),
  };
}

export function buildSapPayload(input: SapPayloadInput) {
  const header = baseHeader(input.baseRows);
  return {
    // What to create.
    documentType: input.kind === "GRN" ? "GRPO" : "APInvoice",
    // Our case references (ask SAP team to map: NumAtCard = vendor invoice no).
    poNumber: input.poNumber,
    invoiceNumber: input.invoiceNumber,
    caseId: input.caseId,
    caseName: input.caseSlug,
    environment: input.sapEnv,
    // Base document linkage.
    baseDocNum: input.baseDocNum,
    baseDocChosenBy: input.baseDocChosenBy,
    ...(input.kind === "AP" && input.createdGrnDocNum
      ? { baseGrnDocNum: input.createdGrnDocNum }
      : {}),
    ...header,
    totals: packetTotals(input.packetLines),
    baseDocumentLines: input.baseRows.map(mapBaseLine),
    packetLines: input.packetLines.map(mapPacketLine),
    receiptEvidence: input.receiptEvidence,
    sourceDocuments: input.documents.map((d) => ({
      type: d.type,
      title: d.title,
    })),
  };
}

export type BuiltSapPayload = ReturnType<typeof buildSapPayload>;

/**
 * Read the created document number out of whatever shape the SAP create
 * endpoint returns: {DocNum}, {DocEntry}, {data:{...}}, {success,data},
 * a bare numeric string, etc.
 */
export function extractSapDocNum(body: unknown): string | null {
  if (body === null || body === undefined) return null;
  if (typeof body === "number" && Number.isFinite(body)) return String(body);
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (/^\d+$/.test(trimmed)) return trimmed;
    try {
      return extractSapDocNum(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  if (typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["DocNum", "docNum", "DocEntry", "docEntry", "id", "DocNo", "documentNumber"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    if (record.data !== undefined && record.data !== body) {
      const nested = extractSapDocNum(record.data);
      if (nested) return nested;
    }
    if (record.result !== undefined && record.result !== body) {
      const nested = extractSapDocNum(record.result);
      if (nested) return nested;
    }
  }
  if (Array.isArray(body) && body.length > 0) {
    return extractSapDocNum(body[0]);
  }
  return null;
}
