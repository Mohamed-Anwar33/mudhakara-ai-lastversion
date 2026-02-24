import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const connectionString = Deno.env.get('SUPABASE_DB_URL') || Deno.env.get('APP_SUPABASE_DB_URL');

    if (!connectionString) {
      throw new Error("SUPABASE_DB_URL is missing. Please set it in Edge Function secrets.");
    }

    const sql = postgres(connectionString);

    // Add columns directly
    await sql`
      ALTER TABLE processing_queue
      ADD COLUMN IF NOT EXISTS stage TEXT DEFAULT 'pending_upload',
      ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_error TEXT,
      ADD COLUMN IF NOT EXISTS gemini_file_uri TEXT,
      ADD COLUMN IF NOT EXISTS extraction_cursor INTEGER DEFAULT 0;
    `;

    return new Response(JSON.stringify({ success: true, message: "Columns added successfully" }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    });
  }
});
