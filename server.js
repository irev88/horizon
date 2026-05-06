const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();

// ─── Security & Performance Middleware ────────────────────────────────────────

app.use(helmet({
    contentSecurityPolicy: false,      // Allow inline scripts/styles for SPA
    crossOriginEmbedderPolicy: false,
}));

app.use(compression());

app.use(cors({
    origin: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public', {
    maxAge: '1h',
    etag: true,
}));

// ─── Rate Limiting ───────────────────────────────────────────────────────────

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,       // 1 minute
    max: 60,                    // 60 requests per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.', retryAfter: '60s' },
    keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || 'unknown',
});

app.use('/api/', apiLimiter);

// ─── Request Logging & Tracking ──────────────────────────────────────────────

const requestStats = {
    totalRequests: 0,
    totalErrors: 0,
    avgResponseTime: 0,
    responseTimes: [],
    activeRequests: 0,
    startTime: Date.now(),
    requestLog: [],        // Last N requests
};

app.use((req, res, next) => {
    const start = Date.now();
    const id = Math.random().toString(36).slice(2, 8);
    req._reqId = id;
    req._startTime = start;
    requestStats.totalRequests++;
    requestStats.activeRequests++;

    console.log(`[${id}] ➜ ${req.method} ${req.path} | Active: ${requestStats.activeRequests}`);

    const origEnd = res.end;
    res.end = function(...args) {
        const duration = Date.now() - start;
        requestStats.activeRequests--;
        requestStats.responseTimes.push(duration);
        if (requestStats.responseTimes.length > 100) requestStats.responseTimes = requestStats.responseTimes.slice(-100);
        requestStats.avgResponseTime = Math.round(requestStats.responseTimes.reduce((a,b)=>a+b,0) / requestStats.responseTimes.length);

        if (res.statusCode >= 400) requestStats.totalErrors++;

        // Keep last 50 requests
        requestStats.requestLog.push({
            id, method: req.method, path: req.path,
            status: res.statusCode, duration, ts: new Date().toISOString(),
        });
        if (requestStats.requestLog.length > 50) requestStats.requestLog = requestStats.requestLog.slice(-50);

        const statusIcon = res.statusCode < 400 ? '✓' : '✗';
        console.log(`[${id}] ${statusIcon} ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);

        origEnd.apply(res, args);
    };

    next();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function getApiConfig(provider) {
    const configs = {
        Groq: {
            baseUrl: 'https://api.groq.com/openai/v1',
            key: process.env.GROQ_API_KEY,
            name: 'Groq',
        },
        NVIDIA: {
            baseUrl: 'https://integrate.api.nvidia.com/v1',
            key: process.env.NVIDIA_API_KEY,
            name: 'NVIDIA',
        },
    };
    return configs[provider] || null;
}

function buildMessages(conversationHistory, prompt, images_b64) {
    const messages = [...conversationHistory];
    if (images_b64 && images_b64.length > 0) {
        const contentArray = [{ type: 'text', text: prompt }];
        images_b64.forEach(img =>
            contentArray.push({ type: 'image_url', image_url: { url: img } })
        );
        messages.push({ role: 'user', content: contentArray });
    } else {
        messages.push({ role: 'user', content: prompt });
    }
    return messages;
}

function isImageModel(id) {
    const lower = id.toLowerCase();
    return lower.includes('stable-diffusion') || lower.includes('sdxl') ||
           lower.includes('flux') || lower.includes('dall-e');
}

function timestamp() {
    return new Date().toISOString();
}

function safeJsonParse(text) {
    try { return JSON.parse(text); }
    catch { return null; }
}

// ─── Keep-Alive ──────────────────────────────────────────────────────────────

app.get('/api/ping', (req, res) => res.status(200).json({ status: 'ok', ts: timestamp() }));

// ─── Health / Debug / Stats Endpoint ─────────────────────────────────────────

app.get('/api/health', (req, res) => {
    const uptime = process.uptime();
    const mem = process.memoryUsage();

    res.json({
        status: 'ok',
        ts: timestamp(),
        uptime: {
            seconds: Math.round(uptime),
            human: `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m ${Math.round(uptime%60)}s`,
        },
        memory: {
            rss: `${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
            heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`,
            heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`,
            external: `${(mem.external / 1024 / 1024).toFixed(1)} MB`,
        },
        stats: {
            totalRequests: requestStats.totalRequests,
            totalErrors: requestStats.totalErrors,
            activeRequests: requestStats.activeRequests,
            avgResponseTime: requestStats.avgResponseTime + 'ms',
            errorRate: requestStats.totalRequests > 0
                ? ((requestStats.totalErrors / requestStats.totalRequests) * 100).toFixed(1) + '%'
                : '0%',
        },
        env: {
            hasNvidiaKey: !!process.env.NVIDIA_API_KEY,
            hasGroqKey: !!process.env.GROQ_API_KEY,
            nodeVersion: process.version,
            platform: process.platform,
            renderUrl: process.env.RENDER_EXTERNAL_URL || 'not set',
        },
    });
});

// ─── Server Stats (for debug console) ───────────────────────────────────────

app.get('/api/stats', (req, res) => {
    res.json({
        ...requestStats,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        ts: timestamp(),
    });
});

// ─── Models (cached) ─────────────────────────────────────────────────────────

let modelsCache = null;
let modelsCacheTime = 0;
const MODELS_CACHE_TTL = 5 * 60 * 1000;

app.get('/api/models', async (req, res) => {
    try {
        const now = Date.now();
        if (modelsCache && now - modelsCacheTime < MODELS_CACHE_TTL) {
            return res.json({ data: modelsCache, cached: true, ts: timestamp() });
        }

        let allModels = [];
        const errors = [];

        // ── Fetch NVIDIA models ───────────────────────────────────────────────
        if (process.env.NVIDIA_API_KEY) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 15000);
                const nvRes = await fetch('https://integrate.api.nvidia.com/v1/models', {
                    headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
                    signal: controller.signal,
                });
                clearTimeout(timeout);

                if (nvRes.ok) {
                    const nvData = await nvRes.json();
                    allModels = allModels.concat(nvData.data.map(m => ({
                        id: m.id, provider: 'NVIDIA', type: isImageModel(m.id) ? 'image' : 'chat',
                    })));
                    console.log(`[Models] NVIDIA: ${nvData.data.length} models loaded`);
                } else {
                    const errText = await nvRes.text().catch(() => '');
                    errors.push(`NVIDIA ${nvRes.status}: ${errText.slice(0, 200)}`);
                    console.error(`[Models] NVIDIA error: ${nvRes.status}`);
                }
            } catch (e) {
                const msg = e.name === 'AbortError' ? 'timeout (15s)' : e.message;
                errors.push(`NVIDIA: ${msg}`);
                console.error(`[Models] NVIDIA fetch failed: ${msg}`);
            }
        } else {
            errors.push('NVIDIA_API_KEY not set');
        }

        // ── Fetch Groq models ─────────────────────────────────────────────────
        if (process.env.GROQ_API_KEY) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 15000);
                const groqRes = await fetch('https://api.groq.com/openai/v1/models', {
                    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
                    signal: controller.signal,
                });
                clearTimeout(timeout);

                if (groqRes.ok) {
                    const groqData = await groqRes.json();
                    allModels = allModels.concat(groqData.data
                        .filter(m => !m.id.includes('whisper') && !m.id.includes('tts'))
                        .map(m => ({ id: m.id, provider: 'Groq', type: 'chat' }))
                    );
                    console.log(`[Models] Groq: ${groqData.data.length} models loaded`);
                } else {
                    const errText = await groqRes.text().catch(() => '');
                    errors.push(`Groq ${groqRes.status}: ${errText.slice(0, 200)}`);
                    console.error(`[Models] Groq error: ${groqRes.status}`);
                }
            } catch (e) {
                const msg = e.name === 'AbortError' ? 'timeout (15s)' : e.message;
                errors.push(`Groq: ${msg}`);
                console.error(`[Models] Groq fetch failed: ${msg}`);
            }
        } else {
            errors.push('GROQ_API_KEY not set');
        }

        if (allModels.length === 0 && errors.length > 0) {
            return res.status(502).json({ error: errors.join('; '), ts: timestamp() });
        }

        modelsCache = allModels;
        modelsCacheTime = now;
        res.json({ data: allModels, errors: errors.length ? errors : undefined, ts: timestamp() });
    } catch (error) {
        console.error('[Models] Fatal:', error);
        res.status(500).json({ error: error.message, ts: timestamp() });
    }
});

// ─── Chat — Streaming with fallback ──────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
    const reqId = req._reqId;
    const {
        model, provider, prompt,
        images_b64, history = [], system_prompt = '',
        temperature = 0.7, max_tokens = 4096, top_p = 1,
    } = req.body;

    const debugInfo = {
        reqId,
        ts: timestamp(),
        model,
        provider,
        promptLength: prompt ? prompt.length : 0,
        imageCount: images_b64 ? images_b64.length : 0,
        historyTurns: history.length,
        temperature,
        max_tokens,
        top_p,
    };

    try {
        // ── Validation ───────────────────────────────────────────────────────
        if (!model || !provider || !prompt) {
            return res.status(400).json({
                error: 'model, provider, and prompt are required.',
                debug: debugInfo,
            });
        }

        if (prompt.length > 100000) {
            return res.status(400).json({
                error: 'Prompt too long (max 100,000 chars).',
                debug: debugInfo,
            });
        }

        const cfg = getApiConfig(provider);
        if (!cfg) return res.status(400).json({ error: `Unknown provider: ${provider}`, debug: debugInfo });
        if (!cfg.key) return res.status(500).json({ error: `API key for ${provider} is not configured.`, debug: debugInfo });

        // ── Build messages ───────────────────────────────────────────────────
        const messages = [];
        if (system_prompt) messages.push({ role: 'system', content: system_prompt });
        const fullMessages = buildMessages([...messages, ...history], prompt, images_b64);

        debugInfo.messageCount = fullMessages.length;
        debugInfo.upstreamUrl = `${cfg.baseUrl}/chat/completions`;

        // ── Try streaming ────────────────────────────────────────────────────
        const useStreaming = req.body.stream !== false;

        if (useStreaming) {
            try {
                await handleStreamingChat(cfg, model, fullMessages, temperature, max_tokens, top_p, debugInfo, req, res);
                return;
            } catch (streamErr) {
                if (!res.headersSent) {
                    console.log(`[${reqId}] Stream failed (${streamErr.message}), falling back`);
                    debugInfo.streamingFailed = true;
                    debugInfo.streamError = streamErr.message;
                } else {
                    console.error(`[${reqId}] Stream broke after headers sent:`, streamErr.message);
                    try {
                        res.write(`data: ${JSON.stringify({ error: streamErr.message, debug: debugInfo })}\n\n`);
                    } catch {}
                    try { res.end(); } catch {}
                    return;
                }
            }
        }

        // ── Non-streaming fallback ───────────────────────────────────────────
        console.log(`[${reqId}] Using non-streaming mode`);
        debugInfo.mode = 'non-streaming';

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000);

        const upstreamStart = Date.now();
        const upstream = await fetch(`${cfg.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
            body: JSON.stringify({
                model,
                messages: fullMessages,
                temperature: parseFloat(temperature),
                max_tokens: parseInt(max_tokens, 10),
                top_p: parseFloat(top_p),
                stream: false,
            }),
            signal: controller.signal,
        });
        clearTimeout(timeout);

        debugInfo.upstreamStatus = upstream.status;
        debugInfo.upstreamLatency = Date.now() - upstreamStart;

        const rawText = await upstream.text();
        debugInfo.rawResponseLength = rawText.length;

        let data;
        try {
            data = JSON.parse(rawText);
        } catch (parseErr) {
            debugInfo.parseError = parseErr.message;
            debugInfo.rawResponsePreview = rawText.slice(0, 500);
            return res.status(502).json({
                error: 'Failed to parse upstream response as JSON',
                debug: debugInfo,
            });
        }

        if (!upstream.ok) {
            debugInfo.upstreamError = data;
            return res.status(upstream.status).json({
                error: data.error?.message || data.error || JSON.stringify(data),
                debug: debugInfo,
            });
        }

        const reply = data.choices?.[0]?.message?.content || '';
        debugInfo.replyLength = reply.length;
        debugInfo.finishReason = data.choices?.[0]?.finish_reason;
        debugInfo.usage = data.usage || null;

        res.json({
            reply,
            usage: data.usage || null,
            debug: debugInfo,
            mode: 'non-streaming',
        });
    } catch (error) {
        debugInfo.fatalError = error.message;
        debugInfo.errorName = error.name;
        debugInfo.errorStack = error.stack?.split('\n').slice(0, 5);
        console.error(`[${reqId}] Fatal:`, error.message);

        if (!res.headersSent) {
            const statusCode = error.name === 'AbortError' ? 504 : 500;
            res.status(statusCode).json({
                error: error.name === 'AbortError' ? 'Request timed out (120s)' : error.message,
                debug: debugInfo,
            });
        }
    }
});

// ── Streaming handler ────────────────────────────────────────────────────────

async function handleStreamingChat(cfg, model, fullMessages, temperature, max_tokens, top_p, debugInfo, req, res) {
    const reqId = debugInfo.reqId;
    debugInfo.mode = 'streaming';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    const upstreamStart = Date.now();
    const upstream = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify({
            model,
            messages: fullMessages,
            temperature: parseFloat(temperature),
            max_tokens: parseInt(max_tokens, 10),
            top_p: parseFloat(top_p),
            stream: true,
        }),
        signal: controller.signal,
    });
    clearTimeout(timeout);

    debugInfo.upstreamStatus = upstream.status;
    debugInfo.upstreamLatency = Date.now() - upstreamStart;

    if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        const errData = safeJsonParse(errText) || { message: upstream.statusText, raw: errText.slice(0, 500) };
        debugInfo.upstreamError = errData;
        throw new Error(errData.error?.message || errData.message || `Upstream ${upstream.status}`);
    }

    // Verify we got a readable stream
    if (!upstream.body) {
        throw new Error('Upstream response has no body (stream)');
    }

    // ── SSE to browser ───────────────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Request-Id', reqId);
    res.flushHeaders();

    // Send debug info as the first event
    res.write(`data: ${JSON.stringify({ debug: debugInfo })}\n\n`);

    let inputTokens = 0;
    let outputTokens = 0;
    let chunkCount = 0;
    let totalBytes = 0;

    const streamReader = upstream.body.getReader();
    const textDecoder = new TextDecoder();
    let buffer = '';

    // Keep-alive: send comment every 15s to prevent proxy timeouts
    const keepAlive = setInterval(() => {
        try { res.write(': keep-alive\n\n'); } catch {}
    }, 15000);

    try {
        while (true) {
            const { done, value } = await streamReader.read();
            if (done) break;

            totalBytes += value.length;
            buffer += textDecoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const raw = line.slice(6).trim();

                if (raw === '[DONE]') {
                    clearInterval(keepAlive);
                    debugInfo.totalBytes = totalBytes;
                    debugInfo.chunkCount = chunkCount;
                    res.write(`data: ${JSON.stringify({
                        done: true,
                        usage: { input: inputTokens, output: outputTokens },
                        chunks: chunkCount,
                    })}\n\n`);
                    res.end();
                    return;
                }

                try {
                    const parsed = JSON.parse(raw);
                    const delta = parsed.choices?.[0]?.delta?.content || '';
                    if (delta) {
                        chunkCount++;
                        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
                    }
                    if (parsed.usage) {
                        inputTokens = parsed.usage.prompt_tokens || inputTokens;
                        outputTokens = parsed.usage.completion_tokens || outputTokens;
                    }
                    const finish = parsed.choices?.[0]?.finish_reason;
                    if (finish && finish !== 'null') {
                        debugInfo.finishReason = finish;
                    }
                } catch (parseErr) {
                    // Log parse errors but don't crash the stream
                    if (parseErr.message && !parseErr.message.includes('JSON')) {
                        console.error(`[${reqId}] Stream parse error:`, parseErr.message);
                    }
                }
            }
        }

        // Process remaining buffer
        if (buffer.trim().startsWith('data: ')) {
            const raw = buffer.trim().slice(6).trim();
            if (raw && raw !== '[DONE]') {
                try {
                    const parsed = JSON.parse(raw);
                    const delta = parsed.choices?.[0]?.delta?.content || '';
                    if (delta) {
                        chunkCount++;
                        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
                    }
                    if (parsed.usage) {
                        inputTokens = parsed.usage.prompt_tokens || inputTokens;
                        outputTokens = parsed.usage.completion_tokens || outputTokens;
                    }
                } catch {}
            }
        }

        clearInterval(keepAlive);
        debugInfo.totalBytes = totalBytes;
        debugInfo.chunkCount = chunkCount;

        res.write(`data: ${JSON.stringify({
            done: true,
            usage: { input: inputTokens, output: outputTokens },
            chunks: chunkCount,
        })}\n\n`);
        res.end();
    } catch (readErr) {
        clearInterval(keepAlive);
        console.error(`[${reqId}] Stream read error:`, readErr.message);
        try { streamReader.cancel(); } catch {}
        throw readErr;
    }
}

// ─── Image Generation ────────────────────────────────────────────────────────

app.post('/api/image', async (req, res) => {
    const debugInfo = { reqId: req._reqId, ts: timestamp(), model: req.body.model };

    try {
        const { model, prompt, width = 1024, height = 1024, steps = 30 } = req.body;
        if (!model || !prompt) return res.status(400).json({ error: 'model and prompt are required.', debug: debugInfo });
        if (!process.env.NVIDIA_API_KEY) return res.status(500).json({ error: 'NVIDIA_API_KEY not configured.', debug: debugInfo });

        debugInfo.width = width;
        debugInfo.height = height;
        debugInfo.steps = steps;
        debugInfo.promptLength = prompt.length;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000);

        const start = Date.now();
        const response = await fetch('https://integrate.api.nvidia.com/v1/images/generations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
            body: JSON.stringify({ model, prompt, response_format: 'b64_json', width, height, steps }),
            signal: controller.signal,
        });
        clearTimeout(timeout);

        debugInfo.upstreamStatus = response.status;
        debugInfo.upstreamLatency = Date.now() - start;

        const data = await response.json();
        if (!response.ok) {
            debugInfo.upstreamError = data;
            return res.status(response.status).json({ error: data, debug: debugInfo });
        }

        const imgSrc = data.data[0].b64_json
            ? `data:image/png;base64,${data.data[0].b64_json}`
            : data.data[0].url;

        debugInfo.imageFormat = data.data[0].b64_json ? 'base64' : 'url';

        res.json({ reply: imgSrc, isImage: true, debug: debugInfo });
    } catch (error) {
        debugInfo.error = error.message;
        debugInfo.errorName = error.name;
        const statusCode = error.name === 'AbortError' ? 504 : 500;
        res.status(statusCode).json({
            error: error.name === 'AbortError' ? 'Image generation timed out (120s)' : error.message,
            debug: debugInfo,
        });
    }
});

// ─── 404 / Error handlers ────────────────────────────────────────────────────

app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        path: req.path,
        method: req.method,
        ts: timestamp(),
        hint: 'Valid endpoints: GET /api/ping, /api/health, /api/stats, /api/models | POST /api/chat, /api/image',
    });
});

app.use((err, req, res, next) => {
    console.error('[Unhandled Error]', err);
    requestStats.totalErrors++;
    if (!res.headersSent) {
        res.status(500).json({
            error: err.message,
            type: 'unhandled_error',
            ts: timestamp(),
        });
    }
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

process.on('SIGTERM', () => {
    console.log('[Server] SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('[Server] Closed');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Unhandled Rejection]', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[Uncaught Exception]', err);
    // Don't exit in production — let the process manager restart
});

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  AI Studio Nexus — Server v1.2.0`);
    console.log(`  Port: ${PORT} | Node: ${process.version} | PID: ${process.pid}`);
    console.log(`  Time: ${timestamp()}`);
    console.log(`  NVIDIA Key: ${process.env.NVIDIA_API_KEY ? '✓ configured' : '✗ missing'}`);
    console.log(`  Groq Key:   ${process.env.GROQ_API_KEY ? '✓ configured' : '✗ missing'}`);
    console.log(`${'═'.repeat(60)}\n`);

    // Self keep-alive for Render free tier
    const selfUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    setInterval(() => {
        fetch(`${selfUrl}/api/ping`)
            .then(r => r.json())
            .then(() => console.log(`[Keep-Alive] ✓`))
            .catch(err => console.log(`[Keep-Alive] ✗ ${err.message}`));
    }, 10 * 60 * 1000);
});