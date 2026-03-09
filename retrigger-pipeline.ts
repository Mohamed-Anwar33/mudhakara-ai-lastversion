/**
 * FULL pipeline re-trigger: clears everything and re-queues transcribe_audio + segment_lesson
 * This ensures the NEW audio-worker (with hallucination detection) runs from scratch.
 */
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
    const LESSON_ID = '30054b02-a0cd-4fcc-b851-ac7f1c7b49b7';
    console.log(`\n🔄 FULL PIPELINE RE-TRIGGER for lesson ${LESSON_ID}\n`);

    // 1. Get the audio source path from the lesson
    const { data: lesson } = await supabase.from('lessons')
        .select('sources, analysis_status').eq('id', LESSON_ID).single();

    if (!lesson) { console.log('❌ Lesson not found'); return; }
    console.log(`📋 Lesson found | status: ${lesson.analysis_status}`);
    console.log(`📂 Sources: ${JSON.stringify(lesson.sources?.length || 0)}`);

    // Find the audio source
    const sources = lesson.sources || [];
    const audioSource = sources.find((s: any) =>
        s.type === 'audio' || /\.(mp3|wav|m4a|mp4|ogg|webm)$/i.test(s.name || '')
    );

    if (!audioSource) { console.log('❌ No audio source in lesson'); return; }

    let audioPath = '';
    if (audioSource.uploadedUrl && audioSource.uploadedUrl.includes('/homework-uploads/')) {
        const parts = audioSource.uploadedUrl.split('/homework-uploads/');
        if (parts.length > 1) audioPath = parts[1];
    }

    if (!audioPath) { console.log('❌ No storage path for audio source'); return; }
    console.log(`🎵 Audio: ${audioSource.name} → ${audioPath}\n`);

    // 2. Clean everything
    console.log('🧹 Cleaning all old data...');

    // Delete ALL jobs for this lesson
    await supabase.from('processing_queue').delete().eq('lesson_id', LESSON_ID);
    console.log('  ✅ Cleared all jobs');

    // Delete segments
    await supabase.from('segmented_lectures').delete().eq('lesson_id', LESSON_ID);
    console.log('  ✅ Cleared segments');

    // Delete old transcripts
    const { data: transcriptFiles } = await supabase.storage.from('audio_transcripts').list(LESSON_ID);
    if (transcriptFiles && transcriptFiles.length > 0) {
        await supabase.storage.from('audio_transcripts').remove(
            transcriptFiles.map(f => `${LESSON_ID}/${f.name}`)
        );
    }
    // Also try alternate path
    const { data: altFiles } = await supabase.storage.from('audio_transcripts').list(`audio_transcripts/${LESSON_ID}`);
    if (altFiles && altFiles.length > 0) {
        await supabase.storage.from('audio_transcripts').remove(
            altFiles.map(f => `audio_transcripts/${LESSON_ID}/${f.name}`)
        );
    }
    console.log('  ✅ Cleared old transcripts');

    // Delete analysis files
    const { data: analysisFiles } = await supabase.storage.from('analysis').list(LESSON_ID);
    if (analysisFiles && analysisFiles.length > 0) {
        await supabase.storage.from('analysis').remove(
            analysisFiles.map(f => `${LESSON_ID}/${f.name}`)
        );
    }
    console.log('  ✅ Cleared analysis files');

    // Delete document sections
    await supabase.from('document_sections').delete().eq('lesson_id', LESSON_ID);
    console.log('  ✅ Cleared document sections');

    // 3. Re-queue: transcribe_audio → segment_lesson (chain)
    console.log('\n📤 Creating fresh pipeline jobs...');

    const audioJob = {
        lesson_id: LESSON_ID,
        job_type: 'transcribe_audio',
        status: 'pending',
        payload: {
            stage: 'upload',
            audio_url: audioPath,
            file_path: audioPath,
            source_type: 'audio',
            file_name: audioSource.name,
        },
        dedupe_key: `lesson:${LESSON_ID}:transcribe_audio:${audioPath}`,
        attempt_count: 0,
    };

    const segmentJob = {
        lesson_id: LESSON_ID,
        job_type: 'segment_lesson',
        status: 'pending',
        payload: { source_type: 'audio' },
        dedupe_key: `lesson:${LESSON_ID}:segment_lesson`,
        attempt_count: 0,
    };

    const { error: e1 } = await supabase.from('processing_queue')
        .upsert([audioJob], { onConflict: 'dedupe_key', ignoreDuplicates: false });
    if (e1) console.log(`  ❌ Audio job error: ${e1.message}`);
    else console.log('  ✅ Queued: transcribe_audio');

    const { error: e2 } = await supabase.from('processing_queue')
        .upsert([segmentJob], { onConflict: 'dedupe_key', ignoreDuplicates: false });
    if (e2) console.log(`  ❌ Segment job error: ${e2.message}`);
    else console.log('  ✅ Queued: segment_lesson (will wait for audio)');

    // 4. Update lesson status
    await supabase.from('lessons').update({
        analysis_status: 'processing', analysis_result: null
    }).eq('id', LESSON_ID);
    console.log('  ✅ Set lesson status to "processing"');

    // 5. Kick the queue worker
    console.log('\n⚡ Triggering queue worker...');
    try {
        const res = await fetch('https://mudhakara-ai-lastversion.vercel.app/api/process-queue', {
            method: 'POST',
        });
        const data = await res.json().catch(() => ({}));
        console.log(`  Worker: ${res.status} — ${JSON.stringify(data).substring(0, 100)}`);
    } catch (e: any) {
        console.log(`  Worker kick: ${e.message} (normal - Vercel free tier)`)
    }

    console.log('\n✅ Pipeline re-triggered!');
    console.log('📊 Flow: transcribe_audio → segment_lesson → analyze_lecture → finalize');
    console.log('⏱️ Go to the app to monitor progress.');
}

main().catch(e => console.error('FATAL:', e));
