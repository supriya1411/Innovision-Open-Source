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
    jsonStr = jsonStr.replace(/(?<!\\)\n/g, "\\n");
    jsonStr = jsonStr.replace(/(?<!\\)\r/g, "\\r");
    jsonStr = jsonStr.replace(/(?<!\\)\t/g, "\\t");
    jsonStr = jsonStr.replace(/[\x00-\x1F\x7F]/g, (char) => {
      if (char === '\n' || char === '\r' || char === '\t') return '';
      return '';
    });

    return JSON.parse(jsonStr);
  } catch (e) {
    console.error("JSON parse error:", e.message);
    return null;
  }
}

export async function POST(request) {
  try {
    const { title, summary, transcript, videoId, author, thumbnail } = await request.json();

    if (!title || !transcript) {
      return NextResponse.json({ error: "Title and transcript are required" }, { status: 400 });
    }

    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json({ error: "AI service not configured. Please add GEMINI_API_KEY to your environment." }, { status: 500 });
    }
    let session = null;
    let userEmail = "guest";

    try {
      const { getServerSession } = await import("@/lib/auth-server");
      session = await getServerSession();
      if (session?.user?.email) {
        userEmail = session.user.email;
      }
    } catch (authError) {
      console.warn("Auth not available, continuing as guest:", authError.message);
    }
    if (session?.user?.email) {
      try {
        const { canGenerateYouTubeCourse } = await import("@/lib/premium");
        const eligibility = await canGenerateYouTubeCourse(session.user.email);
        if (!eligibility.canGenerate) {
          return NextResponse.json(
            {
              error: eligibility.reason,
              isPremium: eligibility.isPremium,
              count: eligibility.count,
              needsUpgrade: !eligibility.isPremium,
            },
            { status: 403 }
          );
        }
      } catch (premiumError) {
        console.warn("Premium check failed, continuing:", premiumError.message);
      }
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `Create a comprehensive learning course from this YouTube video.

Video Title: ${title}
Video Author: ${author || 'Unknown'}
Transcript (first 10000 chars): ${transcript.substring(0, 10000)}

Generate a course with 5-6 chapters. Return ONLY valid JSON with this structure (no markdown, no code blocks):

{
  "title": "Course Title",
  "description": "Course description in 2-3 sentences",
  "difficulty": "beginner",
  "estimatedDuration": "2-3 hours",
  "learningObjectives": ["Objective 1", "Objective 2"],
  "prerequisites": ["Prerequisite 1"],
  "chapters": [
    {
      "number": 1,
      "title": "Chapter Title",
      "description": "Chapter description",
      "duration": "20 minutes",
      "content": {
        "introduction": "Introduction paragraph",
        "mainContent": "Main content with explanations. Use simple text without special characters.",
        "keyPoints": ["Point 1", "Point 2", "Point 3"],
        "examples": ["Example 1"],
        "summary": "Chapter summary"
      },
      "exercises": [
        {
          "type": "practice",
          "title": "Exercise Title",
          "description": "Exercise description",
          "difficulty": "easy",
          "estimatedTime": "10 minutes"
        }
      ],
      "quiz": {
        "title": "Chapter Quiz",
        "questions": [
          {
            "question": "Question text?",
            "options": ["Option A", "Option B", "Option C", "Option D"],
            "correctAnswer": 0,
            "explanation": "Explanation"
          }
        ]
      }
    }
  ],
  "finalProject": {
    "title": "Capstone Project",
    "description": "Project description",
    "requirements": ["Requirement 1", "Requirement 2"],
    "deliverables": ["Deliverable 1"],
    "estimatedTime": "1-2 hours"
  }
}

IMPORTANT RULES:
1. Return ONLY valid JSON - no markdown, no code blocks
2. Do NOT use newlines or special characters inside string values
3. Keep all text simple and clean
4. Make sure all brackets and quotes are properly closed
5. Generate exactly 5-6 chapters`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    console.log("AI Response length:", text.length);

    const courseData = safeJsonParse(text);

    if (!courseData) {
      console.error("Failed to parse AI response. First 500 chars:", text.substring(0, 500));
      return NextResponse.json({
        error: "Failed to generate course structure. The AI returned an invalid response. Please try again."
      }, { status: 500 });
    }
    if (courseData.chapters && Array.isArray(courseData.chapters)) {
      courseData.chapters = courseData.chapters.map((ch, index) => ({
        ...ch,
        number: ch.number || index + 1
      }));
    } else {
      courseData.chapters = [];
    }
    const courseId = `course-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const enhancedCourseData = {
      ...courseData,
      source: "youtube",
      videoId: videoId || "",
      videoTitle: title,
      videoAuthor: author || "Unknown",
      thumbnail: thumbnail || "",
      videoUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      process: "completed",
      progress: 0,
      completedChapters: [],
      quizScores: {},
      exerciseProgress: {},
      enrolledAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString()
    };
    let savedToDb = false;
    let finalCourseId = courseId;

    try {
      const { getAdminDb } = await import("@/lib/firebase-admin");
      const adminDb = getAdminDb();

      if (adminDb && session?.user?.email) {
        const docRef = await adminDb
          .collection("users")
          .doc(session.user.email)
          .collection("youtube-courses")
          .add(enhancedCourseData);

        finalCourseId = docRef.id;
        enhancedCourseData.id = finalCourseId;
        savedToDb = true;
        console.log("Course saved to Firebase with ID:", docRef.id);


        try {
          const { createNotification } = await import("@/lib/create-notification");
          await createNotification(adminDb, {
            userId: session.user.email,
            title: "New Course Ready!",
            body: `Your YouTube course "${courseData.title || title}" has been created and is ready to learn.`,
            type: "progress",
            link: `/youtube-course/${finalCourseId}`,
          });
        } catch (notifErr) {
          console.warn("Notification creation failed:", notifErr.message);
        }
      }
    } catch (dbError) {
      console.warn("Could not save to Firebase:", dbError.message);
    }
    try {
      const { storeCourse } = await import("@/lib/course-store");
      storeCourse(finalCourseId, enhancedCourseData);
      console.log("Course stored in temp store with ID:", finalCourseId);
    } catch (storeError) {
      console.warn("Could not store in temp store:", storeError.message);
    }

    return NextResponse.json({
      success: true,
      id: finalCourseId,
      ...enhancedCourseData,
      savedToDb
    });
  } catch (error) {
    console.error("Course generation error:", error);
    return NextResponse.json({
      error: error.message || "An unexpected error occurred"
    }, { status: 500 });
  }
}