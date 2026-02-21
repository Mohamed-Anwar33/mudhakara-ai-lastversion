import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Configure the worker using Vite's ?url import for correct resolution.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export const MAX_TOTAL_CHARS = 100000; // ~25k tokens
export const MAX_CHUNK_CHARS = 20000;
export const MAX_CHUNKS = 5;

/**
 * Extracts text content from a PDF file.
 * @param file The PDF file object
 * @param onProgress Optional callback for progress updates
 * @returns Promise resolving to the extracted text
 */
export const extractPdfText = async (
    file: File,
    onProgress?: (loaded: number, total: number) => void
): Promise<string> => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    let fullText = '';
    const totalPages = pdf.numPages;

    for (let i = 1; i <= totalPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map((item: any) => item.str).join(' ');
        fullText += `\n--- Page ${i} ---\n${pageText}`;

        if (onProgress) {
            onProgress(i, totalPages);
        }

        // Safety check: Stop if we exceed the limit significantly to save memory
        if (fullText.length > MAX_TOTAL_CHARS * 1.5) {
            console.warn(`PDF extraction reached safety limit at page ${i}. Stopping early.`);
            break;
        }
    }

    return fullText;
};

/**
 * Truncates text to a safe limit, identifying if it was truncated.
 */
export const safeTruncate = (text: string, limit: number = MAX_TOTAL_CHARS): { text: string, truncated: boolean } => {
    if (text.length <= limit) return { text, truncated: false };
    return {
        text: text.substring(0, limit) + "\n...[Content Truncated due to size limits]...",
        truncated: true
    };
};


/**
 * Advanced Sliding Window Algorithm for Text Splitting.
 * Splits text into overlapping chunks to ensure AI context continuity.
 * @param text Full text content
 * @param chunkSize Size of each chunk in characters (default 25000 ~ 6k tokens)
 * @param overlapSize Overlap between chunks (default 1000 chars)
 * @returns Array of text chunks
 */
export const smartSlidingWindow = (
    text: string,
    chunkSize: number = 50000,
    overlapSize: number = 2000
): string[] => {
    if (text.length <= chunkSize) return [text];

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
        let end = start + chunkSize;

        // Ensure we don't split words in half (simple heuristic: look for space)
        if (end < text.length) {
            const lastSpace = text.lastIndexOf(' ', end);
            if (lastSpace > start + chunkSize * 0.8) { // Only adjust if space is reasonably close to end
                end = lastSpace;
            }
        }

        const chunk = text.substring(start, end);
        chunks.push(chunk);

        // Move window forward, minus overlap
        // Stop if we reached the end
        if (end >= text.length) break;

        start = end - overlapSize;
    }

    return chunks;
};

// Deprecated: Kept for backward compatibility if needed, but redirects to smart logic
export const splitTextIntoChunks = (text: string, chunkSize: number = MAX_CHUNK_CHARS): string[] => {
    return smartSlidingWindow(text, chunkSize, 0); // No overlap for legacy calls
};

/**
 * Converts PDF pages to Base64 Images (JPEG) for Vision Analysis.
 * Limits to first 20 pages to ensure payload size is manageable.
 */
/**
 * Converts PDF pages to Base64 Images (JPEG) for Vision Analysis.
 * Limits to first 5 pages to prevent Vercel 4.5MB Payload Error.
 */
export const convertPdfToImages = async (
    file: File,
    maxPages: number = 5 // Reduced from 20 to 5 to avoid 413 Payload Too Large
): Promise<{ data: string, mimeType: string }[]> => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    const images: { data: string, mimeType: string }[] = [];
    const totalPages = Math.min(pdf.numPages, maxPages);

    for (let i = 1; i <= totalPages; i++) {
        const page = await pdf.getPage(i);
        // Reduce scale from 2.0 to 1.5 (Enough for AI to read text, but saves 50% size)
        const viewport = page.getViewport({ scale: 1.5 });

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        if (context) {
            await page.render({ canvas: canvas, canvasContext: context, viewport: viewport }).promise;

            // Compress aggressively: JPEG 0.6 quality (Good balance for AI reading vs Size)
            const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
            const base64 = dataUrl.split(',')[1];

            images.push({
                data: base64,
                mimeType: 'image/jpeg'
            });
        }
    }

    return images;
};

