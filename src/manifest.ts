type JsonValue = null | boolean | number | string | JsonObject | JsonValue[];
interface JsonObject { [key: string]: JsonValue; }

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceList(value: JsonValue): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry: JsonValue) => typeof entry === "string");
}

export function readManifest(text: string): string[] {
  // JSON without a reviver can contain only JSON values. Check the manifest before accessing its fields.
  const value: JsonValue = JSON.parse(text);
  if (!isObject(value)) throw new Error("CR001: invalid Bake manifest");
  const target = value.target ?? null;
  if (!isObject(target) || target.backend !== "clang" || target.freestanding !== true)
    throw new Error("CR001: input must be Bake --target=clang freestanding output");
  if (Object.hasOwn(target, "intrinsicAbi") && target.intrinsicAbi !== 1) throw new Error("CR003: unsupported Bake native intrinsic ABI");
  const sources = value.sourceFiles ?? null;
  if (!sourceList(sources)) throw new Error("CR002: Bake manifest has no valid source files");
  return sources;
}
