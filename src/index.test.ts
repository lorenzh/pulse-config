import assert from "node:assert/strict";
import { test } from "node:test";
import { name } from "./index.ts";

test("exports the package name", () => {
  assert.equal(name, "pulse-config");
});
