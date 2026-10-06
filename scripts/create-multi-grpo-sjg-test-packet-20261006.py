"""Create an upload-ready SAP Test packet for one invoice based on two GRPOs.

The commercial values mirror currently open SAP Test documents for supplier
OTHR002. The PDF is explicitly marked as test data and must not be used as a
real tax document.
"""

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = (
    ROOT
    / "output"
    / "pdf"
    / "multi-grpo-sjg-20261006"
    / "SJG_Multi_GRPO_Invoice_12345678.pdf"
)

PAGE_W, PAGE_H = A4
NAVY = colors.HexColor("#17243D")
BLUE = colors.HexColor("#2563EB")
PALE = colors.HexColor("#EFF6FF")
INK = colors.HexColor("#172033")
MUTED = colors.HexColor("#5C667A")
LINE = colors.HexColor("#D7DEEA")
GREEN = colors.HexColor("#18794E")
RED = colors.HexColor("#B42318")

styles = getSampleStyleSheet()
styles.add(
    ParagraphStyle(
        name="PacketTitle",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=20,
        leading=24,
        textColor=NAVY,
        spaceAfter=4 * mm,
    )
)
styles.add(
    ParagraphStyle(
        name="PacketSub",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=9,
        leading=13,
        textColor=MUTED,
        spaceAfter=4 * mm,
    )
)
styles.add(
    ParagraphStyle(
        name="Section",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=11,
        leading=14,
        textColor=NAVY,
        spaceBefore=3 * mm,
        spaceAfter=2 * mm,
    )
)
styles.add(
    ParagraphStyle(
        name="BodySmall",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=8.5,
        leading=12,
        textColor=INK,
    )
)
styles.add(
    ParagraphStyle(
        name="BodyRight",
        parent=styles["BodySmall"],
        alignment=TA_RIGHT,
    )
)
styles.add(
    ParagraphStyle(
        name="Centered",
        parent=styles["BodySmall"],
        alignment=TA_CENTER,
    )
)
styles.add(
    ParagraphStyle(
        name="TableHeader",
        parent=styles["Centered"],
        fontName="Helvetica-Bold",
        textColor=colors.white,
    )
)
styles.add(
    ParagraphStyle(
        name="Callout",
        parent=styles["Normal"],
        fontName="Helvetica-Bold",
        fontSize=9,
        leading=13,
        textColor=GREEN,
    )
)


def p(value, style="BodySmall"):
    return Paragraph(str(value), styles[style])


def money(value):
    return f"INR {value:,.2f}"


def details(rows, widths=(52 * mm, 125 * mm)):
    data = [[p(f"<b>{label}</b>"), p(value)] for label, value in rows]
    table = Table(data, colWidths=list(widths), hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (0, -1), PALE),
                ("BOX", (0, 0), (-1, -1), 0.6, LINE),
                ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return table


def grid(headers, rows, widths):
    data = [[p(cell, "TableHeader") for cell in headers]]
    data.extend([[p(cell) for cell in row] for row in rows])
    table = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("BOX", (0, 0), (-1, -1), 0.7, LINE),
                ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return table


def title(text, subtitle):
    return [p(text, "PacketTitle"), p(subtitle, "PacketSub")]


def party_table():
    return grid(
        ["Supplier", "Bill to / Ship to"],
        [
            [
                "<b>SJG EVENTS &amp; EXHIBITIONS</b><br/>11/2 RT, Prakash Nagar, Old Airport, Begumpet, Secunderabad, Telangana 500016<br/><b>GSTIN:</b> 36ABCFS1208D1ZP<br/><b>SAP supplier:</b> OTHR002",
                "<b>SAMRAT IRONS PRIVATE LIMITED</b><br/>Kadapa Road, Opp. Bharathi Cement Company, Kamalapuram, YSR, Andhra Pradesh 516289<br/><b>GSTIN:</b> 37AAQCS9189P1ZW",
            ]
        ],
        [88 * mm, 89 * mm],
    )


def page_mark(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(colors.HexColor("#FDECEC"))
    canvas.rect(0, PAGE_H - 11 * mm, PAGE_W, 11 * mm, fill=1, stroke=0)
    canvas.setFillColor(RED)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.drawCentredString(
        PAGE_W / 2,
        PAGE_H - 7 * mm,
        "SAP TEST PACKET - NOT A REAL TAX OR TRANSPORT DOCUMENT",
    )
    canvas.setStrokeColor(LINE)
    canvas.line(17 * mm, 14 * mm, PAGE_W - 17 * mm, 14 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7.5)
    canvas.drawString(17 * mm, 9 * mm, "Samrat workflow multi-GRPO validation")
    canvas.drawRightString(
        PAGE_W - 17 * mm,
        9 * mm,
        f"Invoice 12345678  |  Page {doc.page}",
    )
    canvas.restoreState()


story = []

# Page 1: consolidated tax invoice.
story += title(
    "TAX INVOICE",
    "Consolidated supplier invoice covering two separately received SAP GRPOs",
)
story.append(party_table())
story.append(Spacer(1, 4 * mm))
story.append(
    details(
        [
            ("Invoice number", "12345678"),
            ("Invoice date", "06-Oct-2026"),
            ("Currency", "INR"),
            ("Purchase orders", "297 and 100269"),
            ("Delivery references", "SJG-DN-297 and SJG-DN-100269"),
            ("Place of supply", "Andhra Pradesh (37)"),
        ]
    )
)
story.append(p("Invoice lines", "Section"))
story.append(
    grid(
        ["#", "Item", "PO / GRPO", "Qty", "Unit rate", "Taxable"],
        [
            [
                "1",
                "CUP0001<br/>COUPLER - 25MM<br/>HSN 73079990",
                "PO 297<br/>GRPO 101031",
                "15 NOS",
                money(30000),
                money(450000),
            ],
            [
                "2",
                "CUP0001<br/>COUPLER - 25MM<br/>HSN 73079990",
                "PO 100269<br/>GRPO 101033",
                "100 NOS",
                money(10000),
                money(1000000),
            ],
        ],
        [8 * mm, 49 * mm, 34 * mm, 20 * mm, 31 * mm, 35 * mm],
    )
)
story.append(Spacer(1, 3 * mm))
story.append(
    details(
        [
            ("Taxable value", money(1450000)),
            ("IGST at 18%", money(261000)),
            ("Invoice total", f"<b>{money(1711000)}</b>"),
            ("Amount in words", "Indian Rupees Seventeen Lakh Eleven Thousand Only"),
        ]
    )
)
story.append(Spacer(1, 4 * mm))
story.append(
    p(
        "Declaration: Both delivery lots belong to this single invoice. The quantities and rates are stated separately so each invoice row remains traceable to its own SAP goods receipt.",
        "Callout",
    )
)
story.append(PageBreak())


def add_po(doc_num, doc_entry, date, qty, rate, warehouse, grpo):
    story.extend(title(f"PURCHASE ORDER {doc_num}", "Buyer-issued material order"))
    story.append(party_table())
    story.append(Spacer(1, 4 * mm))
    story.append(
        details(
            [
                ("SAP PO number", str(doc_num)),
                ("SAP PO entry", str(doc_entry)),
                ("Order date", date),
                ("Supplier code", "OTHR002"),
                ("Warehouse", warehouse),
                ("Linked open GRPO", str(grpo)),
            ]
        )
    )
    story.append(p("Ordered material", "Section"))
    story.append(
        grid(
            ["Item code", "Description", "Qty", "Unit", "Rate", "Value", "Tax"],
            [["CUP0001", "COUPLER - 25MM", str(qty), "NOS", money(rate), money(qty * rate), "IGST 18%"]],
            [23 * mm, 47 * mm, 17 * mm, 17 * mm, 27 * mm, 30 * mm, 16 * mm],
        )
    )
    story.append(Spacer(1, 5 * mm))
    story.append(
        p(
            "Commercial terms: supply against this order; invoice only after accepted receipt. Payment follows invoice verification and SAP three-way matching.",
            "BodySmall",
        )
    )
    story.append(PageBreak())


add_po(297, 56678, "28-Sep-2026", 15, 30000, "APK-CAB", 101031)
add_po(100269, 56687, "06-Oct-2026", 100, 10000, "AP-HRRET", 101033)

# Page 4: first received lot.
story += title("DELIVERY NOTE SJG-DN-297", "First material lot received against PO 297")
story.append(
    details(
        [
            ("Supplier", "SJG EVENTS & EXHIBITIONS (OTHR002)"),
            ("Delivery date", "28-Sep-2026"),
            ("Purchase order", "297"),
            ("SAP GRPO", "101031 (DocEntry 169090)"),
            ("Vendor invoice reference", "12345678"),
            ("Vehicle number", "AP12S2323"),
            ("Lorry receipt", "123"),
            ("E-way bill", "181000012345 (SAP short reference 12345)"),
            ("Warehouse", "APK-CAB"),
        ]
    )
)
story.append(p("Received material", "Section"))
story.append(
    grid(
        ["Item code", "Description", "Accepted qty", "Unit", "GRPO open qty", "Rate"],
        [["CUP0001", "COUPLER - 25MM", "15", "NOS", "15", money(30000)]],
        [25 * mm, 55 * mm, 25 * mm, 18 * mm, 28 * mm, 31 * mm],
    )
)
story.append(Spacer(1, 6 * mm))
story.append(p("Material checked and accepted. No rejection or return was recorded.", "Callout"))
story.append(PageBreak())

# Page 5: e-way bill for the first truck.
story += title("E-WAY BILL", "Transport document for delivery SJG-DN-297")
story.append(
    details(
        [
            ("E-way bill number", "181000012345"),
            ("Generated on", "28-Sep-2026 08:10"),
            ("Valid through", "30-Sep-2026"),
            ("Document type / number", "Tax Invoice / 12345678"),
            ("Supplier GSTIN", "36ABCFS1208D1ZP"),
            ("Recipient GSTIN", "37AAQCS9189P1ZW"),
            ("From", "Begumpet, Secunderabad, Telangana 500016"),
            ("To", "Kamalapuram, YSR, Andhra Pradesh 516289"),
            ("Vehicle number", "AP12S2323"),
            ("Transporter / LR", "South Central Roadways / LR 123"),
            ("Material", "CUP0001 - COUPLER - 25MM, 15 NOS"),
            ("Taxable value", money(450000)),
        ]
    )
)
story.append(Spacer(1, 5 * mm))
story.append(p("Inter-state movement; IGST applies.", "Callout"))
story.append(PageBreak())

# Page 6: second received lot. SAP contains no logistics UDFs for this GRPO.
story += title("DELIVERY NOTE SJG-DN-100269", "Second material lot received against PO 100269")
story.append(
    details(
        [
            ("Supplier", "SJG EVENTS & EXHIBITIONS (OTHR002)"),
            ("Delivery date", "06-Oct-2026"),
            ("Purchase order", "100269"),
            ("SAP GRPO", "101033 (DocEntry 169106)"),
            ("Vendor invoice reference", "12345678"),
            ("Warehouse", "AP-HRRET"),
            ("Receipt note", "Second lot under the same consolidated supplier invoice"),
        ]
    )
)
story.append(p("Received material", "Section"))
story.append(
    grid(
        ["Item code", "Description", "Accepted qty", "Unit", "GRPO open qty", "Rate"],
        [["CUP0001", "COUPLER - 25MM", "100", "NOS", "100", money(10000)]],
        [25 * mm, 55 * mm, 25 * mm, 18 * mm, 28 * mm, 31 * mm],
    )
)
story.append(Spacer(1, 6 * mm))
story.append(p("Material checked and accepted. No rejection or return was recorded.", "Callout"))

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
document = SimpleDocTemplate(
    str(OUTPUT),
    pagesize=A4,
    rightMargin=16 * mm,
    leftMargin=16 * mm,
    topMargin=17 * mm,
    bottomMargin=18 * mm,
    title="SJG multi-GRPO SAP Test packet - invoice 12345678",
    author="Samrat workflow QA",
)
document.build(story, onFirstPage=page_mark, onLaterPages=page_mark)
print(OUTPUT)
