const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.static('public')); 

// --- NEW: Keep-Alive Ping Endpoint ---
app.get('/api/ping', (req, res) => res.status(200).send('Pong'));

// 1. Fetch Models
app.get('/api/models', async (req, res) => {
    try {
        let allModels =[];

        if (process.env.NVIDIA_API_KEY) {
            const nvRes = await fetch('https://integrate.api.nvidia.com/v1/models', { headers: { 'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}` } });
            if (nvRes.ok) {
                const nvData = await nvRes.json();
                allModels = allModels.concat(nvData.data.map(m => ({ id: m.id, provider: 'NVIDIA' })));
            }
        }

        if (process.env.GROQ_API_KEY) {
            const groqRes = await fetch('https://api.groq.com/openai/v1/models', { headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` } });
            if (groqRes.ok) {
                const groqData = await groqRes.json();
                allModels = allModels.concat(groqData.data.map(m => ({ id: m.id, provider: 'Groq' })));
            }
        }

        res.json({ data: allModels });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Chat & Vision Endpoint
app.post('/api/chat', async (req, res) => {
    try {
        const { model, provider, prompt, images_b64 } = req.body;
        let messages =[];

        if (images_b64 && images_b64.length > 0) {
            let contentArray =[{ type: "text", text: prompt }];
            images_b64.forEach(img => contentArray.push({ type: "image_url", image_url: { url: img } }));
            messages.push({ role: "user", content: contentArray });
        } else {
            messages.push({ role: "user", content: prompt });
        }

        const url = provider === 'Groq' ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://integrate.api.nvidia.com/v1/chat/completions';
        const apiKey = provider === 'Groq' ? process.env.GROQ_API_KEY : process.env.NVIDIA_API_KEY;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 4096 })
        });

        const data = await response.json();
        if (!response.ok) return res.status(response.status).json({ error: data });

        res.json({ reply: data.choices[0].message.content });
    } catch (error) {
        res.status(500).json({ error: 'Failed to connect to AI API.' });
    }
});

// 3. Image Generation Endpoint
app.post('/api/image', async (req, res) => {
    try {
        const { model, prompt } = req.body;
        const response = await fetch('https://integrate.api.nvidia.com/v1/images/generations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}` },
            body: JSON.stringify({ model, prompt, response_format: "b64_json" })
        });

        const data = await response.json();
        if (!response.ok) return res.status(response.status).json({ error: data });

        const imgSrc = data.data[0].b64_json ? `data:image/png;base64,${data.data[0].b64_json}` : data.data[0].url;
        res.json({ reply: imgSrc, isImage: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to connect to Image API.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    
    // --- NEW: Keep-Alive Loop (Runs every 10 minutes) ---
    // Render automatically provides process.env.RENDER_EXTERNAL_URL
    const selfUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    setInterval(() => {
        fetch(`${selfUrl}/api/ping`)
            .then(() => console.log(`[Keep-Alive] Ping successful.`))
            .catch(err => console.log(`[Keep-Alive] Ping failed:`, err.message));
    }, 10 * 60 * 1000);
});