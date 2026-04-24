exports.handler = async function (event) {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

    try {
        const body = JSON.parse(event.body);
        
        const response = await fetch('https://integrate.api.nvidia.com/v1/images/generations', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`
            },
            body: JSON.stringify({
                model: body.model,
                prompt: body.prompt,
                response_format: "b64_json" // Asks NVIDIA for a raw image file instead of a temporary URL
            })
        });

        const data = await response.json();
        if (!response.ok) return { statusCode: response.status, body: JSON.stringify({ error: data }) };

        // Return the Image properly decoded
        const imgSrc = data.data[0].b64_json ? `data:image/png;base64,${data.data[0].b64_json}` : data.data[0].url;

        return { statusCode: 200, body: JSON.stringify({ reply: imgSrc, isImage: true }) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to connect to NVIDIA Image API.' }) };
    }
};