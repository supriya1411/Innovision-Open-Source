
import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = process.env.GEMINI_API_KEY
    ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    : null;

export async function POST(req) {
    console.log("AI Generation Request Received");

    try {
        if (!genAI) {
            return NextResponse.json(
                { error: "AI is not configured. Please set GEMINI_API_KEY in your environment." },
                { status: 503 }
            );
        }

        const body = await req.json();
        const type = body?.type;
        const content = typeof body?.content === "string" ? body.content : String(body?.content ?? "").trim();
        console.log(`Request Type: ${type}`);

        if (!content) {
            return NextResponse.json(
                { error: "Content is required" },
                { status: 400 }
            );
        }

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        let prompt = "";
        let jsonMode = false;

        switch (type) {
            case "summary":
                prompt = `You are an expert tutor. Summarize the following educational content in a clear, concise paragraph (max 150 words). Focus on the main ideas.
                
                Content:
                "${content.slice(0, 10000)}"`;
                break;

            case "tips":
                prompt = `Identify 3-5 key takeaways or important tips from the following content. Format as a simple list.
                
                Content:
                "${content.slice(0, 10000)}"`;
                break;

            case "quiz":
                jsonMode = true;
                prompt = `Generate a short quiz (3-5 questions) based on the following content to test understanding.
                
                Return a JSON array with this structure:
                [
                  {
                    "question": "Question text here?",
                    "options": ["Option A", "Option B", "Option C", "Option D"],
                    "correctAnswer": 0, // Index of the correct option (0-3)
                    "explanation": "Brief explanation of why this is correct."
                  }
                ]
                
                IMPORTANT: Return ONLY the JSON array. available options must be 4.
                
                Content:
                "${content.slice(0, 10000)}"`;
                break;

            default:
                return NextResponse.json(
                    { error: "Invalid generation type" },
                    { status: 400 }
                );
        }

        console.log(`Sending prompt to Gemini...`);
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        console.log("Gemini Response Received length:", text.length);

        let data = text;

        if (jsonMode) {
            try {
                let cleanText = text.trim();
                // Improved regex to handle markdown code blocks more robustly
                if (cleanText.includes("```")) {
                    cleanText = cleanText.replace(/```(?:json)?/g, "").trim();
                }
                data = JSON.parse(cleanText);
            } catch (e) {
                console.error("JSON parse error:", e);
                console.log("Raw text was:", text);
                return NextResponse.json(
                    { error: "Failed to generate valid JSON format", raw: text },
                    { status: 500 }
                );
            }
        }

        return NextResponse.json({ result: data });

    } catch (error) {
        console.error("AI Generation Error Detailed:", error);
        return NextResponse.json(
            { error: "Failed to generate content", details: error.message },
            { status: 500 }
        );
    }
}
