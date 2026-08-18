import { Request, Response, NextFunction } from 'express';
import { getRedis } from '../services/redis';

interface RateLimitConfig {
  algorithm: 'token_bucket' | 'sliding_window';
  // Token bucket
  capacity?: number;
  refillRate?: number;
  // Sliding window
  windowSeconds?: number;
  maxRequests?: number;
}

/**
 * Sliding Window Rate Limiter
 * ─────────────────────────────
 * Strict per-IP limit within a rolling time window.
 * Used for sensitive endpoints (login, password reset).
 *
 * Algorithm: Store request timestamps in a Redis sorted set.
 * On each request:
 *   1. Remove entries older than window
 *   2. Count remaining entries
 *   3. If count < limit → allow + add timestamp
 *   4. Else → reject 429
 */
async function slidingWindowCheck(
  key: string,
  windowSeconds: number,
  maxRequests: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const redis = getRedis();
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;

  const pipe = redis.pipeline();
  pipe.zremrangebyscore(key, 0, windowStart);       // Remove old entries
  pipe.zadd(key, now, `${now}-${Math.random()}`);   // Add this request
  pipe.zcard(key);                                   // Count in window
  pipe.expire(key, windowSeconds);                   // Auto-expire key

  const results = await pipe.exec();
  const count = (results?.[2]?.[1] as number) ?? 0;
  const allowed = count <= maxRequests;

  if (!allowed) {
    // Remove the entry we just added (don't count rejected requests)
    await redis.zpopmax(key);
  }

  return {
    allowed,
    remaining: Math.max(0, maxRequests - count),
    resetAt: Math.ceil((now + windowSeconds * 1000) / 1000),
  };
}

/**
 * Token Bucket Rate Limiter
 * ──────────────────────────
 * Burst-tolerant: allows short traffic spikes while enforcing sustained rate.
 * Used for general API traffic.
 *
 * Algorithm: Store (tokens, lastRefill) in Redis.
 * On each request:
 *   1. Calculate tokens added since lastRefill (rate * elapsed_seconds)
 *   2. Clamp tokens to capacity
 *   3. If tokens >= 1 → allow + decrement
 *   4. Else → reject 429
 */
async function tokenBucketCheck(
  key: string,
  capacity: number,
  refillRate: number
): Promise<{ allowed: boolean; remaining: number }> {
  const redis = getRedis();
  const now = Date.now() / 1000; // seconds

  const script = `
    local key = KEYS[1]
    local capacity = tonumber(ARGV[1])
    local refill_rate = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])

    local data = redis.call('HMGET', key, 'tokens', 'last_refill')
    local tokens = tonumber(data[1]) or capacity
    local last_refill = tonumber(data[2]) or now

    -- Calculate tokens to add
    local elapsed = now - last_refill
    local new_tokens = math.min(capacity, tokens + (elapsed * refill_rate))

    if new_tokens >= 1 then
      -- Allow request
      redis.call('HMSET', key, 'tokens', new_tokens - 1, 'last_refill', now)
      redis.call('EXPIRE', key, 3600)
      return {1, math.floor(new_tokens - 1)}
    else
      -- Deny request
      redis.call('HMSET', key, 'tokens', new_tokens, 'last_refill', now)
      redis.call('EXPIRE', key, 3600)
      return {0, 0}
    end
  `;

  const result = await redis.eval(script, 1, key, capacity, refillRate, now) as [number, number];
  return { allowed: result[0] === 1, remaining: result[1] };
}

/**
 * Rate Limiter Middleware Factory
 * Creates Express middleware for a given rate limit configuration.
 */
export function rateLimiter(config: RateLimitConfig) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `ratelimit:${ip}:${req.path.split('/')[2] || 'root'}`;

    try {
      let result: { allowed: boolean; remaining: number; resetAt?: number };

      if (config.algorithm === 'sliding_window') {
        result = await slidingWindowCheck(
          key,
          config.windowSeconds ?? 60,
          config.maxRequests ?? 60
        );
      } else {
        result = await tokenBucketCheck(
          key,
          config.capacity ?? 100,
          config.refillRate ?? 10
        );
      }

      // Set rate limit headers (standard)
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      if (result.resetAt) res.setHeader('X-RateLimit-Reset', result.resetAt);

      if (!result.allowed) {
        return res.status(429).json({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded. Please slow down.',
          retry_after: result.resetAt
            ? Math.max(0, result.resetAt - Math.floor(Date.now() / 1000))
            : 60,
        });
      }

      next();
    } catch (err) {
      // Fail open — don't block requests if Redis is down
      console.error('[RateLimit] Redis error, failing open:', err);
      next();
    }
  };
}
