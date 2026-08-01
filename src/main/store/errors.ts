/**
 * Store-level error identities. One module so `instanceof` works across stores and so the IPC
 * layer (and, later, the renderer's toast) can tell "you asked for something that is gone" apart
 * from "the disk blew up".
 */

/** Thrown when an id does not exist in the store. `name` is stable — it crosses IPC. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFound'
  }
}
