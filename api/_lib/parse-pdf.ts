import { createClient } from '@supabase/supabase-js';
import { PDFDocument } from 'pdf-lib';

/**
 * Handles the 'extract_text_range' job natively in Node.js on Vercel.
 * This function downloads the PDF from Supabase, crops it to the requested 1-2 pages using pdf-lib,
 * extracts the text using pdf-parse, and saves the text to document_sections or queues ocr_range.
 */
export async function processExtractTextRange(supabase: any, job: any) {
    console.log(`[ParsePDF] Starting extract_text_range for Job ${job.id}`);

    try {
        const { lesson_id, payload } = job;
        const { lecture_id, page } = payload; // currently processing page numbers

        if (!lecture_id || !page) throw new Error("Missing lecture_id or page in extract_text_range");

        // First, check the lecture segment to see its boundaries
        const { data: lecture, error: lecErr } = await supabase
            .from('lecture_segments')
            .select('page_from, page_to, lesson_id')
            .eq('id', lecture_id)
            .single();

        if (lecErr || !lecture) throw new Error(`Lecture not found: ${lecture_id}`);

        // Decide how many pages to process (max 10 — doubled for throughput)
        const pagesToProcess = [];
        for (let p = page; p <= Math.min(page + 9, lecture.page_to); p++) {
            pagesToProcess.push(p);
        }

        // Fetch original file path from file_hashes (first one for this lesson)
        const { data: fileHash, error: hashErr } = await supabase
            .from('file_hashes')
            .select('file_path, content_hash')
            .eq('lesson_id', lesson_id)
            .eq('source_type', 'pdf')
            .limit(1)
            .single();

        if (hashErr || !fileHash) throw new Error(`Origin PDF not found for lesson ${lesson_id}`);

        // Download the PDF from storage
        const { data: fileData, error: fileErr } = await supabase.storage
            .from('homework-uploads')
            .download(fileHash.file_path);

        if (fileErr || !fileData) throw new Error(`Failed to download PDF: ${fileErr?.message}`);

        const pdfBuffer = Buffer.from(await fileData.arrayBuffer());

        // Crop the PDF using pdf-lib
        console.log(`[ParsePDF] Cropping pages ${pagesToProcess.join(',')} for lecture ${lecture_id}`);
        const originalDoc = await PDFDocument.load(pdfBuffer);
        const totalPages = originalDoc.getPageCount();

        const croppedDoc = await PDFDocument.create();
        const validIndices = pagesToProcess
            .map(p => p - 1) // 0-indexed
            .filter(idx => idx >= 0 && idx < totalPages);

        if (validIndices.length === 0) {
            console.log(`[ParsePDF] Invalid page range, skipping.`);
            return { status: 'completed' };
        }

        const copiedPages = await croppedDoc.copyPages(originalDoc, validIndices);
        copiedPages.forEach(p => croppedDoc.addPage(p));

        const croppedBytes = await croppedDoc.save();
        const croppedBuffer = Buffer.from(croppedBytes);

        // Extract text using pdf-parse
        let parsedText = '';
        try {
            const pdfParseModule = await import('pdf-parse');
            const ParseFunction = (pdfParseModule as any).default || pdfParseModule;
            const parsed = await ParseFunction(croppedBuffer);
            parsedText = parsed.text || '';
        } catch (e) {
            console.warn(`[ParsePDF] pdf-parse failed, assuming empty text:`, e);
            parsedText = '';
        }

        const cleanText = parsedText.replace(/\0/g, '').trim();

        // Hybrid Approach: Check if the text layer is valid
        // Average page has ~500+ chars. If we extracted less than 150 chars per page, it's likely scanned.
        // Raised from 100→150 to catch more scanned PDFs that have minimal text layer noise.
        const EXPECTED_MIN_CHARS = validIndices.length * 150;
        const hasTextLayer = cleanText.length >= EXPECTED_MIN_CHARS;

        if (hasTextLayer) {
            console.log(`[ParsePDF] Found robust text layer (${cleanText.length} chars)`);
            // Save to document_sections directly
            for (let i = 0; i < validIndices.length; i++) {
                const physicalPage = validIndices[i] + 1;
                const { error: insErr } = await supabase.from('document_sections').insert({
                    lesson_id: lesson_id,
                    lecture_id: lecture_id,
                    page: physicalPage,
                    content: i === 0 ? cleanText : '', // Only save the bulk on the first row to prevent duplication
                    source_type: 'pdf',
                    source_file_id: fileHash.file_path,
                    metadata: { extraction_method: 'pdf-parse', content_hash: fileHash.content_hash }
                });
                if (insErr) console.error(`[ParsePDF] Failed to save section:`, insErr);
            }
        } else {
            console.log(`[ParsePDF] Weak/No text layer (${cleanText.length} chars). Delegating to ocr_range.`);

            // Save the cropped PDF back to storage temporarily
            const croppedPath = `temp-ocr/${lesson_id}/${lecture_id}_pages_${validIndices.join('-')}.pdf`;
            await supabase.storage.from('homework-uploads').upload(croppedPath, croppedBuffer, { upsert: true });

            // Spawn an ocr_range job for the Edge Function (Gemini Vision)
            await supabase.from('processing_queue').insert({
                lesson_id: lesson_id,
                job_type: 'ocr_range',
                payload: {
                    lecture_id: lecture_id,
                    pages: validIndices.map(i => i + 1),
                    cropped_file_path: croppedPath,
                    content_hash: fileHash.content_hash
                },
                status: 'pending',
                dedupe_key: `lesson:${lesson_id}:ocr_range:lec_${lecture_id}:p_${validIndices[0]}`
            });
        }

        // Chain the next extraction job logic
        const nextPage = pagesToProcess[pagesToProcess.length - 1] + 1;

        if (nextPage <= lecture.page_to && nextPage <= totalPages) {
            // Keep extracting the same lecture
            await supabase.from('processing_queue').insert({
                lesson_id: lesson_id,
                job_type: 'extract_text_range',
                payload: { lecture_id: lecture_id, page: nextPage },
                status: 'pending',
                dedupe_key: `lesson:${lesson_id}:extract_text_range:lec_${lecture_id}:p_${nextPage}`
            });
        } else {
            console.log(`[ParsePDF] Finished lecture ${lecture_id}. Spawning chunk_lecture.`);
            await supabase.from('processing_queue').insert({
                lesson_id: lesson_id,
                job_type: 'chunk_lecture',
                payload: { lecture_id: lecture_id },
                status: 'pending',
                dedupe_key: `lesson:${lesson_id}:chunk_lecture:lec_${lecture_id}`
            });

            // Also kick off the NEXT lecture if it exists
            const { data: nextLecture } = await supabase.from('lecture_segments')
                .select('id, page_from')
                .eq('lesson_id', lesson_id)
                .gt('page_from', lecture.page_from)
                .order('page_from', { ascending: true })
                .limit(1)
                .maybeSingle();

            if (nextLecture) {
                await supabase.from('processing_queue').insert({
                    lesson_id: lesson_id,
                    job_type: 'extract_text_range',
                    payload: { lecture_id: nextLecture.id, page: nextLecture.page_from },
                    status: 'pending',
                    dedupe_key: `lesson:${lesson_id}:extract_text_range:lec_${nextLecture.id}:p_${nextLecture.page_from}`
                });
            } else {
                console.log(`[ParsePDF] All lectures extracted. Ready for final generation.`);
                // We're done extracting everything!
            }
        }

        // Mark the current job as completed natively
        await supabase.from('processing_queue').update({
            status: 'completed',
            stage: 'completed',
            progress: 100,
            completed_at: new Date().toISOString()
        }).eq('id', job.id);

        return { status: 'completed' };

    } catch (error: any) {
        console.error(`[ParsePDF] Error in processExtractTextRange:`, error);

        // Anti-Deadlock Chaining: Ensure we don't break the pipeline on fatal crashes
        try {
            const { lesson_id, payload } = job;
            if (lesson_id && payload?.lecture_id) {
                console.log(`[ParsePDF] Anti-deadlock: Spawning chunk_lecture for ${payload.lecture_id}`);
                await supabase.from('processing_queue').insert({
                    lesson_id: lesson_id,
                    job_type: 'chunk_lecture',
                    payload: { lecture_id: payload.lecture_id },
                    status: 'pending',
                    dedupe_key: `lesson:${lesson_id}:chunk_lecture:lec_${payload.lecture_id}`
                });

                // Also kick off the NEXT lecture if it exists to keep the chain moving
                const { data: nextLecture } = await supabase.from('lecture_segments')
                    .select('id, page_from')
                    .eq('lesson_id', lesson_id)
                    .gt('page_from', payload.page || 0)
                    .order('page_from', { ascending: true })
                    .limit(1)
                    .maybeSingle();

                if (nextLecture) {
                    await supabase.from('processing_queue').insert({
                        lesson_id: lesson_id,
                        job_type: 'extract_text_range',
                        payload: { lecture_id: nextLecture.id, page: nextLecture.page_from },
                        status: 'pending',
                        dedupe_key: `lesson:${lesson_id}:extract_text_range:lec_${nextLecture.id}:p_${nextLecture.page_from}`
                    });
                }
            }
        } catch (chainErr) {
            console.error(`[ParsePDF] Anti-deadlock chaining failed:`, chainErr);
        }

        await supabase.from('processing_queue').update({
            status: 'failed',
            stage: 'failed',
            error_message: error.message,
            updated_at: new Date().toISOString()
        }).eq('id', job.id);

        return { status: 'failed', error: error.message };
    }
}
