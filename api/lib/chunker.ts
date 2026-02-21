/**
 * Text Chunking Utility — Word-Based Tokenizer
 * 
 * يقسم النص إلى أجزاء بناءً على عدد الكلمات (كتقريب ثابت لعدد الـ tokens).
 * 
 * لماذا word-based وليس character-based؟
 * - أدق بكثير خصوصاً للنصوص العربية
 * - text-embedding-3-small يستخدم cl100k_base tokenizer
 * - القاعدة: 1 كلمة عربية ≈ 2-3 tokens، 1 كلمة إنجليزية ≈ 1.3 tokens
 * - نستخدم معدل 2 tokens/word كتقريب محافظ
 * - الحد الأقصى للـ API: 8191 tokens → 512 token target = ~256 كلمة
 * 
 * Safety: نضيف 15% margin فوق الحد لمنع الـ overflow.
 */

export interface TextChunk {
    content: string;
    chunkIndex: number;
    metadata: {
        startChar: number;
        endChar: number;
        wordCount: number;
        tokenEstimate: number;
    };
}

export interface ChunkOptions {
    maxTokens?: number;       // بالـ tokens (افتراضي 512)
    overlapTokens?: number;   // tokens تداخل (افتراضي 102 ≈ 20%)
    tokensPerWord?: number;   // معدل tokens لكل كلمة (افتراضي 2 للعربي)
}

const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_OVERLAP_TOKENS = 102;     // ~20% of 512
const DEFAULT_TOKENS_PER_WORD = 2;      // Conservative for Arabic

/**
 * يحسب عدد الكلمات في النص.
 * يتعامل مع العربية والإنجليزية وعلامات الترقيم.
 */
function countWords(text: string): number {
    return text.split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * يحوّل عدد كلمات إلى تقدير tokens.
 */
function wordsToTokens(wordCount: number, tokensPerWord: number): number {
    return Math.ceil(wordCount * tokensPerWord);
}

/**
 * يحوّل عدد tokens إلى عدد كلمات.
 */
function tokensToWords(tokens: number, tokensPerWord: number): number {
    return Math.floor(tokens / tokensPerWord);
}

/**
 * يبني مصفوفة كلمات من النص مع تتبع مواقعها.
 */
interface WordPosition {
    word: string;
    startChar: number;
    endChar: number;
}

function getWordPositions(text: string): WordPosition[] {
    const positions: WordPosition[] = [];
    const regex = /\S+/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        positions.push({
            word: match[0],
            startChar: match.index,
            endChar: match.index + match[0].length
        });
    }
    return positions;
}

/**
 * يبحث عن أفضل نقطة قطع بناءً على الكلمات.
 * الأولوية: نهاية فقرة → نهاية جملة → نهاية كلمة
 */
function findBestWordBreak(
    words: WordPosition[],
    startIdx: number,
    maxWordIdx: number,
    fullText: string
): number {
    if (maxWordIdx >= words.length) return words.length;

    // ابحث عن نهاية فقرة (سطر فارغ بعد كلمة)
    const minIdx = Math.floor(startIdx + (maxWordIdx - startIdx) * 0.5);
    for (let i = maxWordIdx; i >= minIdx; i--) {
        const afterWord = fullText.substring(words[i].endChar, words[i].endChar + 3);
        if (afterWord.includes('\n\n')) return i + 1;
    }

    // ابحث عن نهاية جملة
    const sentenceEnders = ['.', '。', '؟', '!', '؛'];
    for (let i = maxWordIdx; i >= minIdx; i--) {
        const lastChar = words[i].word[words[i].word.length - 1];
        if (sentenceEnders.includes(lastChar)) return i + 1;
    }

    // اقطع عند حد الكلمات
    return maxWordIdx;
}

/**
 * يقسم النص إلى chunks بناءً على عدد الـ tokens (عبر الكلمات).
 * 
 * @param text - النص الكامل
 * @param options - خيارات التقسيم
 * @returns مصفوفة من الأجزاء مع metadata
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
    const maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;
    const overlapTokens = options.overlapTokens || DEFAULT_OVERLAP_TOKENS;
    const tokensPerWord = options.tokensPerWord || DEFAULT_TOKENS_PER_WORD;

    // Apply 15% safety margin to prevent token overflow
    const safeMaxTokens = Math.floor(maxTokens * 0.85);
    const maxWordsPerChunk = tokensToWords(safeMaxTokens, tokensPerWord);
    const overlapWords = tokensToWords(overlapTokens, tokensPerWord);

    // Clean text
    const cleanedText = text.replace(/\r\n/g, '\n').trim();
    if (!cleanedText) return [];

    // Get all word positions
    const wordPositions = getWordPositions(cleanedText);

    if (wordPositions.length === 0) return [];

    // If text fits in one chunk, return as-is
    const totalWords = wordPositions.length;
    if (totalWords <= maxWordsPerChunk) {
        return [{
            content: cleanedText,
            chunkIndex: 0,
            metadata: {
                startChar: 0,
                endChar: cleanedText.length,
                wordCount: totalWords,
                tokenEstimate: wordsToTokens(totalWords, tokensPerWord)
            }
        }];
    }

    const chunks: TextChunk[] = [];
    let wordStartIdx = 0;
    let chunkIndex = 0;

    while (wordStartIdx < wordPositions.length) {
        // Find end of this chunk
        const targetEndIdx = wordStartIdx + maxWordsPerChunk;
        const endIdx = findBestWordBreak(wordPositions, wordStartIdx, targetEndIdx, cleanedText);

        // Extract chunk text
        const startChar = wordPositions[wordStartIdx].startChar;
        let endChar = endIdx < wordPositions.length
            ? wordPositions[endIdx - 1].endChar
            : cleanedText.length;

        // Safety limit: 2500 chars max per chunk (content column is TEXT, not B-Tree indexed)
        if (endChar - startChar > 2500) {
            endChar = startChar + 2500;
            // Adjust to nearest whitespace to avoid splitting words
            const lastSpace = cleanedText.lastIndexOf(' ', endChar);
            if (lastSpace > startChar) endChar = lastSpace;
        }

        const chunkContent = cleanedText.slice(startChar, endChar).trim();
        const chunkWordCount = endIdx - wordStartIdx;

        if (chunkContent.length > 0) {
            chunks.push({
                content: chunkContent,
                chunkIndex,
                metadata: {
                    startChar,
                    endChar,
                    wordCount: chunkWordCount,
                    tokenEstimate: wordsToTokens(chunkWordCount, tokensPerWord)
                }
            });
            chunkIndex++;
        }

        // Advance with overlap
        const advance = (endIdx - wordStartIdx) - overlapWords;
        wordStartIdx += Math.max(advance, Math.floor(maxWordsPerChunk * 0.3));

        if (endIdx >= wordPositions.length) break;
    }

    return chunks;
}

/**
 * يربط الـ chunks ببعض (prev_id, next_id) لتكوين سلسلة مرتبطة.
 */
export function linkChunks(chunkIds: string[]): { id: string; prevId: string | null; nextId: string | null }[] {
    return chunkIds.map((id, i) => ({
        id,
        prevId: i > 0 ? chunkIds[i - 1] : null,
        nextId: i < chunkIds.length - 1 ? chunkIds[i + 1] : null
    }));
}
