import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { ApiResponse } from '../types';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  console.error(err.message);

  if (err instanceof ZodError) {
    const body: ApiResponse = {
      success: false,
      error: err.errors[0]?.message ?? 'Validation error',
    };
    res.status(400).json(body);
    return;
  }

  const body: ApiResponse = { success: false, error: err.message };
  res.status(500).json(body);
}
