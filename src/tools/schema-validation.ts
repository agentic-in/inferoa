import type { JsonObject, JsonValue, ToolDefinition, ToolResult } from "../types.js";
import { fail } from "../util/limit.js";

interface ValidationIssue {
  path: string;
  message: string;
}

export function validateToolArguments(definition: ToolDefinition, args: JsonObject): ToolResult | undefined {
  const issues: ValidationIssue[] = [];
  validateSchema(definition.parameters, args, "arguments", issues);
  if (!issues.length) {
    return undefined;
  }
  return fail(
    "invalid_tool_arguments",
    `Invalid ${definition.name} arguments: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
    { issues: issues as unknown as JsonObject[] },
  );
}

function validateSchema(schema: JsonObject, value: JsonValue, path: string, issues: ValidationIssue[]): void {
  const variants = Array.isArray(schema.oneOf) ? schema.oneOf.filter(isPlainObject) : [];
  if (variants.length) {
    validateOneOf(variants, value, path, issues);
    return;
  }

  if (schema.const !== undefined && !jsonEqual(value, schema.const as JsonValue)) {
    issues.push({ path, message: `must be ${JSON.stringify(schema.const)}` });
    return;
  }

  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type === "object") {
    if (!isPlainObject(value)) {
      issues.push({ path, message: "must be an object" });
      return;
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const name of required) {
      if (value[name] === undefined) {
        issues.push({ path: `${path}.${name}`, message: "is required" });
      }
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (properties[name] === undefined) {
          issues.push({ path: `${path}.${name}`, message: "is not a supported argument" });
        }
      }
    }
    for (const [name, propertySchema] of Object.entries(properties)) {
      const child = value[name];
      if (child === undefined) {
        continue;
      }
      if (isPlainObject(propertySchema)) {
        validateSchema(propertySchema, child, `${path}.${name}`, issues);
      }
    }
    return;
  }

  if (type === "array") {
    if (!Array.isArray(value)) {
      issues.push({ path, message: "must be an array" });
      return;
    }
    if (isPlainObject(schema.items)) {
      value.forEach((item, index) => validateSchema(schema.items as JsonObject, item, `${path}[${index}]`, issues));
    }
    return;
  }

  if (type === "string") {
    if (typeof value !== "string") {
      issues.push({ path, message: "must be a string" });
      return;
    }
    validateEnum(schema, value, path, issues);
    return;
  }

  if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push({ path, message: "must be a finite number" });
    }
    return;
  }

  if (type === "boolean") {
    if (typeof value !== "boolean") {
      issues.push({ path, message: "must be a boolean" });
    }
    return;
  }

  validateEnum(schema, value, path, issues);
}

function validateOneOf(variants: JsonObject[], value: JsonValue, path: string, issues: ValidationIssue[]): void {
  const failures: ValidationIssue[][] = [];
  const opMatchedFailures: ValidationIssue[][] = [];
  let matches = 0;
  for (const variant of variants) {
    const variantIssues: ValidationIssue[] = [];
    validateSchema(variant, value, path, variantIssues);
    if (variantIssues.length === 0) {
      matches += 1;
    } else {
      failures.push(variantIssues);
      if (variantMatchesOpConst(variant, value)) {
        opMatchedFailures.push(variantIssues);
      }
    }
  }
  if (matches === 1) {
    return;
  }
  if (matches > 1) {
    issues.push({ path, message: "must match exactly one supported argument shape" });
    return;
  }
  const candidates = opMatchedFailures.length ? opMatchedFailures : failures;
  const closest = candidates
    .slice()
    .sort((left, right) => left.length - right.length)[0];
  if (closest?.length) {
    issues.push(...closest);
    return;
  }
  issues.push({ path, message: "must match one supported argument shape" });
}

function variantMatchesOpConst(variant: JsonObject, value: JsonValue): boolean {
  if (!isPlainObject(value) || typeof value.op !== "string") {
    return false;
  }
  const properties = isPlainObject(variant.properties) ? variant.properties : {};
  const opSchema = properties.op;
  return isPlainObject(opSchema) && opSchema.const === value.op;
}

function validateEnum(schema: JsonObject, value: JsonValue, path: string, issues: ValidationIssue[]): void {
  const values = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (!values?.length) {
    return;
  }
  if (!values.includes(value)) {
    issues.push({ path, message: `must be one of ${values.map((item) => JSON.stringify(item)).join(", ")}` });
  }
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
