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

    const { courseId, courseTitle, courseDescription, chapters, difficulty, topics } = await request.json();

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `Create a comprehensive learning roadmap for this course.

Course Title: ${courseTitle}
Course Description: ${courseDescription}
Difficulty: ${difficulty}
Topics Covered: ${JSON.stringify(topics)}
Chapters: ${JSON.stringify(chapters.map(c => ({ number: c.number, title: c.title, keyConcepts: c.keyConcepts || c.content?.keyPoints || [] })))}

Generate a detailed learning roadmap that helps students navigate this course and plan their learning journey.

Return as JSON:
{
  "roadmap": {
    "title": "Learning Roadmap for ${courseTitle}",
    "description": "Overview of the learning journey",
    "estimatedTotalTime": "X hours/days",
    "learningPath": [
      {
        "phase": 1,
        "title": "Foundation Phase",
        "description": "Building the basics",
        "chapters": [1, 2],
        "objectives": ["Objective 1", "Objective 2"],
        "milestones": ["Milestone 1", "Milestone 2"],
        "estimatedTime": "X hours"
      },
      {
        "phase": 2,
        "title": "Core Learning Phase",
        "description": "Deep dive into main concepts",
        "chapters": [3, 4, 5],
        "objectives": ["Objective 1", "Objective 2"],
        "milestones": ["Milestone 1", "Milestone 2"],
        "estimatedTime": "X hours"
      },
      {
        "phase": 3,
        "title": "Advanced Phase",
        "description": "Mastering advanced concepts",
        "chapters": [6, 7],
        "objectives": ["Objective 1", "Objective 2"],
        "milestones": ["Milestone 1", "Milestone 2"],
        "estimatedTime": "X hours"
      },
      {
        "phase": 4,
        "title": "Mastery Phase",
        "description": "Apply and consolidate knowledge",
        "chapters": [8],
        "objectives": ["Complete final project", "Pass final assessment"],
        "milestones": ["Course completion"],
        "estimatedTime": "X hours"
      }
    ],
    "weeklySchedule": {
      "week1": {
        "focus": "Week 1 focus area",
        "chapters": [1, 2],
        "activities": ["Activity 1", "Activity 2"],
        "goals": ["Goal 1", "Goal 2"]
      },
      "week2": {
        "focus": "Week 2 focus area",
        "chapters": [3, 4],
        "activities": ["Activity 1", "Activity 2"],
        "goals": ["Goal 1", "Goal 2"]
      }
    },
    "prerequisites": [
      {
        "skill": "Required skill",
        "importance": "essential/recommended/optional",
        "resources": ["Resource to learn this skill"]
      }
    ],
    "learningOutcomes": [
      "By the end of this course, you will be able to...",
      "Outcome 2",
      "Outcome 3"
    ],
    "skillProgression": {
      "beginner": ["Skill 1", "Skill 2"],
      "intermediate": ["Skill 3", "Skill 4"],
      "advanced": ["Skill 5", "Skill 6"]
    },
    "checkpoints": [
      {
        "afterChapter": 2,
        "assessment": "Self-assessment questions",
        "reviewTopics": ["Topic to review"],
        "goNoGo": "Criteria to proceed"
      }
    ],
    "recommendedPace": {
      "casual": "X hours/week - Description",
      "moderate": "X hours/week - Description",
      "intensive": "X hours/week - Description"
    },
    "nextSteps": {
      "relatedCourses": ["Course 1", "Course 2"],
      "advancedTopics": ["Advanced topic 1", "Advanced topic 2"],
      "careerPaths": ["Career path 1", "Career path 2"],
      "certifications": ["Related certification 1"]
    },
    "resources": {
      "required": ["Required resource 1"],
      "recommended": ["Recommended resource 1"],
      "community": ["Community/forum links"]
    }
  }
}

Make the roadmap practical, achievable, and motivating. Include realistic time estimates.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const roadmapData = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

    if (!roadmapData) {
      throw new Error("Failed to generate roadmap");
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
              roadmap: roadmapData.roadmap,
              updatedAt: new Date().toISOString()
            });
        }
      } catch (dbError) {
        console.warn("Could not save roadmap to Firebase:", dbError.message);
      }
    }

    return NextResponse.json({
      success: true,
      roadmap: roadmapData.roadmap
    });
  } catch (error) {
    console.error("Roadmap generation error:", error);
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

    if (!courseId) {
      return NextResponse.json({ error: "Course ID required" }, { status: 400 });
    }

    const adminDb = getAdminDb();
    if (!adminDb) {
      return NextResponse.json({
        error: "Database not configured",
        _warning: "Roadmap functionality requires Firebase configuration"
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
    const roadmap = courseData.roadmap;
    const completedChapters = courseData.completedChapters || [];
    const quizScores = courseData.quizScores || {};
    const exerciseProgress = courseData.exerciseProgress || {};
    let phaseProgress = [];
    if (roadmap?.learningPath) {
      phaseProgress = roadmap.learningPath.map(phase => {
        const phaseChapters = phase.chapters || [];
        const completedInPhase = phaseChapters.filter(ch => completedChapters.includes(ch));
        const progress = phaseChapters.length > 0
          ? Math.round((completedInPhase.length / phaseChapters.length) * 100)
          : 0;

        return {
          phase: phase.phase,
          title: phase.title,
          progress,
          completedChapters: completedInPhase,
          totalChapters: phaseChapters.length
        };
      });
    }
    const totalChapters = courseData.chapters?.length || 0;
    const overallProgress = totalChapters > 0
      ? Math.min(100, Math.round((completedChapters.length / totalChapters) * 100))
      : 0;
    let currentPhase = null;
    if (roadmap?.learningPath) {
      for (const phase of roadmap.learningPath) {
        const phaseChapters = phase.chapters || [];
        const hasUncompleted = phaseChapters.some(ch => !completedChapters.includes(ch));
        if (hasUncompleted) {
          currentPhase = phase;
          break;
        }
      }
    }

    return NextResponse.json({
      success: true,
      roadmap,
      progress: {
        overall: overallProgress,
        completedChapters,
        totalChapters,
        phaseProgress,
        currentPhase,
        quizScores,
        exerciseProgress
      }
    });
  } catch (error) {
    console.error("Roadmap fetch error:", error);
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

    const { courseId, chapterNumber, completed } = await request.json();
    const adminDb = getAdminDb();

    if (!adminDb) {
      return NextResponse.json({
        error: "Database not configured",
        _warning: "Progress tracking requires Firebase configuration"
      }, { status: 503 });
    }

    const courseRef = adminDb
      .collection("users")
      .doc(session.user.email)
      .collection("youtube-courses")
      .doc(courseId);

    const courseDoc = await courseRef.get();

    if (!courseDoc.exists) {
      return NextResponse.json({ error: "Course not found" }, { status: 404 });
    }

    const courseData = courseDoc.data();
    let completedChapters = courseData.completedChapters || [];

    if (completed && !completedChapters.includes(chapterNumber)) {
      completedChapters.push(chapterNumber);
      completedChapters.sort((a, b) => a - b);
    } else if (!completed) {
      completedChapters = completedChapters.filter(ch => ch !== chapterNumber);
    }
    const totalChapters = courseData.chapters?.length || 0;
    const progress = totalChapters > 0
      ? Math.min(100, Math.round((completedChapters.length / totalChapters) * 100))
      : 0;

    const currentProgress = courseData.progress || 0;

    await courseRef.update({
      completedChapters,
      progress,
      lastAccessedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    if (completed) {
      await awardChapterXP(session.user.email, 10, chapterNumber);
    }

    if (progress === 100 && currentProgress < 100) {
      try {
        const { sendCourseCompletionEmail } = await import("@/lib/brevo");
        await sendCourseCompletionEmail(
          session.user.email,
          session.user.name || session.user.email.split('@')[0],
          courseData.title || "Your YouTube Course"
        );
      } catch (emailError) {
        console.error("Failed to send completion email:", emailError);
      }
    }

    return NextResponse.json({
      success: true,
      progress,
      completedChapters
    });
  } catch (error) {
    console.error("Progress update error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function awardChapterXP(userEmail, xpAmount, chapterNumber) {
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
              title: `Completed Chapter ${chapterNumber}!`,
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
    console.error("Failed to award chapter XP:", xpError);
  }
}