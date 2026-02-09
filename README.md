# Compu Magic Catalog

Compu Magic is a professional, showcase-only hardware catalog for enterprise clients. It provides a structured inventory experience with an admin console to manage manufacturers and catalog entries. There are no sales, pricing, or checkout flows—this site is strictly for product discovery and specification review.

## Highlights
- Professional, navy/white/black design system
- Structured catalog with category jump navigation
- Product detail pages with specs and image gallery
- Admin console for managing brands and catalog listings
- Editable contact page (admin-only)
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

## Admin Access
The admin console is available at `/admin.html`. Admin privileges are controlled by the `admin` flag on the `users` table in Supabase.

## Data Model (Supabase)
- `users`
- `brands`
- `products`
- `laptops`, `gpus`, `cpus`, `hdds`, `motherboards`
- `contact`

## License
All rights reserved.
