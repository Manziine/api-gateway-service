# API Gateway Service

<div align="center">

![Node.js](https://img.shields.io/badge/Node.js-20-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-DC382D?style=flat-square&logo=redis&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white)
![JWT](https://img.shields.io/badge/JWT-000000?style=flat-square&logo=jsonwebtokens&logoColor=white)

**A production-ready API gateway** implementing the core patterns that underpin every microservices architecture: authentication, rate limiting, routing, circuit breaking, and observability — all without a framework.

</div>

---

## 🎯 Why This Project Matters

Every company running microservices has an API gateway. AWS, Azure, and GCP sell them as managed services because they're critical and complex. Building one from scratch proves you understand:

- **Security boundaries**: Every request authenticated before touching a service
- **Rate limiting algorithms**: Token bucket vs. sliding window — when to use each
- **Fault tolerance**: Circuit breakers prevent cascading failures across services
- **Observability**: Structured request logging with correlation IDs
- **Reverse proxy patterns**: The core of Nginx, Kong, and AWS API Gateway

## 🏗️ Architecture

```
Incoming Requests
       │
┌──────▼──────────────────────────────────────────┐
│                 API Gateway                      │
│                                                  │
│  1. TLS Termination                              │
│  2. JWT Authentication ──── token cache (Redis) │
│  3. Rate Limiting ─────────  counters  (Redis) │
│  4. Request Routing ────────  rules   (config) │
│  5. Circuit Breaker ──────── state    (Redis)  │
│  6. Load Balancing ────────  round-robin       │
│  7. Response + Logging                          │
└──────┬──────────────────────────────────────────┘
       │
  ┌────┴──────────┬───────────────┐
  ▼               ▼               ▼
Service A     Service B       Service C
(Auth)        (Users)         (Orders)
```

## ✅ Features

| Feature | Algorithm | Details |
|---|---|---|
| 🔐 JWT Auth | RS256/HS256 | Validates token, caches decoded payload in Redis (5min TTL) |
| 🚦 Rate Limiting | **Sliding Window** | Per-IP and per-user, configurable per route |
| 🔌 Circuit Breaker | **Half-Open State** | Opens after 5 failures in 60s, auto-recovers |
| ⚖️ Load Balancing | **Round-Robin** | Distributes across healthy upstream instances |
| 🛡️ Request Validation | JSON Schema | Validates request body before forwarding |
| 🔗 Correlation IDs | UUID v4 | Every request tagged with `X-Request-ID` for tracing |
| 📝 Structured Logging | JSON | Every request logged: latency, status, upstream, user |
| ❤️ Health Aggregation | Active probing | `/health` reflects health of ALL upstream services |

## 🚦 Rate Limiting — Two Algorithms

### 1. Token Bucket (burst-tolerant)
Used for general API traffic. Allows short bursts while enforcing a sustained rate.
```
Capacity: 100 tokens
Refill: 10 tokens/second
→ Handles traffic spikes without blocking legitimate bursts
```

### 2. Sliding Window (strict)
Used for sensitive endpoints (login, password reset).
```
Window: 60 seconds
Limit: 5 requests
→ No burst allowance — strict compliance
```

## 🔌 Circuit Breaker States

```
            failures > threshold
CLOSED ────────────────────────► OPEN
  ▲                               │
  │ success                       │ timeout expires
  │                               ▼
  └──────────────────────── HALF-OPEN
         test request sent
```

## 🚀 Quick Start

```bash
git clone https://github.com/Manziine/api-gateway-service.git
cd api-gateway-service

cp .env.example .env
docker compose up --build

# Gateway is running at http://localhost:3000
```

### Route Configuration (`config/routes.json`)

```json
{
  "routes": [
    {
      "path": "/api/auth/**",
      "upstream": ["http://auth-service:4001"],
      "auth_required": false,
      "rate_limit": {
        "algorithm": "sliding_window",
        "window_seconds": 60,
        "max_requests": 10
      }
    },
    {
      "path": "/api/users/**",
      "upstream": [
        "http://user-service-1:4002",
        "http://user-service-2:4002"
      ],
      "auth_required": true,
      "rate_limit": {
        "algorithm": "token_bucket",
        "capacity": 100,
        "refill_rate": 10
      },
      "circuit_breaker": {
        "failure_threshold": 5,
        "reset_timeout_ms": 30000
      }
    }
  ]
}
```

### Example: Authenticated Request

```bash
# 1. Get a token
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -d '{"username":"demo","password":"demo"}' \
  -H "Content-Type: application/json" | jq -r .access_token)

# 2. Call a protected route (gateway validates token + forwards)
curl http://localhost:3000/api/users/me \
  -H "Authorization: Bearer $TOKEN"

# Gateway logs (JSON):
{
  "request_id": "req_8f3a1b2c",
  "method": "GET",
  "path": "/api/users/me",
  "upstream": "http://user-service-1:4002",
  "user_id": "usr_123",
  "status": 200,
  "latency_ms": 12,
  "timestamp": "2025-08-18T03:00:00Z"
}
```

## 📁 Project Structure

```
api-gateway-service/
├── src/
│   ├── gateway.ts          # Core proxy + middleware chain
│   ├── middleware/
│   │   ├── auth.ts         # JWT validation + Redis caching
│   │   ├── rateLimiter.ts  # Token bucket + sliding window
│   │   ├── circuitBreaker.ts # Circuit breaker state machine
│   │   └── logger.ts       # Structured JSON logging
│   ├── routing/
│   │   ├── router.ts       # Route matching + load balancer
│   │   └── healthCheck.ts  # Upstream health prober
│   ├── services/
│   │   └── redis.ts        # Redis client (rate limits, CB state, token cache)
│   └── index.ts
├── config/
│   └── routes.json         # Route definitions
├── .github/workflows/ci.yml
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## 💡 Key Design Decisions

**Why build this instead of using Kong or Traefik?**
This isn't meant to replace those — it's meant to demonstrate you understand what they do internally. Interviewers love when you can explain the trade-offs because you've built it yourself.

**Why TypeScript over JavaScript?**
Type safety for the middleware chain prevents subtle bugs when composing functions. The middleware pipeline is a perfect use case for strict typing.

**Why Redis for all state?**
- Rate limit counters → Redis (atomic INCR operations)
- Circuit breaker state → Redis (shared across gateway instances)
- Token cache → Redis (avoid re-validating JWT on every request)
- Makes the gateway itself **stateless** → horizontal scaling works

## 🛠️ Built By

**Arnaud Ineza Manzi** — Backend & Infrastructure Engineer
📧 ainezamanzi@gmail.com | 🔗 [LinkedIn](https://linkedin.com/in/arnaud-ineza-manzi-471221272) | 🐙 [GitHub](https://github.com/Manziine)
