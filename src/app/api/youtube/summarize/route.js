import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
function safeJsonParse(text) {
  let cleaned = text;
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let jsonStr = jsonMatch[0];
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.log("Initial parse failed, attempting to fix JSON...");
  }
  try {
    jsonStr = jsonStr.replace(/(?<!\\)\n/g, " ");
    jsonStr = jsonStr.replace(/(?<!\\)\r/g, " ");
    jsonStr = jsonStr.replace(/(?<!\\)\t/g, " ");
    jsonStr = jsonStr.replace(/[\x00-\x1F\x7F]/g, '');

    return JSON.parse(jsonStr);
  } catch (e) {
    console.error("JSON parse error:", e.message);
    return null;
  }
}

export async function POST(request) {
  try {
    const { title, transcript, timestampedTranscript, duration } = await request.json();

    if (!transcript) {
      return NextResponse.json({ error: "Transcript is required" }, { status: 400 });
    }

    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json({ error: "AI service not configured" }, { status: 500 });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `Analyze this YouTube video transcript and create a chapter-wise summary.

Video Title: ${title}
Transcript: ${transcript.substring(0, 8000)}

Return ONLY valid JSON (no markdown, no code blocks) with this structure:
{
  "overview": "Brief overview of the video content",
  "targetAudience": "Who would benefit from this content",
  "prerequisites": ["Prerequisite 1"],
  "chapters": [
    {
      "number": 1,
      "title": "Chapter Title",
      "summary": "Brief summary of the chapter",
      "keyConcepts": ["concept1", "concept2"],
      "estimatedTimestamp": "0:00",
      "duration": "5 minutes"
    }
  ],
  "mainTakeaways": ["Takeaway 1", "Takeaway 2"],
  "difficulty": "beginner",
  "topics": ["topic1", "topic2"]
}

Rules:
1. Return ONLY valid JSON
2. No newlines or special characters in strings
3. Generate 4-6 chapters`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const summaryData = safeJsonParse(text);

    if (!summaryData) {
      console.error("Failed to parse summary. First 300 chars:", text.substring(0, 300));
      return NextResponse.json({
        error: "Failed to generate summary",
        overview: "Could not generate summary",
        chapters: []
      });
    }

    if (!summaryData.chapters || !Array.isArray(summaryData.chapters)) {
      summaryData.chapters = [];
    }
    summaryData.chapters = summaryData.chapters.map((ch, index) => ({
      ...ch,
      number: ch.number || index + 1
    }));

    return NextResponse.json({
      success: true,
      ...summaryData
    });
  } catch (error) {
    console.error("Summarize API error:", error);
    return NextResponse.json({
      error: error.message || "Failed to generate summary",
      overview: "Unable to generate summary",
      chapters: []
    }, { status: 500 });
  }
}