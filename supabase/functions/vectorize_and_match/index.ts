import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4'

// Define the shape of our expected JSON payload
interface WebhookPayload {
    record: {
        id: string; // The analysis_jobs ID
        lesson_id: string;
        status: string;
        progress_percent: number;
    }
}

serve(async (req) => {
    try {
        const payload: WebhookPayload = await req.json()
        const { id, lesson_id, status, progress_percent } = payload.record

        // Only process if status is 'vectorizing'
        if (status !== 'vectorizing') {
            return new Response(JSON.stringify({ message: "Not a valid vectorizing job" }), { status: 200 })
        }

        const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
        const supabase = createClient(supabaseUrl, supabaseKey)
        const openAiKey = Deno.env.get('OPENAI_API_KEY')
        if (!openAiKey) throw new Error("Missing OPENAI_API_KEY")

        // 1. Fetch chunks that need vectors (Process in small batches of 10-20 to avoid timeouts)
        const { data: docChunks } = await supabase
            .from('document_chunks')
            .select('id, content')
            .eq('job_id', id)
            .is('embedding', null)
            .not('content', 'is', null) // only if OCR worked
            .limit(10)

        const { data: audioChunks } = await supabase
            .from('audio_transcripts')
            .select('id, content')
            .eq('job_id', id)
            .is('embedding', null)
            .limit(10)

        // Helper to call OpenAI
        const getEmbedding = async (text: string) => {
            const response = await fetch('https://api.openai.com/v1/embeddings', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${openAiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: "text-embedding-3-small",
                    input: text
                })
            })
            if (!response.ok) throw new Error(`OpenAI Embedding Error: ${await response.text()}`)
            const resJson = await response.json()
            return resJson.data[0].embedding
        }

        let workDone = false

        // Process Document Embeddings
        if (docChunks && docChunks.length > 0) {
            workDone = true
            for (const chunk of docChunks) {
                if (chunk.content.trim() === 'NO_TEXT_FOUND') continue;
                const embedding = await getEmbedding(chunk.content)
                await supabase.from('document_chunks').update({ embedding }).eq('id', chunk.id)
            }
        }

        // Process Audio Embeddings
        if (audioChunks && audioChunks.length > 0) {
            workDone = true
            for (const chunk of audioChunks) {
                const embedding = await getEmbedding(chunk.content)
                await supabase.from('audio_transcripts').update({ embedding }).eq('id', chunk.id)
            }
        }

        if (workDone) {
            // Still working, update progress slightly
            const newProgress = Math.min(75, progress_percent + 5)
            await supabase.from('analysis_jobs').update({ progress_percent: newProgress }).eq('id', id)
            return new Response(JSON.stringify({ message: "Processed batch of embeddings." }), { status: 200 })
        }

        // --- IF WE REACH HERE, ALL EMBEDDINGS ARE DONE ---

        // 2. Perform Matching Logic (Teacher Focus extraction)
        // We will do this by calling a Postgres RPC (Stored Procedure) to calculate cosine similarity
        // This avoids pulling massive vectors into Deno memory

        const { error: matchError } = await supabase.rpc('match_teacher_focus', { p_job_id: id })
        if (matchError) throw new Error(`Matching Error: ${matchError.message}`)

        // 3. Move to Summarization Phase
        await supabase.from('analysis_jobs').update({ status: 'summarizing', progress_percent: 80 }).eq('id', id)

        return new Response(JSON.stringify({ message: "Vectorizing and Matching Completed." }), {
            headers: { 'Content-Type': 'application/json' },
        })

    } catch (err) {
        console.error("Vectorizing Error: ", err)
        return new Response(JSON.stringify({ error: err.message }), { status: 500 })
    }
})
