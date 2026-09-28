import assert from "node:assert/strict";
import test from "node:test";
import {
  countUploadPages,
  validateCasePageLimit,
} from "../src/lib/upload-page-limit";
import { samplePdf } from "./pdf-fixture";

const pdf = (name: string, pages: number) =>
  new File([samplePdf(pages).buffer as ArrayBuffer], name, {
    type: "application/pdf",
  });

test("counts PDF pages and treats each image as one page", async () => {
  const files = [
    pdf("invoice.pdf", 3),
    new File(["image"], "weighment.jpg", { type: "image/jpeg" }),
    pdf("purchase-order.pdf", 2),
  ];
  assert.equal(await countUploadPages(files), 6);
});

test("rejects nine five-page PDFs with a clear 45-of-40 message", async () => {
  const files = Array.from({ length: 9 }, (_, index) =>
    pdf(`packet-${index + 1}.pdf`, 5),
  );
  await assert.rejects(
    validateCasePageLimit(files),
    /45 pages.*maximum of 40 pages.*5 pages/,
  );
});

test("rejects unreadable PDFs instead of guessing their page count", async () => {
  const invalid = new File(["not a pdf"], "broken.pdf", {
    type: "application/pdf",
  });
  await assert.rejects(
    validateCasePageLimit([invalid]),
    /couldn't read the page count.*valid, unencrypted PDF/,
  );
});
