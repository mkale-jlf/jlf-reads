import { loadRecommendations as loadJsonRecommendations, normalizeRecommendation } from "./data.js";

export const DATA_SOURCE = "json";

const SUPABASE_URL = "https://zlqosreqjqpkmjofivgp.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_abNIaLCL15vGH6ijv91_TA_J-f8HPk1";

const PUBLIC_COLUMNS = `
  id,
  media_type,
  title,
  source,
  url,
  blurb,
  sink,
  display_order,
  artwork_source,
  artwork_status,
  artwork_api_provider,
  artwork_api_id,
  artwork_api_url,
  manual_image_path,
  image_alt_text,
  image_credit,
  published_at,
  updated_at
`
  .trim()
  .replace(/\s+/g, " ");

function mapRow(row) {
  return {
    mediaType: row.media_type,
    title: row.title,
    source: row.source,
    url: row.url,
    blurb: row.blurb,
    sink: row.sink
  };
}

async function loadFromSupabase() {
  const url =
    `${SUPABASE_URL}/rest/v1/recommendations` +
    `?select=${encodeURIComponent(PUBLIC_COLUMNS)}` +
    `&order=${encodeURIComponent("sink.asc,display_order.asc,published_at.desc")}`;
  let response;
  try {
    response = await fetch(url, {
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        Accept: "application/json"
      }
    });
  } catch {
    throw new Error("Could not reach the recommendations database.");
  }
  if (!response.ok) {
    throw new Error(`Could not load recommendations from Supabase (HTTP ${response.status}).`);
  }
  let rows;
  try {
    rows = await response.json();
  } catch {
    throw new Error("Supabase returned invalid JSON.");
  }
  if (!Array.isArray(rows)) {
    throw new Error("Unexpected Supabase response shape.");
  }
  const valid = [];
  rows.forEach((row, index) => {
    try {
      valid.push(normalizeRecommendation(mapRow(row)));
    } catch (error) {
      console.warn(`Skipping recommendation ${index + 1}: ${error.message}`);
    }
  });
  return valid;
}

export async function loadRecommendations() {
  if (DATA_SOURCE === "supabase") {
    return loadFromSupabase();
  }
  return loadJsonRecommendations("data/recommendations.json");
}