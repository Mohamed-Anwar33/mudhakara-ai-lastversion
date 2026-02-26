import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4'

// Define the shape of our expected JSON payload
interface WebhookPayload {
  record: {
    id: string; // The analysis_jobs ID
    lesson_id: string;
    file_path: string;
    file_type: string;
    status: string;
  }
}

serve(async (req) => {
  try {
    const payload: WebhookPayload = await req.json()
    const { id, lesson_id, file_path, file_type, status } = payload.record

    // Only process if it's an audio file and it's pending/extracting
    if (file_type !== 'audio' || (status !== 'pending' && status !== 'extracting')) {
      return new Response(JSON.stringify({ message: "Not a valid audio job" }), { status: 200 })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    const supabase = createClient(supabaseUrl, supabaseKey)

    // 1. Mark Job as extracting
    await supabase.from('analysis_jobs').update({ status: 'extracting', progress_percent: 10 }).eq('id', id)

    // 2. Download audio file from storage Bucket 'lesson_files'
    const { data: audioData, error: downloadError } = await supabase.storage
      .from('lesson_files')
      .download(file_path)

    if (downloadError || !audioData) {
      throw new Error(`Failed to download audio: ${downloadError?.message}`)
    }

    // 3. Send to OpenAI Whisper SDK (using standard Fetch API for Deno compatibility)
    const formData = new FormData()
    // Whisper requires a filename ending with a valid extension (.mp3, .mp4, .mpeg, .mpga, .m4a, .wav, or .webm)
    formData.append('file', audioData, 'audio.mp3') 
    formData.append('model', 'whisper-1')

    const openAiKey = Deno.env.get('OPENAI_API_KEY')
    if (!openAiKey) throw new Error("Missing OPENAI_API_KEY environment variable")

    const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openAiKey}`
      },
      body: formData
    })

    if (!whisperResponse.ok) {
        const errorText = await whisperResponse.text()
        throw new Error(`OpenAI API error: ${errorText}`)
    }

    const whisperResult = await whisperResponse.json()
    const transcribedText = whisperResult.text

    if (!transcribedText) {
       throw new Error("No text transcribed from OpenAI")
    }

    // 4. Save the transcript to database
    // Note: Whisper by default doesn't return timestamps unless `response_format='srt' or 'vtt'`
    // For now, we save it as a single chunk. For >25MB handling, we would loop this.
    const { error: insertError } = await supabase.from('audio_transcripts').insert({
        job_id: id,
        lesson_id: lesson_id,
        content: transcribedText
    })

    if (insertError) {
        throw new Error(`Failed to save transcript: ${insertError.message}`)
    }

    // 5. Update Job status to Vectorizing (It will trigger the next Edge Function or step)
    await supabase.from('analysis_jobs').update({ status: 'vectorizing', progress_percent: 30 }).eq('id', id)

    return new Response(JSON.stringify({ message: "Audio processed successfully" }), {
      headers: { 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error("Audio Processing Error: ", err)
    
    // Attempt to log failure to DB if we have access to the ID
    // (We would ideally parse the ID safely before the try catch block)
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})
