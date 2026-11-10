import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { ApiError } from '../common/errors.js';
import type { ApiFailure } from '../common/response.js';
import { env } from '../config/env.js';

interface MongoServerErrorLike {
  code?: number;
  keyValue?: Record<string, unknown>;
  name?: string;
}

export function notFoundHandler(req: Request, res: Response): void {
  const body: ApiFailure = {
    success: false,
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.originalUrl} not found` },
  };
  res.status(404).json(body);
}

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) {
    _next(error);
    return;
  }

  const httpError = error as { type?: string; name?: string; code?: string } | null;
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'An unexpected error occurred';
  let details: unknown;

  if (error instanceof ApiError) {
    status = error.status;
    code = error.code;
    message = error.message;
    details = error.details;
  } else if (error instanceof ZodError) {
    status = 422;
    code = 'VALIDATION_ERROR';
    message = 'Please check the provided information';
    details = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
  } else if (error instanceof mongoose.Error.ValidationError) {
    status = 422;
    code = 'VALIDATION_ERROR';
    message = 'Please check the provided information';
    details = Object.values(error.errors).map((item) => ({
      path: item.path,
      message: item.message,
    }));
  } else if (error instanceof mongoose.Error.CastError) {
    status = 400;
    code = 'INVALID_IDENTIFIER';
    message = 'Invalid identifier';
  } else if ((error as { name?: string }).name === 'MulterError') {
    status = 400;
    code = 'UPLOAD_ERROR';
    const multerError = error as { code?: string };
    message = multerError.code === 'LIMIT_FILE_SIZE' ? 'Image is too large' : 'Image upload failed';
  } else {
    const mongoError = error as MongoServerErrorLike;
    if (mongoError?.code === 11000) {
      status = 409;
      code = 'DUPLICATE';
      message = 'This record already exists';
      details = mongoError.keyValue;
    }
  }

  if (status >= 500 && !env.isTest) {
    console.error('[error]', error);
  }

  const body: ApiFailure = { success: false, error: { code, message } };
  if (details !== undefined) {
    body.error.details = details;
  }
  res.status(status).json(body);
}
