import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET /api/profile - Get current user's profile
export async function GET() {
  try {
    const supabase = await createClient();

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from("user_profiles")
      .select("*")
      .eq("user_id", user.id)
      .single();

    return NextResponse.json(profile ?? { user_id: user.id, nickname: null, email: user.email });
  } catch (error) {
    console.error("GET /api/profile error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PUT /api/profile - Update current user's nickname
export async function PUT(request: Request) {
  try {
    const supabase = await createClient();

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { nickname } = await request.json();

    if (nickname !== null && nickname !== undefined) {
      const trimmed = String(nickname).trim();
      if (trimmed.length > 50) {
        return NextResponse.json({ error: "Biệt danh không được dài hơn 50 ký tự" }, { status: 400 });
      }
    }

    const { data, error } = await supabase
      .from("user_profiles")
      .upsert(
        { user_id: user.id, email: user.email!, nickname: nickname?.trim() || null },
        { onConflict: "user_id" }
      )
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("PUT /api/profile error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
