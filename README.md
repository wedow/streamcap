# P2P Studio

Browser-only peer-to-peer recording studio. Static site, no build step.

## Run locally

ES modules need HTTP, not `file://`:

    python -m http.server

then open http://localhost:8000.

## Layout

- `index.html` – markup
- `css/style.css` – styles
- `js/main.js` – entry: lobby and UI wiring
- `js/config.js` – CDN URLs, ICE servers, recording formats
- `js/util.js` – DOM helpers, storage, frame ticker, file writing
- `js/media.js` – audio context, camera/mic, background blur
- `js/layout.js` – tile layouts and compositor
- `js/call.js` – room, peers, live program mix, call controls
- `js/recording.js` – recording sessions and full-quality file transfer
- `js/editor.js` – post-call editor and render

## Deploy

GitHub Pages → Settings → Pages → "Deploy from a branch", branch `master`, folder `/ (root)`.
