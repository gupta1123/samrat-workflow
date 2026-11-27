import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { needsInvoiceVerification } from "../src/lib/sap-match-recovery";

const panel = readFileSync("src/components/cases/SapMatchPanel.tsx", "utf8");
const candidates = readFileSync(
  "src/components/cases/sap-match/ServicePoCandidates.tsx",
  "utf8",
);

test("an open duplicate-invoice check keeps item matching out of the way", () => {
  assert.match(panel, /check\.id === "dup" && check\.open && !check\.decision/);
  assert.match(panel, /only needed if you do not close this invoice/);
});

test("an invoice-assembly failure selects invoice verification recovery", () => {
  assert.equal(
    needsInvoiceVerification({
      available: false,
      reason:
        "The invoice cover and billing pages need a source-reviewed invoice assembly.",
    }),
    true,
  );
});

test("PO line choice shows the invoice line beside the PO lines and the price gap", () => {
  assert.match(candidates, /This invoice line/);
  assert.match(
    candidates,
    /% \$\{invoicePrice > sapPrice \? "above" : "below"\} the PO/,
  );
});

test("a single cited PO collapses the supplier PO picker", () => {
  assert.match(candidates, /cited on the invoice/);
  assert.match(candidates, /Change PO \(/);
});
