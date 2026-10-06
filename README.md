# Comp Report Builder (Cloudflare Worker)

Type an address, confirm the property details, get 5 sold comps, their average sold price, and a downloadable PDF.

## Layout
- `wrangler.jsonc`   Worker config (set `name` to match your Worker's name in Cloudflare)
- `src/index.js`     Worker: handles POST /api/comps (RentCast lookup + comp ranking)
- `public/index.html` The web page (served as static assets)

## Deploy (GitHub -> Cloudflare Worker)
1. Push these files to GitHub, keeping the folder structure.
2. Cloudflare: Workers & Pages > Create > Import a repository. Build command empty; deploy command `npx wrangler deploy`.
3. Worker > Settings > Variables and Secrets: add `RENTCAST_API_KEY` as a Secret, then redeploy.

The API key stays on Cloudflare's side and is never sent to the browser.
