import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getAdminDb } from "@/lib/firebase-admin";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
export async function POST(request) {
  try {
    const { getServerSession } = await import("@/lib/auth-server");
    const session = await getServerSession();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { courseId, chapterNumber, chapterContent, chapterTitle, difficulty = "intermediate" } = await request.json();

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `Generate practical exercises for this chapter of an educational course.

Chapter Title: ${chapterTitle}
Chapter Number: ${chapterNumber}
Chapter Content: ${chapterContent}
Difficulty Level: ${difficulty}

Create a variety of exercises that help students practice and apply what they learned.

Return as JSON:
{
  "exercises": [
    {
      "id": "ex1",
      "type": "practice",
      "title": "Exercise title",
      "description": "Detailed description of what to do",
      "instructions": ["Step 1", "Step 2", "Step 3"],
      "difficulty": "easy/medium/hard",
      "estimatedTime": "10 minutes",
      "skills": ["skill1", "skill2"],
      "hints": ["Hint 1 if stuck", "Hint 2 if stuck"],
      "solution": "Expected solution or approach",
      "rubric": {
        "criteria1": "Description of what earns points",
        "criteria2": "Another criteria"
      }
    },
    {
      "id": "ex2",
      "type": "coding",
      "title": "Coding exercise",
      "description": "Write code to accomplish X",
      "starterCode": "// Start coding here\n",
      "testCases": [
        {"input": "test input", "expectedOutput": "expected output"}
      ],
      "difficulty": "medium",
      "estimatedTime": "20 minutes"
    },
    {
      "id": "ex3",
      "type": "reflection",
      "title": "Reflection exercise",
      "description": "Think about and answer these questions",
      "questions": [
        "Question 1 to reflect on",
        "Question 2 to reflect on"
      ],
      "difficulty": "easy",
      "estimatedTime": "15 minutes"
    },
    {
      "id": "ex4",
      "type": "project",
      "title": "Mini-project",
      "description": "Build something that demonstrates understanding",
      "requirements": ["Requirement 1", "Requirement 2"],
      "deliverables": ["What to submit"],
      "difficulty": "hard",
      "estimatedTime": "45 minutes"
    }
  ],
  "answerKey": {
    "ex1": {
      "sampleAnswer": "Sample solution",
      "gradingNotes": "What to look for in student answers"
    }
  }
}

Generate 4-6 exercises with a mix of types. Make them practical and educational.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const exercisesData = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

    if (!exercisesData) {
      throw new Error("Failed to generate exercises");
    }
    if (courseId) {
      try {
        const adminDb = getAdminDb();
        if (adminDb) {
          await adminDb
            .collection("users")
            .doc(session.user.email)
            .collection("youtube-courses")
            .doc(courseId)
            .update({
              [`chapters.${chapterNumber - 1}.exercises`]: exercisesData.exercises,
              [`chapters.${chapterNumber - 1}.answerKey`]: exercisesData.answerKey,
              updatedAt: new Date().toISOString()
            });
        }
      } catch (dbError) {
        console.warn("Could not save exercises to Firebase:", dbError.message);
      }
    }

    return NextResponse.json({
      success: true,
      ...exercisesData
    });
  } catch (error) {
    console.error("Exercise generation error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const { getServerSession } = await import("@/lib/auth-server");
    const session = await getServerSession();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { courseId, chapterNumber, exerciseId, solution, notes } = await request.json();
    const adminDb = getAdminDb();
    const submissionData = {
      exerciseId,
      solution,
      notes,
      submittedAt: new Date().toISOString(),
      status: "completed"
    };

    if (adminDb) {
      try {
        await adminDb
          .collection("users")
          .doc(session.user.email)
          .collection("youtube-courses")
          .doc(courseId)
          .update({
            [`exerciseProgress.chapter${chapterNumber}.${exerciseId}`]: submissionData,
            updatedAt: new Date().toISOString()
          });
        await awardExerciseXP(session.user.email, 5, chapterNumber, exerciseId);
      } catch (dbError) {
        console.warn("Could not save exercise to Firebase:", dbError.message);
      }
    }

    return NextResponse.json({
      success: true,
      message: "Exercise submitted successfully",
      submission: submissionData
    });
  } catch (error) {
    console.error("Exercise submission error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
export async function GET(request) {
  try {
    const { getServerSession } = await import("@/lib/auth-server");
    const session = await getServerSession();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const courseId = searchParams.get('courseId');
    const chapterNumber = searchParams.get('chapterNumber');

    if (!courseId) {
      return NextResponse.json({ error: "Course ID required" }, { status: 400 });
    }

    const adminDb = getAdminDb();
    if (!adminDb) {
      return NextResponse.json({
        success: true,
        progress: {}
      });
    }

    const courseDoc = await adminDb
      .collection("users")
      .doc(session.user.email)
      .collection("youtube-courses")
      .doc(courseId)
      .get();

    if (!courseDoc.exists) {
      return NextResponse.json({ error: "Course not found" }, { status: 404 });
    }

    const courseData = courseDoc.data();

    if (chapterNumber) {
      const chapterProgress = courseData.exerciseProgress?.[`chapter${chapterNumber}`] || {};
      return NextResponse.json({
        success: true,
        progress: chapterProgress
      });
    }

    return NextResponse.json({
      success: true,
      progress: courseData.exerciseProgress || {}
    });
  } catch (error) {
    console.error("Exercise progress fetch error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function awardExerciseXP(userEmail, xpAmount, chapterNumber, exerciseId) {
  try {
    const adminDb = getAdminDb();
    if (!adminDb) {
      console.warn("Firebase not configured, skipping XP award");
      return;
    }

    const statsRef = adminDb.collection("gamification").doc(userEmail);
    await adminDb.runTransaction(async (transaction) => {
      const statsDoc = await transaction.get(statsRef);
      let stats = statsDoc.exists
        ? statsDoc.data()
        : {
          xp: 0,
          level: 1,
          streak: 1,
          badges: [],
          achievements: [],
          lastActive: new Date().toISOString(),
        };

      const newXP = (stats.xp || 0) + xpAmount;
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
              title: `Completed Exercise!`,
              description: `Chapter ${chapterNumber} - Exercise ${exerciseId}`,
              xp: xpAmount,
              timestamp: new Date().toISOString(),
            },
          ],
        },
        { merge: true }
      );
    });
  } catch (xpError) {
    console.error("Failed to award exercise XP:", xpError);
  }
}