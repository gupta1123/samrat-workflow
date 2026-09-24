import { NextResponse } from "next/server";
import { dbCheck, ownedCase, withUser } from "@/server/api/helpers";
import { readStoredLineItems } from "@/server/line-items";
import { fetchSapOpenPOs } from "@/server/sap/client";
import { readSapEnvironment } from "@/server/sap/config";
import {
  fetchTestOpenGrpoRows,
  withTestServiceLayer,
  type SapReadDocument,
} from "@/server/sap/service-layer";
import { normalizeSapItem, selectSapLine } from "@/lib/sap-line-match";
import {
  classifySapCase,
  normalizeSapReference,
  parseSapAmount,
  scoreVendorNames,
} from "@/lib/sap-decision";
import type { SapPacketLine } from "@/server/sap/posting";
import { invoiceMoneyPreview } from "@/server/sap/preview";
import { sapInvoiceDate, sapPostingDate } from "@/server/sap/dates";

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
  docEntry: number | null;
  docNum: string | number;
  bpCode: string | null;
  bpName: string | null;
  lines: PoLine[];
};

function groupPoByDoc(rows: Record<string, unknown>[]): PoDoc[] {
  const byDoc = new Map<
    string,
    {
      docNum: string | number;
      docEntry: number | null;
      bpCode: string | null;
      bpName: string | null;
      lines: PoLine[];
    }
  >();
  for (const row of rows) {
    const docNum = row.DocNum as string | number;
    if (!docNum) continue;
    const bpCode = typeof row["BP Code"] === "string" ? row["BP Code"] : null;
    const bpName = typeof row["BP Name"] === "string" ? row["BP Name"] : null;
    const key =
      typeof row.DocEntry === "number"
        ? `entry:${row.DocEntry}`
        : `${bpCode ?? ""}:${docNum}`;
    const line: PoLine = {
      docNum,
      poLineNum:
        typeof row["PO Line Num"] === "number" ? row["PO Line Num"] : 0,
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
    const existing = byDoc.get(key);
    if (existing) {
      existing.lines.push(line);
    } else {
      byDoc.set(key, {
        docNum,
        docEntry: typeof row.DocEntry === "number" ? row.DocEntry : null,
        bpCode,
        bpName,
        lines: [line],
      });
    }
  }
  return Array.from(byDoc.values()).map((data) => ({
    docNum: data.docNum,
    docEntry: data.docEntry,
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
          if (vendorScore < 0.8) return -1;
          score += vendorScore * 50;
        } else if (vendorName) {
          return -1;
        }
        if (poNumber) {
          const normalizedPo = normalizeSapReference(poNumber);
          const normalizedDocNum = normalizeSapReference(doc.docNum);
          if (
            normalizedPo &&
            normalizedDocNum &&
            normalizedPo === normalizedDocNum
          ) {
            score += 50;
          } else {
            // No PO match - significantly reduce score to prevent false matches
            score = Math.max(0, score - 40);
          }
        }
        const hasOpenQty = doc.lines.some(
          (l) => l.openQty !== null && l.openQty > 0,
        );
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
  return selectSapLine(packetLine, poLines, usedIndices);
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

function extractVendorName(
  documents: Array<{ extractedFields: Record<string, unknown> }>,
): string | null {
  for (const doc of documents) {
    const vendor =
      doc.extractedFields.vendorName ?? doc.extractedFields.supplierName;
    if (typeof vendor === "string" && vendor.trim()) return vendor.trim();
  }
  return null;
}

function extractPoNumber(
  casePoNumber: unknown,
  documents: Array<{ extractedFields: Record<string, unknown> }>,
): string | null {
  if (typeof casePoNumber === "string" && casePoNumber.trim())
    return casePoNumber.trim();
  for (const doc of documents) {
    const val =
      doc.extractedFields.poNumber ?? doc.extractedFields.purchaseOrderNumber;
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

function groupGrpoByDoc(rows: Record<string, unknown>[]): GrpoDoc[] {
  const byDoc = new Map<
    string,
    { docNum: string | number; lines: MatchedGrpoLine[] }
  >();
  for (const row of rows) {
    const docNum = row.DocNum as string | number;
    if (!docNum) continue;
    const line: MatchedGrpoLine = {
      docNum,
      docEntry: row.DocEntry as string | number,
      poLineNum:
        typeof row["PO Line Num"] === "number" ? row["PO Line Num"] : 0,
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
    const key = `entry:${String(row.DocEntry ?? `${line.bpCode ?? ""}:${docNum}`)}`;
    const existing = byDoc.get(key) ?? { docNum, lines: [] };
    existing.lines.push(line);
    byDoc.set(key, existing);
  }
  return Array.from(byDoc.values()).map(({ docNum, lines }) => ({
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
  invoiceDescriptions: string[],
): number {
  let score = 0;

  // A vendor alone is not enough to select one of several open receipts.
  let vendorScore = 0;
  if (vendorName && doc.bpName) {
    vendorScore = scoreVendorNames(vendorName, doc.bpName);
    score += vendorScore * 50;
  }
  if (vendorName && vendorScore < 0.8) return 0;

  let exactDocNum = false;
  if (poNumber) {
    const normalizedPo = normalizeSapReference(poNumber);
    const normalizedDocNum = normalizeSapReference(doc.docNum);
    if (normalizedPo && normalizedDocNum && normalizedPo === normalizedDocNum) {
      exactDocNum = true;
      score += 50;
    }
  }

  const lineMatches = invoiceDescriptions.filter((description) =>
    doc.lines.some(
      (line) =>
        line.description &&
        normalizeSapItem(line.description) === normalizeSapItem(description),
    ),
  ).length;
  if (invoiceDescriptions.length > 0)
    score += (lineMatches / invoiceDescriptions.length) * 60;
  if (!exactDocNum && (vendorScore < 0.8 || lineMatches === 0)) return 0;

  const hasOpenQty = doc.lines.some((l) => l.openQty !== null && l.openQty > 0);
  if (hasOpenQty) score += 10;

  return Math.round(score);
}

function matchPacketLineToGrpoLine(
  packetLine: SapPacketLine,
  grpoLines: MatchedGrpoLine[],
  usedIndices: Set<number>,
): { line: MatchedGrpoLine; confidence: "exact" | "fuzzy" } | null {
  return selectSapLine(packetLine, grpoLines, usedIndices);
}

function invoiceBasedOn(
  invoice: SapReadDocument,
  baseType: 20 | 22,
  baseEntry: number,
): boolean {
  return (
    invoice.Cancelled === "tNO" &&
    (invoice.DocumentLines ?? []).some(
      (line) => line.BaseType === baseType && line.BaseEntry === baseEntry,
    )
  );
}

function matchingClosedGrpo(
  documents: SapReadDocument[],
  vendorName: string | null,
  packetLines: SapPacketLine[],
): SapReadDocument | null {
  const candidates = documents.filter((document) => {
    if (
      document.Cancelled !== "tNO" ||
      document.DocumentStatus !== "bost_Close"
    )
      return false;
    if (!vendorName || scoreVendorNames(vendorName, document.CardName) < 0.8)
      return false;
    const used = new Set<number>();
    const sapLines = (document.DocumentLines ?? []).map((line) => ({
      itemCode: line.ItemCode,
      description: line.ItemDescription,
      quantity: line.Quantity,
      price: line.Price,
    }));
    return (
      packetLines.length > 0 &&
      packetLines.every((line) => {
        const match = selectSapLine(line, sapLines, used);
        return match && Number(line.quantity) === Number(match.line.quantity);
      })
    );
  });
  return candidates.length === 1 ? candidates[0] : null;
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
    const invoiceDocuments = (documentsResult.data ?? []).filter(
      (document) =>
        document.document_type === "Invoice" ||
        document.document_type === "Tax Invoice",
    );
    const invoiceTotal = parseSapAmount(
      (
        invoiceDocuments[0]?.extracted_fields as
          Record<string, unknown> | undefined
      )?.totalAmount,
    );
    const invoiceFields = (invoiceDocuments[0]?.extracted_fields ??
      {}) as Record<string, unknown>;
    const invoiceDate = sapInvoiceDate(invoiceFields.documentDate);
    const postingDate =
      invoiceDate && invoiceDate <= sapPostingDate() ? invoiceDate : null;
    const invoiceCurrency =
      typeof invoiceFields.currency === "string" &&
      invoiceFields.currency.trim()
        ? invoiceFields.currency.trim().toUpperCase()
        : null;
    // Preserve separate rows even when a vendor repeats one description at different rates.
    const packetLines: SapPacketLine[] = invoiceDocuments.flatMap((document) =>
      readStoredLineItems(document.extracted_fields).map((item) => ({
        documentType: String(document.document_type ?? ""),
        itemCode: typeof item.itemCode === "string" ? item.itemCode : undefined,
        description:
          typeof item.description === "string" ? item.description : undefined,
        hsnSac: typeof item.hsnSac === "string" ? item.hsnSac : undefined,
        quantity: item.quantity,
        unit: typeof item.unit === "string" ? item.unit : undefined,
        rate: item.rate,
        taxableAmount: item.taxableAmount,
        taxAmount: item.taxAmount,
        lineTotal: item.lineTotal,
      })),
    );

    // Fetch GRPOs and POs
    let grpoRows: Record<string, unknown>[] = [];
    let poRows: Record<string, unknown>[] = [];
    try {
      [grpoRows, poRows] = await Promise.all([
        sapEnv === "test" ? fetchTestOpenGrpoRows() : Promise.resolve([]),
        fetchSapOpenPOs(sapEnv).catch(() => []),
      ]);
    } catch {
      return NextResponse.json({ matched: false, reason: "sap_unavailable" });
    }

    // Group by GRPO document and score
    const grpoDocs = groupGrpoByDoc(grpoRows);
    const invoiceDescriptions = invoiceDocuments
      .flatMap((document) => readStoredLineItems(document.extracted_fields))
      .map((line) => line.description?.trim() ?? "")
      .filter(Boolean);
    const scored = grpoDocs
      .map((doc) => ({
        doc,
        score: scoreGrpoDoc(doc, vendorName, poNumber, invoiceDescriptions),
      }))
      .filter((entry) => entry.score > 20) // minimum threshold
      .sort((a, b) => b.score - a.score);

    // GRPO first, OpenPO fallback for the base document
    let bestPo = findBestPoDoc(groupPoByDoc(poRows), poNumber, vendorName);
    const unambiguousGrpo =
      scored.length > 0 &&
      (scored.length === 1 || scored[0].score > scored[1].score);

    if (sapEnv === "test") {
      try {
        const inspection = await withTestServiceLayer(async (client) => {
          if (!unambiguousGrpo && bestPo?.docEntry) {
            const po = await client.getPurchaseOrder(bestPo.docEntry);
            if (
              po.CardCode !== bestPo.bpCode ||
              String(po.DocNum) !== String(bestPo.docNum)
            ) {
              return { reason: "unverified_po" as const };
            }
            if (po.DocumentStatus !== "bost_Open" || po.Cancelled !== "tNO") {
              const invoices =
                invoiceTotal !== null && po.CardCode
                  ? await client.listInvoicesByAmount(po.CardCode, invoiceTotal)
                  : [];
              const posted = invoices.find((invoice) =>
                invoiceBasedOn(invoice, 22, po.DocEntry!),
              );
              return {
                reason: posted
                  ? ("already_posted" as const)
                  : ("closed_po" as const),
                sapDocument: {
                  kind: "PO",
                  docNum: po.DocNum,
                  docEntry: po.DocEntry,
                  vendor: po.CardName,
                },
                postedInvoice: posted
                  ? {
                      docNum: posted.DocNum,
                      docEntry: posted.DocEntry,
                      vendorReference: posted.NumAtCard,
                    }
                  : null,
              };
            }
          }
          if (!unambiguousGrpo && poNumber && /^\d+$/.test(poNumber)) {
            const candidates = await client.listGrposByDocNum(Number(poNumber));
            const closed = matchingClosedGrpo(
              candidates,
              vendorName,
              packetLines,
            );
            if (closed && closed.DocEntry) {
              const invoices =
                invoiceTotal !== null && closed.CardCode
                  ? await client.listInvoicesByAmount(
                      closed.CardCode,
                      invoiceTotal,
                    )
                  : [];
              const posted = invoices.find((invoice) =>
                invoiceBasedOn(invoice, 20, closed.DocEntry!),
              );
              return {
                reason: posted
                  ? ("already_posted" as const)
                  : ("closed_grpo" as const),
                sapDocument: {
                  kind: "GRPO",
                  docNum: closed.DocNum,
                  docEntry: closed.DocEntry,
                  vendor: closed.CardName,
                },
                postedInvoice: posted
                  ? {
                      docNum: posted.DocNum,
                      docEntry: posted.DocEntry,
                      vendorReference: posted.NumAtCard,
                    }
                  : null,
              };
            }
          }
          return null;
        });
        if (inspection) {
          return NextResponse.json({ matched: false, ...inspection });
        }
      } catch (error) {
        console.error("SAP Test document inspection failed:", error);
        return NextResponse.json({ matched: false, reason: "sap_unavailable" });
      }
    }
    if (bestPo && sapEnv === "test" && !bestPo.docEntry) bestPo = null;
    if (!unambiguousGrpo && !bestPo) {
      return NextResponse.json({ matched: false, reason: "no_match" });
    }
    const baseSource: "grpo" | "po" = unambiguousGrpo ? "grpo" : "po";
    const bestGrpo = unambiguousGrpo ? scored[0].doc : null;

    // Match packet lines against both documents; confidence comes from the base
    const grpoUsedIndices = new Set<number>();
    const poUsedIndices = new Set<number>();
    const matchedLines: MatchedPacketLine[] = packetLines.map((line) => {
      const grpoMatch = bestGrpo
        ? matchPacketLineToGrpoLine(line, bestGrpo.lines, grpoUsedIndices)
        : null;
      const poMatch = bestPo
        ? matchPacketLineToPoLine(line, bestPo.lines, poUsedIndices)
        : null;
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

    const matchCount = matchedLines.filter(
      (l) => l.matchConfidence !== "none",
    ).length;
    if (matchCount === 0) {
      return NextResponse.json({ matched: false, reason: "no_line_match" });
    }

    const postingResult = await db
      .from("sap_postings")
      .select("status, sap_docnum, payload")
      .eq("case_id", id)
      .eq("owner_user_id", user)
      .eq("kind", "AP")
      .eq("sap_env", "test")
      .maybeSingle();
    dbCheck(postingResult.error);
    const storedPosting = postingResult.data;
    const storedPayload =
      storedPosting?.payload && typeof storedPosting.payload === "object"
        ? (storedPosting.payload as Record<string, unknown>)
        : {};
    const sapPosting =
      storedPosting?.sap_docnum &&
      (storedPosting.status === "prepared" || storedPosting.status === "posted")
        ? {
            status: storedPosting.status,
            documentNumber: storedPosting.sap_docnum,
            postingDate:
              typeof storedPayload.postingDate === "string"
                ? storedPayload.postingDate
                : null,
            invoiceDate:
              typeof storedPayload.invoiceDate === "string"
                ? storedPayload.invoiceDate
                : null,
          }
        : null;

    // Build AP payload
    const money = invoiceMoneyPreview(invoiceDocuments, packetLines);
    const apPayload = {
      documentType: "APInvoice",
      vendor: {
        cardCode:
          (baseSource === "grpo" ? bestGrpo?.bpCode : bestPo?.bpCode) ?? null,
        cardName:
          (baseSource === "grpo" ? bestGrpo?.bpName : bestPo?.bpName) ?? null,
      },
      baseGrpoDocNum:
        baseSource === "grpo" && bestGrpo ? String(bestGrpo.docNum) : null,
      baseGrpoDocEntry:
        baseSource === "grpo" && bestGrpo
          ? Number(bestGrpo.lines[0]?.docEntry)
          : null,
      basePoDocNum:
        baseSource === "po" && bestPo ? String(bestPo.docNum) : null,
      basePoDocEntry: baseSource === "po" && bestPo ? bestPo.docEntry : null,
      poNumber,
      invoiceNumber: classification.invoiceNumber,
      currency: invoiceCurrency,
      invoiceDate,
      postingDate: sapPosting?.postingDate ?? postingDate,
      caseId: id,
      caseName: row.display_name,
      lines: matchedLines.map((line, index) => ({
        description: line.description,
        hsnSac: line.hsnSac,
        quantity: line.quantity,
        unit: line.unit,
        rate: money.lines[index]?.rate ?? null,
        taxableAmount: money.lines[index]?.taxableAmount ?? null,
        taxAmount: money.lines[index]?.taxAmount ?? null,
        baseGrpoLine: line.matchedGrpoLine
          ? {
              docEntry: line.matchedGrpoLine.docEntry,
              poLineNum: line.matchedGrpoLine.poLineNum,
              openQty: line.matchedGrpoLine.openQty,
            }
          : null,
      })),
      totals: money.totals,
    };

    return NextResponse.json({
      matched: true,
      caseStatus: row.status,
      sapEnv,
      baseSource,
      grpoDocNum: bestGrpo?.docNum ?? null,
      grpoVendor: bestGrpo?.bpName ?? null,
      grpoLineCount: bestGrpo?.lines.length ?? 0,
      poDocNum: bestPo?.docNum ?? null,
      poLineCount: bestPo?.lines.length ?? 0,
      matchCount,
      packetLineCount: packetLines.length,
      sapPosting,
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
