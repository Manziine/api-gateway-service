import { Request, Response, NextFunction } from 'express';

/**
 * Structured JSON Logger Middleware
 * ────────────────────────────────────
 * Logs every request as a JSON object.
 * Fields follow the standard observability format used by Datadog, Splunk, Loki.
 */
export function structuredLogger(req: Request, res: Response, next: NextFunction) {
  const startTime = (req as any).startTime || Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const log = {
      timestamp: new Date().toISOString(),
      request_id: req.headers['x-request-id'],
      method: req.method,
      path: req.path,
      status: res.statusCode,
      latency_ms: duration,
      user_id: req.headers['x-user-id'] || null,
      ip: req.ip,
      user_agent: req.headers['user-agent'],
      upstream: req.headers['x-forwarded-host'] || null,
    };

    const level = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO';
    if (level === 'ERROR') {
      console.error(JSON.stringify(log));
    } else {
      console.log(JSON.stringify(log));
    }
  });

  next();
}
