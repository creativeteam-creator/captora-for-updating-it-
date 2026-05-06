/**
 * Hand-written types for the Captora Supabase schema. Mirrors
 * `supabase/migrations/001_init.sql` — keep in sync.
 *
 * Once the schema stabilises, swap this for the auto-generated output of:
 *     npx supabase gen types typescript --project-id <id> > types.ts
 */

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string | null;
          display_name: string | null;
          avatar_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email?: string | null;
          display_name?: string | null;
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["profiles"]["Insert"]>;
      };
      user_fonts: {
        Row: {
          id: string;
          user_id: string;
          family: string;
          storage_path: string;
          format: "ttf" | "otf" | "woff" | "woff2";
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          family: string;
          storage_path: string;
          format: "ttf" | "otf" | "woff" | "woff2";
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["user_fonts"]["Insert"]>;
      };
      projects: {
        Row: {
          id: string;
          user_id: string;
          title: string;

          // Source media
          source_path: string | null;
          source_ext: string | null;
          source_thumbnail: string | null;
          media_kind: "video" | "audio";

          // Language settings
          spoken_language: string;
          spoken_language_label: string;
          writing_script: "native" | "roman";
          writing_script_label: string;
          translate_to_english: boolean;

          // Transcription
          transcribe_provider: string | null;
          transcript_words: WhisperWordRow[];
          transcript_text: string | null;
          duration_sec: number;

          // Style
          style_id: string;
          style_overrides: Record<string, unknown>;

          // Render
          render_status: "idle" | "rendering" | "rendered" | "failed";
          render_url: string | null;
          rendered_at: string | null;

          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          title: string;
          source_path?: string | null;
          source_ext?: string | null;
          source_thumbnail?: string | null;
          media_kind?: "video" | "audio";
          spoken_language: string;
          spoken_language_label: string;
          writing_script?: "native" | "roman";
          writing_script_label: string;
          translate_to_english?: boolean;
          transcribe_provider?: string | null;
          transcript_words?: WhisperWordRow[];
          transcript_text?: string | null;
          duration_sec?: number;
          style_id?: string;
          style_overrides?: Record<string, unknown>;
          render_status?: "idle" | "rendering" | "rendered" | "failed";
          render_url?: string | null;
          rendered_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["projects"]["Insert"]>;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

/** Shape that the `transcript_words` JSONB column stores. */
export interface WhisperWordRow {
  word: string;
  start: number;
  end: number;
}
