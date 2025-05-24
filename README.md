# logdude-middleware

Minimal audit logging middleware for Express with batched delivery to a central server

## Installation

```bash
npm install logdude
```

## Features

- **Automatic request/response logging**: Captures method, path, route, status code, duration, and more
- **Correlation IDs**: Generates unique request IDs for tracking
- **Batched delivery**: Efficient batching with retry logic
- **Query parameter filtering**: Hide sensitive parameters from logs
- **Manual enrichment**: Add custom data to logs via `req.logAudit()`

## Usage Example

```js
const express = require('express');
const createLoggingMiddleware = require('logdude');

const app = express();

// Create and attach the middleware
const loggingMiddleware = createLoggingMiddleware({
    endpoint: 'http://audit.yourdomain.com/log',
    ignoreQueryParams: ['token', 'api_key'] // Optional: Query params to ignore globally
});

app.use(loggingMiddleware);

// Automatic logging happens for every request
// Logs will include: request_id, timestamp, IP, method, path, route, 
// status_code, duration_ms, query_params, user_agent, hostname, etc.

// Example usage - enrich logs with user data (authenticated user)
app.get('/api/users', (req, res) => {
    req.logAudit({
        user_id: req.auth?.email || null,
        auth_type: 'firebase',
        auth_strength: 'strong',
        auth_success: true,
        auth_reason: 'Authorized'
    });
    
    res.json({ users: [] });
});

// Example usage - API access with custom ignored params
app.get('/api/data', (req, res) => {
    req.logAudit({
        user_id: req.apiKey,
        auth_type: 'api_key', 
        ignoreQueryParams: ['auth'] // Ignore specific query params for this log entry
    });
    
    res.json({ data: [] });
});
```

## Log Format

Each log entry includes:

```json
{
    "request_id": "uuid-v4",
    "ts": "2023-12-01T10:30:00.000Z",
    "ip": "192.168.1.1", 
    "method": "GET",
    "path": "/api/users",
    "route": "/api/users",
    "route_id": "GET:/api/users",
    "query_params": {},
    "user_agent": "Mozilla/5.0...",
    "hostname": "server-01",
    "status_code": 200,
    "duration_ms": 45,
    "response_finished": true,
    "tags": [],
    "extra": {},
    "user_id": "user@example.com",
    "auth_type": "firebase"
}