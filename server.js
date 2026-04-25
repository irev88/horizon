const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

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

// ─── Keep-Alive ──────────────────────────────────────────────────────────────

app.get('/api/ping', (req, res) => res.status(200).json({ status: 'ok', ts: Date.now() }));

// ─── Models ──────────────────────────────────────────────────────────────────

let modelsCache = null;
let modelsCacheTime = 0;
const MODELS_CACHE_TTL = 5 * 60 * 1000;

app.get('/api/models', async (req, res) => {
    try {
        const now = Date.now();
        if (modelsCache && now - modelsCacheTime < MODELS_CACHE_TTL) {
            return res.json({ data: modelsCache, cached: true });
        }

        let allModels = [];
        const errors = [];

        if (process.env.NVIDIA_API_KEY) {
            try {
                const nvRes = await fetch('https://integrate.api.nvidia.com/v1/models', {
                    headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` }
                });
                if (nvRes.ok) {
                    const nvData = await nvRes.json();
                    allModels = allModels.concat(nvData.data.map(m => ({
                        id: m.id, provider: 'NVIDIA', type: isImageModel(m.id) ? 'image' : 'chat'
                    })));
                } else {
                    errors.push(`NVIDIA API returned ${nvRes.status}`);
                }
            } catch (e) { errors.push(`NVIDIA fetch failed: ${e.message}`); }
        }

        if (process.env.GROQ_API_KEY) {
            try {
                const groqRes = await fetch('https://api.groq.com/openai/v1/models', {
                    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }
                });
                if (groqRes.ok) {
                    const groqData = await groqRes.json();
                    allModels = allModels.concat(groqData.data
                        .filter(m => !m.id.includes('whisper') && !m.id.includes('tts'))
                        .map(m => ({ id: m.id, provider: 'Groq', type: 'chat' }))
                    );
                } else {
                    errors.push(`Groq API returned ${groqRes.status}`);
                }
            } catch (e) { errors.push(`Groq fetch failed: ${e.message}`); }
        }

        if (allModels.length === 0 && errors.length > 0) {
            return res.status(502).json({ error: errors.join('; ') });
        }

        modelsCache = allModels;
        modelsCacheTime = now;
        res.json({ data: allModels, errors: errors.length ? errors : undefined });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ─── Chat / Vision — Streaming (FIXED) ───────────────────────────────────────

app.post('/api/chat', async (req, res) => {
    try {
        const { model, provider, prompt, images_b64, history = [], system_prompt = '', temperature = 0.7, max_tokens = 4096 } = req.body;

        if (!model || !provider || !prompt) {
            return res.status(400).json({ error: 'model, provider, and prompt are required.' });
        }

        const cfg = getApiConfig(provider);
        if (!cfg) return res.status(400).json({ error: `Unknown provider: ${provider}` });
        if (!cfg.key) return res.status(500).json({ error: `API key for ${provider} is not configured.` });

        const messages = [];
        if (system_prompt) messages.push({ role: 'system', content: system_prompt });
        const fullMessages = buildMessages([...messages, ...history], prompt, images_b64);

        const upstream = await fetch(`${cfg.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
            body: JSON.stringify({ model, messages: fullMessages, temperature: parseFloat(temperature), max_tokens: parseInt(max_tokens, 10), stream: true })
        });

        if (!upstream.ok) {
            const errData = await upstream.json().catch(() => ({ message: upstream.statusText }));
            return res.status(upstream.status).json({ error: errData });
        }

        // ── Stream SSE to browser ────────────────────────────────────────────
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        let inputTokens = 0;
        let outputTokens = 0;

        // FIX: Use getReader() and TextDecoder for reliable cross-environment streaming
        const streamReader = upstream.body.getReader();
        const textDecoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await streamReader.read();
            if (done) break;

            // FIX: Properly decode Uint8Array chunks to UTF-8 string
            buffer += textDecoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep incomplete line for next chunk

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const raw = line.slice(6).trim();
                
                if (raw === '[DONE]') {
                    res.write(`data: ${JSON.stringify({ done: true, usage: { input: inputTokens, output: outputTokens } })}\n\n`);
                    res.end();
                    return;
                }

                try {
                    const parsed = JSON.parse(raw);
                    const delta = parsed.choices?.[0]?.delta?.content || '';
                    if (delta) {
                        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
                    }
                    if (parsed.usage) {
                        inputTokens = parsed.usage.prompt_tokens || 0;
                        outputTokens = parsed.usage.completion_tokens || 0;
                    }
                } catch { /* Skip malformed SSE lines */ }
            }
        }

        // Handle any remaining data in buffer after stream closes
        if (buffer.trim().startsWith('data: ')) {
            const raw = buffer.trim().slice(6).trim();
            if (raw !== '[DONE]') {
                try {
                    const parsed = JSON.parse(raw);
                    const delta = parsed.choices?.[0]?.delta?.content || '';
                    if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
                    if (parsed.usage) {
                        inputTokens = parsed.usage.prompt_tokens || 0;
                        outputTokens = parsed.usage.completion_tokens || 0;
                    }
                } catch {}
            }
        }

        res.write(`data: ${JSON.stringify({ done: true, usage: { input: inputTokens, output: outputTokens } })}\n\n`);
        res.end();
    } catch (error) {
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        } else {
            res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
        }
    }
});

// ─── Image Generation ────────────────────────────────────────────────────────

app.post('/api/image', async (req, res) => {
    try {
        const { model, prompt, width = 1024, height = 1024, steps = 30 } = req.body;
        if (!model || !prompt) return res.status(400).json({ error: 'model and prompt are required.' });
        if (!process.env.NVIDIA_API_KEY) return res.status(500).json({ error: 'NVIDIA_API_KEY is not configured.' });

        const response = await fetch('https://integrate.api.nvidia.com/v1/images/generations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
            body: JSON.stringify({ model, prompt, response_format: 'b64_json', width, height, steps })
        });

        const data = await response.json();
        if (!response.ok) return res.status(response.status).json({ error: data });

        const imgSrc = data.data[0].b64_json ? `data:image/png;base64,${data.data[0].b64_json}` : data.data[0].url;
        res.json({ reply: imgSrc, isImage: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ─── Server ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Server] Running on port ${PORT}`);
    const selfUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    setInterval(() => {
        fetch(`${selfUrl}/api/ping`)
            .then(r => r.json())
            .then(() => console.log(`[Keep-Alive] OK`))
            .catch(err => console.log(`[Keep-Alive] Failed:`, err.message));
    }, 10 * 60 * 1000);
});