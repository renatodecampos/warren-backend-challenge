/** An error the client is meant to see: it becomes `{ error: { code, message } }` with this status. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
