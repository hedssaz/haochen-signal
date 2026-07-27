export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | {[key: string]: JsonValue};
export type JsonObject = {[key: string]: JsonValue};

export interface NormalizedOperation {
  input: JsonObject;
  scope: string[];
  confirmReasons: string[];
  reviewReasons: string[];
  allowReason: string;
  executableIdentity?: string;
}
