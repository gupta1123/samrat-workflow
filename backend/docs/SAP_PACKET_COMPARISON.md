# Packet vs SAP API — Complete Comparison

A detailed breakdown of what the Samrat workflow extracts from uploaded documents (packet) and what the SAP API provides for invoice creation.

---

## Table of Contents

1. [Packet Contents (Extracted Data)](#1-packet-contents-extracted-data)
2. [SAP API Response (Open PO & GRPO)](#2-sap-api-response-open-po--grpo)
3. [How They Connect](#3-how-they-connect)
4. [AP Invoice Creation Flow](#4-ap-invoice-creation-flow)
5. [GRN Creation Flow](#5-grn-creation-flow)
6. [Field Mapping Reference](#6-field-mapping-reference)

---

## 1. Packet Contents (Extracted Data)

### 1.1 Document Types in a Packet

| Document Type | Purpose | Key Fields |
|---------------|---------|------------|
| **Purchase Order** | Buyer's order to vendor | PO number, vendor, items, terms |
| **Amended Purchase Order** | Revised PO | Amendment number, updated terms |
| **Invoice** | Vendor's bill | Invoice number, amounts, tax |
| **Tax Invoice** | GST-compliant invoice | Same as Invoice + IRN, ACK |
| **E-Way Bill** | Transport document | E-way number, vehicle, route |
| **Delivery Note** | Goods dispatch proof | DN number, items, quantities |
| **Delivery Challan** | Transport challan | Challan number, route |
| **Weighment Slip** | Weight proof | Weighment number, gross/tare/net |
| **Lorry Receipt** | Transport receipt | LR number, freight, route |
| **Material Test Certificate** | Quality certificate | Certificate number, batch/heat |
| **Transport Permit** | Movement permit | Permit number, validity |
| **FASTag Toll Proof** | Toll transactions | Statement, trip count |

### 1.2 Extracted Fields — Invoice / Tax Invoice

#### Identity Fields
| Field Key | Label | Description |
|-----------|-------|-------------|
| `vendorName` | Vendor Name | Supplier/seller name |
| `supplierGstin` | Supplier GSTIN | Vendor's GST number |
| `buyerName` | Buyer Name | Purchaser name |
| `buyerGstin` | Buyer GSTIN | Purchaser's GST number |
| `shipToName` | Ship-to Name | Consignee name |
| `shipToGstin` | Ship-to GSTIN | Consignee GST number |

#### Reference Fields
| Field Key | Label | Description |
|-----------|-------|-------------|
| `invoiceNumber` | Invoice Number | Vendor's invoice reference |
| `poNumber` | PO Number | Purchase order reference |
| `deliveryOrderNumber` | Delivery Order Number | DO reference |
| `deliveryNoteNumber` | Delivery Note Number | DN reference |
| `referencePoNumber` | Reference PO Number | Linked PO |
| `eWayBillNumber` | E-Way Bill Number | E-way reference |
| `irnNumber` | IRN Number | Invoice Registration Number |
| `lorryReceiptNumber` | Lorry Receipt Number | LR reference |
| `weighmentNumber` | Weighment Number | Weighbridge slip number |

#### Date Fields
| Field Key | Label |
|-----------|-------|
| `documentDate` | Document Date |
| `ackDate` | Acknowledgement Date |

#### Financial Fields
| Field Key | Label | Description |
|-----------|-------|-------------|
| `subtotal` | Subtotal | Pre-tax amount |
| `totalTaxableAmount` | Total Taxable Amount | Taxable base |
| `taxAmount` | Tax Amount | Total GST |
| `taxRate` | GST Rate % | Combined rate |
| `cgstRate` | CGST Rate % | Central GST rate |
| `sgstRate` | SGST Rate % | State GST rate |
| `igstRate` | IGST Rate % | Integrated GST rate |
| `tdsAmount` | TDS Amount | Tax deducted at source |
| `tdsRate` | TDS Rate % | TDS percentage |
| `tcsAmount` | TCS Amount | Tax collected at source |
| `roundOffAmount` | Round-off Amount | Adjustment |
| `totalAmount` | Total Amount | Final payable |

#### Transport Fields
| Field Key | Label |
|-----------|-------|
| `vehicleNumber` | Vehicle Number |
| `grossWeight` | Gross Weight |
| `tareWeight` | Tare Weight |
| `netWeight` | Net Weight |

#### Terms Fields
| Field Key | Label |
|-----------|-------|
| `deliveryTerms` | Delivery Terms |
| `freightTerms` | Freight / Transport Terms |
| `priceBasis` | Price Basis |

#### Stamp/Signature Fields
| Field Key | Label |
|-----------|-------|
| `hasAuthorizedSignature` | Authorized Signature Present |
| `hasVendorStamp` | Vendor Stamp Present |
| `hasStoreStamp` | Store Stamp Present |
| `hasStoreSignature` | Store Signature Present |
| `hasGateStamp` | Gate Stamp Present |

### 1.3 Line Items (Commercial Table)

Each invoice/document can have multiple line items:

| Field | Description | Example |
|-------|-------------|---------|
| `lineNumber` | Row number | 1, 2, 3... |
| `itemCode` | Product code | "TMT-16MM" |
| `description` | Item description | "TMT Steel Bar 16mm" |
| `hsnSac` | HSN/SAC code | "7214" |
| `quantity` | Quantity | "500" |
| `unit` | Unit of measure | "KG", "NOS", "MT" |
| `rate` | Unit price | "42.50" |
| `discountPercent` | Discount % | "2" |
| `netRate` | Rate after discount | "41.65" |
| `taxableAmount` | Taxable value | "20825.00" |
| `cgstRate` | CGST rate % | "9" |
| `cgstAmount` | CGST amount | "1874.25" |
| `sgstRate` | SGST rate % | "9" |
| `sgstAmount` | SGST amount | "1874.25" |
| `igstRate` | IGST rate % | "18" |
| `igstAmount` | IGST amount | "3748.50" |
| `taxRate` | Total tax rate % | "18" |
| `taxAmount` | Total tax amount | "3748.50" |
| `lineTotal` | Line total | "24573.50" |
| `rawText` | Original text | Full row text from document |

### 1.4 Supported Document Types (Complete List)

```typescript
type DocType =
  | "Purchase Order"
  | "Amended Purchase Order"
  | "Invoice"
  | "Tax Invoice"
  | "Receipt"
  | "Delivery Note"
  | "Delivery Challan"
  | "E-Way Bill"
  | "Weighment Slip"
  | "Lorry Receipt"
  | "Vehicle Registration Certificate"
  | "Driving Licence"
  | "PAN Card"
  | "FASTag Toll Proof"
  | "Material Test Certificate"
  | "Photo Evidence"
  | "Transport Permit"
  | "Bank Statement"
  | "Map Printout"
  | "Payment Screenshot"
  | "Unknown";
```

---

## 2. SAP API Response (Open PO & GRPO)

### 2.1 OpenPO Endpoint

**URL**: `GET /SPAPI/OpenPO`

**Authentication**: Basic Auth (username:password)

**Response Structure**:
```json
{
  "success": true,
  "data": [
    {
      "DocEntry": 123,
      "DocNum": 15,
      "BP Code": "V001",
      "BP Name": "TATA STEEL LIMITED",
      "PO Line Num": 0,
      "ItemCode": "TMT-16MM",
      "Dscription": "TMT Steel Bar 16mm Fe500",
      "Quantity": 1000,
      "OpenQty": 500,
      "Price": 42.50,
      "TaxCode": "GST-18",
      "LineTotal": 42500.00,
      "Tax Amount": 7650.00,
      "Total Amount": 50150.00,
      "WhsCode": "WH-01",
      "Project": "PRJ-2026"
    }
  ]
}
```

#### Field Descriptions

| SAP Field | Type | Description |
|-----------|------|-------------|
| `DocEntry` | number | Internal SAP document entry ID |
| `DocNum` | number/string | SAP PO document number (user-facing) |
| `BP Code` | string | Business Partner / Vendor code |
| `BP Name` | string | Business Partner / Vendor name |
| `PO Line Num` | number | Line number within the PO |
| `ItemCode` | string | Product/item code in SAP |
| `Dscription` | string | Item description |
| `Quantity` | number | Ordered quantity |
| `OpenQty` | number | Remaining open quantity (not yet received) |
| `Price` | number | Unit price |
| `TaxCode` | string | Tax code (e.g., "GST-18", "IGST-12") |
| `LineTotal` | number | Line amount (qty × price) |
| `Tax Amount` | number | Tax amount on this line |
| `Total Amount` | number | Line total + tax |
| `WhsCode` | string | Warehouse code |
| `Project` | string | Project code |

### 2.2 OpenGRPO Endpoint

**URL**: `GET /SPAPI/OpenGRPO`

**Authentication**: Basic Auth (username:password)

**Response Structure**:
```json
{
  "success": true,
  "data": [
    {
      "DocEntry": 456,
      "DocNum": 49,
      "BP Code": "V001",
      "BP Name": "TATA STEEL LIMITED(RETAIL)",
      "PO Line Num": 0,
      "ItemCode": "TMT-16MM",
      "Dscription": "TMT Steel Bar 16mm Fe500",
      "Quantity": 500,
      "OpenQty": 200,
      "Price": 42.50,
      "TaxCode": "GST-18",
      "LineTotal": 21250.00,
      "Tax Amount": 3825.00,
      "Total Amount": 25075.00,
      "WhsCode": "WH-01",
      "Project": "PRJ-2026"
    }
  ]
}
```

#### Difference from OpenPO

| Aspect | OpenPO | OpenGRPO |
|--------|--------|----------|
| **Purpose** | Purchase orders awaiting goods receipt | Goods receipts awaiting AP invoice |
| **OpenQty** | Qty not yet received | Qty not yet invoiced |
| **Base for** | GRN creation | AP Invoice creation |
| **DocNum** | PO number | GRPO number |

### 2.3 Caching

- Cache TTL: **60 seconds**
- Timeout: **20 seconds** per request
- Cache key: `{environment}:{endpoint}` (e.g., `test:OpenPO`)

---

## 3. How They Connect

### 3.1 Matching Logic

```
┌─────────────────────────────────────────────────────────────┐
│                    PACKET (Uploaded Documents)                │
├─────────────────────────────────────────────────────────────┤
│  Invoice: TATA STEEL - INV-2026-001                         │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Line 1: TMT Steel Bar 16mm, HSN: 7214, Qty: 500   │   │
│  │ Line 2: TMT Steel Bar 12mm, HSN: 7214, Qty: 300   │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    MATCHING ENGINE                            │
├─────────────────────────────────────────────────────────────┤
│  1. Match vendor name (token overlap scoring)               │
│  2. Match PO number to DocNum (normalized comparison)       │
│  3. Match line items (description / HSN / ItemCode)         │
│  4. Score candidates (vendor × 0.6 + amount × 0.4)         │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    SAP API RESPONSE                          │
├─────────────────────────────────────────────────────────────┤
│  OpenGRPO DocNum: 49 - TATA STEEL LIMITED(RETAIL)           │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Line 1: TMT-16MM, Qty: 500, OpenQty: 200          │   │
│  │ Line 2: TMT-12MM, Qty: 300, OpenQty: 150          │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Matching Confidence Levels

| Level | Criteria |
|-------|----------|
| **Exact** | Description matches exactly OR HSN = ItemCode |
| **Fuzzy** | Description contains OR HSN contains ItemCode |
| **None** | No match found |

### 3.3 Scoring Formula

```typescript
score = vendorScore * 0.6 + amountScore * 0.4

// Where:
// vendorScore = commonTokens / totalVendorTokens (0 to 1)
// amountScore = based on drift from case total:
//   drift ≤ 1% → 1.0
//   drift ≤ 5% → 0.6
//   drift > 5% → 0
```

---

## 4. AP Invoice Creation Flow

### 4.1 When AP Invoice is Created

```
Packet has Invoice/Tax Invoice with valid invoiceNumber
                    │
                    ▼
        ┌───────────────────────┐
        │ classifySapCase()     │
        │                       │
        │ hasVendorInvoice =    │
        │   doc type is Invoice │
        │   or Tax Invoice AND  │
        │   invoiceNumber exists│
        └───────────────────────┘
                    │
                    ▼
            plan.push("AP")
```

### 4.2 AP Invoice Payload Structure

```json
{
  "documentType": "APInvoice",
  "poNumber": "SIPL/PO/26-27/1204",
  "invoiceNumber": "INV-2026-001",
  "caseId": "abc-123",
  "caseName": "Tata Steel / INV-2026-001",
  "environment": "test",
  "baseDocNum": "49",
  "baseDocChosenBy": "automatic",
  "cardCode": "V001",
  "cardName": "TATA STEEL LIMITED",
  "baseDocEntry": 456,
  "warehouse": "WH-01",
  "project": "PRJ-2026",
  "totals": {
    "taxableAmount": 42075.00,
    "taxAmount": 7573.50,
    "totalAmount": 49648.50
  },
  "baseDocumentLines": [
    {
      "lineNumber": 1,
      "poLineNum": 0,
      "docEntry": 456,
      "itemCode": "TMT-16MM",
      "description": "TMT Steel Bar 16mm",
      "quantity": 500,
      "openQuantity": 200,
      "unit": "KG",
      "price": 42.50,
      "taxCode": "GST-18",
      "warehouse": "WH-01",
      "project": "PRJ-2026"
    }
  ],
  "packetLines": [
    {
      "lineNumber": 1,
      "description": "TMT Steel Bar 16mm",
      "hsnSac": "7214",
      "quantity": 500,
      "unit": "KG",
      "rate": 42.50,
      "taxableAmount": 21250.00,
      "taxAmount": 3825.00
    }
  ],
  "receiptEvidence": ["E-Way Bill", "Weighment Slip"],
  "sourceDocuments": [
    { "type": "Invoice", "title": "Vendor Invoice" },
    { "type": "E-Way Bill", "title": "Transport Document" }
  ]
}
```

---

## 5. GRN Creation Flow

### 5.1 When GRN is Created

```
Packet has Purchase Order (or PO number) AND receipt evidence:
  - Weighment Slip
  - Delivery Note
  - Lorry Receipt
  - E-Way Bill
                    │
                    ▼
            plan.push("GRN")
```

### 5.2 GRN Payload Structure

```json
{
  "documentType": "GRPO",
  "poNumber": "SIPL/PO/26-27/1204",
  "invoiceNumber": null,
  "caseId": "abc-123",
  "caseName": "Tata Steel / GRN",
  "environment": "test",
  "baseDocNum": "15",
  "baseDocChosenBy": "automatic",
  "cardCode": "V001",
  "cardName": "TATA STEEL LIMITED",
  "baseDocEntry": 123,
  "warehouse": "WH-01",
  "project": "PRJ-2026",
  "totals": { ... },
  "baseDocumentLines": [ ... ],
  "packetLines": [ ... ],
  "receiptEvidence": ["Weighment Slip", "Delivery Note"],
  "sourceDocuments": [ ... ]
}
```

---

## 6. Field Mapping Reference

### 6.1 Packet → SAP Header Mapping

| Packet Field | SAP Field | Notes |
|--------------|-----------|-------|
| `vendorName` | `CardName` | Vendor name |
| Extracted from GRPO | `CardCode` | BP Code from SAP |
| `poNumber` | `NumAtCard` | Our PO ref in SAP |
| `invoiceNumber` | `NumAtCard` | Vendor invoice ref |
| Case ID | `Comments` | Case reference |

### 6.2 Packet Line → SAP Line Mapping

| Packet Line Field | SAP Line Field | Notes |
|-------------------|----------------|-------|
| `description` | `Dscription` | Item description |
| `hsnSac` | `ItemCode` | HSN used as item code |
| `quantity` | `Quantity` | Ordered/received qty |
| `unit` | `Uom` | Unit of measure |
| `rate` | `Price` | Unit price |
| `taxableAmount` | `LineTotal` | Line amount |
| `taxAmount` | `TaxAmount` | Tax on line |

### 6.3 SAP GRPO Line → AP Invoice Base

| GRPO Field | AP Field | Purpose |
|------------|----------|---------|
| `DocEntry` | `BaseEntry` | Link to GRPO |
| `PO Line Num` | `BaseLine` | Link to GRPO line |
| `OpenQty` | `Quantity` | Qty to invoice |
| `ItemCode` | `ItemCode` | Product code |
| `Price` | `Price` | Unit price |
| `TaxCode` | `TaxCode` | Tax classification |

### 6.4 Vendor Name Stop Words (Excluded from Matching)

```
PVT, PRIVATE, LIMITED, LTD, INC, CORP, CORPORATION,
LLP, CO, COMPANY, AND, &, THE
```

---

## 7. Blocking Conditions

### AP Invoice Blocked When:

| Condition | Message |
|-----------|---------|
| No vendor invoice found | "No numbered vendor invoice were extracted" |
| No invoiceNumber extracted | "Analyze the packet again before posting to SAP" |

### GRN Blocked When:

| Condition | Message |
|-----------|---------|
| No PO number | "purchase-order number is missing" |
| No receipt evidence | "No goods-receipt evidence found" |

### General Blocks:

| Condition | Message |
|-----------|---------|
| Case not approved | Posting disabled until approval |
| Already posted | Duplicate posting prevented |
| Duplicate invoice number | Warning raised, must resolve |

---

## 8. Environment Configuration

### Required Environment Variables

```bash
# SAP Connection
SAP_BASE_URL=https://sap.example.com
SAP_USERNAME=api_user
SAP_PASSWORD=secret

# Environment (test or live)
SAP_ENV=test

# Create endpoints (pending from SAP team)
SAP_CREATE_GRPO_URL=
SAP_CREATE_AP_URL=

# Review model (optional)
OPENROUTER_REVIEW_MODEL=google/gemini-2.5-pro
```

### Cache Behavior

| Setting | Value |
|---------|-------|
| Cache TTL | 60 seconds |
| Request timeout | 20 seconds |
| Cache key format | `{env}:{endpoint}` |

---

## 9. Quick Reference Card

```
┌─────────────────────────────────────────────────────────────┐
│                    POSTING DECISION TREE                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Has Invoice + invoiceNumber?                               │
│      YES → AP Invoice (base: GRPO or PO)                   │
│      NO  → Skip AP                                          │
│                                                             │
│  Has PO + Receipt Evidence?                                 │
│      YES → GRN (base: Open PO)                             │
│      NO  → Skip GRN                                         │
│                                                             │
│  Has Both?                                                  │
│      YES → GRN first, then AP (linked to new GRN)          │
│                                                             │
│  Order: GRN → AP (always)                                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

*Document generated from Samrat Workflow codebase.*
*Source files: `sap-decision.ts`, `sap-posting.ts`, `posting.ts`, `sap-invoice-prepare/route.ts`*
