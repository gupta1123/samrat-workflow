import assert from "node:assert/strict";
import test from "node:test";
import { reviewFlowBadge } from "@/components/cases/CaseReviewFlowBadge";

test("badge names the flow and warns when goods are reviewed without stock", () => {
  assert.equal(reviewFlowBadge(null, "goods"), null);
  assert.equal(reviewFlowBadge("material_grpo", "goods")?.warn, false);
  const badge = reviewFlowBadge("non_stock_po", "goods");
  assert.equal(badge?.label, "Non-material · PO line");
  assert.equal(badge?.warn, true);
  assert.equal(reviewFlowBadge("service_po", "services")?.warn, false);
});
