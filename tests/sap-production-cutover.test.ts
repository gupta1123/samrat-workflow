import assert from "node:assert/strict";
import test from "node:test";
import {
  readSapEnvironment,
  readSapServiceConnection,
  sapCaseEnvironment,
  sapCaseOrigin,
  sapCompanyKey,
} from "../src/server/sap/config";
import {
  isSapMatchForEnvironment,
  requireActiveSapCase,
} from "../src/server/sap/case-environment";

test("the cutover keeps historic uploads and split cases in their original company", (t) => {
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.SAP_API_ENV = "live";
  process.env.SAP_LIVE_CASES_FROM = "2099-06-01T00:00:00Z";
  assert.equal(readSapEnvironment(), "test");
  process.env.SAP_LIVE_CASES_FROM = "2026-06-01T00:00:00Z";
  const old = "2026-05-31T23:59:59Z";
  const fresh = "2026-06-01T00:00:00Z";
  assert.equal(readSapEnvironment(), "live");
  assert.equal(sapCaseEnvironment(old), "test");
  assert.equal(
    sapCaseEnvironment(sapCaseOrigin(fresh, { sapOriginCreatedAt: old })),
    "test",
  );
  assert.equal(requireActiveSapCase(fresh), "live");
  assert.throws(() => requireActiveSapCase(old), /SAP Test/);
  assert.throws(() => requireActiveSapCase(null), /case date/);
  process.env.SAP_API_ENV = "test";
  assert.throws(() => requireActiveSapCase(fresh), /SAP Production/);
  assert.equal(requireActiveSapCase(old), "test");
});

test("Production never uses a Test match, mapping or connection", (t) => {
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.SAP_API_ENV = "live";
  process.env.SAP_LIVE_CASES_FROM = "2026-06-01T00:00:00Z";
  process.env.SAP_SL_TEST_COMPANY_DB = "TEST";
  process.env.SAP_SL_LIVE_BASE_URL = "https://sap.example/b1s/v1";
  delete process.env.SAP_SL_LIVE_COMPANY_DB;
  assert.throws(() => readSapServiceConnection(), /SAP_SL_LIVE_COMPANY_DB/);
  process.env.SAP_SL_LIVE_COMPANY_DB = "test";
  assert.throws(() => readSapServiceConnection(), /different companies/);
  process.env.SAP_SL_LIVE_COMPANY_DB = "PRODUCTION";
  process.env.SAP_SL_LIVE_USERNAME = "fixture";
  process.env.SAP_SL_LIVE_PASSWORD = "fixture";
  assert.equal(sapCompanyKey("vendor"), "live:PRODUCTION:vendor");
  assert.equal(sapCompanyKey("vendor", "test"), "vendor");
  assert.equal(isSapMatchForEnvironment({}, "live"), false);
  assert.equal(isSapMatchForEnvironment({}, "test"), true);
  assert.equal(isSapMatchForEnvironment({ sapEnv: "live" }, "live"), true);
});
