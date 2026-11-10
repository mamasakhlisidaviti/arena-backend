import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny } from 'zod';

type Source = 'body' | 'query' | 'params';

export function validate(schema: ZodTypeAny, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(result.error);
      return;
    }
    const bag = ((req as Request & { validated?: Record<string, unknown> }).validated ??= {});
    bag[source] = result.data;
    if (source === 'body') {
      req.body = result.data;
    }
    next();
  };
}

export function validated<T>(req: Request, source: Source): T {
  const bag = (req as Request & { validated?: Record<string, unknown> }).validated;
  return bag?.[source] as T;
}
