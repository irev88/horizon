const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Allows large image uploads
app.use(express.static('public')); // Serves your index.html

// 1. Models Endpoint
app.get('/api/models', async (req, res) => {
    try {
        const response = await fetch('https://integrate.api.nvidia.com/v1/models', {
            headers: { 'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}` }
        });
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Chat & Vision Endpoint
app.post('/api/chat', async (req, res) => {
    try {
        const { model, prompt, image_b64 } = req.body;
        let messages =[];

        if (image_b64) {
            messages.push({
                role: "user",
                content:[
                    { type: "text", text: prompt },
                    { type: "image_url", image_url: { url: image_b64 } }
                ]
            });
        } else {
            messages.push({ role: "user", content: prompt });
        }

        const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`
            },
            body: JSON.stringify({
                model: model || 'meta/llama-3.1-8b-instruct',
                messages: messages,
                temperature: 0.7,
                max_tokens: 4096
            })
        });

        const data = await response.json();
        if (!response.ok) return res.status(response.status).json({ error: data });

        res.json({ reply: data.choices[0].message.content });
    } catch (error) {
        res.status(500).json({ error: 'Failed to connect to NVIDIA Chat API.' });
    }
});

// 3. Image Generation Endpoint
app.post('/api/image', async (req, res) => {
    try {
        const { model, prompt } = req.body;
        
        const response = await fetch('https://integrate.api.nvidia.com/v1/images/generations', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`
            },
            body: JSON.stringify({
                model: model,
                prompt: prompt,
                response_format: "b64_json"
            })
        });

        const data = await response.json();
        if (!response.ok) return res.status(response.status).json({ error: data });

        const imgSrc = data.data[0].b64_json ? `data:image/png;base64,${data.data[0].b64_json}` : data.data[0].url;
        res.json({ reply: imgSrc, isImage: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to connect to NVIDIA Image API.' });
    }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});