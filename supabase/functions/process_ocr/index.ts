import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4'

// Define the shape of our expected JSON payload
interface WebhookPayload {
    record: {
        id: string; // The analysis_jobs ID
        lesson_id: string;
        file_path: string; // E.g., folder path for the image chunks: 'lesson_files/123/pages/'
        file_type: string;
        status: string;
        progress_percent: number;
    }
}

serve(async (req) => {
    try {
        const payload: WebhookPayload = await req.json()
        const { id, lesson_id, file_path, file_type, status, progress_percent } = payload.record

        // Only process if it's a PDF/Image job and it's pending/extracting
        if ((file_type !== 'pdf' && file_type !== 'image') || (status !== 'pending' && status !== 'extracting')) {
            return new Response(JSON.stringify({ message: "Not a valid OCR job" }), { status: 200 })
        }

        const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
        const supabase = createClient(supabaseUrl, supabaseKey)

        // Mark Job as extracting if it just started
        if (status === 'pending') {
            await supabase.from('analysis_jobs').update({ status: 'extracting', progress_percent: 10 }).eq('id', id)
        }

        // 1. Find pending pages in the `document_chunks` table for this job that have NO content yet
        // The frontend should pre-insert these empty rows when uploading the chunks,
        // or we list the files in the storage bucket. Let's assume frontend pre-inserts rows with empty content.
        const { data: pendingChunks, error: fetchError } = await supabase
            .from('document_chunks')
            .select('*')
            .eq('job_id', id)
            .is('content', null)
            .order('page_number', { ascending: true })
            .limit(3) // Process max 3 pages per Edge Function invocation to avoid timeouts

        if (fetchError) throw new Error(`Failed to fetch pending chunks: ${fetchError.message}`)

        if (!pendingChunks || pendingChunks.length === 0) {
            // If no more empty chunks, we are done with OCR!
            await supabase.from('analysis_jobs').update({ status: 'vectorizing', progress_percent: 50 }).eq('id', id)
            return new Response(JSON.stringify({ message: "All pages OCR completed. Moving to Vectorizing." }), { status: 200 })
        }

        const openAiKey = Deno.env.get('OPENAI_API_KEY')
        if (!openAiKey) throw new Error("Missing OPENAI_API_KEY environment variable")

        // 2. Process the batch (up to 3 pages)
        for (const chunk of pendingChunks) {
            // Assuming `file_path` on the job was `lessons/123/`, chunk has `page_number`
            // Frontend uploaded them as `lessons/123/page_1.png`
            const imagePath = `${file_path}/page_${chunk.page_number}.png`

            const { data: fileData, error: downloadError } = await supabase.storage
                .from('lesson_files')
                .createSignedUrl(imagePath, 60) // 60 seconds expiry

            if (downloadError || !fileData) {
                console.error(`Skipping page ${chunk.page_number} due to download error:`, downloadError)
                continue;
            }

            const imageUrl = fileData.signedUrl

            // 3. Send to Vision API (Using GPT-4o for best OCR Arabic/English)
            const visionResponse = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openAiKey}`
                },
                body: JSON.stringify({
                    model: "gpt-4o",
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text",
                                    text: "Please extract ALL the text from this image exactly as it appears. Preserve the formatting. Do not invent details. If there is no text, return 'NO_TEXT_FOUND'."
                                },
                                {
                                    type: "image_url",
                                    image_url: {
                                        url: imageUrl
                                    }
                                }
                            ]
                        }
                    ],
                    max_tokens: 2000
                })
            })

            if (!visionResponse.ok) {
                console.error(`Vision API error for page ${chunk.page_number}:`, await visionResponse.text())
                continue; // Skip and it will be retried in the next batch
            }

            const visionResult = await visionResponse.json()
            const extractedText = visionResult.choices[0].message.content

            // 4. Update the chunk with the extracted text
            await supabase.from('document_chunks').update({ content: extractedText }).eq('id', chunk.id)
        }

        // After processing the batch, we haven't finished all pages necessarily.
        // We increment progress slightly just for UI feedback
        const newProgress = Math.min(45, progress_percent + 2)
        await supabase.from('analysis_jobs').update({ progress_percent: newProgress }).eq('id', id)

        // IMPORTANT: Since Edge Functions shouldn't run forever, we rely on Supabase DB Webhooks
        // or a cron job to keep firing this function as long as `status = extracting`.
        // By returning 200, the webhook succeeds. Another webhook trigger can be fired by the `UPDATE` we just did!

        return new Response(JSON.stringify({ message: `Successfully processed ${pendingChunks.length} pages.` }), {
            headers: { 'Content-Type': 'application/json' },
        })

    } catch (err) {
        console.error("OCR Processing Error: ", err)
        return new Response(JSON.stringify({ error: err.message }), { status: 500 })
    }
})
