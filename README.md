# logdude-middleware

Minimal audit logging middleware for Express with batched delivery to a central server

## Installation

```bash
npm install logdude
```

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

// Example usage (authenticated user)
req.logAudit({
    user_id: req.auth?.email || null,
    auth_type: 'firebase',
    auth_strength: 'strong',
    auth_success: true,
    auth_reason: 'Authorized'
});

// Example usage (API access)
req.logAudit({
    user_id: key,
    auth_type: 'api_key',
    auth_strength: req.auth?.secret ? 'strong' : 'weak',
    auth_success: true,
    auth_reason: 'Valid API key'
});

// Example usage with per-request ignored query params 
req.logAudit({
    user_id: req.user.id,
    ignoreQueryParams: ['auth'] // Ignore specific query params for this log entry
});