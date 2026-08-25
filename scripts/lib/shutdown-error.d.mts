/** The single shutdown-rejection type, shared by the registry and child runner. */
export class ResourceRegistryShuttingDownError extends Error {
  readonly code: 'RESOURCE_REGISTRY_SHUTTING_DOWN'
  constructor(what: string)
}
