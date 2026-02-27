import * as dotenv from 'dotenv';
import * as fs from 'fs';
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

async function listModels() {
    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
        );
        const data = await response.json();
        if (response.ok) {
            fs.writeFileSync('gemini_models_out.json', JSON.stringify(data, null, 2));
        } else {
            fs.writeFileSync('gemini_models_out.json', JSON.stringify(data, null, 2));
        }
    } catch (e) {
        console.log('Network error');
    }
}

listModels();
