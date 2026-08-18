import express, { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { rateLimiter } from './middleware/rateLimiter';
import { circuitBreaker, reportUpstreamResult } from './middleware/circuitBreaker';
import { authMiddleware } from './middleware/auth';
import { structuredLogger } from './middleware/logger';

const app = express();

// ─── Load Route Configuration ─────────────────────────────────────────────────
const routesConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../config/routes.json'), 'utf-8')
);

// ─── Global Middleware ────────────────────────────────────────────────────────
app.use(express.json());

// Assign correlation ID to every request
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = (req.headers['x-request-id'] as string) || `req_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  req.headers['x-request-id'] = requestId;
  res.setHeader('X-Request-ID', requestId);
  (req as any).startTime = Date.now();
  next();
});

// Structured JSON logging
app.use(structuredLogger);

// ─── Dynamic Route Registration ───────────────────────────────────────────────
for (const route of routesConfig.routes) {
  const middlewares: any[] = [];

  // 1. JWT Auth (if required)
  if (route.auth_required) {
    middlewares.push(authMiddleware);
  }

  // 2. Rate Limiting
  if (route.rate_limit) {
    middlewares.push(rateLimiter(route.rate_limit));
  }

  // 3. Circuit Breaker
  if (route.circuit_breaker) {
    middlewares.push(circuitBreaker({
      serviceKey: route.path.replace(/\//g, '_').replace(/\*/g, ''),
      failureThreshold: route.circuit_breaker.failure_threshold,
      resetTimeoutMs: route.circuit_breaker.reset_timeout_ms,
    }));
  }

  // 4. Round-Robin Load Balancer + Proxy
  let currentIndex = 0;
  const upstreams: string[] = route.upstream;

  middlewares.push(
    createProxyMiddleware({
      router: () => {
        const target = upstreams[currentIndex % upstreams.length];
        currentIndex++;
        return target;
      },
      changeOrigin: true,
      pathRewrite: { [`^${route.path.replace('/**', '')}`]: '' },
      on: {
        proxyRes: async (proxyRes, req) => {
          await reportUpstreamResult(req as Request, proxyRes.statusCode || 500);
        },
        error: async (err, req, res: any) => {
          await reportUpstreamResult(req as Request, 503);
          res.status(503).json({
            error: 'Upstream service unavailable',
            request_id: (req as Request).headers['x-request-id'],
          });
        },
      },
    })
  );

  app.use(route.path.replace('/**', ''), ...middlewares);
}

// ─── Health Check Endpoint ────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    gateway: 'api-gateway-service',
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ─── 404 Fallback ────────────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Gateway] API Gateway running on http://0.0.0.0:${PORT}`);
  console.log(`[Gateway] Routes loaded: ${routesConfig.routes.length}`);
});

export default app;
