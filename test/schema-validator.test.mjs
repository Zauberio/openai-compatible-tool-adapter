import assert from "node:assert/strict";
import { test } from "node:test";
import { compileJsonSchema } from "../dist/core/schema-validator.js";

test("validates JSON Schema constraints beyond basic types", () => {
  const validate = compileJsonSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["command", "items", "title"],
    properties: {
      command: { const: "/review" },
      items: { type: "array", minItems: 1, items: { type: "string", pattern: "^#[0-9]+$" } },
      title: { type: "string", maxLength: 8 },
    },
  });

  assert.deepEqual(validate({ command: "/review", items: ["#12"], title: "valid" }), []);
  const errors = validate({ command: "/other", items: [], title: "too long a title" });
  assert.equal(errors.length >= 3, true);
  assert.match(errors.join("\n"), /equal to constant|minItems|fewer than 1|maxLength|more than 8/);
});
