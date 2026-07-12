import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";

export type JsonSchemaValidator = (value: unknown) => string[];

export function compileJsonSchema(schema: unknown): JsonSchemaValidator {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema as object);
  return (value: unknown) => {
    if (validate(value)) return [];
    return formatErrors(validate);
  };
}

function formatErrors(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).slice(0, 40).map(formatError);
}

function formatError(error: ErrorObject): string {
  const at = error.instancePath ? `$${error.instancePath}` : "$";
  if (error.keyword === "required") {
    const missing = String((error.params as { missingProperty?: string }).missingProperty ?? "");
    return `${at}.${missing} is required`;
  }
  if (error.keyword === "additionalProperties") {
    const extra = String(
      (error.params as { additionalProperty?: string }).additionalProperty ?? "",
    );
    return `${at}.${extra} is not allowed`;
  }
  return `${at} ${error.message ?? `failed ${error.keyword}`}`;
}
