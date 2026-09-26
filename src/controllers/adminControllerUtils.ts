import { Response } from 'express';
import { z } from 'zod';
import { ErrorCode } from '../utils/errorCodes';

export function sendValidationError(res: Response, error: z.ZodError): void {
  const details = error.errors.map((e) => ({ field: e.path.join('.'), message: e.message }));
  res.status(400).json({ success: false, error: 'Validation Error', details, code: ErrorCode.VALIDATION_ERROR });
}
