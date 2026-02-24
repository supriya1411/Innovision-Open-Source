import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MAX_INPUT_CHARS = 100000;
const MIN_CHAPTER_LENGTH = 200;

export async function chunkContentWithAI(text, fileName) {

    const truncatedText =
        text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `You are a world-class curriculum designer and educational content architect. 
Your goal is to transform raw, extracted text into a "Premium Digital Learning Experience". 

TEXT SOURCE: "${fileName}"
---
${truncatedText}
---

INSTRUCTIONS:
1. **Educational Decomposition**: Break the text into 3-15 logically sequential chapters. Do not just follow the original order if it's confusing; create a logical learning path.
2. **The "Innovision" Style (STRICT MARKDOWN)**:
   - **H2 for Main Sections**: Start each major sub-topic with an H2 (##).
   - **H3 for Concepts**: Use H3 (###) for specific concepts within sections.
   - **Callout Boxes (Using Blockquotes)**: 
     - Use \`> [!NOTE]\` for background context.
     - Use \`> [!TIP]\` for practical applications.
     - Use \`> [!IMPORTANT]\` for critical concepts.
   - **Visual Spacing**: Use ample white space between paragraphs.
   - **Mental Models**: Where applicable, rephrase complex sections into "Mental Models" or analogies.
   - **Key Terms**: Bold (**term**) new or critical vocabulary upon first mention.
   - **Checklists/Lists**: Use bulleted and numbered lists extensively to avoid "walls of text".
3. **Refine, Don't Copy**: You are NOT a copier. You are an editor. Fix grammatical errors in the source, improve the flow, and ensure an engaging, instructional tone throughout.
4. **Learning Objectives**: The "summary" field for each chapter must be written as: "In this chapter, you will learn [point 1], [point 2], and [point 3]."

Return your response as a valid JSON array:
[
  {
    "chapterNumber": 1,
    "title": "Mastery Title: [Topic Name]",
    "summary": "In this chapter, you will learn...",
    "content": "Full, beautifully formatted Markdown content here..."
  }
]

IMPORTANT: NO MARKDOWN WRAPPERS AROUND THE JSON. RETURN PURE JSON.`;

    try {
        const result = await model.generateContent(prompt);
        const response = result.response.text();


        let cleanedResponse = response.trim();
        if (cleanedResponse.startsWith("```")) {
            cleanedResponse = cleanedResponse
                .replace(/^```(?:json)?\s*\n?/, "")
                .replace(/\n?```\s*$/, "");
        }

        const chapters = JSON.parse(cleanedResponse);

        if (!Array.isArray(chapters) || chapters.length === 0) {
            throw new Error("AI returned invalid chapter structure");
        }

        // Validate and clean chapters
        const validChapters = chapters
            .filter(
                (ch) =>
                    ch.content &&
                    ch.content.trim().length >= MIN_CHAPTER_LENGTH &&
                    ch.title
            )
            .map((ch, index) => ({
                chapterNumber: index + 1,
                title: ch.title.trim(),
                summary: ch.summary ? ch.summary.trim() : "",
                content: ch.content.trim(),
                wordCount: ch.content.trim().split(/\s+/).length,
            }));

        if (validChapters.length === 0) {
            throw new Error("No valid chapters generated from AI analysis");
        }

        return validChapters;
    } catch (error) {
        if (error.message.includes("No valid chapters") || error.message.includes("invalid chapter")) {
            throw error;
        }
        console.error("AI chunking failed, using fallback:", error.message);
        return fallbackChunking(text, fileName);
    }
}


function fallbackChunking(text, fileName) {
    const words = text.split(/\s+/);
    const totalWords = words.length;


    const targetChapterSize = 1500;
    const numChapters = Math.max(2, Math.min(15, Math.ceil(totalWords / targetChapterSize)));
    const wordsPerChapter = Math.ceil(totalWords / numChapters);

    const chapters = [];
    for (let i = 0; i < numChapters; i++) {
        const start = i * wordsPerChapter;
        const end = Math.min(start + wordsPerChapter, totalWords);
        const chapterWords = words.slice(start, end);
        const content = chapterWords.join(" ");

        if (content.trim().length < MIN_CHAPTER_LENGTH) continue;

        chapters.push({
            chapterNumber: chapters.length + 1,
            title: `Chapter ${chapters.length + 1}`,
            summary: `Section ${chapters.length + 1} of ${fileName}`,
            content: content.trim(),
            wordCount: chapterWords.length,
        });
    }

    return chapters;
}


export async function generateCourseTitle(fileName, textPreview) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const cleanName = fileName.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ");
    const preview = textPreview.slice(0, 1000);

    const prompt = `Given a document with filename "${cleanName}" and this text preview:
"${preview}"

Generate a concise, professional course title (max 80 characters). 
Return ONLY the title text, nothing else.`;

    try {
        const result = await model.generateContent(prompt);
        const title = result.response.text().trim().replace(/^["']|["']$/g, "");
        return title || cleanName;
    } catch {
        // Fallback to cleaned filename
        return cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
    }
}

export async function generateCourseDescription(textPreview) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const preview = textPreview.slice(0, 2000);

    const prompt = `Based on this text preview from an educational document:
"${preview}"

Write a compelling 2-3 sentence course description. 
Return ONLY the description text, nothing else.`;

    try {
        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch {
        return "AI-generated course from uploaded document content.";
    }
}


