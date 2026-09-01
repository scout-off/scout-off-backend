import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { ApiResponse } from '../types';
import { logger } from '../utils/logger';
import { ErrorCode } from '../utils/errorCodes';

interface HttpError extends Error {
  type?: string;
  status?: number;
  code?: string;
}

/**
 * Determine whether a numeric status code is a valid HTTP error status.
 * Status 200 and non-4xx/5xx codes are treated as unexpected and fall back to 500.
 */
function isValidErrorStatus(status: unknown): status is number {
  return typeof status === 'number' && status >= 400 && status <= 599;
}

/**
 * Map HTTP status codes to appropriate error codes.
 * This provides sensible defaults for status codes that don't have explicit error codes set.
 */
function getErrorCodeByStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ErrorCode.VALIDATION_ERROR;
    case 401:
      return ErrorCode.UNAUTHORIZED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 409:
      return ErrorCode.CONFLICT;
    case 412:
      return ErrorCode.PRECONDITION_FAILED;
    case 413:
      return ErrorCode.PAYLOAD_TOO_LARGE;
    case 415:
      return ErrorCode.UNSUPPORTED_MEDIA_TYPE;
    case 428:
      return ErrorCode.PRECONDITION_REQUIRED;
    case 500:
    default:
      return ErrorCode.INTERNAL_SERVER_ERROR;
  }
}

export function errorHandler(
  // Accept `unknown` so the handler is safe for null/non-Error inputs
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const correlationId = req.correlationId;

  // Safely extract message for logging — err may be null or a plain object
  const errMessage =
    err != null && typeof (err as Record<string, unknown>).message === 'string'
      ? (err as Record<string, unknown>).message as string
      : 'Internal Server Error';

  logger.error(`[error] ${errMessage}${correlationId ? ` correlationId=${correlationId}` : ''}`);

  // Cast to HttpError for property access — we validate each field before use
  const httpErr = err as HttpError;

  if (httpErr != null && httpErr.type === 'entity.parse.failed') {
    res.status(400).json({
      success: false,
      error: 'Malformed JSON payload',
      code: ErrorCode.MALFORMED_JSON,
      ...(correlationId !== undefined && { correlationId }),
    });
    return;
  }

  if (httpErr != null && httpErr.type === 'entity.too.large') {
    res.status(413).json({
      success: false,
      error: 'Payload too large',
      code: ErrorCode.PAYLOAD_TOO_LARGE,
      ...(correlationId !== undefined && { correlationId }),
    });
    return;
  }

  if (err instanceof ZodError) {
    const body: ApiResponse & { code: string; correlationId?: string } = {
      success: false,
      error: err.errors[0]?.message ?? 'Validation error',
      code: ErrorCode.VALIDATION_ERROR,
      ...(correlationId !== undefined && { correlationId }),
    };
    res.status(400).json(body);
    return;
  }

  // Use the error's status code only when it is a genuine HTTP error status (4xx/5xx).
  // A status of 200 or any non-error code is treated as unexpected → 500.
  const status =
    httpErr != null && isValidErrorStatus(httpErr.status) ? httpErr.status : 500;

  const message = errMessage || 'Internal Server Error';

  // Preserve explicit error codes if already set on the error object,
  // otherwise determine the appropriate code based on HTTP status.
  const code = httpErr?.code || getErrorCodeByStatus(status);

  const body: ApiResponse & { code: string; correlationId?: string } = {
    success: false,
    error: message,
    code,
    ...(correlationId !== undefined && { correlationId }),
  };
  res.status(status).json(body);
}
