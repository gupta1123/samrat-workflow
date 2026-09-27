# SAP Invoice Creation — How It Works

A plain-words explanation of how approved cases become GRN and AP Invoice
documents inside SAP. Intended for non-technical readers.

## The idea in one paragraph

When our team approves a purchase packet in the Samrat app, one button —
**Post to SAP** — creates the matching documents in SAP automatically:
first the **GRN** (goods receipt), then the **AP Invoice** (vendor payment).
No re-typing of vendor names, items, quantities, or totals.

## The two SAP documents, simply

| # | Document | Meaning | Made from |
|---|----------|---------|-----------|
| 1 | **GRN** (Goods Receipt Note) | "The goods arrived" | The **PO** in SAP |
| 2 | **AP Invoice** | "Pay the vendor this amount" | The **GRN** + the vendor's invoice |

Order matters: the GRN is always created first, and the AP Invoice is
linked to that GRN — exactly how SAP expects it.

## The exact flow, step by step

```
1. Upload      Team uploads invoice, e-way bill, LR, weighment slip…
2. Analyze     The app reads every page and checks for mismatches
3. Review      Reviewer accepts or rejects each mismatch
4. Approve     Reviewer approves the case (button unlocks only now)
5. Detect      The app decides what SAP needs:
                 • PO + goods-receipt proof  →  GRN needed
                 • Vendor invoice present    →  AP Invoice needed
                 • Both present              →  both, GRN first
6. Match       The app finds the matching open PO / GRPO in SAP:
                 • Exact match on PO number, when possible
                 • Otherwise a ranked pick-list (same vendor + same
                   total), and the reviewer picks the right one
7. Prepare     The app builds both SAP documents: vendor code, items,
               quantities, rates, tax, totals, and the link to the
               base SAP document
8. Post        One click sends GRN first, then the AP Invoice linked
               to the new GRN. SAP's document numbers are saved on
               the case as proof
9. Done        The case panel shows Posted + the SAP document numbers
```

## Safety rules (automatic, no extra work)

- **Posting unlocks only after approval.** A half-reviewed case can never
  reach SAP.
- **No double posting.** Each document posts once per case per
  environment (Test / Live). Re-clicking is safe — already-posted items
  are skipped, failed items can be retried alone.
- **No double payment.** If the same invoice number appears twice in one
  packet, or was already used in another case, the app raises a
  duplicate-invoice warning that must be resolved before approval.
- **Everything is recorded.** Every attempt — success or failure, with
  SAP's exact reply — is saved on the case in a permanent audit trail.
- **Test vs Live are separated.** The panel always shows which
  environment it will post to. Testing never touches live SAP data.

## What is already built and tested

- Steps 1–7 fully working, verified against SAP's Test environment with
  real open POs (e.g. PO 15: same vendor + matching total found
  automatically, payload prepared with vendor code, 9 PO lines, totals).
- Step 8 built and tested up to SAP's door: payloads, sequencing,
  retries, audit trail, and responses all handled.
- 223 automated checks pass; the app builds cleanly for production.

## The one thing pending (from the SAP team)

SAP has given us the **reading** access (lists of open POs and GRPOs —
working). To perform step 8 we still need the **writing** access:

1. The URL to **create a GRPO** (with a sample format)
2. The URL to **create an AP Invoice** (with a sample format)
3. Confirmation of which SAP field holds **our PO number**
   (ours look like `SIPL/PO/26-27/1204`, SAP's look like `15`)

The day these two URLs arrive, they go into one settings line each —
no other work is needed, and the very first approved case can post
end-to-end.
