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

function validateEnum(schema: JsonObject, value: JsonValue, path: string, issues: ValidationIssue[]): void {
  const values = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (!values?.length) {
    return;
  }
  if (!values.includes(value)) {
    issues.push({ path, message: `must be one of ${values.map((item) => JSON.stringify(item)).join(", ")}` });
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
