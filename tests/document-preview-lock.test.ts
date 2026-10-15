import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = ts.createSourceFile(
  "CaseDetailPage.tsx",
  readFileSync(
    new URL("../src/components/cases/CaseDetailPage.tsx", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function elements(tag: string) {
  const matches: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = [];
  function visit(node: ts.Node) {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(source) === tag
    )
      matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return matches;
}
function attribute(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
) {
  const value = element.attributes.properties.find(
    (prop) => ts.isJsxAttribute(prop) && prop.name.getText(source) === name,
  );
  if (!value || !ts.isJsxAttribute(value)) return undefined;
  const initializer = value.initializer;
  if (
    !initializer ||
    !ts.isJsxExpression(initializer) ||
    !initializer.expression
  )
    return undefined;
  return initializer.expression;
}

test("document tiles use native disabling during queued/running analysis for mouse and keyboard", () => {
  const tile = elements("button").find((button) =>
    attribute(button, "onClick")
      ?.getText(source)
      .includes("setDraftPreviewFile(file)"),
  );
  assert.ok(tile);
  assert.equal(attribute(tile, "disabled")?.getText(source), "isAnalyzing");
  assert.ok(
    attribute(tile, "onClick")?.getText(source).includes("if (!isAnalyzing)"),
  );
  const label = attribute(tile, "aria-label");
  assert.ok(label && ts.isConditionalExpression(label));
  assert.equal(label.condition.getText(source), "isAnalyzing");
  assert.equal(label.whenTrue.getText(source), "file.originalName");
  assert.equal(label.whenFalse.getText(source), "`Open ${file.originalName}`");
});

test("the saved document dialog cannot open or fetch a preview while analysis is active", () => {
  const dialog = elements("SavedDocumentDialog");
  assert.equal(dialog.length, 1);
  const file = attribute(dialog[0], "file");
  assert.ok(file && ts.isConditionalExpression(file));
  assert.equal(file.condition.getText(source), "isAnalyzing");
  assert.equal(file.whenTrue.kind, ts.SyntaxKind.NullKeyword);
  assert.equal(file.whenFalse.getText(source), "draftPreviewFile");
});
