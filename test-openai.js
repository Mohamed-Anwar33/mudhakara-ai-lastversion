import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.OPENAI_API_KEY;

async function testOpenAIFeatures() {
    console.log("Testing OpenAI Features...");

    // 1. Test GPT-4o
    try {
        const chatRes = await fetch("https://api.openai.com/v1/chat/completions", {
            method: 'POST',
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "gpt-4o",
                messages: [{ role: "user", content: "Say 'GPT-4o is active' in Arabic" }],
                max_tokens: 10
            })
        });
        if (chatRes.ok) {
            console.log("✅ GPT-4o Active");
        } else {
            console.error("❌ GPT-4o Failed:", chatRes.status, await chatRes.text());
        }
    } catch (e) { console.error("GPT-4o network error", e); }

    // 2. Test Embeddings
    try {
        const embRes = await fetch("https://api.openai.com/v1/embeddings", {
            method: 'POST',
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "text-embedding-3-small",
                input: "Test embedding string"
            })
        });
        if (embRes.ok) {
            console.log("✅ Embeddings Active (text-embedding-3-small)");
        } else {
            console.error("❌ Embeddings Failed:", embRes.status, await embRes.text());
        }
    } catch (e) { console.error("Embeddings network error", e); }

}

testOpenAIFeatures();
