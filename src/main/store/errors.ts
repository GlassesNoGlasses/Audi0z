
/** Thrown when an id does not exist in the store. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFound'
  }
}

/** Thrown when a write collides. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Conflict'
  }
}
