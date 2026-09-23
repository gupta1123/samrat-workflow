import assert from "node:assert/strict";
import { test } from "node:test";

import { selectSapLine } from "../src/lib/sap-line-match";

test("keeps separate same-description invoice rows and pairs them by rate and quantity", () => {
  const sapLines = [
    { itemCode: "NINV1210", description: "SMART COIL 13+  -SCHNELL INDIA", quantity: 2, price: 1592.8 },
    { itemCode: "NINV1210", description: "SMART COIL 13+  -SCHNELL INDIA", quantity: 1, price: 2050.4 },
    { itemCode: "NINV1210", description: "SMART COIL 13+  -SCHNELL INDIA", quantity: 2, price: 2701.6 },
  ];
  const packetLines = [
    { itemCode: "NINV1210", description: "SMART COIL 13+ - SCHNELL INDIA", quantity: "1", rate: "2050.4" },
    { itemCode: "NINV1210", description: "SMART COIL 13+ - SCHNELL INDIA", quantity: "2", rate: "1592.8" },
    { itemCode: "NINV1210", description: "SMART COIL 13+ - SCHNELL INDIA", quantity: "2", rate: "2701.6" },
  ];
  const used = new Set<number>();
  assert.deepEqual(packetLines.map((line) => selectSapLine(line, sapLines, used)?.index), [1, 0, 2]);
  assert.equal(used.size, 3);
});

test("matches a Tata receipt by item and quantity, not document number alone", () => {
  const packet = { itemCode: "TWLR001", description: "LR 15.2MM - OILED", quantity: "29.836" };
  const wrong = [{ itemCode: "TBW003", description: "TATA WIRON (30 KG'S)", quantity: 30 }];
  const right = [{ itemCode: "TWLR001", description: "LR 15.2MM - OILED", quantity: 29.836 }];
  assert.equal(selectSapLine(packet, wrong, new Set()), null);
  assert.equal(selectSapLine(packet, right, new Set())?.index, 0);
});
