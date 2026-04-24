// netlify/functions/chat.js

exports.handler = async function (event, context) {
    // Only allow POST requests
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    try {
        // Parse the incoming request from the frontend
        const body = JSON.parse(event.body);
        const userPrompt = body.prompt;

        // Call the NVIDIA API
        const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // Netlify will securely inject this environment variable
                'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}` 
            },
            body: JSON.stringify({
                model: 'meta/llama-3.1-8b-instruct',
                messages: [{ role: 'user', content: userPrompt }],
                temperature: 0.7,
                max_tokens: 1024
            })
        });

        const data = await response.json();

        // Handle NVIDIA API errors
        if (!response.ok) {
            return {
                statusCode: response.status,
                body: JSON.stringify({ error: data })
            };
        }

        // Return the successful response back to the frontend
        return {
            statusCode: 200,
            body: JSON.stringify({ reply: data.choices[0].message.content })
        };

    } catch (error) {
        console.error('Function Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal Server Error while connecting to NVIDIA.' })
        };
    }
};