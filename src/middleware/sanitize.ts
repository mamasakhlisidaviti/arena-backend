import type { NextFunction, Request, Response } from 'express';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const clean: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith('$') || key.includes('.') || DANGEROUS_KEYS.has(key)) {
        continue;
      }
      clean[key] = sanitizeValue(nested);
    }
    return clean;
  }
  return value;
}

/** Blocks Mongo operator injection and prototype pollution in request payloads. */
export function sanitizeRequest(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body);
  }
  if (req.params && typeof req.params === 'object') {
    const clean = sanitizeValue(req.params);
    for (const key of Object.keys(req.params)) {
      delete (req.params as Record<string, unknown>)[key];
    }
    Object.assign(req.params, clean as Record<string, string>);
  }
  next();
}
