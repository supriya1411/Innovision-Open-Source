import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MODELS = [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
];

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGemini(prompt, modelIndex = 0, attempt = 0) {
    const model = MODELS[modelIndex];
    if (!model) {
        throw new Error("All Gemini models are rate-limited. Please try again in a minute.");
    }

    const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 1024,
            },
        }),
    });

    if (res.status === 429) {
        if (attempt < MAX_RETRIES) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt);
            console.warn(`Rate limited on ${model}, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
            await sleep(delay);
            return callGemini(prompt, modelIndex, attempt + 1);
        }
        console.warn(`Rate limited on ${model} after ${MAX_RETRIES} retries, trying next model...`);
        return callGemini(prompt, modelIndex + 1, 0);
    }

    const data = await res.json();

    if (!res.ok) {
        throw new Error(data?.error?.message || `Gemini API error (${res.status})`);
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
        throw new Error("Empty response from Gemini.");
    }

    return text;
}

export async function POST(req) {
    try {
        if (!GEMINI_API_KEY) {
            return NextResponse.json(
                { error: "AI is not configured. Please set GEMINI_API_KEY." },
                { status: 503 }
            );
        }

        const body = await req.json();
        const { message, courseId, chapterId, history } = body;

        if (!message) {
            return NextResponse.json(
                { error: "Message is required." },
                { status: 400 }
            );
        }

        let contextText = "";

        if (courseId) {
            try {
                const db = getAdminDb();
                if (db) {
                    const courseRef = db.collection("ingested_courses").doc(courseId);
                    const courseSnap = await courseRef.get();

                    if (courseSnap.exists) {
                        const courseData = courseSnap.data();

                        if (chapterId) {
                            const chapterSnap = await courseRef
                                .collection("chapters")
                                .doc(chapterId)
                                .get();

                            if (chapterSnap.exists) {
                                const chapterData = chapterSnap.data();
                                contextText = `Course Title: ${courseData.title}\nCourse Description: ${courseData.description || ""}\n\nCurrent Chapter: ${chapterData.title}\nChapter Summary: ${chapterData.summary || ""}\n\nChapter Content:\n${(chapterData.content || "").slice(0, 12000)}`;
                            }
                        }

                        if (!contextText) {
                            const chaptersSnap = await courseRef
                                .collection("chapters")
                                .orderBy("order", "asc")
                                .get();

                            const chapterSummaries = chaptersSnap.docs
                                .map((doc) => {
                                    const d = doc.data();
                                    return `Ch ${d.chapterNumber}: ${d.title} - ${d.summary || "No summary"}`;
                                })
                                .join("\n");

                            contextText = `Course Title: ${courseData.title}\nCourse Description: ${courseData.description || ""}\n\nChapters:\n${chapterSummaries}`;
                        }
                    }
                }
            } catch (dbError) {
                console.warn("Could not fetch course context:", dbError.message);

            }
        }

        const conversationHistory = (history || [])
            .slice(-6)
            .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.text}`)
            .join("\n");

        // Build the system prompt based on whether we have course context
        let systemPrompt;
        if (contextText) {
            systemPrompt = `You are a knowledgeable and helpful AI assistant with expertise in every subject. You MUST answer every question the user asks — no matter the topic. NEVER say "this is not covered in the course content" or "I can only answer based on the course" or anything similar. You have full general knowledge and should use it freely.

Below is some course content the user is currently studying. If their question relates to it, incorporate it into your answer. If their question is about something else entirely, answer it fully using your general knowledge. ALWAYS provide a helpful, complete answer.

Use concise markdown formatting. Be thorough but clear.

--- COURSE CONTENT (optional reference) ---
${contextText}
--- END ---`;
        } else {
            systemPrompt = `You are a knowledgeable and helpful AI assistant with expertise in every subject. Answer any question the user asks — no matter the topic. Provide accurate, detailed, and well-structured responses. NEVER refuse to answer a question.
Use concise markdown formatting. Be thorough but clear.`;
        }

        const fullPrompt = `${systemPrompt}

${conversationHistory ? `Chat history:\n${conversationHistory}\n` : ""}
User's question: ${message}`;

        const reply = await callGemini(fullPrompt);

        return NextResponse.json({ reply });
    } catch (error) {
        console.error("Chat API Error:", error.message);
        return NextResponse.json(
            { error: error.message || "Failed to generate response." },
            { status: 500 }
        );
    }
}
