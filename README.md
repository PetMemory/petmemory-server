# Pet Memory Hologram Backend

A tiny, dependency-free Node server that:
1. **Verifies payment** — checks a Shoplazza order number is PAID and actually contains a hologram motion (stops freeloading).
2. **Generates the film securely** — holds your Kling keys server-side and calls Kling image-to-video, returning the 5s video URL.

The browser studio never sees your Shoplazza token or Kling keys.

## Endpoints
- `GET /api/health` → `{ ok, shop, kling, pets }`
- `POST /api/generate` `{ orderNumber, photo, name, type, actions[] }`
  - `402` if the order isn't paid / doesn't include a motion
  - `200 { ok, petId, videoUrl, wallUrl, petUrl }` on success
- `GET /api/pets` → JSON list of saved pets
- `GET /wall` → **Memorial Wall** page (avatar + name grid, dark/gold)
- `GET /pet/:id` → fullscreen projection player for one pet (for the hologram box)
- `GET /data/...` → stored photos & videos

## Memorial Wall (persistence)
Each generated film is **saved on the server**: the pet's photo → `data/photos/<id>.jpg`, the video → `data/videos/<id>.mp4` (Kling URLs expire, so we download & store the mp4), and a record in `data/pets.json`. Customers revisit `{PUBLIC_URL}/wall`, tap their pet's face, and get a fullscreen looping video to project with the hologram box.

Set `PUBLIC_URL` to this server's public URL so the wall/pet links are absolute.

## Environment variables
| Var | Where to get it |
|---|---|
| `SHOPLAZZA_HOST` | `https://petmenory.com` |
| `SHOPLAZZA_TOKEN` | Shoplazza admin → Apps → Manage private apps → your app token |
| `KLING_API_KEY` | Kling 控制台 → API Key 管理 → 新建 API Key（新版单 key，优先） |
| `KLING_AK` / `KLING_SK` | （可选，旧版）Access Key / Secret Key，JWT 模式 |
| `KLING_HOST` | optional, default `https://api-beijing.klingai.com`（海外账号改 `https://api.klingai.com`） |
| `PUBLIC_URL` | this server's public URL, e.g. `https://pawmemory-hologram.onrender.com` (for wall/pet links) |
| `PORT` | optional, default `3000` |

## Deploy (Render — free, no server to manage)
1. Push this folder to a Git repo (GitHub).
2. On render.com → **New → Web Service** → connect the repo.
3. Build command: *(leave empty)*. Start command: `node server.js`.
4. Add the 4 environment variables above.
5. Deploy → you get a URL like `https://pawmemory-hologram.onrender.com`.
6. Put that URL into the studio's `BACKEND` variable (top of `hologram-app/index.html`), then redeploy the studio.

(Railway / Fly.io / a VPS work the same way — anything that runs `node server.js`.)

## Local test
```
set SHOPLAZZA_TOKEN=xxx
set KLING_API_KEY=api-key-kling-xxx
node server.js
# then: curl http://localhost:3000/api/health
```
