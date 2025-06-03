const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const os = require('os');

function createLoggingMiddleware({ 
    endpoint, 
    ignoreQueryParams = [],
    maxBufferSize = 1000,
    maxRetryQueueSize = 500,
    circuitBreakerThreshold = 5,
    circuitBreakerResetTimeout = 30000
}) {
    const FLUSH_INTERVAL_MS = 5000;
    const MAX_BATCH_SIZE = 100;
    const RETRY_DELAY_MS = 1000;
    const MAX_RETRIES = 3;
    
    const logBuffer = [];
    const retryQueue = [];
    
    // Circuit breaker state
    let circuitState = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    let consecutiveFailures = 0;
    let lastFailureTime = 0;
    let nextRetryTime = 0;

    // Non-blocking retry processing
    async function processRetryQueue() {
        if (retryQueue.length === 0 || circuitState === 'OPEN') return;
        
        const retryItem = retryQueue.shift();
        if (!retryItem) return;
        
        try {
            await sendToAuditServer(retryItem.logs);
            resetCircuitBreaker();
        } catch (err) {
            handleCircuitBreakerFailure();
            
            if (retryItem.attempts < MAX_RETRIES) {
                // Re-queue with incremented attempt count
                if (retryQueue.length < maxRetryQueueSize) {
                    retryQueue.push({
                        logs: retryItem.logs,
                        attempts: retryItem.attempts + 1
                    });
                } else {
                    console.warn('Retry queue full, dropping failed audit batch');
                }
            } else {
                console.error('Audit batch failed after max retries, dropping logs');
            }
        }
    }

    // Direct send without retry logic (used by retry processor)
    async function sendToAuditServer(logs) {
        const res = await fetch(endpoint, {
            method: 'POST',
            body: JSON.stringify(logs),
            headers: { 'Content-Type': 'application/json' },
            timeout: 2000
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
    }

    // Circuit breaker functions
    function resetCircuitBreaker() {
        consecutiveFailures = 0;
        circuitState = 'CLOSED';
    }

    function handleCircuitBreakerFailure() {
        consecutiveFailures++;
        lastFailureTime = Date.now();
        
        if (consecutiveFailures >= circuitBreakerThreshold) {
            circuitState = 'OPEN';
            nextRetryTime = Date.now() + circuitBreakerResetTimeout;
            console.warn(`Circuit breaker OPEN: ${consecutiveFailures} consecutive failures`);
        }
    }

    function checkCircuitBreaker() {
        if (circuitState === 'OPEN' && Date.now() >= nextRetryTime) {
            circuitState = 'HALF_OPEN';
            console.info('Circuit breaker moving to HALF_OPEN state');
        }
        return circuitState !== 'OPEN';
    }

    // Non-blocking batch sender
    async function sendBatchNonBlocking(logs) {
        if (!checkCircuitBreaker()) {
            console.warn('Circuit breaker OPEN, dropping audit batch');
            return;
        }

        try {
            await sendToAuditServer(logs);
            resetCircuitBreaker();
        } catch (err) {
            handleCircuitBreakerFailure();
            
            // Queue for retry instead of blocking
            if (retryQueue.length < maxRetryQueueSize) {
                retryQueue.push({
                    logs: logs,
                    attempts: 1
                });
            } else {
                console.warn('Retry queue full, dropping failed audit batch');
            }
        }
    }

    // Buffer management with size limits
    function addToBuffer(logEntry) {
        logBuffer.push(logEntry);
        
        // Enforce buffer size limit
        if (logBuffer.length > maxBufferSize) {
            const droppedCount = logBuffer.length - maxBufferSize;
            logBuffer.splice(0, droppedCount);
            console.warn(`Buffer overflow: dropped ${droppedCount} old log entries`);
        }
    }

    // Main flush interval - now completely non-blocking
    setInterval(() => {
        if (logBuffer.length === 0) return;
        
        const batch = logBuffer.splice(0, MAX_BATCH_SIZE);
        // Fire and forget - no await to avoid blocking
        sendBatchNonBlocking(batch);
    }, FLUSH_INTERVAL_MS);

    // Separate retry processing interval
    setInterval(() => {
        // Process retries independently - fire and forget
        processRetryQueue();
    }, RETRY_DELAY_MS);

    function middleware(req, res, next) {
        // Check if logging is disabled via environment variable
        if (process.env.DISABLE_AUDIT_LOGGING === 'true' || process.env.DISABLE_AUDIT_LOGGING === '1') {
            return next();
        }

        if (!req.id) req.id = uuidv4();

        // Start timing
        const startTime = process.hrtime();
        const startTimestamp = new Date().toISOString();
        
        // Store any manual audit data
        req._auditData = {};
        req._auditLogged = false;

        // Function to get route information
        function getRoute(req) {
            if (req.route && req.route.path) {
                const baseUrl = req.baseUrl || '';
                return `${baseUrl === '/' ? '' : baseUrl}${req.route.path}`;
            }
            return req.path || 'unknown';
        }

        // Function to create the complete log entry
        function createLogEntry() {
            if (req._auditLogged) return;
            req._auditLogged = true;

            // Calculate duration
            const diff = process.hrtime(startTime);
            const durationMs = Math.round((diff[0] * 1e9 + diff[1]) / 1e6);

            // Filter out ignored query params
            const filteredQueryParams = { ...req.query };
            const paramsToIgnore = req._auditData.ignoreQueryParams || ignoreQueryParams;
            
            if (Array.isArray(paramsToIgnore) && paramsToIgnore.length > 0) {
                paramsToIgnore.forEach(param => {
                    delete filteredQueryParams[param];
                });
            }

            const log = {
                request_id: req.id,
                ts: startTimestamp,
                ip: req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.connection?.remoteAddress || req.socket?.remoteAddress || req.connection?.socket?.remoteAddress || '',
                method: req.method,
                path: req.path,
                route: getRoute(req),
                route_id: `${req.method}:${getRoute(req)}`,
                query_params: filteredQueryParams,
                user_agent: req.get('user-agent') || '',
                referer: req.get('referer') || req.headers['referer'] || '',
                hostname: req?.hostname || process.env.HOSTNAME || os.hostname(),
                status_code: res.statusCode,
                duration_ms: durationMs,
                response_finished: res.finished,
                tags: [],
                extra: {},
                ...req._auditData,
            };

            // Remove the ignoreQueryParams from the final log object
            if (log.ignoreQueryParams) {
                delete log.ignoreQueryParams;
            }

            addToBuffer(log);
        }

        // Override logAudit to store data for later use
        req.logAudit = (userOverrides = {}) => {
            req._auditData = { ...req._auditData, ...userOverrides };
        };

        // Set up response hooks with proper cleanup
        let logCompleted = false;
        
        function logOnComplete() {
            if (logCompleted) return; // Prevent double logging
            logCompleted = true;
            
            try {
                createLogEntry();
            } catch (err) {
                console.error('Error creating audit log entry:', err);
            }
            
            // Clean up listeners to prevent memory leaks
            res.removeListener('finish', logOnComplete);
            res.removeListener('close', logOnComplete);
        }

        res.on('finish', logOnComplete);
        res.on('close', logOnComplete);

        // Handle aborted requests
        req.on('aborted', () => {
            if (!logCompleted) {
                logCompleted = true;
                try {
                    createLogEntry();
                } catch (err) {
                    console.error('Error creating audit log entry for aborted request:', err);
                }
            }
        });

        next();
    }

    // Expose circuit breaker status for monitoring
    middleware.getStatus = () => ({
        circuitState,
        consecutiveFailures,
        bufferSize: logBuffer.length,
        retryQueueSize: retryQueue.length,
        maxBufferSize,
        maxRetryQueueSize
    });

    return middleware;
}

module.exports = createLoggingMiddleware;

