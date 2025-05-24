const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const os = require('os');

function createLoggingMiddleware({ endpoint, ignoreQueryParams = [] }) {
    const FLUSH_INTERVAL_MS = 5000;
    const MAX_BATCH_SIZE = 100;
    const logBuffer = [];

    async function sendBatchToAuditServer(logs, attempt = 1) {
        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                body: JSON.stringify(logs),
                headers: { 'Content-Type': 'application/json' },
                timeout: 2000
            });

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
        } catch (err) {
            if (attempt < 3) {
                const delay = 1000;
                console.warn(`Audit log attempt ${attempt} failed: ${err.message}. Retrying in ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return sendBatchToAuditServer(logs, attempt + 1);
            } else {
                throw err;
            }
        }
    }

    setInterval(() => {
        if (logBuffer.length === 0) return;
        const batch = logBuffer.splice(0, MAX_BATCH_SIZE);
        sendBatchToAuditServer(batch).catch(err => {
            console.error('Audit log batch failed after retries. Re-queueing...');
            logBuffer.unshift(...batch);
        });
    }, FLUSH_INTERVAL_MS);

    function middleware(req, res, next) {
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

            logBuffer.push(log);
        }

        // Override logAudit to store data for later use
        req.logAudit = (userOverrides = {}) => {
            req._auditData = { ...req._auditData, ...userOverrides };
        };

        // Set up response hooks to capture complete information
        function logOnComplete() {
            createLogEntry();
        }

        res.on('finish', logOnComplete);
        res.on('close', logOnComplete);

        next();
    }

    return middleware;
}

module.exports = createLoggingMiddleware;
