import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth-server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { nanoid } from "nanoid";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { canGenerateCourse } from "@/lib/premium";
import { createNotification } from "@/lib/create-notification";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: {
    temperature: 0.7,
    topP: 0.8,
    topK: 40,
    maxOutputTokens: 8192,
    responseMimeType: "application/json",
  },
  safetySettings: [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
  ],
});

async function updateDatabase(details, id, user, retries = 3, context = {}) {
  const docRef = adminDb.collection("users").doc(user.email).collection("roadmaps").doc(id);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await docRef.set({ ...details, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return true;
    } catch (error) {
      console.error(`DB Attempt ${attempt} failed:`, {
        userId: user.email,
        roadmapId: id,
        attempt,
        maxRetries: retries,
        operation: context.operation || 'updateDatabase',
        prompt: context.prompt,
        error: {
          message: error.message,
          code: error.code,
          stack: error.stack
        }
      });
      if (attempt === retries) return false;
      await new Promise((res) => setTimeout(res, 1000 * attempt));
    }
  }
  return false;
}

function cleanJsonResponse(text) {
  return text
    .replace(/^```json\s?/, "")
    .replace(/^```\s?/, "")
    .replace(/\s?```$/, "")
    .trim();
}

async function generateRoadmap(prompt, id, session, user_prompt) {
  const docRef = adminDb.collection("users").doc(session.user.email).collection("roadmaps").doc(id);

  try {
    const result = await model.generateContent(`
You are an expert curriculum designer. Generate a complete learning roadmap in strict JSON format.

Return ONLY valid JSON (no markdown, no explanations) with this exact structure:
{
  "courseTitle": "string",
  "courseDescription": "string",
  "chapters": [
    {
      "chapterNumber": 1,
      "chapterTitle": "string",
      "chapterDescription": "1 short sentence",
      "learningObjectives": ["Start with action verbs like Understand, Apply, Analyze..."],
      "contentOutline": ["Key topics as bullet points"]
    }
  ]
}

If the topic is not suitable for a structured course, return exactly: {"error": "unsuitable"}

Topic: ${prompt}
    `);

    const response = result.response;
    const rawText = response.text();
    const cleanedText = cleanJsonResponse(rawText);

    let parsed;
    try {
      parsed = JSON.parse(cleanedText);
    } catch (parseError) {
      console.error("JSON Parse failed:", cleanedText);
      throw new Error(`Invalid JSON from Gemini: ${parseError.message}`);
    }

    if (parsed.error === "unsuitable") {
      const dbSuccess = await updateDatabase(
        {
          message: "This topic is not suitable for a structured course.",
          process: "unsuitable",
        },
        id,
        session.user,
        3,
        { operation: 'unsuitable_topic', prompt }
      );

      if (!dbSuccess) {
        console.error("Database update failed for unsuitable topic:", {
          userId: session.user.email,
          roadmapId: id,
          prompt,
          operation: 'unsuitable_topic'
        });
      }
      return;
    }

    const difficulty = user_prompt.difficulty === "in-depth" ? "inDepth" : user_prompt.difficulty;

    await adminDb.collection("users").doc(session.user.email).set(
      {
        email: session.user.email,
        createdAt: FieldValue.serverTimestamp(),
        roadmapLevel: {},
      },
      { merge: true }
    );

    await updateDatabase(
      {
        ...parsed,
        createdAt: Date.now(),
        difficulty,
        process: "completed",
      },
      id,
      session.user,
      3,
      { operation: 'course_completion', prompt }
    );

    // Create notification for completion
    try {
      await createNotification(adminDb, {
        userId: session.user.email,
        title: "Course Ready!",
        body: `Your generated course is ready.`,
        type: "progress",
        link: `/roadmap/${id}`,
      });
    } catch (notifError) {
      console.warn("Failed to create course generation notification:", notifError);
    }

    // Award 10 XP for generating a course
    try {
      const statsRef = adminDb.collection("gamification").doc(session.user.email);
      await adminDb.runTransaction(async (transaction) => {
        const statsDoc = await transaction.get(statsRef);
        const xpGained = 10;
        let stats = statsDoc.exists
          ? statsDoc.data()
          : {
            xp: 0,
            level: 1,
            streak: 1,
            badges: [],
            rank: 0,
            achievements: [],
            lastActive: new Date().toISOString(),
          };

        const newXP = (stats.xp || 0) + xpGained;
        const newLevel = Math.floor(newXP / 500) + 1;

        transaction.set(
          statsRef,
          {
            ...stats,
            xp: newXP,
            level: newLevel,
            lastActive: new Date().toISOString(),
            achievements: [
              ...(stats.achievements || []),
              {
                title: "New Course Generated!",
                description: "You generated a new AI course",
                xp: xpGained,
                timestamp: new Date().toISOString(),
              },
            ],
          },
          { merge: true }
        );
      });
    } catch (xpError) {
      console.error("Failed to award XP for course generation:", xpError);
    }
  } catch (error) {
    console.error("Gemini generation failed:", {
      userId: session.user.email,
      roadmapId: id,
      prompt,
      operation: 'gemini_generation',
      error: {
        message: error.message,
        status: error.status,
        code: error.code,
        stack: error.stack
      }
    });

    let userMessage = "There was an error while generating your roadmap.";
    let detectedCondition = 'unknown';

    if (error.message?.includes("API key") || error.message?.includes("API_KEY")) {
      userMessage = "API key error. Please contact support or try again later.";
      detectedCondition = 'api_key_error';
    } else if (error.message?.includes("SAFETY")) {
      userMessage = "Content was blocked by safety filters. Try simpler wording.";
      detectedCondition = 'safety_filter';
    } else if (error.message?.includes("quota") || error.status === 429) {
      userMessage = "Rate limit reached. Please wait a minute and try again.";
      detectedCondition = 'rate_limit';
    } else if (error.message?.includes("Invalid JSON")) {
      userMessage = "AI returned invalid format. Please try again.";
      detectedCondition = 'invalid_json';
    } else if (error.message?.includes("token") || error.message?.includes("maximum")) {
      userMessage = "Topic too long. Try fewer modules or shorter names.";
      detectedCondition = 'token_limit';
    }

    console.error("Error condition detected:", {
      userId: session.user.email,
      roadmapId: id,
      prompt,
      detectedCondition,
      userMessage
    });

    const dbSuccess = await updateDatabase(
      {
        message: userMessage,
        process: "error",
        errorDetails: error.message,
      },
      id,
      session.user,
      3,
      { operation: 'error_handling', prompt, detectedCondition }
    );

    if (!dbSuccess) {
      console.error("Database update failed during error handling:", {
        userId: session.user.email,
        roadmapId: id,
        prompt,
        operation: 'error_handling',
        detectedCondition,
        originalError: error.message
      });
    }
  }
}

// Removed - now using canGenerateCourse from premium.js

export async function POST(req) {
  try {
    const user_prompt = await req.json();
    const session = await getServerSession();

    if (!session?.user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    if (!user_prompt?.prompt || user_prompt.prompt.trim().length === 0) {
      return NextResponse.json({ message: "Prompt is required" }, { status: 400 });
    }

    if (user_prompt.prompt.length > 1500) {
      return NextResponse.json({ message: "Prompt too long. Maximum 1500 characters." }, { status: 400 });
    }

    // Check if user can generate more courses based on premium status
    const eligibility = await canGenerateCourse(session.user.email);
    if (!eligibility.canGenerate) {
      return NextResponse.json(
        {
          message: eligibility.reason,
          isPremium: eligibility.isPremium,
          courseCount: eligibility.courseCount,
          needsUpgrade: !eligibility.isPremium
        },
        { status: 403 }
      );
    }

    const roadmapId = nanoid(20);

    const dbSuccess = await updateDatabase(
      { process: "pending", createdAt: Date.now() },
      roadmapId,
      session.user,
      3,
      { operation: 'initialize_roadmap', prompt: user_prompt.prompt }
    );

    if (!dbSuccess) {
      console.error("Failed to initialize roadmap:", {
        userId: session.user.email,
        roadmapId,
        prompt: user_prompt.prompt,
        operation: 'initialize_roadmap'
      });
      return NextResponse.json({ message: "Failed to initialize roadmap" }, { status: 500 });
    }

    setTimeout(() => {
      generateRoadmap(user_prompt.prompt, roadmapId, session, user_prompt);
    }, 0);

    return NextResponse.json({ process: "pending", id: roadmapId }, { status: 202 });
  } catch (error) {
    console.error("POST /api/user_prompt error:", error);
    return NextResponse.json({ message: "Internal server error" }, { status: 500 });
  }
}
