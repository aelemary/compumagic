# Compu Magic Catalog

Compu Magic is a professional, showcase-only hardware catalog for enterprise clients. It provides a structured inventory experience with an admin console to manage manufacturers and catalog entries. There are no sales, pricing, or checkout flows—this site is strictly for product discovery and specification review.

## Highlights
- Professional, navy/white/black design system
- Structured catalog with homepage category tiles and horizontal product rails
- Dedicated category pages with practical advanced filters
- Product detail pages with specs and image gallery
- Admin console for managing brands and catalog listings
- Supabase-backed data persistence

## Tech Stack
- Node.js HTTP server (`server.js`)
- Supabase (REST + Storage)
- Vanilla HTML/CSS/JS front-end

## Local Setup
1. Install Node.js (v18+ recommended).
2. Create `.env` with the variables below.
3. Start the server.

```bash
npm install
npm run start
```

The app serves static files from `public/` and exposes API routes under `/api`.

## Environment Variables
Add these to `.env`:

```bash
SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_KEY=your_supabase_service_key
SUPABASE_STORAGE_BUCKET=your_bucket_name
SESSION_SECRET=your_session_secret
PORT=3000
```

Notes:
- `SUPABASE_STORAGE_BUCKET` is optional but required for image uploads.
- `SESSION_SECRET` is optional; if omitted, the Supabase service key is used.

## New Compu Magic Database Setup
1. Create a fresh Supabase project for Compu Magic.
2. Run `database/schema.sql` in the Supabase SQL editor.
3. Create a public Storage bucket for product images if uploads will be used.
4. Update local and deployment environment variables to the new project URL/key/bucket.
5. Seed the admin account by setting `ADMIN_USERNAME` and `ADMIN_PASSWORD`, then running the catalog import once.

The schema intentionally keeps the new database focused on the catalog: `users`, `brands`, and `products`.
The old Nourtech products are not copied.

## Catalog Import
The spreadsheet import reads `/home/amrelemary/Downloads/27-6-2026.xlsx` by default.

Preview parsing without touching the database:

```bash
npm run import:catalog -- --dry-run
```

```bash
COMPUMAGIC_IMPORT_CONFIRM=1 ADMIN_USERNAME=admin ADMIN_PASSWORD="change-me" npm run import:catalog
```

Use `--xlsx=/path/to/file.xlsx` to import a different workbook. The importer requires
`COMPUMAGIC_IMPORT_CONFIRM=1` or `--confirm` so the old database is not overwritten accidentally.

Optional product image URLs can be supplied with:

```bash
node scripts/import-catalog.js --replace --confirm --image-manifest=images.json
```

`images.json` should map exact spreadsheet product titles to public image URLs. Products without a manifest
entry receive a category placeholder image.

## Admin Access
The admin console is available at `/admin.html`. Admin privileges are controlled by the `admin` flag on the `users` table in Supabase.

## Data Model (Supabase)
- `users`
- `brands`
- `products`

## License
All rights reserved.
