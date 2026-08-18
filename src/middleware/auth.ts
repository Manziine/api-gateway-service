import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getRedis } from '../services/redis';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const TOKEN_CACHE_TTL = 300; // 5 minutes

/**
 * JWT Authentication Middleware
 * ──────────────────────────────
 * 1. Extracts Bearer token from Authorization header
 * 2. Checks Redis cache for decoded payload (avoids re-verifying on every request)
 * 3. Falls back to jwt.verify() on cache miss
 * 4. Caches decoded payload for 5 minutes
 * 5. Injects user info as X-User-* headers for upstream services
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Authorization header with Bearer token required',
    });
  }

  const token = authHeader.split(' ')[1];
  const cacheKey = `jwt:${token.slice(-32)}`; // Use last 32 chars as cache key

  try {
    const redis = getRedis();

    // Cache lookup (fast path)
    const cached = await redis.get(cacheKey);
    if (cached) {
      const payload = JSON.parse(cached);
      injectUserHeaders(req, payload);
      return next();
    }

    // Verify token (slower path)
    const payload = jwt.verify(token, JWT_SECRET) as Record<string, any>;

    // Cache the decoded payload
    await redis.setex(cacheKey, TOKEN_CACHE_TTL, JSON.stringify(payload));

    injectUserHeaders(req, payload);
    next();
  } catch (err: any) {
    const isExpired = err?.name === 'TokenExpiredError';
    return res.status(401).json({
      error: 'Unauthorized',
      message: isExpired ? 'Token has expired' : 'Invalid token',
    });
  }
}

function injectUserHeaders(req: Request, payload: Record<string, any>) {
  // Pass user context to upstream services via headers
  req.headers['x-user-id'] = payload.sub || payload.id || '';
  req.headers['x-user-email'] = payload.email || '';
  req.headers['x-user-roles'] = Array.isArray(payload.roles)
    ? payload.roles.join(',')
    : payload.roles || '';
}
