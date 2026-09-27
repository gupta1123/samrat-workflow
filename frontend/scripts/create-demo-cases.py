"""Build fictional, upload-ready procurement cases; never contacts a service."""
from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from xml.sax.saxutils import escape

from pypdf import PdfReader, PdfWriter
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, Table, TableStyle

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output/pdf/samrat-demo-cases"
FONT_ROOT = Path("/System/Library/Fonts/Supplemental")
for name, filename in [("Demo", "Arial.ttf"), ("DemoBold", "Arial Bold.ttf"), ("DemoItalic", "Arial Italic.ttf")]:
    pdfmetrics.registerFont(TTFont(name, str(FONT_ROOT / filename)))
pdfmetrics.registerFontFamily("Demo", normal="Demo", bold="DemoBold", italic="DemoItalic", boldItalic="DemoBold")

W, H = A4
M = 38
CW = W - M * 2
INK = colors.HexColor("#172B3A")
MUTED = colors.HexColor("#596B78")
RULE = colors.HexColor("#D9E1E6")
PALE = colors.HexColor("#F3F6F8")
BUYER = "Samrat Group - Demo Division"
SUPPLIER = "Aster Ridge Metals Pvt. Ltd. (Demo)"
TRANSPORTER = "Northstar Roadlines (Demo)"
BUYER_ADDRESS = "Unit 01, Training Park, Nashik, Maharashtra 422001"
SUPPLIER_ADDRESS = "Unit 42, Sample Industrial Estate, Pune, Maharashtra 411001"


def gstin(base: str) -> str:
    # Syntactically realistic specimen identifier, not a registered GST identity.
    alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    factor, total = 2, 0
    for char in reversed(base):
        product = factor * alphabet.index(char)
        total += product // 36 + product % 36
        factor = 1 if factor == 2 else 2
    return base + alphabet[(36 - total % 36) % 36]


BUYER_GST = gstin("27AABCS9001D1Z")
SUPPLIER_GST = gstin("27AABCA1001C1Z")


def amount(value) -> str:
    return f"{Decimal(str(value)):,.2f}"


def qty(value) -> str:
    return f"{int(value):,}"


def plain(value) -> str:
    return str(Decimal(str(value)).quantize(Decimal("0.01")))


def text(c, x, top, value, size=9, bold=False, color=INK):
    c.setFillColor(color)
    c.setFont("DemoBold" if bold else "Demo", size)
    c.drawString(x, H - top, str(value))


def paragraph(c, x, top, value, width, size=9, color=INK, bold=False):
    style = ParagraphStyle("body", fontName="DemoBold" if bold else "Demo", fontSize=size, leading=size * 1.42, textColor=color)
    p = Paragraph(escape(str(value)).replace("\n", "<br/>"), style)
    _, height = p.wrap(width, H)
    p.drawOn(c, x, H - top - height)
    return top + height


def section(c, top, title, accent):
    text(c, M, top + 11, title.upper(), 8.3, True, accent)
    c.setStrokeColor(RULE)
    c.line(M, H - top - 18, W - M, H - top - 18)
    return top + 27


def grid(c, top, cells, columns=2):
    cell_width = CW / columns
    cursor = top
    for start in range(0, len(cells), columns):
        row_height = 0
        for index, (label, value) in enumerate(cells[start:start + columns]):
            x = M + index * cell_width
            text(c, x, cursor + 8, label.upper(), 7.0, True, MUTED)
            end = paragraph(c, x, cursor + 14, value, cell_width - 15, 9.4)
            row_height = max(row_height, end - cursor + 12)
        cursor += row_height
    return cursor


def parties(c, top, accent, first_label="SUPPLIER / DISPATCH FROM", second_label="BUYER / SHIP TO"):
    gap = 16
    bw = (CW - gap) / 2
    bottom = top
    for x, label, name, address, gst in [
        (M, first_label, SUPPLIER, SUPPLIER_ADDRESS, SUPPLIER_GST),
        (M + bw + gap, second_label, BUYER, BUYER_ADDRESS, BUYER_GST),
    ]:
        c.setFillColor(PALE)
        c.roundRect(x, H - top - 94, bw, 94, 5, fill=1, stroke=0)
        text(c, x + 10, top + 15, label, 7.0, True, accent)
        end = paragraph(c, x + 10, top + 23, name, bw - 20, 9.5, bold=True)
        end = paragraph(c, x + 10, end + 3, address, bw - 20, 8.0, MUTED)
        text(c, x + 10, top + 82, "GSTIN: " + gst, 8.3)
        bottom = max(bottom, top + 104)
    return bottom


def table(c, top, headings, rows, widths, accent, numeric_columns=()):
    body = ParagraphStyle("cell", fontName="Demo", fontSize=8.3, leading=11, textColor=INK)
    head = ParagraphStyle("head", fontName="DemoBold", fontSize=7.4, leading=10, textColor=colors.white)
    data = [[Paragraph(escape(str(v)), head) for v in headings]]
    for row in rows:
        cells = []
        for index, value in enumerate(row):
            style = ParagraphStyle("number", parent=body, alignment=2) if index in numeric_columns else body
            cells.append(Paragraph(escape(str(value)), style))
        data.append(cells)
    t = Table(data, colWidths=widths)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), accent),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PALE]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LINEBELOW", (0, 1), (-1, -1), 0.4, RULE),
    ]))
    _, height = t.wrap(CW, H)
    t.drawOn(c, M, H - top - height)
    return top + height + 12


def line_table(c, top, s, accent, commercial=True, received=False):
    if commercial:
        headings = ["ITEM / DESCRIPTION", "HSN", "QTY (KG)", "RATE (INR/KG)", "TAXABLE (INR)"]
        widths = [CW - 287, 43, 66, 79, 99]
        rows = [[f"{item['code']} - {item['description']}", item["hsn"], qty(item["quantity"]), amount(item["rate"]), amount(item["quantity"] * item["rate"])] for item in s["items"]]
        return table(c, top, headings, rows, widths, accent, (2, 3, 4))
    headings = ["ITEM / DESCRIPTION", "HSN", "DISPATCHED (KG)", "RECEIVED (KG)"] if received else ["GOODS DESCRIPTION", "HSN", "QUANTITY (KG)"]
    widths = [CW - 261, 45, 108, 108] if received else [CW - 153, 45, 108]
    rows = [[f"{i['code']} - {i['description']}", i["hsn"], qty(i["quantity"])] + ([qty(i["quantity"])] if received else []) for i in s["items"]]
    return table(c, top, headings, rows, widths, accent, (2, 3))


def totals(c, top, subtotal, accent, title="Invoice total (INR)"):
    base = Decimal(str(subtotal))
    cgst = base * Decimal("0.09")
    tax = cgst * 2
    total = base + tax
    rows = [("Taxable value", base), ("CGST @ 9%", cgst), ("SGST @ 9%", cgst), ("Total GST @ 18%", tax), (title, total)]
    x, tw, rh = M + CW - 254, 254, 24
    for index, (label, value) in enumerate(rows):
        last = index == len(rows) - 1
        c.setFillColor(accent if last else PALE)
        c.rect(x, H - top - (index + 1) * rh, tw, rh, fill=1, stroke=0)
        color = colors.white if last else INK
        text(c, x + 10, top + index * rh + 16, label, 8.7, last, color)
        c.setFillColor(color)
        c.setFont("DemoBold" if last else "Demo", 9)
        c.drawRightString(x + tw - 10, H - top - index * rh - 16, amount(value))
    return top + len(rows) * rh + 12


def stamp(c, x, top, label, accent):
    c.setStrokeColor(accent)
    c.setFillColor(colors.white)
    c.roundRect(x, H - top - 52, 151, 52, 4, fill=1, stroke=1)
    text(c, x + 10, top + 16, label, 8.5, True, accent)
    text(c, x + 10, top + 31, "DEMO RECORD", 7.4, True, accent)
    text(c, x + 10, top + 44, "Approved / Demo signatory", 7.0, False, MUTED)


def finish(c, last_bottom, file_label):
    if last_bottom > H - 63:
        raise ValueError(f"Content exceeds safe area: {file_label}: {last_bottom}")
    c.setStrokeColor(RULE)
    c.line(M, 49, W - M, 49)
    text(c, M, H - 35, "FICTIONAL TRAINING RECORD - NOT VALID FOR TAX, TRANSIT OR PAYMENT", 7.1, True, MUTED)
    text(c, M, H - 23, "All parties, identifiers and approvals are specimen data. No real transaction.", 7.0, color=MUTED)
    c.setFont("Demo", 7)
    c.drawRightString(W - M, 23, "1 / 1")
    c.showPage()
    c.save()


def header(c, title, issuer, number, accent, doc_no):
    c.setFillColor(accent)
    c.rect(0, H - 9, W, 9, fill=1, stroke=0)
    text(c, M, 34, issuer, 12, True, accent)
    text(c, M, 67, title, 23, True)
    text(c, M, 88, number, 9.5, color=MUTED)
    c.setFont("DemoBold", 8)
    c.setFillColor(MUTED)
    c.drawRightString(W - M, H - 34, f"DOCUMENT {doc_no:02d}  /  SPECIMEN")
    return 105


def signature_pair(c, top, accent, left="ISSUED / APPROVED", right="RECEIVED / VERIFIED"):
    stamp(c, M, top, left, accent)
    stamp(c, W - M - 151, top, right, accent)
    return top + 52


def make_shipment(case_no, items, vehicle, mismatched=False):
    base = sum(i["quantity"] * i["rate"] for i in items)
    weight = sum(i["quantity"] for i in items)
    code = 100 + case_no
    return dict(case_no=case_no, items=items, vehicle=vehicle, mismatched=mismatched,
                po=f"SG/PO/26-27/{code}", invoice=f"ARM/26-27/{code}",
                eway=f"271260831{code}", lr=f"NSR/26-27/{code}",
                delivery=f"ARM/DN/26-27/{code}", weighment=f"SG/WB/26-27/{code}",
                base=base, tax=base * Decimal("0.18"), total=base * Decimal("1.18"),
                weight=weight, weigh_net=weight - 300 if mismatched else weight,
                lr_vehicle="MH20CD7823" if mismatched else vehicle,
                eway_base=base + 30000 if mismatched else base)


SHIPMENTS = [
    make_shipment(1, [dict(code="CH150", description="MS Channel 150 x 75 mm, Grade E250", hsn="7216", quantity=6000, rate=60), dict(code="CH100", description="MS Channel 100 x 50 mm, Grade E250", hsn="7216", quantity=4000, rate=65)], "MH12AB4821"),
    make_shipment(2, [dict(code="PL06", description="MS Plate 6 mm, Grade E250", hsn="7208", quantity=8000, rate=50), dict(code="PL08", description="MS Plate 8 mm, Grade E250", hsn="7208", quantity=4000, rate=55)], "MH14EF6724", True),
]

DOCS = [
    ("Purchase Order", "01-purchase-order.pdf", "po", "#234B72"),
    ("Tax Invoice", "02-tax-invoice.pdf", "invoice", "#176A55"),
    ("E-Way Bill", "03-eway-bill.pdf", "eway", "#644273"),
    ("Lorry Receipt", "04-lorry-receipt.pdf", "lr", "#8A5424"),
    ("Weighment Slip", "05-weighment-slip.pdf", "weighment", "#35434E"),
    ("Delivery Note", "06-delivery-note.pdf", "delivery", "#216B7A"),
]


def draw_document(path, s, doc_type, number_key, color, doc_no):
    accent = colors.HexColor(color)
    c = canvas.Canvas(str(path), pagesize=A4, pageCompression=1)
    c.setTitle(f"{doc_type} - {s[number_key]}")
    c.setAuthor("Samrat fictional workflow test generator")
    c.setSubject("Synthetic procurement document for software testing only")
    issuer = BUYER if doc_type in {"Purchase Order", "Weighment Slip", "Delivery Note"} else TRANSPORTER if doc_type == "Lorry Receipt" else "TRANSPORT DOCUMENT / E-WAY RECORD" if doc_type == "E-Way Bill" else SUPPLIER
    y = header(c, doc_type.upper(), issuer, s[number_key], accent, doc_no)

    if doc_type in {"Purchase Order", "Tax Invoice"}:
        y = parties(c, y, accent)
        common = [("Order date", "28-Aug-2026"), ("Delivery date", "31-Aug-2026"), ("PO number", s["po"]), ("Currency / supply state", "INR / Maharashtra (27)")]
        if doc_type == "Tax Invoice":
            common = [("Invoice date", "31-Aug-2026"), ("Reference PO number", s["po"]), ("Vehicle number", s["vehicle"]), ("E-way bill number", s["eway"])]
        y = grid(c, y + 3, common)
        y = section(c, y, "Material schedule", accent)
        y = line_table(c, y, s, accent)
        paragraph(c, M, y + 5, f"Total material quantity\n{qty(s['weight'])} KG\n\nPacking and freight included.\nNo additional charges.\nCurrency: INR.", 220, 9)
        y = totals(c, y, s["base"], accent, "Order total (INR)" if doc_type == "Purchase Order" else "Invoice total (INR)")
        y = section(c, y, "Commercial terms", accent)
        terms = "Payment: 30 days from invoice date. Delivery: 31-Aug-2026 to the buyer address. Price: fixed per KG; packing and freight included. GST: CGST 9% + SGST 9%. Goods and quantities as listed above."
        y = paragraph(c, M, y, terms, CW, 8.8) + 17
        y = signature_pair(c, y, accent, "PURCHASE APPROVAL" if doc_type == "Purchase Order" else "SUPPLIER DISPATCH", "ORDER ACKNOWLEDGED" if doc_type == "Purchase Order" else "STORE RECEIVED")

    elif doc_type == "E-Way Bill":
        y = grid(c, y, [("Generated at", "31-Aug-2026 09:30"), ("Valid until", "01-Sep-2026 23:59"), ("Transaction / mode", "Outward supply / Road"), ("Reference invoice / date", s["invoice"] + " / 31-Aug-2026")])
        y = section(c, y, "Part A - consignment and parties", accent)
        y = parties(c, y, accent)
        y = line_table(c, y + 2, s, accent, commercial=False)
        paragraph(c, M, y + 5, "Consignment quantity\n" + qty(s["weight"]) + " KG\n\nPlace of supply: Maharashtra\nSupply category: Intra-state\nCurrency: INR", 220, 9)
        y = totals(c, y, s["eway_base"], accent, "Declared invoice value")
        y = section(c, y, "Part B - transport particulars", accent)
        y = grid(c, y, [("Vehicle number", s["vehicle"]), ("Lorry receipt reference", s["lr"]), ("Transporter", TRANSPORTER), ("Route", "Pune to Nashik, Maharashtra")])
        y = paragraph(c, M, y + 2, "Transport distance: 210 KM. Reference purchase order: " + s["po"] + ". This specimen is an e-way bill layout for testing and is not issued by a government portal.", CW, 8.2, MUTED)

    elif doc_type == "Lorry Receipt":
        y = grid(c, y, [("Booking date / time", "31-Aug-2026 10:00"), ("Reference invoice", s["invoice"]), ("E-way bill number", s["eway"]), ("Reference purchase order", s["po"])])
        y = parties(c, y, accent, "CONSIGNOR / FROM", "CONSIGNEE / TO")
        y = section(c, y, "Vehicle and consignment", accent)
        y = grid(c, y, [("Vehicle number", s["lr_vehicle"]), ("Consignment net weight", qty(s["weight"]) + " KG"), ("Route from", "Pune, Maharashtra"), ("Route to", "Nashik, Maharashtra")])
        y = line_table(c, y, s, accent, commercial=False)
        y = section(c, y, "Carriage instructions", accent)
        y = paragraph(c, M, y, "Freight: included in supplier's price; no separate freight billed or payable by the consignee on this receipt. Carry both material lines under the referenced invoice. Delivery date: 31-Aug-2026. No vehicle substitution recorded.", CW, 9) + 22
        y = signature_pair(c, y, accent, "TRANSPORTER ISSUED", "DRIVER ACKNOWLEDGED")

    elif doc_type == "Weighment Slip":
        y = grid(c, y, [("Weighbridge", "Samrat Demo Weighbridge - Nashik"), ("Date / time", "31-Aug-2026 15:05"), ("Vehicle number", s["vehicle"]), ("Invoice reference", s["invoice"]), ("Supplier", SUPPLIER), ("PO reference", s["po"])])
        y = section(c, y + 3, "Electronic scale readings", accent)
        for label, value, time in [("GROSS WEIGHT", s["weigh_net"] + 14000, "14:55"), ("TARE WEIGHT", 14000, "15:05"), ("NET WEIGHT", s["weigh_net"], "Gross minus tare")]:
            c.setFillColor(PALE)
            c.roundRect(M, H - y - 78, CW, 78, 5, fill=1, stroke=0)
            text(c, M + 15, y + 22, label, 9, True, MUTED)
            text(c, M + 15, y + 60, qty(value) + " KG", 25, True, accent)
            c.setFont("Demo", 9)
            c.drawRightString(W - M - 15, H - y - 25, time)
            y += 88
        y = paragraph(c, M, y + 2, f"Scale calculation: {qty(s['weigh_net'] + 14000)} KG - 14,000 KG = {qty(s['weigh_net'])} KG.\nVehicle remained on the same consignment. Reading unit: KG. All weights are simulated.", CW, 9) + 24
        stamp(c, M, y, "OPERATOR VERIFIED", accent)
        y += 52

    elif doc_type == "Delivery Note":
        y = parties(c, y, accent, "SUPPLIER / SENT BY", "BUYER / RECEIVED AT")
        y = grid(c, y, [("Delivery date / time", "31-Aug-2026 15:20"), ("Reference invoice", s["invoice"]), ("Reference PO number", s["po"]), ("Vehicle number", s["vehicle"]), ("E-way bill number", s["eway"]), ("Lorry receipt number", s["lr"])])
        y = section(c, y, "Receipt schedule", accent)
        y = line_table(c, y, s, accent, commercial=False, received=True)
        y = grid(c, y, [("Dispatched quantity", qty(s["weight"]) + " KG"), ("Recorded received quantity", qty(s["weight"]) + " KG")])
        y = section(c, y, "Receipt acknowledgement", accent)
        y = paragraph(c, M, y, "Store records the material and quantities listed above against the referenced purchase order and invoice. Packing is intact. Delivery completed at the buyer address on 31-Aug-2026. Freight and packing are included in the supplier's invoice price.", CW, 9) + 24
        y = signature_pair(c, y, accent, "SUPPLIER HANDOVER", "STORE RECEIVED")

    finish(c, y, path.name)


def reference_lines(s, commercial=True):
    result = []
    for index, item in enumerate(s["items"], 1):
        row = dict(lineNumber=str(index), itemCode=item["code"], description=item["description"], hsnSac=item["hsn"], quantity=str(item["quantity"]), unit="KG")
        if commercial:
            base = Decimal(item["quantity"] * item["rate"])
            row.update(rate=plain(item["rate"]), taxableAmount=plain(base), lineTotal=plain(base), cgstRate="9", sgstRate="9", taxRate="18", cgstAmount=plain(base * Decimal("0.09")), sgstAmount=plain(base * Decimal("0.09")), taxAmount=plain(base * Decimal("0.18")))
        result.append(row)
    return result


def reference_docs(s, packet_name):
    party = dict(vendorName=SUPPLIER, buyerName=BUYER, supplierGstin=SUPPLIER_GST, buyerGstin=BUYER_GST)
    commercial = dict(currency="INR", subtotal=plain(s["base"]), taxAmount=plain(s["tax"]), totalAmount=plain(s["total"]), itemQuantity=str(s["weight"]), unit="KG", hsnSac=s["items"][0]["hsn"], taxRate="18", cgstRate="9", sgstRate="9")
    fields = [
        dict(**party, **commercial, poNumber=s["po"], documentDate="2026-08-28"),
        dict(**party, **commercial, invoiceNumber=s["invoice"], referencePoNumber=s["po"], documentDate="2026-08-31", eWayBillNumber=s["eway"], vehicleNumber=s["vehicle"]),
        dict(**party, eWayBillNumber=s["eway"], referenceInvoiceNumber=s["invoice"], documentDate="2026-08-31", validityDate="2026-09-01", vehicleNumber=s["vehicle"], lorryReceiptNumber=s["lr"], transporterName=TRANSPORTER, subtotal=plain(s["eway_base"]), totalTaxableAmount=plain(s["eway_base"]), taxAmount=plain(s["eway_base"] * Decimal("0.18")), totalAmount=plain(s["eway_base"] * Decimal("1.18")), cgstRate="9", sgstRate="9", taxRate="18", currency="INR"),
        dict(vendorName=SUPPLIER, buyerName=BUYER, documentDate="2026-08-31", lorryReceiptNumber=s["lr"], eWayBillNumber=s["eway"], vehicleNumber=s["lr_vehicle"], netWeight=str(s["weight"]), transporterName=TRANSPORTER),
        dict(weighmentNumber=s["weighment"], weighbridgeName="Samrat Demo Weighbridge - Nashik", referencePoNumber=s["po"], referenceInvoiceNumber=s["invoice"], documentDate="2026-08-31", vendorName=SUPPLIER, vehicleNumber=s["vehicle"], grossWeight=str(s["weigh_net"] + 14000), tareWeight="14000", netWeight=str(s["weigh_net"])),
        dict(vendorName=SUPPLIER, buyerName=BUYER, documentDate="2026-08-31", deliveryNoteNumber=s["delivery"], referencePoNumber=s["po"], vehicleNumber=s["vehicle"], itemQuantity=str(s["weight"]), unit="KG"),
    ]
    docs = []
    for index, ((doc_type, filename, key, _), doc_fields) in enumerate(zip(DOCS, fields), 1):
        docs.append(dict(id=f"case-{s['case_no']}-doc-{index}", type=doc_type, title=f"{doc_type} - {s[key]}", pages=1, fields=doc_fields, lineItems=reference_lines(s, index in (1, 2)) if index in (1, 2, 3, 6) else [], md="", sourceFileName=packet_name, sourceHint=filename))
    return docs


def write_guide():
    content = """# Samrat Group - two test cases

These are fictional procurement packets modelled on Kalika's document types, not copies of client transactions. All business names, GSTINs, vehicle numbers, references and approvals are specimen data. No document is valid for tax, transport, payment or legal use. Tax rates and dates are fixed test inputs, not compliance advice.

## Upload one case at a time

1. Start with `01-clean-case/Samrat-Case-01-Complete-Packet.pdf`.
2. In Samrat, keep **Find separate documents automatically** ON and **Treat formatting differences as mismatches** OFF.
3. Select only that one combined PDF. It contains all six documents for one case.
4. Click **Save draft** first if checking storage. When ready to test AI, start analysis from the saved case, or use **Create case & review** on a new upload. AI analysis uses the shared OpenRouter credits.
5. Check the originals, extracted values, review findings and final case status. If no issues are raised, accept the clean case from its detail page.
6. Create a NEW case for `02-mismatch-case/Samrat-Case-02-Mismatch-Packet.pdf`; do not add it to the clean case.
7. Review each discrepancy against its original document. To exercise the workflow, reject one issue, refresh and check that the decision persists. On this disposable test case you may then change it to accepted and accept the remaining issues; accepting the final issue should accept the case. This is a UI test, not a recommendation to approve incorrect real documents.

Alternative: select the six PDFs in a case's `individual-documents` folder together instead of the combined PDF. Do not upload the combined packet AND its individual documents, and do not upload both cases together. The ZIP and this answer sheet are not case documents.

## Case 01 - matching procurement packet

- Purchase order: **SG/PO/26-27/101**; supplier invoice: **ARM/26-27/101**.
- Goods: 6,000 KG of MS Channel 150 x 75 mm at INR 60/KG, and 4,000 KG of MS Channel 100 x 50 mm at INR 65/KG.
- Taxable value: **INR 620,000.00**. CGST 9%: **55,800.00**. SGST 9%: **55,800.00**. Total GST: **111,600.00**. Invoice total: **INR 731,600.00**.
- Vehicle: **MH12AB4821** wherever stated.
- Total quantity and consignment net weight: **10,000 KG**. Weighment: **24,000 - 14,000 = 10,000 KG**.
- E-way bill: **271260831101**. LR: **NSR/26-27/101**. All references, parties, quantities, dates and commercial values reconcile.
- Expected: one case with six documents and no substantive mismatches. An extra finding should be investigated as an extraction or verification issue, not assumed to be intentional.

## Case 02 - deliberately conflicting packet

Purchase order **SG/PO/26-27/102** and invoice **ARM/26-27/102** describe 8,000 KG of 6 mm MS Plate at INR 50/KG and 4,000 KG of 8 mm MS Plate at INR 55/KG. The invoiced total is **INR 731,600.00**, quantity **12,000 KG**, and invoice vehicle **MH14EF6724**. Three business discrepancies are deliberately introduced:

| Problem | Reference evidence | Conflicting evidence |
| --- | --- | --- |
| Commercial value | Invoice: taxable 620,000; GST 111,600; total 731,600 | E-way bill: taxable 650,000; GST 117,000; declared invoice value 767,000. Total difference: INR 35,400. |
| Vehicle | Invoice, e-way bill, weighment and delivery note: MH14EF6724 | Lorry receipt: MH20CD7823. No vehicle substitution is recorded. |
| Net weight | Lorry receipt and commercial documents: 12,000 KG | Weighment: 25,700 - 14,000 = 11,700 KG, short by 300 KG. |

The e-way bill's own GST arithmetic is internally consistent; its figures disagree with the invoice. The weighment's own subtraction is correct; its result disagrees with the documented consignment. Reference numbers remain consistent so these are comparisons inside one case, not two unrelated shipments.

Expected: review required, with the commercial-value, vehicle and net-weight conflicts surfaced. The commercial problem can appear as separate subtotal, tax and total findings; do not assume exactly three cards. Case acceptance should remain blocked while issues are pending or rejected.

## Validation limits

The generator checks arithmetic, page counts, document text and PDF readability. The app's local grouped comparison engine is also checked against reference fields separately from AI extraction. That reference-data check is NOT proof that the live Gemini extraction, document grouping or terms review will produce identical output. No AI request, Supabase upload or case creation was performed while preparing these files. Local comparison results are recorded in `validation/comparison-results.json`.
"""
    (OUT / "READ-ME-FIRST.md").write_text(content)
    c = canvas.Canvas(str(OUT / "Expected-Results-Do-Not-Upload.pdf"), pagesize=A4)
    c.setTitle("Samrat test cases - expected results; do not upload")
    accent = colors.HexColor("#234B72")
    y = header(c, "TEST CASE ANSWER SHEET", "SAMRAT GROUP / QA", "For the tester only - do not upload with case documents", accent, 0)
    y = section(c, y, "Upload instructions", accent)
    y = paragraph(c, M, y, "Upload Case 01 first. Use one combined six-page PDF per case. Keep automatic document detection ON and formatting mismatches OFF. Alternatively upload the six individual PDFs together, never both versions. Create a separate case for Case 02. AI analysis consumes shared OpenRouter credits.", CW, 10) + 18
    y = section(c, y, "Case 01 - matching case", accent)
    y = paragraph(c, M, y, "PO SG/PO/26-27/101 | Invoice ARM/26-27/101\nTaxable INR 620,000.00 + GST INR 111,600.00 = INR 731,600.00.\n10,000 KG; vehicle MH12AB4821; weighment 24,000 - 14,000 = 10,000 KG.\nExpected: one case, six documents, no substantive mismatches; then manual case acceptance.", CW, 10) + 18
    y = section(c, y, "Case 02 - deliberate discrepancies", accent)
    rows = [
        ["Amount", "Invoice: INR 731,600.00", "E-way bill: INR 767,000.00 (INR 35,400.00 higher)"],
        ["Vehicle", "Invoice / e-way / weighment / delivery: MH14EF6724", "Lorry receipt: MH20CD7823"],
        ["Net weight", "Lorry receipt / consignment: 12,000 KG", "Weighment: 11,700 KG (300 KG short)"],
    ]
    y = table(c, y, ["CHECK", "REFERENCE", "CONFLICT"], rows, [65, 211, CW - 276], accent)
    y = paragraph(c, M, y, "The amount discrepancy may create three cards: taxable value, tax, and total. Check that unresolved issues block acceptance. On this disposable test, reject an issue, refresh, then change decisions to test persistence and final acceptance. Do not approve incorrect real records merely to clear a queue.", CW, 9.5) + 18
    y = section(c, y, "What has and has not been verified", accent)
    y = paragraph(c, M, y, "PDF and reference-field checks are local. Live Gemini extraction and terms review have not been run and may yield additional findings. Investigate differences against the original pages. All documents are fictional; no cloud upload or paid AI request was made during preparation. See READ-ME-FIRST.md for full details.", CW, 9.5)
    finish(c, y, "answer-sheet")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "validation").mkdir(exist_ok=True)
    reference = []
    qa = []
    for s in SHIPMENTS:
        folder = OUT / ("01-clean-case" if s["case_no"] == 1 else "02-mismatch-case")
        individual = folder / "individual-documents"
        individual.mkdir(parents=True, exist_ok=True)
        packet_name = "Samrat-Case-01-Complete-Packet.pdf" if s["case_no"] == 1 else "Samrat-Case-02-Mismatch-Packet.pdf"
        combined = PdfWriter()
        for index, (doc_type, filename, key, color) in enumerate(DOCS, 1):
            path = individual / filename
            draw_document(path, s, doc_type, key, color, index)
            reader = PdfReader(path)
            assert len(reader.pages) == 1, filename
            visible = reader.pages[0].extract_text()
            assert doc_type.upper() in visible and s[key] in visible, filename
            assert "FICTIONAL TRAINING RECORD" in visible, filename
            combined.append(path)
            qa.append(dict(file=str(path.relative_to(OUT)), pages=1, textCharacters=len(visible), bytes=path.stat().st_size))
        combined.add_metadata({"/Title": f"Samrat Case {s['case_no']:02d} - six-document specimen packet", "/Author": "Samrat fictional workflow test generator"})
        combined.write(folder / packet_name)
        assert len(PdfReader(folder / packet_name).pages) == 6
        assert s["base"] == sum(i["quantity"] * i["rate"] for i in s["items"])
        assert s["total"] == s["base"] + s["tax"]
        ref = reference_docs(s, packet_name)
        for doc, (_, filename, _, _) in zip(ref, DOCS):
            doc["md"] = PdfReader(individual / filename).pages[0].extract_text()
        reference.append(dict(caseNumber=s["case_no"], packet=str((folder / packet_name).relative_to(OUT)), documents=ref, expectedFields=[] if s["case_no"] == 1 else ["subtotal", "taxAmount", "totalAmount", "vehicleNumber", "netWeight"]))
    (OUT / "validation/reference-data.json").write_text(json.dumps(reference, indent=2))
    (OUT / "validation/pdf-qa.json").write_text(json.dumps(qa, indent=2))
    write_guide()
    print(f"Created two 6-page packets, 12 individual PDFs and a separate answer sheet in {OUT}")


if __name__ == "__main__":
    main()
