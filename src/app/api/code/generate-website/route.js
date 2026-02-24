import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export async function POST(request) {
  try {
    // Check for API key
    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json({ error: "GEMINI_API_KEY is not configured" }, { status: 500 });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const { prompt } = await request.json();

    if (!prompt) {
      return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const fullPrompt = `You are an expert AI web developer. Generate a complete, modern, single-file HTML website based on this request: "${prompt}".

Requirements:
1.  **Single File**: The output must be a single, valid \`<!DOCTYPE html>\` file.
2.  **Tailwind CSS**: Use Tailwind CSS via CDN for styling. Add this to the head: \`<script src="https://cdn.tailwindcss.com"></script>\`.
3.  **Modern Design**: Use a clean, modern aesthetic (good spacing, typography, colors, shadows). Use Tailwind utility classes extensively.
4.  **Responsive**: The layout must be fully responsive (mobile-first).
5.  **Images**: If images are needed, use high-quality placeholders from Unsplash Source (e.g., \`https://images.unsplash.com/photo-...\`) or similar.
6.  **Icons**: If icons are needed, use FontAwesome CDN or SVG icons.
7.  **No Markdown**: Return ONLY the raw HTML code. Do not wrap it in \`\`\`html or markdown blocks. Do not add any conversational text.

Generate the code now.`;

    const result = await model.generateContent(fullPrompt);
    const responseText = result.response.text();

    // Clean up the output just in case the model keeps the markdown blocks
    const html = responseText
      .replace(/^```html/, "")
      .replace(/^```/, "")
      .replace(/```$/, "")
      .trim();

    return NextResponse.json({ html });
  } catch (error) {
    console.error("Website generation error:", error);
    return NextResponse.json(
      {
        error: "Failed to generate website. Please try again.",
        details: error.message,
      },
      { status: 500 }
    );
  }
}
