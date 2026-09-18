import { NextResponse } from "next/server";
import {
  dbCheck,
  ownedCase,
  withUser,
} from "@/server/api/helpers";
import { readStoredLineItems } from "@/server/line-items";
import { fetchSapOpenGRPOs, fetchSapOpenPOs } from "@/server/sap/client";
import { readSapEnvironment } from "@/server/sap/config";
import {
  classifySapCase,
  normalizeSapReference,
  parseSapAmount,
  scoreVendorNames,
} from "@/lib/sap-decision";
import type { SapPacketLine } from "@/server/sap/posting";

type Context = { params: Promise<{ id: string }> };

type PoLine = {
  docNum: string | number;
  poLineNum: number;
  itemCode: string | null;
  description: string | null;
  quantity: number | null;
  openQty: number | null;
  price: number | null;
  taxCode: string | null;
  lineTotal: number | null;
  taxAmount: number | null;
  totalAmount: number | null;
};

type PoDoc = {
  docNum: string | number;
  bpCode: string | null;
  bpName: string | null;
  lines: PoLine[];
};

function groupPoByDoc(rows: Record<string, unknown>[]): PoDoc[] {
  const byDoc = new Map<string | number, { bpCode: string | null; bpName: string | null; lines: PoLine[] }>();
  for (const row of rows) {
    const docNum = row.DocNum as string | number;
    if (!docNum) continue;
    const bpCode = typeof row["BP Code"] === "string" ? row["BP Code"] : null;
    const bpName = typeof row["BP Name"] === "string" ? row["BP Name"] : null;
    const line: PoLine = {
      docNum,
      poLineNum: typeof row["PO Line Num"] === "number" ? row["PO Line Num"] : 0,
      itemCode: typeof row.ItemCode === "string" ? row.ItemCode : null,
      description: typeof row.Dscription === "string" ? row.Dscription : null,
      quantity: parseSapAmount(row.Quantity),
      openQty: parseSapAmount(row.OpenQty),
      price: parseSapAmount(row.Price),
      taxCode: typeof row.TaxCode === "string" ? row.TaxCode : null,
      lineTotal: parseSapAmount(row.LineTotal),
      taxAmount: parseSapAmount(row["Tax Amount"]),
      totalAmount: parseSapAmount(row["Total Amount"]),
    };
    const existing = byDoc.get(docNum);
    if (existing) {
      existing.lines.push(line);
    } else {
      byDoc.set(docNum, { bpCode, bpName, lines: [line] });
    }
  }
  return Array.from(byDoc.entries()).map(([docNum, data]) => ({
    docNum,
    bpCode: data.bpCode,
    bpName: data.bpName,
    lines: data.lines,
  }));
}

function findBestPoDoc(
  poDocs: PoDoc[],
  poNumber: string | null,
  vendorName: string | null,
): PoDoc | null {
  if (poDocs.length === 0) return null;
  const scored = poDocs
    .map((doc) => ({
      doc,
      score: (() => {
        let score = 0;
        if (vendorName && doc.bpName) {
          const vendorScore = scoreVendorNames(vendorName, doc.bpName);
          score += vendorScore * 50;
        }
        if (poNumber) {
          const normalizedPo = normalizeSapReference(poNumber);
          const normalizedDocNum = normalizeSapReference(doc.docNum);
          if (normalizedPo && normalizedDocNum && normalizedPo === normalizedDocNum) {
            score += 50;
          } else {
            // No PO match - significantly reduce score to prevent false matches
            score = Math.max(0, score - 40);
          }
        }
        const hasOpenQty = doc.lines.some((l) => l.openQty !== null && l.openQty > 0);
        if (hasOpenQty) score += 10;
        return Math.round(score);
      })(),
    }))
    .filter((e) => e.score > 20)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.doc ?? null;
}

function matchPacketLineToPoLine(
  packetLine: SapPacketLine,
  poLines: PoLine[],
  usedIndices: Set<number>,
): { line: PoLine; confidence: "exact" | "fuzzy" } | null {
  const lineDesc = (packetLine.description ?? "").toLowerCase().trim();
  const lineHsn = (packetLine.hsnSac ?? "").trim();

  for (let i = 0; i < poLines.length; i++) {
    if (usedIndices.has(i)) continue;
    const po = poLines[i];
    const poDesc = (po.description ?? "").toLowerCase().trim();
    const poItemCode = (po.itemCode ?? "").trim();
    if (
      (lineDesc && poDesc && lineDesc === poDesc) ||
      (lineHsn && poItemCode && lineHsn === poItemCode)
    ) {
      usedIndices.add(i);
      return { line: po, confidence: "exact" };
    }
  }
  for (let i = 0; i < poLines.length; i++) {
    if (usedIndices.has(i)) continue;
    const po = poLines[i];
    const poDesc = (po.description ?? "").toLowerCase().trim();
    const poItemCode = (po.itemCode ?? "").trim();
    if (
      (lineDesc && poDesc && (lineDesc.includes(poDesc) || poDesc.includes(lineDesc))) ||
      (lineHsn && poItemCode && lineHsn.includes(poItemCode))
    ) {
      usedIndices.add(i);
      return { line: po, confidence: "fuzzy" };
    }
  }
  return null;
}

type MatchedGrpoLine = {
  docNum: string | number;
  docEntry: string | number;
  poLineNum: number;
  itemCode: string | null;
  description: string | null;
  quantity: number | null;
  openQty: number | null;
  price: number | null;
  taxCode: string | null;
  lineTotal: number | null;
  taxAmount: number | null;
  totalAmount: number | null;
  warehouse: string | null;
  project: string | null;
  bpCode: string | null;
  bpName: string | null;
};

type MatchedPacketLine = {
  description: string | undefined;
  hsnSac: string | undefined;
  quantity: string | number | undefined;
  unit: string | undefined;
  rate: string | number | undefined;
  taxableAmount: string | number | undefined;
  taxAmount: string | number | undefined;
  matchedGrpoLine: MatchedGrpoLine | null;
  matchConfidence: "exact" | "fuzzy" | "none";
  matchedPoLine: PoLine | null;
};

type GrpoDoc = {
  docNum: string | number;
  bpCode: string | null;
  bpName: string | null;
  lines: MatchedGrpoLine[];
};

function extractVendorName(documents: Array<{ extractedFields: Record<string, unknown> }>): string | null {
  for (const doc of documents) {
    const vendor = doc.extractedFields.vendorName ?? doc.extractedFields.supplierName;
    if (typeof vendor === "string" && vendor.trim()) return vendor.trim();
  }
  return null;
}

function extractPoNumber(
  casePoNumber: unknown,
  documents: Array<{ extractedFields: Record<string, unknown> }>,
): string | null {
  if (typeof casePoNumber === "string" && casePoNumber.trim()) return casePoNumber.trim();
  for (const doc of documents) {
    const val = doc.extractedFields.poNumber ?? doc.extractedFields.purchaseOrderNumber;
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

function groupGrpoByDoc(rows: Record<string, unknown>[]): GrpoDoc[] {
  const byDoc = new Map<string | number, MatchedGrpoLine[]>();
  for (const row of rows) {
    const docNum = row.DocNum as string | number;
    if (!docNum) continue;
    const line: MatchedGrpoLine = {
      docNum,
      docEntry: row.DocEntry as string | number,
      poLineNum: typeof row["PO Line Num"] === "number" ? row["PO Line Num"] : 0,
      itemCode: typeof row.ItemCode === "string" ? row.ItemCode : null,
      description: typeof row.Dscription === "string" ? row.Dscription : null,
      quantity: parseSapAmount(row.Quantity),
      openQty: parseSapAmount(row.OpenQty),
      price: parseSapAmount(row.Price),
      taxCode: typeof row.TaxCode === "string" ? row.TaxCode : null,
      lineTotal: parseSapAmount(row.LineTotal),
      taxAmount: parseSapAmount(row["Tax Amount"]),
      totalAmount: parseSapAmount(row["Total Amount"]),
      warehouse: typeof row.WhsCode === "string" ? row.WhsCode : null,
      project: typeof row.Project === "string" ? row.Project : null,
      bpCode: typeof row["BP Code"] === "string" ? row["BP Code"] : null,
      bpName: typeof row["BP Name"] === "string" ? row["BP Name"] : null,
    };
    const existing = byDoc.get(docNum) ?? [];
    existing.push(line);
    byDoc.set(docNum, existing);
  }
  return Array.from(byDoc.entries()).map(([docNum, lines]) => ({
    docNum,
    bpCode: lines[0]?.bpCode ?? null,
    bpName: lines[0]?.bpName ?? null,
    lines,
  }));
}

function scoreGrpoDoc(
  doc: GrpoDoc,
  vendorName: string | null,
  poNumber: string | null,
): number {
  let score = 0;

  // Vendor match
  if (vendorName && doc.bpName) {
    const vendorScore = scoreVendorNames(vendorName, doc.bpName);
    score += vendorScore * 50;
  }

  // PO number match against DocNum (required for GRPO matching)
  if (poNumber) {
    const normalizedPo = normalizeSapReference(poNumber);
    const normalizedDocNum = normalizeSapReference(doc.docNum);
    if (normalizedPo && normalizedDocNum && normalizedPo === normalizedDocNum) {
      score += 50;
    } else {
      // No PO match - significantly reduce score to prevent false matches
      score = Math.max(0, score - 40);
    }
  }

  // Open quantity bonus
  const hasOpenQty = doc.lines.some((l) => l.openQty !== null && l.openQty > 0);
  if (hasOpenQty) score += 10;

  return Math.round(score);
}

function matchPacketLineToGrpoLine(
  packetLine: SapPacketLine,
  grpoLines: MatchedGrpoLine[],
  usedIndices: Set<number>,
): { line: MatchedGrpoLine; confidence: "exact" | "fuzzy" } | null {
  const lineDesc = (packetLine.description ?? "").toLowerCase().trim();
  const lineHsn = (packetLine.hsnSac ?? "").trim();

  // Pass 1: exact match
  for (let i = 0; i < grpoLines.length; i++) {
    if (usedIndices.has(i)) continue;
    const grpo = grpoLines[i];
    const grpoDesc = (grpo.description ?? "").toLowerCase().trim();
    const grpoItemCode = (grpo.itemCode ?? "").trim();

    if (
      (lineDesc && grpoDesc && lineDesc === grpoDesc) ||
      (lineHsn && grpoItemCode && lineHsn === grpoItemCode)
    ) {
      usedIndices.add(i);
      return { line: grpo, confidence: "exact" };
    }
  }

  // Pass 2: fuzzy (contains)
  for (let i = 0; i < grpoLines.length; i++) {
    if (usedIndices.has(i)) continue;
    const grpo = grpoLines[i];
    const grpoDesc = (grpo.description ?? "").toLowerCase().trim();
    const grpoItemCode = (grpo.itemCode ?? "").trim();

    if (
      (lineDesc && grpoDesc && (lineDesc.includes(grpoDesc) || grpoDesc.includes(lineDesc))) ||
      (lineHsn && grpoItemCode && lineHsn.includes(grpoItemCode))
    ) {
      usedIndices.add(i);
      return { line: grpo, confidence: "fuzzy" };
    }
  }

  return null;
}

export async function GET(request: Request, context: Context) {
  return withUser(request, async (db, user) => {
    const { id } = await context.params;
    const row = await ownedCase(db, user, id);

    const documentsResult = await db
      .from("packet_documents")
      .select("client_document_id, document_type, title, extracted_fields")
      .eq("case_id", id)
      .order("created_at");
    dbCheck(documentsResult.error);

    const documents = (documentsResult.data ?? []).map((d) => ({
      id: String(d.client_document_id ?? ""),
      documentType: String(d.document_type ?? ""),
      title: String(d.title ?? ""),
      extractedFields:
        d.extracted_fields && typeof d.extracted_fields === "object"
          ? (d.extracted_fields as Record<string, unknown>)
          : {},
    }));

    const classification = classifySapCase({
      casePoNumber: row.po_number,
      caseInvoiceNumber: row.invoice_number,
      documents,
    });

    // No AP invoice in packet — nothing to match
    if (!classification.hasVendorInvoice) {
      return NextResponse.json({ matched: false, reason: "no_invoice" });
    }

    const sapEnv = readSapEnvironment();
    const vendorName = extractVendorName(documents);
    const poNumber = extractPoNumber(row.po_number, documents);

    // Fetch GRPOs and POs
    let grpoRows: Record<string, unknown>[] = [];
    let poRows: Record<string, unknown>[] = [];
    try {
      [grpoRows, poRows] = await Promise.all([
        fetchSapOpenGRPOs(sapEnv),
        fetchSapOpenPOs(sapEnv),
      ]);
    } catch {
      return NextResponse.json({ matched: false, reason: "sap_unavailable" });
    }

    // Group by GRPO document and score
    const grpoDocs = groupGrpoByDoc(grpoRows);
    const scored = grpoDocs
      .map((doc) => ({ doc, score: scoreGrpoDoc(doc, vendorName, poNumber) }))
      .filter((entry) => entry.score > 20) // minimum threshold
      .sort((a, b) => b.score - a.score);

    // GRPO first, OpenPO fallback for the base document
    const bestPo = findBestPoDoc(groupPoByDoc(poRows), poNumber, vendorName);
    if (scored.length === 0 && !bestPo) {
      return NextResponse.json({ matched: false, reason: "no_match" });
    }
    const baseSource: "grpo" | "po" = scored.length > 0 ? "grpo" : "po";
    const bestGrpo = scored.length > 0 ? scored[0].doc : null;

    // Build packet lines (deduplicated by description)
    const allPacketLines: SapPacketLine[] = (documentsResult.data ?? []).flatMap((d) =>
      readStoredLineItems(d.extracted_fields).map((item) => ({
        documentType: String(d.document_type ?? ""),
        description: typeof item.description === "string" ? item.description : undefined,
        hsnSac: typeof item.hsnSac === "string" ? item.hsnSac : undefined,
        quantity: item.quantity,
        unit: typeof item.unit === "string" ? item.unit : undefined,
        rate: item.rate,
        taxableAmount: item.taxableAmount,
        taxAmount: item.taxAmount,
      })),
    );

    // Deduplicate by description (keep first occurrence)
    const seenDescriptions = new Set<string>();
    const packetLines: SapPacketLine[] = [];
    for (const line of allPacketLines) {
      const key = (line.description ?? "").toLowerCase().trim();
      if (!key || !seenDescriptions.has(key)) {
        packetLines.push(line);
        if (key) seenDescriptions.add(key);
      }
    }

    // Match packet lines against both documents; confidence comes from the base
    const grpoUsedIndices = new Set<number>();
    const poUsedIndices = new Set<number>();
    const matchedLines: MatchedPacketLine[] = packetLines.map((line) => {
      const grpoMatch = bestGrpo ? matchPacketLineToGrpoLine(line, bestGrpo.lines, grpoUsedIndices) : null;
      const poMatch = bestPo ? matchPacketLineToPoLine(line, bestPo.lines, poUsedIndices) : null;
      const primary = baseSource === "grpo" ? grpoMatch : poMatch;
      return {
        description: line.description,
        hsnSac: line.hsnSac,
        quantity: line.quantity,
        unit: line.unit,
        rate: line.rate,
        taxableAmount: line.taxableAmount,
        taxAmount: line.taxAmount,
        matchedGrpoLine: grpoMatch?.line ?? null,
        matchConfidence: primary?.confidence ?? "none",
        matchedPoLine: poMatch?.line ?? null,
      };
    });

    const matchCount = matchedLines.filter((l) => l.matchConfidence !== "none").length;

    // Build AP payload
    const apPayload = {
      documentType: "APInvoice",
      vendor: {
        cardCode: (baseSource === "grpo" ? bestGrpo?.bpCode : bestPo?.bpCode) ?? null,
        cardName: (baseSource === "grpo" ? bestGrpo?.bpName : bestPo?.bpName) ?? null,
      },
      baseGrpoDocNum: baseSource === "grpo" && bestGrpo ? String(bestGrpo.docNum) : null,
      basePoDocNum: baseSource === "po" && bestPo ? String(bestPo.docNum) : null,
      poNumber,
      invoiceNumber: classification.invoiceNumber,
      caseId: id,
      caseName: row.display_name,
      lines: matchedLines.map((line) => ({
        description: line.description,
        hsnSac: line.hsnSac,
        quantity: line.quantity,
        unit: line.unit,
        rate: line.rate,
        taxableAmount: line.taxableAmount,
        taxAmount: line.taxAmount,
        baseGrpoLine: line.matchedGrpoLine
          ? {
              docEntry: line.matchedGrpoLine.docEntry,
              poLineNum: line.matchedGrpoLine.poLineNum,
              openQty: line.matchedGrpoLine.openQty,
            }
          : null,
      })),
      totals: {
        taxable: packetLines.reduce((s, l) => s + (parseSapAmount(l.taxableAmount) ?? 0), 0),
        tax: packetLines.reduce((s, l) => s + (parseSapAmount(l.taxAmount) ?? 0), 0),
      },
    };

    return NextResponse.json({
      matched: true,
      baseSource,
      grpoDocNum: bestGrpo?.docNum ?? null,
      grpoVendor: bestGrpo?.bpName ?? null,
      grpoLineCount: bestGrpo?.lines.length ?? 0,
      poDocNum: bestPo?.docNum ?? null,
      poLineCount: bestPo?.lines.length ?? 0,
      matchCount,
      packetLineCount: packetLines.length,
      apPayload,
      matchedLines: matchedLines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        rate: l.rate,
        matchConfidence: l.matchConfidence,
        grpoItemCode: l.matchedGrpoLine?.itemCode ?? null,
        poRate: l.matchedPoLine?.price ?? null,
        poQty: l.matchedPoLine?.quantity ?? null,
        poItemCode: l.matchedPoLine?.itemCode ?? null,
        grpoRate: l.matchedGrpoLine?.price ?? null,
        grpoQty: l.matchedGrpoLine?.openQty ?? null,
      })),
    });
  });
}
