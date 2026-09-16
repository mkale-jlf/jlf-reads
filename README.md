# Reading & Watching — John Locke Foundation (POC)

An editorial-style site that displays staff media recommendations (books, films, articles, podcasts). The frontend is plain HTML/CSS/JavaScript — no build step, no dependencies. A Supabase backend provides the production data path.

```text
Microsoft Form
→ Microsoft List
→ Power Automate
→ sync-recommendation Edge Function
→ Supabase recommendations table
→ frontend query on page load
```

While `DATA_SOURCE` is set to `json` (see [Frontend data layer](#frontend-data-layer)), the frontend reads a local JSON fixture instead of Supabase, which is how the site currently ships.

## Quick start

`fetch()` cannot read local files from `file://`, so serve the folder over HTTP:

```sh
python3 -m http.server 8000        # or: npx serve .
```

Then open <http://localhost:8000>.

## Project structure

```text
/
├── index.html                      Page shell (masthead, filters, grid, colophon)
├── styles.css                      Editorial theme (cream paper, serif type, masonry grid)
├── assets/
│   └── locke-floating-head.png     Masthead emblem
├── js/
│   ├── app.js                      Rendering, filtering, cover hydration
│   ├── recommendations-data.js     Data adapter — JSON fixture or Supabase
│   ├── data.js                     Fixture loader + normalization/validation
│   └── covers.js                   Book-cover / movie-poster lookup with caching + fallbacks
├── data/
│   └── recommendations.json        Local JSON fixture (used while DATA_SOURCE = "json")
├── scripts/
│   └── import-recommendations.js   CSV → JSON importer for Microsoft Forms exports
├── supabase/
│   ├── config.toml                 Local Supabase CLI configuration
│   ├── migrations/                 Database schema (recommendations table, RLS, storage)
│   └── functions/
│       └── sync-recommendation/    Edge Function synced from Microsoft Lists
└── README.md
```

## Frontend data layer

`js/recommendations-data.js` exports a single entry point:

```js
loadRecommendations()
```

It keys off one constant:

```js
DATA_SOURCE = "json"        // currently: local fixture
// change to "supabase" once real records exist in the database
```

- **`"json"`** — loads `data/recommendations.json` through `js/data.js` (normalization + warn-and-skip validation). This is the current shipping mode and the local/dev fallback.
- **`"supabase"`** — queries the Supabase PostgREST endpoint using the public project URL and the publishable key from this module. Those values are safe in browser code because access is constrained by RLS and column-level grants.

There is **no silent fallback**: switching `DATA_SOURCE` to `"supabase"` makes Supabase the source of truth, and a failed query surfaces as an error rather than showing stale fixture data. Flip the switch only after the database contains the real published records.

The Supabase query requests exactly the public columns — never `select("*")`:

```js
select(`
  id, media_type, title, source, url, blurb, sink, display_order,
  artwork_source, artwork_status, artwork_api_provider, artwork_api_id, artwork_api_url,
  manual_image_path, image_alt_text, image_credit, published_at, updated_at
`)
```

ordered by `sink` (ascending), then `display_order` (ascending), then `published_at` (descending).

## Editing the JSON fixture

While `DATA_SOURCE = "json"`, edit `data/recommendations.json` directly. Each entry:

| Field       | Required | Notes                                                                 |
| ----------- | -------- | --------------------------------------------------------------------- |
| `mediaType` | yes      | `book`, `movie`, `article`, or `podcast`                              |
| `title`     | yes      | Book/film/episode/article title                                       |
| `url`       | no       | Absolute URL opened in a new tab when clicked                         |
| `blurb`     | no       | Staff-written hook                                                    |
| `source`    | no       | Author, publication, podcast name, or director                        |
| `sink`      | no       | `true` renders the tile last (e.g. JLF's own productions)             |

Fixture rows render in array order, with `sink: true` entries pushed to the bottom of the board; in Supabase mode ordering comes from `display_order`.

Display behavior by type:

- **Books** — cover fetched client-side: Google Books first, Open Library as fallback.
- **Movies** — poster via TMDB if an API key is configured (see below), otherwise a typographic placeholder.
- **Articles / Podcasts** — text-only entries; the title links to the submitted URL.

If a cover can't be found or a URL is missing/invalid, the entry degrades gracefully (placeholder art, plain-text title).

## Importing a CSV into the fixture

1. In Microsoft Forms: **Responses → Open in Excel** (or download the CSV).
2. In Excel: **File → Save As → CSV UTF-8**.
3. Run the importer:

```sh
node scripts/import-recommendations.js ~/Downloads/responses.csv
node scripts/import-recommendations.js responses.csv -o data/recommendations.json
npm run import -- responses.csv          # equivalent via npm
```

The importer recognizes flexible column headers — any of these aliases work:

| Field       | Accepted headers                                                        |
| ----------- | ----------------------------------------------------------------------- |
| Media type  | `Media type`, `Type`, `Category`, `Format`                               |
| Title       | `Title`, `Name`, `Recommendation`                                        |
| Link        | `Link`, `Link (URL)`, `URL`, `Website`                                   |
| Blurb       | `Blurb`, `Description`, `Why`, `Notes`, `Comments`                       |
| Creator     | `Creator/Source`, `Author`, `Publication`, `Podcast`, `Director`, `Show` |

Behavior: normalizes media types (`Books` → `book`, `Film` → `movie`, …), skips duplicate and unrecognized rows with warnings, preserves submission order, and **overwrites** the output file. Commit the generated JSON rather than the CSV.

## Movie posters (optional TMDB key)

Book covers need no key. For movie posters, get a free TMDB API key (<https://www.themoviedb.org/settings/api> — copy the *API Key (v3)*), then either:

- paste it into `<meta name="tmdb-api-key" content="">` in `index.html`, or
- run `localStorage.setItem('tmdbApiKey', '…')` once in your browser's DevTools.

Without a key, movies render with an intentional typographic placeholder — the site still works.

## Supabase backend

### Database (public schema)

The schema lives in `supabase/migrations/` and captures the managed `public` schema:

- **`recommendations`** table — `id`, Microsoft List reference (`microsoft_list_id` / `microsoft_list_item_id`, unique together for idempotent sync), `media_type`, `title`, `source`, `url`, `blurb`, `sink`, `display_order`, `status` (`pending` / `published` / `archived`), artwork metadata, submission/approval audit fields, `source_modified_at`, `published_at`, `created_at`, `updated_at`.
- **CHECK constraints** — media type whitelist, valid statuses, non-empty titles, HTTPS-or-null URLs, artwork consistency rules.
- **Trigger** `set_recommendation_timestamps` — maintains `updated_at` and sets/clears `published_at` as a record becomes or leaves `published`.
- **Indexes** — public ordering (`status, sink, display_order, published_at DESC`), published media-type filtering, artwork review queue, recency.

**Row-level security**

- RLS enabled; the `recommendations_public_read` policy lets `anon` and `authenticated` SELECT only rows where `status = 'published'`.
- Column-level SELECT grants to `anon`/`authenticated` cover exactly the public fields the frontend selects (`id`, `media_type`, `title`, `source`, `url`, `blurb`, `sink`, `display_order`, artwork public fields, `published_at`, `updated_at`).
- Internal columns are **not** granted to `anon`: `status`, `microsoft_list_id`, `microsoft_list_item_id`, `submitted_*`, `approved_*`, `created_at`, `image_rights_confirmed`. Querying them anonymously is denied.
- `service_role` has full access (used only by the Edge Function).

### Storage

Public bucket **`recommendation-artwork`** holds manually uploaded images (JPEG / PNG / WebP, 3 MB max). The frontend receives only the object path (`manual_image_path`); resolves it via the Storage public URL.

### Edge Function — `sync-recommendation`

Deployed at the correct slug `sync-recommendation` — the earlier misspelled `sync-reccomendation` deployment was removed.

- **Authentication** — `verify_jwt = false` in `supabase/config.toml`; the function instead authenticates by comparing the `x-jlf-sync-secret` request header against the `JLF_SYNC_SECRET` env secret (constant-time SHA-256 comparison). Without the header → `401 UNAUTHORIZED`.
- **Required secret** — set once on the project:

  ```sh
  supabase secrets set JLF_SYNC_SECRET=<value>
  ```

  Confirm it exists with `supabase secrets list` (the CLI shows only a digest, never the value).

- **Operations** — `upsert` (requires `status: "published"`; creates or updates by `(microsoft_list_id, microsoft_list_item_id)`, rejecting updates older than the stored `source_modified_at` with `409 STALE_UPDATE`), `archive` (moves a record to `archived`), `validate` (dry run — no row written).
- **Artwork handling** — three modes: `api` (metadata only, e.g. Google Books/TMDB reference), `manual` (base64 image uploaded to the bucket, requires `rights_confirmed: true`; replaced images are cleaned up), and `placeholder` (frontend renders a typographic fallback).
- **Deploy** — after editing `supabase/functions/sync-recommendation/index.ts`:

  ```sh
  supabase functions deploy sync-recommendation --project-ref <project-ref>
  ```

- **Local CLI** — `supabase start` for local dev. DB seeding is disabled (`[db.seed] enabled = false`) until a real `seed.sql` exists.

### Power Automate trigger

No scheduler runs the function. Power Automate invokes it whenever an *approved* Microsoft List item changes, passing `media_type`, `title`, `source`, `url`, `blurb`, `sink`, ordering and artwork fields, plus `source_modified_at` for staleness checks.

## Deploying to GitHub Pages

1. Create a GitHub repository and push these files to the `main` branch.
2. Repo **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, Folder: `/ (root)` → **Save**.
3. The site goes live at `https://<username>.github.io/<repo>/` within a couple of minutes.

All asset and data paths are relative, so subpath hosting works unchanged.

## Deployment and rollback

- **Frontend green** — committing to `main` redeploys GitHub Pages. Roll back by reverting the offending commit.
- **Data path** — moving from fixture to production is a single flag change: set `DATA_SOURCE = "supabase"` in `js/recommendations-data.js` and redeploy. To roll back, revert that flag (the JSON fixture remains the previously shipped set) and redeploy.
- **Edge Function** — roll back by redeploying the previous source with `supabase functions deploy sync-recommendation`, or delete the function (`supabase functions delete sync-recommendation`) to halt syncing entirely.
- **Database** — roll forward/revert schema via migrations; the pre-migration PostgreSQL dump is kept outside this repository as a JLF-controlled backup.

## Notes

- Typeface: [Newsreader](https://fonts.google.com/specimen/Newsreader) via Google Fonts; everything else uses system fonts.
- Google Books, Open Library, and TMDB all allow browser-side requests (CORS enabled); covers are resolved at runtime and cached per session.