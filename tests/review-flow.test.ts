import assert from "node:assert/strict";
import test from "node:test";
import { reviewFlowOf } from "@/lib/sap-match/review-flow";

const r = (lines: unknown[], existingInvoice: unknown = null) =>
  ({ lines, existingInvoice }) as never;

test("review flow follows SAP item flags per line", () => {
  assert.equal(reviewFlowOf(r([{ kind: "material" }])), "material_grpo");
  assert.equal(reviewFlowOf(r([{ kind: "service" }])), "service_po");
  assert.equal(reviewFlowOf(r([{ kind: "non-stock" }])), "non_stock_po");
  assert.equal(
    reviewFlowOf(r([{ kind: "unmapped", nonStockPoCandidates: [{}] }])),
    "non_stock_po",
  );
  assert.equal(reviewFlowOf(r([{ kind: "unmapped" }])), null);
  assert.equal(
    reviewFlowOf(r([{ kind: "material" }, { kind: "service" }])),
    "mixed",
  );
  assert.equal(reviewFlowOf(r([{ kind: "material" }], {})), "already_recorded");
});
