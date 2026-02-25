/**
 * Text chunker for Supabase Edge Functions (Deno-compatible).
 * Same logic as api/lib/chunker.ts but without Node.js dependencies.
 */

interface ChunkOptions {
    maxTokens?: number;
    overlapTokens?: number;
    tokensPerWord?: number;
}

export interface TextChunk {
    content: string;
    chunkIndex: number;
    metadata: {
        startChar: number;
        endChar: number;
        tokenEstimate: number;
    };
}

const MAX_CHUNK_CHARS = 5000;

export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
    const { maxTokens = 800, overlapTokens = 80, tokensPerWord = 2 } = options;
    const safeMaxTokens = Math.floor(maxTokens * 0.85);
    const maxWords = Math.max(20, Math.floor(safeMaxTokens / tokensPerWord));
    const overlapWords = Math.max(5, Math.floor(overlapTokens / tokensPerWord));

    const words = text.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return [];

    const chunks: TextChunk[] = [];
    let start = 0;
    let chunkIndex = 0;

    while (start < words.length) {
        let end = Math.min(start + maxWords, words.length);
        let chunkWords = words.slice(start, end);
        let content = chunkWords.join(' ');

        // Enforce character limit
        if (content.length > MAX_CHUNK_CHARS) {
            while (content.length > MAX_CHUNK_CHARS && chunkWords.length > 10) {
                chunkWords.pop();
                content = chunkWords.join(' ');
            }
            end = start + chunkWords.length;
        }

        // Find best break point
        if (end < words.length) {
            const breakChars = ['.', '؟', '!', ':', '\n'];
            let bestBreak = -1;
            for (let i = end - 1; i >= Math.max(start + 10, end - 20); i--) {
                const word = words[i];
                if (breakChars.some(c => word.endsWith(c))) {
                    bestBreak = i + 1;
                    break;
                }
            }
            if (bestBreak > start) {
                end = bestBreak;
                chunkWords = words.slice(start, end);
                content = chunkWords.join(' ');
            }
        }

        const startChar = text.indexOf(chunkWords[0]);
        chunks.push({
            content,
            chunkIndex,
            metadata: {
                startChar: Math.max(0, startChar),
                endChar: startChar + content.length,
                tokenEstimate: Math.ceil(chunkWords.length * tokensPerWord)
            }
        });

        chunkIndex++;
        start = Math.max(start + 1, end - overlapWords);
        if (start >= words.length) break;
        if (end >= words.length && start < words.length) {
            start = words.length; // prevent infinite loop
        }
    }

    return chunks;
}

export function linkChunks(ids: string[]): Array<{ id: string; prevId: string | null; nextId: string | null }> {
    return ids.map((id, i) => ({
        id,
        prevId: i > 0 ? ids[i - 1] : null,
        nextId: i < ids.length - 1 ? ids[i + 1] : null
    }));
}
