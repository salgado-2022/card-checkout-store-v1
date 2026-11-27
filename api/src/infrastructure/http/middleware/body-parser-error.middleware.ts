// Nest turns a body-parser SyntaxError into a BadRequestException that carries the original
// message and drops `type`, so the exception filter could no longer tell it apart. This error
// handler sits right after the JSON parser and re-emits a parse failure as a plain Error that
// keeps `type` and `status` but never the parser's message (it can quote the request body).
export const BODY_PARSE_FAILED_TYPE = 'entity.parse.failed';
export function preserveBodyParseFailure(
  error: unknown,
  _req: unknown,
  _res: unknown,
  next: (error?: unknown) => void,
): void {
  if ((error as { type?: unknown } | null)?.type === BODY_PARSE_FAILED_TYPE) {
    next(
      Object.assign(new Error('Request body is not valid JSON'), { type: BODY_PARSE_FAILED_TYPE }),
    );
    return;
  }
  next(error);
}
