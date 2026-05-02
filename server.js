const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ─── Request logging middleware ──────────────────────────────────────────────
app.use((req, res, next) => {
    const start = Date.now();
    const id = Math.random().toString(36).slice(2, 8);
    req._reqId = id;
    req._startTime = start;
    console.log(`[${id}] ${req.method} ${req.path} started`);

    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[${id}] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
    });

    next();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function getApiConfig(provider) {
    const configs = {
        Groq: {
            baseUrl: 'https://api.groq.com/openai/v1',
            key: process.env.GROQ_API_KEY,
        },
        NVIDIA: {
            baseUrl: 'https://integrate.api.nvidia.com/v1',
            key: process.env.NVIDIA_API_KEY,
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

// ─── Keep-Alive ──────────────────────────────────────────────────────────────

app.get('/api/ping', (req, res) => res.status(200).json({ status: 'ok', ts: timestamp() }));

// ─── Health / Debug Endpoint ─────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        ts: timestamp(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        env: {
            hasNvidiaKey: !!process.env.NVIDIA_API_KEY,
            hasGroqKey: !!process.env.GROQ_API_KEY,
            nodeVersion: process.version,
            platform: process.platform,
            renderUrl: process.env.RENDER_EXTERNAL_URL || 'not set',
        }
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

        if (process.env.NVIDIA_API_KEY) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 15000);
                const nvRes = await fetch('https://integrate.api.nvidia.com/v1/models', {
                    headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
                    signal: controller.signal
                });
                clearTimeout(timeout);
                if (nvRes.ok) {
                    const nvData = await nvRes.json();
                    allModels = allModels.concat(nvData.data.map(m => ({
                        id: m.id, provider: 'NVIDIA', type: isImageModel(m.id) ? 'image' : 'chat'
                    })));
                } else {
                    const errText = await nvRes.text().catch(() => '');
                    errors.push(`NVIDIA ${nvRes.status}: ${errText.slice(0, 200)}`);
                }
            } catch (e) { errors.push(`NVIDIA: ${e.name === 'AbortError' ? 'timeout (15s)' : e.message}`); }
        } else {
            errors.push('NVIDIA_API_KEY not set');
        }

        if (process.env.GROQ_API_KEY) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 15000);
                const groqRes = await fetch('https://api.groq.com/openai/v1/models', {
                    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
                    signal: controller.signal
                });
                clearTimeout(timeout);
                if (groqRes.ok) {
                    const groqData = await groqRes.json();
                    allModels = allModels.concat(groqData.data
                        .filter(m => !m.id.includes('whisper') && !m.id.includes('tts'))
                        .map(m => ({ id: m.id, provider: 'Groq', type: 'chat' }))
                    );
                } else {
                    const errText = await groqRes.text().catch(() => '');
                    errors.push(`Groq ${groqRes.status}: ${errText.slice(0, 200)}`);
                }
            } catch (e) { errors.push(`Groq: ${e.name === 'AbortError' ? 'timeout (15s)' : e.message}`); }
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
        res.status(500).json({ error: error.message, ts: timestamp() });
    }
});

// ─── Chat — Streaming with fallback ──────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
    const reqId = req._reqId;
    const { model, provider, prompt, images_b64, history = [], system_prompt = '', temperature = 0.7, max_tokens = 4096 } = req.body;

    // Build debug info object to send to client
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
    };

    try {
        if (!model || !provider || !prompt) {
            return res.status(400).json({ error: 'model, provider, and prompt are required.', debug: debugInfo });
        }

        const cfg = getApiConfig(provider);
        if (!cfg) return res.status(400).json({ error: `Unknown provider: ${provider}`, debug: debugInfo });
        if (!cfg.key) return res.status(500).json({ error: `API key for ${provider} is not configured.`, debug: debugInfo });

        const messages = [];
        if (system_prompt) messages.push({ role: 'system', content: system_prompt });
        const fullMessages = buildMessages([...messages, ...history], prompt, images_b64);

        debugInfo.messageCount = fullMessages.length;
        debugInfo.upstreamUrl = `${cfg.baseUrl}/chat/completions`;

        // ── Try streaming first ──────────────────────────────────────────────
        const useStreaming = req.body.stream !== false; // allow client to disable

        if (useStreaming) {
            try {
                await handleStreamingChat(cfg, model, fullMessages, temperature, max_tokens, debugInfo, req, res);
                return;
            } catch (streamErr) {
                // If headers not sent yet, fall back to non-streaming
                if (!res.headersSent) {
                    console.log(`[${reqId}] Streaming failed (${streamErr.message}), falling back to non-streaming`);
                    debugInfo.streamingFailed = true;
                    debugInfo.streamError = streamErr.message;
                } else {
                    // Headers already sent, nothing we can do
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
        const timeout = setTimeout(() => controller.abort(), 120000); // 2 min timeout

        const upstreamStart = Date.now();
        const upstream = await fetch(`${cfg.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
            body: JSON.stringify({ model, messages: fullMessages, temperature: parseFloat(temperature), max_tokens: parseInt(max_tokens, 10), stream: false }),
            signal: controller.signal,
        });
        clearTimeout(timeout);

        debugInfo.upstreamStatus = upstream.status;
        debugInfo.upstreamLatency = Date.now() - upstreamStart;

        const data = await upstream.json();

        if (!upstream.ok) {
            debugInfo.upstreamError = data;
            return res.status(upstream.status).json({
                error: data.error?.message || data.error || JSON.stringify(data),
                debug: debugInfo
            });
        }

        const reply = data.choices?.[0]?.message?.content || '';
        debugInfo.replyLength = reply.length;
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
        console.error(`[${reqId}] Fatal error:`, error);

        if (!res.headersSent) {
            res.status(500).json({ error: error.message, debug: debugInfo });
        }
    }
});

// ── Streaming handler (extracted) ────────────────────────────────────────────

async function handleStreamingChat(cfg, model, fullMessages, temperature, max_tokens, debugInfo, req, res) {
    const reqId = debugInfo.reqId;
    debugInfo.mode = 'streaming';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    const upstreamStart = Date.now();
    const upstream = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify({ model, messages: fullMessages, temperature: parseFloat(temperature), max_tokens: parseInt(max_tokens, 10), stream: true }),
        signal: controller.signal,
    });
    clearTimeout(timeout);

    debugInfo.upstreamStatus = upstream.status;
    debugInfo.upstreamLatency = Date.now() - upstreamStart;

    if (!upstream.ok) {
        const errData = await upstream.json().catch(() => ({ message: upstream.statusText }));
        debugInfo.upstreamError = errData;
        throw new Error(errData.error?.message || errData.message || `Upstream ${upstream.status}`);
    }

    // ── SSE to browser ───────────────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Important for nginx/Render proxy
    res.flushHeaders();

    // Send debug info as the first event
    res.write(`data: ${JSON.stringify({ debug: debugInfo })}\n\n`);

    let inputTokens = 0;
    let outputTokens = 0;
    let chunkCount = 0;

    const streamReader = upstream.body.getReader();
    const textDecoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await streamReader.read();
            if (done) break;

            buffer += textDecoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const raw = line.slice(6).trim();

                if (raw === '[DONE]') {
                    res.write(`data: ${JSON.stringify({ done: true, usage: { input: inputTokens, output: outputTokens }, chunks: chunkCount })}\n\n`);
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
                        inputTokens = parsed.usage.prompt_tokens || 0;
                        outputTokens = parsed.usage.completion_tokens || 0;
                    }
                    // Some APIs send finish_reason
                    const finish = parsed.choices?.[0]?.finish_reason;
                    if (finish && finish !== 'null') {
                        debugInfo.finishReason = finish;
                    }
                } catch {}
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
                        inputTokens = parsed.usage.prompt_tokens || 0;
                        outputTokens = parsed.usage.completion_tokens || 0;
                    }
                } catch {}
            }
        }

        res.write(`data: ${JSON.stringify({ done: true, usage: { input: inputTokens, output: outputTokens }, chunks: chunkCount })}\n\n`);
        res.end();
    } catch (readErr) {
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

        const imgSrc = data.data[0].b64_json ? `data:image/png;base64,${data.data[0].b64_json}` : data.data[0].url;
        res.json({ reply: imgSrc, isImage: true, debug: debugInfo });
    } catch (error) {
        debugInfo.error = error.message;
        debugInfo.errorName = error.name;
        res.status(500).json({ error: error.message, debug: debugInfo });
    }
});

// ─── 404 / Error handlers ────────────────────────────────────────────────────

app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path, ts: timestamp() });
});

app.use((err, req, res, next) => {
    console.error('[Unhandled]', err);
    res.status(500).json({ error: err.message, ts: timestamp() });
});

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Server] Running on port ${PORT} | Node ${process.version} | ${timestamp()}`);
    const selfUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    setInterval(() => {
        fetch(`${selfUrl}/api/ping`)
            .then(r => r.json())
            .then(() => console.log(`[Keep-Alive] OK`))
            .catch(err => console.log(`[Keep-Alive] Failed:`, err.message));
    }, 10 * 60 * 1000);
});