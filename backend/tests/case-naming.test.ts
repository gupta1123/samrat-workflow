import assert from "node:assert/strict";
import { test } from "node:test";

import { composeAuthoritativeCaseDisplayName } from "../src/server/case-naming";

test("case title uses the structured external counterparty and primary reference", () => {
  assert.equal(
    composeAuthoritativeCaseDisplayName({
      counterpartyName: "MAHANADI STEEL & ALLOYS PRIVATE LIMITED",
      primaryReference: "MSAP/26-27/3086",
      fallback: "SAMRAT IRONS PRIVATE LIMITED / SIPL/PO/26-27/1327",
    }),
    "MAHANADI STEEL & ALLOYS PRIVATE LIMITED / MSAP/26-27/3086",
  );
});

test("case title uses whichever verified component is present before a generic fallback", () => {
  assert.equal(
    composeAuthoritativeCaseDisplayName({
      counterpartyName: "",
      primaryReference: "INV-12",
      fallback: "Reviewed packet",
    }),
    "INV-12",
  );
});
