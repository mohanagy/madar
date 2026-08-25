/**
 * The single shutdown-rejection type.
 *
 * Defined in its own module because both the resource registry and the child
 * runner must throw the SAME class: a duplicate definition in each would make
 * `instanceof` false across module boundaries, and a caller distinguishing
 * refusal from failure would silently stop working.
 */
export class ResourceRegistryShuttingDownError extends Error {
  code = 'RESOURCE_REGISTRY_SHUTTING_DOWN'

  constructor(what) {
    super(`refusing to admit ${what}: shutdown has begun`)
    this.name = 'ResourceRegistryShuttingDownError'
  }
}
