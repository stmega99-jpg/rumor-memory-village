import { describe, expect, it } from "vitest";

import {
  RuntimeConfigurationError,
  validateRuntimeSecrets,
} from "../lib/walking-skeleton/config";

const valid = {
  cockroachMcpApiKey: "CCDB1_test_key_that_is_not_real",
  cockroachClusterId: "dcd3153f-e8af-4509-a796-b4f160170270",
  cockroachSqlUrl:
    "postgresql://rmv_app:test-password@cluster.example:26257/defaultdb?sslmode=verify-full",
  worldCookieSecret: "independent-test-cookie-secret-at-least-32-bytes",
};

describe("runtime secret contract", () => {
  it("keeps every value required by the MCP, SQL and world-cookie paths", () => {
    expect(validateRuntimeSecrets(valid)).toEqual(valid);
  });

  it.each([
    ["missing SQL URL", { ...valid, cockroachSqlUrl: undefined }],
    ["non-Postgres URL", { ...valid, cockroachSqlUrl: "https://example.com/db" }],
    [
      "SQL URL without a password",
      { ...valid, cockroachSqlUrl: "postgresql://rmv_app@cluster.example/defaultdb" },
    ],
    ["missing cookie key", { ...valid, worldCookieSecret: undefined }],
    ["short cookie key", { ...valid, worldCookieSecret: "too-short" }],
    [
      "cookie key reused from the MCP key",
      { ...valid, worldCookieSecret: valid.cockroachMcpApiKey },
    ],
  ])("rejects %s without returning partial credentials", (_label, candidate) => {
    expect(() => validateRuntimeSecrets(candidate)).toThrow(RuntimeConfigurationError);
  });
});
