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

    const prompt = `Generate a comprehensive quiz for this chapter of an educational course.

Chapter Title: ${chapterTitle}
Chapter Number: ${chapterNumber}
Chapter Content: ${chapterContent}
Difficulty Level: ${difficulty}

Create a quiz that tests understanding of the key concepts. Include different types of questions.

Return as JSON:
{
  "title": "Chapter ${chapterNumber} Quiz: ${chapterTitle}",
  "description": "Test your understanding of ${chapterTitle}",
  "passingScore": 70,
  "timeLimit": "10 minutes",
  "questions": [
    {
      "id": "q1",
      "type": "multiple-choice",
      "question": "Clear question text?",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswer": 0,
      "explanation": "Detailed explanation of why this is correct",
      "difficulty": "easy/medium/hard",
      "concept": "The concept being tested"
    },
    {
      "id": "q2",
      "type": "true-false",
      "question": "Statement to evaluate",
      "options": ["True", "False"],
      "correctAnswer": 0,
      "explanation": "Explanation",
      "difficulty": "easy",
      "concept": "Concept being tested"
    },
    {
      "id": "q3",
      "type": "fill-blank",
      "question": "Complete the sentence: The ___ is used for ___.",
      "correctAnswer": "expected answer",
      "hints": ["Hint 1", "Hint 2"],
      "explanation": "Explanation",
      "difficulty": "medium",
      "concept": "Concept being tested"
    }
  ],
  "totalPoints": 100,
  "gradingRules": {
    "multiple-choice": 10,
    "true-false": 5,
    "fill-blank": 15
  }
}

Generate 8-10 questions with a mix of types. Ensure questions are educational and test real understanding.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const quizData = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

    if (!quizData) {
      throw new Error("Failed to generate quiz");
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
              [`chapters.${chapterNumber - 1}.quiz`]: quizData,
              updatedAt: new Date().toISOString()
            });
        }
      } catch (dbError) {
        console.warn("Could not save quiz to Firebase:", dbError.message);
      }
    }

    return NextResponse.json({
      success: true,
      quiz: quizData
    });
  } catch (error) {
    console.error("Quiz generation error:", error);
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

    const { courseId, chapterNumber, answers } = await request.json();
    const adminDb = getAdminDb();

    if (!adminDb) {
      return NextResponse.json({
        error: "Database not configured",
        _warning: "Quiz functionality requires Firebase configuration"
      }, { status: 503 });
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
    const chapter = courseData.chapters?.[chapterNumber - 1];
    const quiz = chapter?.quiz;

    if (!quiz) {
      return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
    }
    let correctCount = 0;
    const results = quiz.questions.map((question, index) => {
      const userAnswer = answers[index];
      const isCorrect = userAnswer === question.correctAnswer;
      if (isCorrect) correctCount++;

      return {
        questionId: question.id,
        question: question.question,
        userAnswer,
        correctAnswer: question.correctAnswer,
        isCorrect,
        explanation: question.explanation
      };
    });

    const score = Math.round((correctCount / quiz.questions.length) * 100);
    const passed = score >= quiz.passingScore;
    try {
      await adminDb
        .collection("users")
        .doc(session.user.email)
        .collection("youtube-courses")
        .doc(courseId)
        .update({
          [`quizScores.chapter${chapterNumber}`]: {
            score,
            passed,
            completedAt: new Date().toISOString(),
            results
          },
          updatedAt: new Date().toISOString()
        });
      if (passed) {
        const xpEarned = Math.round(score / 10);
        await awardQuizXP(session.user.email, xpEarned, chapterNumber);
      }
    } catch (saveError) {
      console.warn("Could not save quiz results to Firebase:", saveError.message);
    }

    return NextResponse.json({
      success: true,
      score,
      passed,
      results,
      correctCount,
      totalQuestions: quiz.questions.length
    });
  } catch (error) {
    console.error("Quiz submission error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function awardQuizXP(userEmail, xpAmount, chapterNumber) {
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
              title: `Passed Chapter ${chapterNumber} Quiz!`,
              description: `Earned ${xpAmount} XP`,
              xp: xpAmount,
              timestamp: new Date().toISOString(),
            },
          ],
        },
        { merge: true }
      );
    });
  } catch (xpError) {
    console.error("Failed to award quiz XP:", xpError);
  }
}