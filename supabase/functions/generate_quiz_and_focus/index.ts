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
        const { id, lesson_id, status } = payload.record

        // Only process if status is 'generating_quiz'
        if (status !== 'generating_quiz') {
            return new Response(JSON.stringify({ message: "Not a valid quiz generation job" }), { status: 200 })
        }

        const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
        const supabase = createClient(supabaseUrl, supabaseKey)
        const openAiKey = Deno.env.get('OPENAI_API_KEY')
        if (!openAiKey) throw new Error("Missing OPENAI_API_KEY")

        // 1. Fetch the final massive summary for the lesson
        const { data: finalOutput, error: outputError } = await supabase
            .from('final_lesson_output')
            .select('massive_summary')
            .eq('lesson_id', lesson_id)
            .single()

        if (outputError || !finalOutput || !finalOutput.massive_summary) {
            throw new Error(`Failed to fetch final summary: ${outputError?.message}`)
        }

        // 2. We ask GPT-4o to read the summary and output valid JSON for Quizzes and Focus Points.
        // If the massive summary is > 100k, we could hit GPT-4o's input context limit (128k tokens ~ 400k chars),
        // which is perfectly fine for text-embedding-3 context length!

        const gptResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openAiKey}`
            },
            body: JSON.stringify({
                model: "gpt-4o",
                response_format: { type: "json_object" },
                messages: [
                    {
                        role: "system",
                        content: `You are an educational AI assistant. Extract key focus points and generate a comprehensive quiz in JSON format based on the following text. 
              The JSON must exactly follow this schema:
              {
                "focus_points": ["point 1", "point 2", ...],
                "quiz": [
                  { "type": "mcq", "question": "...", "options": ["A", "B", "C", "D"], "answer": "A" },
                  { "type": "true_false", "question": "...", "answer": "true/false" },
                  { "type": "essay", "question": "...", "suggested_answer_points": ["...", "..."] }
                ]
              }`
                    },
                    {
                        role: "user",
                        content: finalOutput.massive_summary
                    }
                ]
            })
        })

        if (!gptResponse.ok) {
            throw new Error(`OpenAI Quiz Gen Error: ${await gptResponse.text()}`)
        }

        const gptResult = await gptResponse.json()
        const jsonContent = JSON.parse(gptResult.choices[0].message.content)

        // 3. Save the results to the database
        const { error: updateError } = await supabase
            .from('final_lesson_output')
            .update({
                focus_points: jsonContent.focus_points || [],
                quiz: jsonContent.quiz || []
            })
            .eq('lesson_id', lesson_id)

        if (updateError) throw new Error(`Failed to save quiz: ${updateError.message}`)

        // 4. Mark Job as Completed!
        await supabase.from('analysis_jobs').update({ status: 'completed', progress_percent: 100 }).eq('id', id)

        // Also update the original `lessons` table (optional, depending on frontend needs)
        await supabase.from('lessons').update({ analysis_status: 'completed' }).eq('id', lesson_id)

        return new Response(JSON.stringify({ message: "Quiz generated successfully. Job completed." }), {
            headers: { 'Content-Type': 'application/json' },
        })

    } catch (err) {
        console.error("Quiz Error: ", err)

        // Attempt to log failure
        return new Response(JSON.stringify({ error: err.message }), { status: 500 })
    }
})
