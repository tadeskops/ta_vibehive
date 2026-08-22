/**
 * HTTP-shaped error for route handlers. Caller catches and returns via
 * the envelope. Never leaks stack traces to the client — only the message.
 */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}
