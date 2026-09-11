

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_recommendation_timestamps"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  new.updated_at := now();

  -- Set the initial publication timestamp.
  if new.status = 'published' and new.published_at is null then
    new.published_at := now();
  end if;

  -- Pending and archived records are not currently published.
  if new.status <> 'published' then
    new.published_at := null;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."set_recommendation_timestamps"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."recommendations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "microsoft_list_id" "text",
    "microsoft_list_item_id" bigint,
    "media_type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "source" "text",
    "url" "text",
    "blurb" "text",
    "sink" boolean DEFAULT false NOT NULL,
    "display_order" integer DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "artwork_source" "text",
    "artwork_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "artwork_api_provider" "text",
    "artwork_api_id" "text",
    "artwork_api_url" "text",
    "manual_image_path" "text",
    "image_alt_text" "text",
    "image_credit" "text",
    "image_rights_confirmed" boolean DEFAULT false NOT NULL,
    "submitted_by_email" "text",
    "submitted_at" timestamp with time zone,
    "approved_by_email" "text",
    "approved_at" timestamp with time zone,
    "source_modified_at" timestamp with time zone,
    "published_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "recommendations_api_artwork_complete" CHECK ((("artwork_source" <> 'api'::"text") OR (("artwork_api_provider" IS NOT NULL) AND ("artwork_api_url" IS NOT NULL)))),
    CONSTRAINT "recommendations_artwork_api_url_check" CHECK ((("artwork_api_url" IS NULL) OR ("artwork_api_url" ~* '^https?://'::"text"))),
    CONSTRAINT "recommendations_artwork_source_check" CHECK ((("artwork_source" IS NULL) OR ("artwork_source" = ANY (ARRAY['api'::"text", 'manual'::"text", 'placeholder'::"text"])))),
    CONSTRAINT "recommendations_artwork_status_check" CHECK (("artwork_status" = ANY (ARRAY['pending'::"text", 'found'::"text", 'needs_review'::"text", 'manual'::"text", 'placeholder'::"text"]))),
    CONSTRAINT "recommendations_display_order_check" CHECK (("display_order" >= 0)),
    CONSTRAINT "recommendations_manual_artwork_complete" CHECK ((("artwork_source" <> 'manual'::"text") OR (("manual_image_path" IS NOT NULL) AND ("image_rights_confirmed" = true)))),
    CONSTRAINT "recommendations_media_type_check" CHECK (("media_type" = ANY (ARRAY['book'::"text", 'movie'::"text", 'article'::"text", 'podcast'::"text"]))),
    CONSTRAINT "recommendations_microsoft_reference_complete" CHECK (((("microsoft_list_id" IS NULL) AND ("microsoft_list_item_id" IS NULL)) OR (("microsoft_list_id" IS NOT NULL) AND ("microsoft_list_item_id" IS NOT NULL)))),
    CONSTRAINT "recommendations_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'published'::"text", 'archived'::"text"]))),
    CONSTRAINT "recommendations_title_check" CHECK (("length"(TRIM(BOTH FROM "title")) > 0)),
    CONSTRAINT "recommendations_url_check" CHECK ((("url" IS NULL) OR ("url" ~* '^https?://'::"text")))
);


ALTER TABLE "public"."recommendations" OWNER TO "postgres";


COMMENT ON TABLE "public"."recommendations" IS 'Public delivery records for JLF Reads. Microsoft Lists is the editorial source of truth.';



COMMENT ON COLUMN "public"."recommendations"."microsoft_list_id" IS 'Identifier of the Microsoft List from which the record originated.';



COMMENT ON COLUMN "public"."recommendations"."microsoft_list_item_id" IS 'Microsoft List item ID used for idempotent synchronization.';



COMMENT ON COLUMN "public"."recommendations"."source" IS 'Author, director, publication, podcast, organization, or other creator/source.';



COMMENT ON COLUMN "public"."recommendations"."sink" IS 'When true, the frontend renders the recommendation after non-sink items.';



COMMENT ON COLUMN "public"."recommendations"."manual_image_path" IS 'Object path inside the recommendation-artwork Supabase Storage bucket.';



COMMENT ON COLUMN "public"."recommendations"."image_rights_confirmed" IS 'Internal confirmation that JLF may display the manually uploaded image.';



COMMENT ON COLUMN "public"."recommendations"."source_modified_at" IS 'Last-modified timestamp received from Microsoft Lists, used to reject stale updates.';



ALTER TABLE ONLY "public"."recommendations"
    ADD CONSTRAINT "recommendations_microsoft_reference_unique" UNIQUE ("microsoft_list_id", "microsoft_list_item_id");



ALTER TABLE ONLY "public"."recommendations"
    ADD CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id");



CREATE INDEX "recommendations_artwork_status_idx" ON "public"."recommendations" USING "btree" ("artwork_status") WHERE ("artwork_status" = ANY (ARRAY['pending'::"text", 'needs_review'::"text"]));



CREATE INDEX "recommendations_public_order_idx" ON "public"."recommendations" USING "btree" ("status", "sink", "display_order", "published_at" DESC);



CREATE INDEX "recommendations_published_media_type_idx" ON "public"."recommendations" USING "btree" ("media_type", "sink", "display_order") WHERE ("status" = 'published'::"text");



CREATE INDEX "recommendations_updated_at_idx" ON "public"."recommendations" USING "btree" ("updated_at" DESC);



CREATE OR REPLACE TRIGGER "recommendations_set_timestamps" BEFORE INSERT OR UPDATE ON "public"."recommendations" FOR EACH ROW EXECUTE FUNCTION "public"."set_recommendation_timestamps"();



ALTER TABLE "public"."recommendations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "recommendations_public_read" ON "public"."recommendations" FOR SELECT TO "authenticated", "anon" USING (("status" = 'published'::"text"));



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_recommendation_timestamps"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_recommendation_timestamps"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_recommendation_timestamps"() TO "service_role";



GRANT ALL ON TABLE "public"."recommendations" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."recommendations" TO "anon";
GRANT SELECT("id") ON TABLE "public"."recommendations" TO "authenticated";



GRANT SELECT("media_type") ON TABLE "public"."recommendations" TO "anon";
GRANT SELECT("media_type") ON TABLE "public"."recommendations" TO "authenticated";



GRANT SELECT("title") ON TABLE "public"."recommendations" TO "anon";
GRANT SELECT("title") ON TABLE "public"."recommendations" TO "authenticated";



GRANT SELECT("source") ON TABLE "public"."recommendations" TO "anon";
GRANT SELECT("source") ON TABLE "public"."recommendations" TO "authenticated";



GRANT SELECT("url") ON TABLE "public"."recommendations" TO "anon";
GRANT SELECT("url") ON TABLE "public"."recommendations" TO "authenticated";



GRANT SELECT("blurb") ON TABLE "public"."recommendations" TO "anon";
GRANT SELECT("blurb") ON TABLE "public"."recommendations" TO "authenticated";



GRANT SELECT("sink") ON TABLE "public"."recommendations" TO "anon";
GRANT SELECT("sink") ON TABLE "public"."recommendations" TO "authenticated";



GRANT SELECT("display_order") ON TABLE "public"."recommendations" TO "anon";
GRANT SELECT("display_order") ON TABLE "public"."recommendations" TO "authenticated";



GRANT SELECT("artwork_source") ON TABLE "public"."recommendations" TO "anon";
GRANT SELECT("artwork_source") ON TABLE "public"."recommendations" TO "authenticated";



GRANT SELECT("artwork_status") ON TABLE "public"."recommendations" TO "anon";
GRANT SELECT("artwork_status") ON TABLE "public"."recommendations" TO "authenticated";



GRANT SELECT("artwork_api_provider") ON TABLE "public"."recommendations" TO "anon";
GRANT SELECT("artwork_api_provider") ON TABLE "public"."recommendations" TO "authenticated";



GRANT SELECT("artwork_api_id") ON TABLE "public"."recommendations" TO "anon";
GRANT SELECT("artwork_api_id") ON TABLE "public"."recommendations" TO "authenticated";



GRANT SELECT("artwork_api_url") ON TABLE "public"."recommendations" TO "anon";
GRANT SELECT("artwork_api_url") ON TABLE "public"."recommendations" TO "authenticated";



GRANT SELECT("manual_image_path") ON TABLE "public"."recommendations" TO "anon";
GRANT SELECT("manual_image_path") ON TABLE "public"."recommendations" TO "authenticated";



GRANT SELECT("image_alt_text") ON TABLE "public"."recommendations" TO "anon";
GRANT SELECT("image_alt_text") ON TABLE "public"."recommendations" TO "authenticated";



GRANT SELECT("image_credit") ON TABLE "public"."recommendations" TO "anon";
GRANT SELECT("image_credit") ON TABLE "public"."recommendations" TO "authenticated";



GRANT SELECT("published_at") ON TABLE "public"."recommendations" TO "anon";
GRANT SELECT("published_at") ON TABLE "public"."recommendations" TO "authenticated";



GRANT SELECT("updated_at") ON TABLE "public"."recommendations" TO "anon";
GRANT SELECT("updated_at") ON TABLE "public"."recommendations" TO "authenticated";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";


-- Storage bucket for manually uploaded artwork. Not captured by schema dumps.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recommendation-artwork', 'recommendation-artwork', true, 3145728, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;






