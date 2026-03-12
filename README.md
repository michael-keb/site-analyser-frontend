# Site Analyser — Frontend

Static frontend for the StoreConnect Site Analyser.

## Deploy to Render

1. Deploy the [backend](https://github.com/michael-keb/site-analyser-backend) first and note its URL.
2. [Deploy this frontend](https://render.com/deploy?repo=https://github.com/michael-keb/site-analyser-frontend) — choose **Static Site**.
3. Set `API_URL` env var to your backend URL (e.g. `https://site-analyser-backend.onrender.com`).
4. Deploy backend again and add the frontend URL to `ALLOWED_ORIGINS`.

## Local dev

```bash
npm run dev
```

Set `API_URL` env or use default `http://localhost:8000`.
