import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

test("Help page has a material and a non-material card and is linked at the bottom of the sidebar", () => {
  const page = readFileSync("src/components/help/HelpPage.tsx", "utf8");
  assert.match(page, /Material case/);
  assert.match(page, /Non-material case/);
  assert.match(page, /Choose PO line/);
  const sidebar = readFileSync(
    "src/components/dashboard/DashboardSidebar.tsx",
    "utf8",
  );
  assert.match(sidebar, /href: "\/help"/);
  assert.ok(
    sidebar.indexOf("navItem(helpItem)") > sidebar.indexOf("styles.spacer"),
  );
});
