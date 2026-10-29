---
"pushwork": minor
---

Add `--keyhive-version keyline`: keyhive 0.6 used directly, without automerge-repo-keyhive, syncing with Keyline subduction servers, which hand out their own contact card. Contact cards are base64. Public access (up to read) is public to one app's users, through a pair of principals whose secrets the app ships: a reader whose prekeys are public and a fetcher whose signing key is. Patchwork's pair is built in; `pushwork keyhive apps` adds, updates and makes pairs for other apps, and `keyhive public --app` / `init --public-app` choose one
