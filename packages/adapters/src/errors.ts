export type AdapterErrorCode =
  | "PROFILE_NOT_FOUND"
  | "PROFILE_MISMATCH"
  | "PROFILE_INCOMPATIBLE"
  | "ADAPTER_NOT_FOUND"
  | "P0_SINGLE_HTTP_SERVICE_REQUIRED"
  | "P0_RESOURCES_UNSUPPORTED"
  | "SERVICE_PORT_REQUIRED"
  | "ROUTE_TARGET_INVALID"
  | "SIZE_MAPPING_NOT_FOUND"
  | "PROFILE_CONFIGURATION_INVALID";

export class AdapterError extends Error {
  constructor(
    public readonly code: AdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}
