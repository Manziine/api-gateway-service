import { Request, Response, NextFunction } from 'express';
import { getRedis } from '../services/redis';

/**
 * Circuit Breaker Middleware
 * ───────────────────────────
 * Implements the Circuit Breaker pattern to prevent cascading failures
 * in a microservices architecture.
 *
 * States:
 *   CLOSED   → Normal operation. Requests pass through.
 *   OPEN     → Failures exceeded threshold. Requests fail fast (no upstream call).
 *   HALF_OPEN → Testing if upstream recovered. One test request allowed.
 *
 * State machine:
 *   CLOSED ──(failures > threshold)──► OPEN
 *   OPEN   ──(timeout expires)──────► HALF_OPEN
 *   HALF_OPEN ──(success)──────────► CLOSED
 *   HALF_OPEN ──(failure)──────────► OPEN
 */

interface CircuitBreakerConfig {
  serviceKey: string;      // Unique key for this circuit (e.g. "user-service")
  failureThreshold: number; // Number of failures before opening
  resetTimeoutMs: number;   // Time before trying HALF_OPEN (ms)
}

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

async function getCircuitState(
  key: string,
  config: CircuitBreakerConfig
): Promise<CircuitState> {
  const redis = getRedis();
  const data = await redis.hgetall(`cb:${key}`);

  if (!data || !data.state) return 'CLOSED';

  const state = data.state as CircuitState;
  const failures = parseInt(data.failures || '0', 10);
  const lastFailureAt = parseInt(data.lastFailureAt || '0', 10);

  if (state === 'OPEN') {
    const elapsed = Date.now() - lastFailureAt;
    if (elapsed >= config.resetTimeoutMs) {
      // Transition to HALF_OPEN
      await redis.hset(`cb:${key}`, 'state', 'HALF_OPEN');
      return 'HALF_OPEN';
    }
  }

  return state;
}

async function recordSuccess(key: string): Promise<void> {
  const redis = getRedis();
  await redis.hmset(`cb:${key}`, { state: 'CLOSED', failures: '0' });
}

async function recordFailure(key: string, config: CircuitBreakerConfig): Promise<void> {
  const redis = getRedis();
  const failures = await redis.hincrby(`cb:${key}`, 'failures', 1);
  await redis.hset(`cb:${key}`, 'lastFailureAt', Date.now().toString());

  if (failures >= config.failureThreshold) {
    await redis.hset(`cb:${key}`, 'state', 'OPEN');
    console.warn(`[CircuitBreaker] ${key} OPENED after ${failures} failures`);
  }

  await redis.expire(`cb:${key}`, 3600);
}

export function circuitBreaker(config: CircuitBreakerConfig) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const state = await getCircuitState(config.serviceKey, config);

    if (state === 'OPEN') {
      return res.status(503).json({
        error: 'Service Unavailable',
        message: `The ${config.serviceKey} service is temporarily unavailable. Please retry later.`,
        circuit_state: 'OPEN',
        retry_after_ms: config.resetTimeoutMs,
      });
    }

    // Attach hooks for upstream call result tracking
    (req as any)._circuitBreaker = {
      key: config.serviceKey,
      config,
      recordSuccess,
      recordFailure,
    };

    next();
  };
}

/**
 * Call after upstream response to update circuit state.
 */
export async function reportUpstreamResult(
  req: Request,
  statusCode: number
): Promise<void> {
  const cb = (req as any)._circuitBreaker;
  if (!cb) return;

  if (statusCode >= 500) {
    await cb.recordFailure(cb.key, cb.config);
  } else {
    await cb.recordSuccess(cb.key);
  }
}
