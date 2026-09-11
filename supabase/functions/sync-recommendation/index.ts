import { createClient } from "npm:@supabase/supabase-js@2";
const ALLOWED_MEDIA_TYPES = new Set([
  "book",
  "movie",
  "article",
  "podcast"
]);
const ALLOWED_IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
};
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_REQUEST_CHARACTERS = 5_000_000;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-jlf-sync-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
class HttpError extends Error {
  status;
  code;
  constructor(status, code, message){
    super(message);
    this.status = status;
    this.code = code;
  }
}
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json"
    }
  });
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requiredString(value, field, maxLength) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "VALIDATION_ERROR", `${field} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new HttpError(400, "VALIDATION_ERROR", `${field} exceeds ${maxLength} characters.`);
  }
  return normalized;
}
function optionalString(value, field, maxLength) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "VALIDATION_ERROR", `${field} must be a string or null.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length > maxLength) {
    throw new HttpError(400, "VALIDATION_ERROR", `${field} exceeds ${maxLength} characters.`);
  }
  return normalized;
}
function optionalBoolean(value, field, defaultValue) {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, "VALIDATION_ERROR", `${field} must be a boolean.`);
  }
  return value;
}
function optionalInteger(value, field, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HttpError(400, "VALIDATION_ERROR", `${field} must be a nonnegative integer.`);
  }
  return parsed;
}
function requiredListItemId(value) {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, "VALIDATION_ERROR", "microsoft_list_item_id must be a positive integer.");
  }
  return parsed;
}
function isoTimestamp(value, field) {
  const raw = requiredString(value, field, 100);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, "VALIDATION_ERROR", `${field} must be a valid ISO-8601 timestamp.`);
  }
  return date.toISOString();
}
function optionalTimestamp(value, field) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return isoTimestamp(value, field);
}
function optionalEmail(value, field) {
  const email = optionalString(value, field, 320);
  if (email === null) {
    return null;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "VALIDATION_ERROR", `${field} must be a valid email address.`);
  }
  return email.toLowerCase();
}
function optionalHttpsUrl(value, field) {
  const raw = optionalString(value, field, 2048);
  if (raw === null) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch  {
    throw new HttpError(400, "VALIDATION_ERROR", `${field} must be a valid URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new HttpError(400, "VALIDATION_ERROR", `${field} must use HTTPS.`);
  }
  return parsed.toString();
}
function rejectUnknownFields(object, allowed, location) {
  const unknown = Object.keys(object).filter((key)=>!allowed.has(key));
  if (unknown.length > 0) {
    throw new HttpError(400, "UNKNOWN_FIELDS", `Unknown ${location} fields: ${unknown.join(", ")}.`);
  }
}
function decodeBase64(value) {
  const raw = requiredString(value, "artwork.content_base64", 4_500_000);
  const cleaned = raw.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
  if (cleaned.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    throw new HttpError(400, "INVALID_IMAGE", "artwork.content_base64 is not valid base64.");
  }
  let binary;
  try {
    binary = atob(cleaned);
  } catch  {
    throw new HttpError(400, "INVALID_IMAGE", "artwork.content_base64 could not be decoded.");
  }
  if (binary.length > MAX_IMAGE_BYTES) {
    throw new HttpError(413, "IMAGE_TOO_LARGE", "The decoded image exceeds the 3 MB limit.");
  }
  const bytes = new Uint8Array(binary.length);
  for(let index = 0; index < binary.length; index += 1){
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
async function secureCompare(supplied, expected) {
  const encoder = new TextEncoder();
  const [suppliedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const suppliedBytes = new Uint8Array(suppliedHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = suppliedBytes.length ^ expectedBytes.length;
  for(let index = 0; index < Math.max(suppliedBytes.length, expectedBytes.length); index += 1){
    difference |= (suppliedBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }
  return difference === 0;
}
function getSupabaseSecretKey() {
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacyKey) {
    return legacyKey;
  }
  const secretKeysJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!secretKeysJson) {
    throw new HttpError(500, "CONFIGURATION_ERROR", "Supabase server credential is unavailable.");
  }
  try {
    const keys = JSON.parse(secretKeysJson);
    const key = keys.default ?? Object.values(keys).find((value)=>typeof value === "string");
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("No usable key");
    }
    return key;
  } catch  {
    throw new HttpError(500, "CONFIGURATION_ERROR", "Supabase server credential is invalid.");
  }
}
Deno.serve(async (request)=>{
  const requestId = crypto.randomUUID();
  try {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }
    if (request.method !== "POST") {
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Only POST requests are accepted.");
    }
    const expectedSecret = Deno.env.get("JLF_SYNC_SECRET");
    if (!expectedSecret) {
      throw new HttpError(500, "CONFIGURATION_ERROR", "JLF_SYNC_SECRET has not been configured.");
    }
    const suppliedSecret = request.headers.get("x-jlf-sync-secret") ?? "";
    if (suppliedSecret.length === 0 || !await secureCompare(suppliedSecret, expectedSecret)) {
      throw new HttpError(401, "UNAUTHORIZED", "The synchronization secret is invalid.");
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
    }
    const rawBody = await request.text();
    if (rawBody.length > MAX_REQUEST_CHARACTERS) {
      throw new HttpError(413, "REQUEST_TOO_LARGE", "The request body is too large.");
    }
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch  {
      throw new HttpError(400, "INVALID_JSON", "The request body is not valid JSON.");
    }
    if (!isObject(body)) {
      throw new HttpError(400, "VALIDATION_ERROR", "The request body must be a JSON object.");
    }
    rejectUnknownFields(body, new Set([
      "operation",
      "microsoft_list_id",
      "microsoft_list_item_id",
      "source_modified_at",
      "media_type",
      "title",
      "source",
      "url",
      "blurb",
      "sink",
      "display_order",
      "status",
      "submitted_by_email",
      "submitted_at",
      "approved_by_email",
      "approved_at",
      "artwork"
    ]), "top-level");
    const operation = requiredString(body.operation, "operation", 20);
    if (![
      "upsert",
      "archive",
      "validate"
    ].includes(operation)) {
      throw new HttpError(400, "INVALID_OPERATION", "operation must be upsert, archive, or validate.");
    }
    const microsoftListId = requiredString(body.microsoft_list_id, "microsoft_list_id", 200);
    const microsoftListItemId = requiredListItemId(body.microsoft_list_item_id);
    const sourceModifiedAt = isoTimestamp(body.source_modified_at, "source_modified_at");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    if (!supabaseUrl) {
      throw new HttpError(500, "CONFIGURATION_ERROR", "SUPABASE_URL is unavailable.");
    }
    const supabaseAdmin = createClient(supabaseUrl, getSupabaseSecretKey(), {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    const { data: existing, error: existingError } = await supabaseAdmin.from("recommendations").select(`
        id,
        source_modified_at,
        manual_image_path,
        artwork_source
      `).eq("microsoft_list_id", microsoftListId).eq("microsoft_list_item_id", microsoftListItemId).maybeSingle();
    if (existingError) {
      console.error({
        request_id: requestId,
        event: "existing_record_lookup_failed",
        database_code: existingError.code
      });
      throw new HttpError(500, "DATABASE_ERROR", "Could not inspect the existing recommendation.");
    }
    if (existing?.source_modified_at && new Date(sourceModifiedAt).getTime() < new Date(existing.source_modified_at).getTime()) {
      throw new HttpError(409, "STALE_UPDATE", "A newer Microsoft Lists version has already been processed.");
    }
    if (operation === "archive") {
      if (!existing) {
        return jsonResponse({
          ok: true,
          request_id: requestId,
          operation: "archive",
          result: "not_found_noop",
          microsoft_list_id: microsoftListId,
          microsoft_list_item_id: microsoftListItemId
        });
      }
      const { data: archived, error: archiveError } = await supabaseAdmin.from("recommendations").update({
        status: "archived",
        source_modified_at: sourceModifiedAt
      }).eq("id", existing.id).select("id, status, updated_at").single();
      if (archiveError) {
        console.error({
          request_id: requestId,
          event: "archive_failed",
          database_code: archiveError.code
        });
        throw new HttpError(500, "DATABASE_ERROR", "Could not archive the recommendation.");
      }
      return jsonResponse({
        ok: true,
        request_id: requestId,
        operation: "archive",
        result: "archived",
        recommendation: archived
      });
    }
    const mediaType = requiredString(body.media_type, "media_type", 30).toLowerCase();
    if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
      throw new HttpError(400, "VALIDATION_ERROR", "media_type must be book, movie, article, or podcast.");
    }
    const status = requiredString(body.status, "status", 30).toLowerCase();
    if (status !== "published") {
      throw new HttpError(400, "VALIDATION_ERROR", "An upsert must have status set to published.");
    }
    const title = requiredString(body.title, "title", 300);
    const source = optionalString(body.source, "source", 300);
    const url = optionalHttpsUrl(body.url, "url");
    const blurb = optionalString(body.blurb, "blurb", 10_000);
    const sink = optionalBoolean(body.sink, "sink", false);
    const displayOrder = optionalInteger(body.display_order, "display_order", 0);
    const submittedByEmail = optionalEmail(body.submitted_by_email, "submitted_by_email");
    const submittedAt = optionalTimestamp(body.submitted_at, "submitted_at");
    const approvedByEmail = optionalEmail(body.approved_by_email, "approved_by_email");
    const approvedAt = optionalTimestamp(body.approved_at, "approved_at");
    const recommendationId = existing?.id ?? crypto.randomUUID();
    const record = {
      id: recommendationId,
      microsoft_list_id: microsoftListId,
      microsoft_list_item_id: microsoftListItemId,
      source_modified_at: sourceModifiedAt,
      media_type: mediaType,
      title,
      source,
      url,
      blurb,
      sink,
      display_order: displayOrder,
      status: "published"
    };
    if (body.submitted_by_email !== undefined) {
      record.submitted_by_email = submittedByEmail;
    }
    if (body.submitted_at !== undefined) {
      record.submitted_at = submittedAt;
    }
    if (body.approved_by_email !== undefined) {
      record.approved_by_email = approvedByEmail;
    }
    if (body.approved_at !== undefined) {
      record.approved_at = approvedAt;
    }
    let newManualImagePath = null;
    let uploadedNewImage = false;
    let removeOldManualImage = false;
    if (body.artwork !== undefined && body.artwork !== null) {
      if (!isObject(body.artwork)) {
        throw new HttpError(400, "VALIDATION_ERROR", "artwork must be an object or null.");
      }
      rejectUnknownFields(body.artwork, new Set([
        "source",
        "api_provider",
        "api_id",
        "api_url",
        "content_base64",
        "mime_type",
        "filename",
        "alt_text",
        "credit",
        "rights_confirmed"
      ]), "artwork");
      const artworkSource = requiredString(body.artwork.source, "artwork.source", 30).toLowerCase();
      const altText = optionalString(body.artwork.alt_text, "artwork.alt_text", 500);
      const credit = optionalString(body.artwork.credit, "artwork.credit", 500);
      if (artworkSource === "api") {
        const apiProvider = requiredString(body.artwork.api_provider, "artwork.api_provider", 100);
        const apiId = optionalString(body.artwork.api_id, "artwork.api_id", 500);
        const apiUrl = optionalHttpsUrl(body.artwork.api_url, "artwork.api_url");
        if (!apiUrl) {
          throw new HttpError(400, "VALIDATION_ERROR", "artwork.api_url is required for API artwork.");
        }
        record.artwork_source = "api";
        record.artwork_status = "found";
        record.artwork_api_provider = apiProvider;
        record.artwork_api_id = apiId;
        record.artwork_api_url = apiUrl;
        record.manual_image_path = null;
        record.image_alt_text = altText;
        record.image_credit = credit;
        record.image_rights_confirmed = false;
        removeOldManualImage = Boolean(existing?.manual_image_path);
      } else if (artworkSource === "placeholder") {
        record.artwork_source = "placeholder";
        record.artwork_status = "placeholder";
        record.artwork_api_provider = null;
        record.artwork_api_id = null;
        record.artwork_api_url = null;
        record.manual_image_path = null;
        record.image_alt_text = altText ?? `Placeholder image for ${title}`;
        record.image_credit = credit;
        record.image_rights_confirmed = false;
        removeOldManualImage = Boolean(existing?.manual_image_path);
      } else if (artworkSource === "manual") {
        if (body.artwork.rights_confirmed !== true) {
          throw new HttpError(400, "IMAGE_RIGHTS_REQUIRED", "Manual artwork requires rights_confirmed to be true.");
        }
        const mimeType = requiredString(body.artwork.mime_type, "artwork.mime_type", 100).toLowerCase();
        const extension = ALLOWED_IMAGE_TYPES[mimeType];
        if (!extension) {
          throw new HttpError(400, "INVALID_IMAGE_TYPE", "Manual artwork must be JPEG, PNG, or WebP.");
        }
        const imageBytes = decodeBase64(body.artwork.content_base64);
        const uniquePart = crypto.randomUUID();
        newManualImagePath = `recommendations/${recommendationId}/${uniquePart}.${extension}`;
        if (operation !== "validate") {
          const { error: uploadError } = await supabaseAdmin.storage.from("recommendation-artwork").upload(newManualImagePath, imageBytes, {
            contentType: mimeType,
            cacheControl: "31536000",
            upsert: false
          });
          if (uploadError) {
            console.error({
              request_id: requestId,
              event: "image_upload_failed"
            });
            throw new HttpError(500, "IMAGE_UPLOAD_FAILED", "The manual image could not be stored.");
          }
          uploadedNewImage = true;
        }
        record.artwork_source = "manual";
        record.artwork_status = "manual";
        record.artwork_api_provider = null;
        record.artwork_api_id = null;
        record.artwork_api_url = null;
        record.manual_image_path = newManualImagePath;
        record.image_alt_text = altText ?? `Artwork for ${title}`;
        record.image_credit = credit;
        record.image_rights_confirmed = true;
        removeOldManualImage = Boolean(existing?.manual_image_path);
      } else {
        throw new HttpError(400, "VALIDATION_ERROR", "artwork.source must be api, manual, or placeholder.");
      }
    } else if (!existing) {
      record.artwork_source = "placeholder";
      record.artwork_status = "placeholder";
      record.artwork_api_provider = null;
      record.artwork_api_id = null;
      record.artwork_api_url = null;
      record.manual_image_path = null;
      record.image_alt_text = `Placeholder image for ${title}`;
      record.image_credit = null;
      record.image_rights_confirmed = false;
    }
    if (operation === "validate") {
      return jsonResponse({
        ok: true,
        request_id: requestId,
        operation: "validate",
        result: "valid",
        would_create: !existing,
        normalized: {
          microsoft_list_id: microsoftListId,
          microsoft_list_item_id: microsoftListItemId,
          source_modified_at: sourceModifiedAt,
          media_type: mediaType,
          title,
          source,
          url,
          sink,
          display_order: displayOrder,
          status: "published",
          artwork_source: record.artwork_source ?? existing?.artwork_source ?? null
        }
      });
    }
    const { data: saved, error: saveError } = await supabaseAdmin.from("recommendations").upsert(record, {
      onConflict: "microsoft_list_id,microsoft_list_item_id"
    }).select(`
        id,
        microsoft_list_id,
        microsoft_list_item_id,
        status,
        artwork_source,
        artwork_status,
        updated_at
      `).single();
    if (saveError) {
      if (uploadedNewImage && newManualImagePath) {
        await supabaseAdmin.storage.from("recommendation-artwork").remove([
          newManualImagePath
        ]);
      }
      console.error({
        request_id: requestId,
        event: "recommendation_upsert_failed",
        database_code: saveError.code
      });
      throw new HttpError(500, "DATABASE_ERROR", "Could not save the recommendation.");
    }
    const warnings = [];
    if (removeOldManualImage && existing?.manual_image_path && existing.manual_image_path !== newManualImagePath) {
      const { error: removalError } = await supabaseAdmin.storage.from("recommendation-artwork").remove([
        existing.manual_image_path
      ]);
      if (removalError) {
        warnings.push("The recommendation was saved, but its previous image could not be removed.");
        console.error({
          request_id: requestId,
          event: "old_image_removal_failed"
        });
      }
    }
    return jsonResponse({
      ok: true,
      request_id: requestId,
      operation: "upsert",
      result: existing ? "updated" : "created",
      recommendation: saved,
      warnings
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse({
        ok: false,
        request_id: requestId,
        error: {
          code: error.code,
          message: error.message
        }
      }, error.status);
    }
    console.error({
      request_id: requestId,
      event: "unhandled_error"
    });
    return jsonResponse({
      ok: false,
      request_id: requestId,
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred."
      }
    }, 500);
  }
});