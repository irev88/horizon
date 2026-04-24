exports.handler = async function (event) {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

    try {
        const body = JSON.parse(event.body);
        let messages =[];

        // If user attached an image, format it for multimodal Vision models
        if (body.image_b64) {
            messages.push({
                role: "user",
                content:[
                    { type: "text", text: body.prompt },
                    { type: "image_url", image_url: { url: body.image_b64 } }
                ]
            });
        } else {
            // Standard Text format
            messages.push({ role: "user", content: body.prompt });
        }

        const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`
            },
            body: JSON.stringify({
                model: body.model || 'meta/llama-3.1-8b-instruct',
                messages: messages,
                temperature: 0.7,
                max_tokens: 1024
            })
        });

        const data = await response.json();
        if (!response.ok) return { statusCode: response.status, body: JSON.stringify({ error: data }) };

        return { statusCode: 200, body: JSON.stringify({ reply: data.choices[0].message.content }) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to connect to NVIDIA Chat API.' }) };
    }
};