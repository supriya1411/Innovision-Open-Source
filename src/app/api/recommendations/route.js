import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { getServerSession } from "@/lib/auth-server";
import OpenAI from "openai";

const openai = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
});

// Helper to parse AI JSON response
function parseJson(response) {
    const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
        try {
            return JSON.parse(jsonMatch[1].trim());
        } catch (e) {
            return null;
        }
    }
    try {
        return JSON.parse(response);
    } catch (e) {
        return null;
    }
}

export async function GET(request) {
    try {
        const session = await getServerSession();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { searchParams } = new URL(request.url);
        const currentQuery = searchParams.get("query");
        const userEmail = session.user.email;

        const userRef = adminDb.collection("users").doc(userEmail);
        const recommendationsRef = userRef.collection("recommendations").doc("state");
        const recSnap = await recommendationsRef.get();

        // 1. Handle Search History and Cleanup
        let searchHistory = [];
        if (currentQuery && currentQuery.trim().length > 2) {
            const userDoc = await userRef.get();
            searchHistory = userDoc.exists ? (userDoc.data().searchHistory || []) : [];

            // Add new query if not already the most recent
            if (searchHistory[0]?.query !== currentQuery) {
                searchHistory.unshift({ query: currentQuery, timestamp: Date.now() });
            }

            // Cleanup: Keep only last 10 queries
            if (searchHistory.length > 10) {
                searchHistory = searchHistory.slice(0, 10);
            }

            await userRef.update({ searchHistory });

            // Invalidate cache for new searches to provide immediate results
            const cachedData = recSnap.exists ? recSnap.data() : null;
            if (cachedData && cachedData.queryUsed !== currentQuery) {
                await recommendationsRef.delete();
            }
        } else {
            const userDoc = await userRef.get();
            searchHistory = userDoc.exists ? (userDoc.data().searchHistory || []) : [];
        }

        const now = Date.now();
        const oneWeek = 7 * 24 * 60 * 60 * 1000;

        if (recSnap.exists) {
            const data = recSnap.data();
            // If cache is fresh AND (no new query OR query matches cache)
            if (now - (data.lastUpdated || 0) < oneWeek && (!currentQuery || data.queryUsed === currentQuery)) {
                return NextResponse.json({ success: true, recommendations: data.recommendations, lastUpdated: data.lastUpdated });
            }
        }

        // Generate new recommendations
        // 1. Get user roadmaps
        const roadmapsSnap = await userRef.collection("roadmaps").get();
        const userRoadmaps = roadmapsSnap.docs.map(doc => ({
            title: doc.data().courseTitle || doc.data().title,
            completed: doc.data().completed || false,
            process: doc.data().process
        }));

        // 2. Get user bookmarks
        const userDoc = await userRef.get();
        const bookmarks = userDoc.exists ? (userDoc.data().bookmarks || []) : [];

        // 3. Get all published courses - be more lenient with status
        const publishedSnap = await adminDb.collection("published_courses").get();
        const publicCourses = publishedSnap.docs.map(doc => ({
            id: doc.id,
            title: doc.data().courseTitle || doc.data().title,
            description: doc.data().description,
            difficulty: doc.data().difficulty,
            tags: doc.data().tags || [],
            status: doc.data().status
        }));

        // 4. Get feedback (to exclude)
        const feedbackSnap = await userRef.collection("recommendationFeedback").get();
        const excludedIds = feedbackSnap.docs.map(doc => doc.id);

        const availableCourses = publicCourses.filter(c => !excludedIds.includes(c.id));

        // 5. Query Gemini with search context
        const prompt = `
        User context:
        Completed/Started Courses: ${JSON.stringify(userRoadmaps)}
        Bookmarks: ${JSON.stringify(bookmarks.map(b => b.courseTitle || b.roadmapTitle))}
        Recent Searches: ${JSON.stringify(searchHistory.map(s => s.query))}
        Current Active Search: "${currentQuery || 'None'}"

        Available Courses in Library:
        ${availableCourses.length > 0 ? JSON.stringify(availableCourses) : "EMPTY LIBRARY"}

        TASK:
        ${availableCourses.length > 0
                ? "Recommend 3-4 courses from the Available Courses. Prioritize matches to Active/Recent searches."
                : "The library is EMPTY. Suggest 4 NEW course topics (titles and short descriptions) the user should generate next based on their history. These should be ADVANCED or COMPLEMENTARY topics."
            }

        Return a JSON array of objects:
        - id: ${availableCourses.length > 0 ? "the course id" : "a slugified title (e.g., 'idea-nextjs-advanced')"}
        - title: the course title
        - description: a short description
        - rationale: why this is recommended
        - isIdea: ${availableCourses.length > 0 ? "false" : "true"}

        Format: \`\`\`json [ { "id": "...", "title": "...", "description": "...", "rationale": "...", "isIdea": ... }, ... ] \`\`\`
        `;

        const aiResponse = await openai.chat.completions.create({
            model: "gemini-2.5-flash",
            messages: [
                { role: "system", content: "You are a smart educational counselor. Recommend specific courses or generate new roadmap ideas based on user history." },
                { role: "user", content: prompt }
            ]
        });

        const recData = parseJson(aiResponse.choices[0].message.content);

        let recommendations = [];
        if (recData && Array.isArray(recData)) {
            recommendations = recData.map(rec => {
                if (rec.isIdea) return rec; // Return ideas as is

                const course = availableCourses.find(c => c.id === rec.id);
                if (!course) return null;
                return {
                    ...course,
                    rationale: rec.rationale,
                    isIdea: false
                };
            }).filter(Boolean);
        }

        // Fallback: If AI failed, just show default categories
        if (recommendations.length === 0) {
            recommendations = [
                { id: "idea-web-dev", title: "Full Stack Web Development", description: "Master both frontend and backend.", rationale: "A natural next step for your growth.", isIdea: true },
                { id: "idea-ai-ml", title: "Artificial Intelligence Essentials", description: "Learn how to build AI-powered apps.", rationale: "Stay ahead in the tech landscape.", isIdea: true }
            ];
        }

        // Save to DB
        await recommendationsRef.set({
            recommendations,
            lastUpdated: now,
            queryUsed: currentQuery || null
        });

        return NextResponse.json({ success: true, recommendations, lastUpdated: now });

    } catch (error) {
        console.error("Recommendations error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

// POST - Handle feedback
export async function POST(request) {
    try {
        const session = await getServerSession();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { courseId, feedbackType } = await request.json(); // feedbackType: "not_interested" or "already_know"
        if (!courseId) {
            return NextResponse.json({ error: "Course ID required" }, { status: 400 });
        }

        const userEmail = session.user.email;
        await adminDb.collection("users").doc(userEmail).collection("recommendationFeedback").doc(courseId).set({
            type: feedbackType,
            timestamp: Date.now()
        });

        // Trigger a refresh (invalidate cache)
        await adminDb.collection("users").doc(userEmail).collection("recommendations").doc("state").delete();

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Feedback error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
