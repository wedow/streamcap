# Manual QA plan

A test plan for a human, or an agent driving `playwright-cli`. Tests state intent and observable outcomes. Find controls by their visible labels, not by selectors or refs. If the UI has drifted from what a step says, adapt and record the drift (see [Reporting](#reporting)).

Two participants ("peers") are needed for most tests: two browser profiles, two machines, or two `playwright-cli` sessions. Peer A records, peer B is the guest unless a test says otherwise. Use a fresh room code per test run.

## Background

- **Lobby**: camera preview, mic meter, *Your name*, *Room code* (🎲 makes one), *Camera*/*Microphone* (shown only with 2+ devices), *Background*, the full-quality setting (*Ask before sending it to them* / *Always send it automatically* / *Don't keep a local copy*), *Join room*, *Open a recording in the editor…*.
- **Call**: *Mic*, *Camera*, *Share screen*, *Record* (becomes *Stop recording (m:ss)*), *Marker* (visible only while someone records), *Copy invite*, *Leave*. Side tabs *Chat*, *Producer* (has *Recording folder…*, layout), *Settings*.
- **Session folder**: `<YYYY-MM-DD HH.MM.SS> <room-slug>/` inside the chosen recording folder, containing:
  - `program-live.<ext>`: the live mix
  - `local-<name>-<pid>-<cam|screen>-<n>.<ext>`: own feed; `n` counts up per roll
  - `live-<name>-<pid>-<cam|screen>-<n>.<ext>`: each peer's feed as received
  - `hq-<name>-<pid>-<kind>-<random>.<ext>`: full-quality files received from peers
  - `events.jsonl`: one JSON event per line (`session-start`, `peer-join`, `feed-start`/`feed-stop`, `program-start`/`program-stop`, `marker`, `layout`, `state`, `clock`, `hq-file`, `peer-leave`, `session-stop`)
  - `edits.json` and the rendered video once the editor has been used
- **Full-quality (HQ) copy**: while someone records you, your browser keeps an unthrottled copy of your own feeds in OPFS (`hq/` plus `hq/manifest.json`). It is offered to the recorder when they stop, or when you leave.

## Tests

### Lobby and devices

**LOB-1 Preview.** Open the app. Pass: the camera preview shows moving video, the mic meter moves, and the console has no errors besides a missing favicon.

**LOB-2 Rapid device switching.** With 2+ cameras and mics, switch the *Camera* and *Microphone* selects back and forth quickly about 10 times, then wait a few seconds. Pass: preview shows the last chosen camera. Count live tracks with `navigator.mediaDevices` accounting (or the OS camera indicator): exactly one camera and one mic capture stay open. Superseded opens are stopped. *With fake devices there is one camera (its select is hidden) and three mics. In `eval`, `await import('/js/media.js')` returns the app's own module instance: call `openCam('')`/`openMic('')` repeatedly and wrap `getUserMedia` to count live tracks.*

**LOB-3 Settings persist.** Set name, background, and the full-quality option, then reload. Pass: all three are restored.

**LOB-4 Room code with `%`.** Join room `qa-50%-x`, then *Leave*. Pass: back in the lobby the room field reads exactly `qa-50%-x`, and the URL hash is its encoded form. Reload the page. The field still matches. Join again: the session folder slug is `qa-50-x` and the header shows `Room: qa-50%-x`.

**LOB-5 `?trystero=` ignored.** Open `/?trystero=https://example.invalid/x.js` and join. Pass: the network log shows trystero loaded only from the URL in `js/config.js` (esm.sh), with no request to the injected URL.

### Joining and peers

**JOIN-1 Two peers connect.** A and B join the same room. Pass: within about 30 s each sees the other's tile with the right name, and chat shows "<name> joined".

**JOIN-2 Same-name guests.** A, B and C join, with B and C both named `Guest`. A records 15 s and stops. Pass: the session folder has two separate `live-guest-<pid>-cam-1` files, with different pids. Neither overwrote the other: both are non-trivial in size.

**JOIN-3 Peer leaves.** B clicks *Leave*. Pass: A sees B's tile disappear and "B left" in chat. If A is recording, `events.jsonl` gets `peer-leave` for B.

**JOIN-4 feedEnd isolation.** With B sharing its screen in A's call, peer C sends a `feedEnd` message naming B's screen key (from C's console: `(await import('/js/call.js')).room.makeAction('feedEnd').send({key: '<B-pid>:screen'})`). Pass: A still shows B's screen. When B stops sharing, A removes it.

### Chat and markers

**CHAT-1 Chat.** A sends a message. Pass: it appears as "You: …" for A and "A: …" for B. Empty messages are not sent.

**MARK-1 Markers.** A records. A clicks *Marker* (or presses K), and B does the same. Pass: A sees "Marker added" and "Marker from B". B sees "Marker sent to recorder". `events.jsonl` has two `marker` events. Without any recording, *Marker* is hidden.

### Recording

**REC-1 Basic session.** A clicks *Record*. If no folder is remembered, a folder picker appears. Record 15 s, then stop. Pass: a toast names the folder. The recording badge lists "You" for A and A's name for B. The folder holds program, local and live files plus `events.jsonl`, all with non-zero size. `events.jsonl` starts with `session-start` and ends with `session-stop`.

**REC-2 Double-click Record.** Double-click *Record* quickly. Pass: one recording runs (the button reads *Stop recording*) and exactly one new session folder is created.

**REC-3 One recorder fails, stop still finishes.** Make one feed's writer fail (harness: inject a write failure for a single file name). Then stop. Pass: the other files and `events.jsonl` are finalized, `session-stop` is logged, the "Saved …" toast appears, and *Record* returns.

**REC-4 Disk write failure.** Inject write failures for all files after about 1 MB (harness). Pass: each failing file shows **one** "Writing “<file>” failed" toast that persists and does not repeat. The failed recorders stop writing. Pressing *Stop recording* finishes cleanly with the "Saved" toast. *Intended: the affected recording stops cleanly. If the session keeps recording after its writers failed, report FAIL.*

**REC-5 Folder change.** In *Producer*, use *Recording folder…* to pick another folder, then record. Pass: the new session lands in the new folder, and the folder name is shown next to the button.

### Segment rolling

**ROLL-1 Files roll every 5 min.** Record for over 10 minutes (harness: shorten the interval). Pass: each feed has `-1`, `-2`, `-3` … files. `events.jsonl` has a `feed-start`/`feed-stop` pair per file, and each next file starts before the previous one stops (overlap, no gap). B's `hq/` also gains one file per interval.

**ROLL-2 Gapless editor playback.** Open the ROLL-1 session in the editor and play across a roll boundary. Pass: no black frames or audio dropouts at the boundaries, and the timeline shows consecutive segments per feed.

**ROLL-3 Crash survival.** Record past at least one roll, then kill the tab or browser process (not *Leave*). Pass: all files from completed rolls exist and play. `events.jsonl` exists, up to about the last 2 s. Opening the folder in the editor works and plays the surviving segments. Only the in-progress segment may be lost or truncated.

### Full-quality transfer

**HQ-1 "Always" mode.** B sets *Always send it automatically*. A records 20 s and stops. Pass: B shows a sending toast with progress, then "Sent full-quality files to A". A shows "Receiving…" then "Received full-quality files from B". A's folder has `hq-b-…` files and `events.jsonl` has a matching `hq-file` event.

**HQ-2 "Ask" mode.** B uses *Ask before sending it to them*. A records and stops. Pass: B gets the dialog "Send full-quality recording?" with file count and size. *Send* behaves as HQ-1. *Not now* sends nothing, and A's incoming list shows B as declined (the list is visible only in A's leave dialog while some other transfer is pending).

**HQ-3 "Never".** B uses *Don't keep a local copy*. Pass: no "Full-quality local copy" badge on B while A records, nothing in B's `hq/`, and no dialog.

**HQ-4 Peer leaves mid-transfer.** Make the transfer large (record a few minutes). B closes its tab while sending. Pass: A's receive dialog (shown if A leaves) marks B "disconnected", or closes when nothing else is pending, rather than hanging. A can leave. The partial `hq-` file does not crash the editor.

**HQ-5 Leaving with the send dialog open.** B in ask mode. A stops recording, and B's "Send full-quality recording?" dialog appears. B clicks *Leave* without answering. Pass: leave waits for that same dialog, with no second dialog. After B answers, leave proceeds, and with *Send* the transfer completes before B's page reloads.

**HQ-6 Peer-supplied filenames ignored.** From B, send a chunk to A's `hq` action (`room.makeAction('hq', {kind: 'request', onRequest: () => ({ok: false})}).request(buf, {target, metadata})`, plan via `makeAction('hqPlan')`; A's `recId` is `(await import('/js/recording.js')).session.recId`) with malicious metadata (e.g. `info.kind: "../x"`, an extra `name`/`file` field) and without announcing a plan first. Pass: unannounced chunks are rejected. Announced chunks land as `hq-<B-name>-<B-pid>-<cam|screen>-<random>.<ext>` named by A, never outside the session folder, and never more bytes than announced.

### Leaving

**LEAVE-1 Leave while recording.** A clicks *Leave* during a recording. Pass: dialog "Stop recording and leave?". *Cancel* keeps recording. *Stop & leave* finalizes and returns to the lobby with the same room code.

**LEAVE-2 Event log after leave.** A records, B uses "always", A stops and leaves. Pass: A's final `events.jsonl` contains `session-stop` and the `hq-file` entries for B, even if they arrived during leave.

**LEAVE-3 Recorder waits for incoming.** A leaves right after stopping while B is still sending (locally transfers finish in about a second: slow B's sender, see harness). Pass: A shows "Receiving full-quality files…" with progress, closes it automatically when done, and *Leave anyway* works.

### Leftover files

**LEFT-1 Leftover prompt.** B keeps unsent HQ files: at leave, choose *Keep for later*. Pass: the lobby shows "N unsent full-quality file(s) from an earlier call" with *Save to folder…* and *Delete*.

**LEFT-2 Save to folder.** Click *Save to folder…* and pick a folder. Pass: the folder gets the `hq-` files plus `hq-manifest-<name>-<pid>.json`, the prompt hides, and OPFS `hq/manifest.json` no longer lists those segments. After a reload, no prompt.

**LEFT-3 Delete.** Click *Delete*. Pass: the files are removed from OPFS `hq/`, the manifest is updated, and after a reload there is no prompt.

**LEFT-4 Editor picks up saved HQ.** Copy the LEFT-2 files into A's session folder and open it in the editor. Pass: B's segments show as full-quality (green).

### Editor and render

**ED-1 Open.** After stopping, click *Open in editor* in the "Saved" toast (new tab) or *Open a recording in the editor…* and pick the session folder. Pass: the title, duration, tracks (green = full quality, blue = live), markers and layout changes appear. A folder without `events.jsonl` gives a clear toast.

**ED-2 Edit.** Use play/pause (Space), ±5 s, *Mark in* / *Mark out → cut*, both trims, change the layout at the playhead, and *Apply to whole session*. Pass: the cuts list and layout list update, and `edits.json` is written. After reopening, the toast "Loaded your saved edits" appears and the edits are back.

**ED-3 Render.** Click *Generate final video* with *Prefer full-quality sources* checked. Pass: progress runs in real time and a "Saved <file> (<size>)" toast appears. The file is in the session folder and plays with cuts applied. *Cancel* mid-render deletes the partial file.

### Failure handling

**FAIL-1 No signaling.** Block the trystero URL (or go offline) and click *Join room*. Pass: the toast "Could not load Trystero…" appears and *Join room* is enabled again.

**FAIL-2 Denied camera/mic.** Deny permissions. Pass: a "Camera unavailable" / "Microphone unavailable" toast appears and the app stays usable.

**FAIL-3 Folder picker cancelled.** Click *Record* and cancel the picker. Pass: no session starts and no error appears.

**FAIL-4 Unload guard.** Reload while recording, or while a transfer is pending. Pass: the browser asks for confirmation.

## Agent harness

Validated with `playwright-cli` and headless Chromium. Fake media, the OPFS picker shim, recording, two-peer connection over the public relays, "ask"-mode transfer, the shortened roll interval, and write-failure injection all worked.

**Serve.** From the repo root: `python -m http.server 8765` (in the background). Stop it when done.

**Open two peers.** `docs/qa/playwright-cli.json` sets headless Chromium with `--use-fake-ui-for-media-stream`, `--use-fake-device-for-media-stream`, camera/microphone/clipboard permissions, and the init script `docs/qa/opfs-picker.js`. Run from the repo root:

    playwright-cli -s=a open --config=docs/qa/playwright-cli.json http://localhost:8765/
    playwright-cli -s=b open --config=docs/qa/playwright-cli.json http://localhost:8765/

Drive each peer with `-s=a` / `-s=b`: `snapshot` to find controls by label, then `click`/`fill`/`select`. Close with `playwright-cli close-all`. The fake camera is a single device, so the *Camera* select stays hidden (see LOB-2). `goto` to a different `#room` on the same page is a hash change and does not refill *Room code*: fill it.

**Folder picker.** `showDirectoryPicker` can't be automated. `opfs-picker.js` replaces it with an OPFS subfolder `picked-<picker id>`: `picked-p2pstudio` is the recording root and `picked-p2pstudio-hq` is the leftover save target. To list everything in a peer's OPFS with sizes:

    playwright-cli -s=a eval "async () => { const o=[]; const w=async(d,p)=>{ for await (const [n,h] of d) h.kind==='directory' ? await w(h,p+n+'/') : o.push(p+n+' '+(await h.getFile()).size) }; await w(await navigator.storage.getDirectory(),''); return o }"

The shim returns the same folder for the same id, so *Open a recording in the editor…* gets the recording root (no `events.jsonl`). To open a session (ED-*, LEFT-4, ROLL-2), or to pick another root (REC-5), override `window.showDirectoryPicker` in the page to return that folder before clicking. For FAIL-3, delete `root` from IndexedDB `p2pstudio`/`kv`, reload, and make it throw an `AbortError`.

To read a file, e.g. `events.jsonl` of the first session:

    playwright-cli -s=a eval "async () => { const r=await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-p2pstudio'); for await (const d of r.values()) return (await (await d.getFileHandle('events.jsonl')).getFile()).text() }"

The playback checks (ROLL-2, ED-3) need a human, or a screenshot of the editor canvas at a boundary.

**Modified modules via `run-code`.** Use `page.route` to serve a patched copy of a module, then reload. `playwright-cli route --body` would need the whole file, so this is simpler. Find the code by meaning, since locations may move:

- Roll interval: the `setInterval(…, 5 * 60e3)` that rolls feed and full-quality files (currently at the bottom of the HQ section in `js/recording.js`).

      playwright-cli -s=a run-code "async page => { await page.route('**/js/recording.js', async r => { const res = await r.fetch(); await r.fulfill({response: res, body: (await res.text()).replace('5 * 60e3', '15e3')}) }); await page.reload() }"

- Write failure: the `w.write(data)` call inside `fileWriter` (currently in `js/util.js`). Replace it with `(bytes > 1e6 ? Promise.reject(new Error("injected")) : w.write(data))`. Gate on `name` to fail only one file (REC-3).
- Slow full-quality send (LEAVE-3, HQ-4): in `js/recording.js` replace `sent += buf.byteLength` with `await sleep(1500); sent += buf.byteLength` on the sender.

A reload during a call may raise a `beforeunload` dialog (FAIL-4 behaviour). Answer it with `dialog-accept`. Routes persist across reloads in that session. Clear them with `page.unrouteAll()` in `run-code`. A reload after that can still run the patched module from cache: check, or use a fresh session.

**Toasts over controls.** Toasts can cover *Record*/*Stop recording*/*Leave*, and a Playwright click then fails with "intercepts pointer events". Click with `eval "() => document.querySelector('#leaveBtn').click()"` (or `#recBtn`) and report it.

**Network log.** `playwright-cli network` came back empty. For LOB-5, read `performance.getEntriesByType('resource')`.

**Network.** Peers find each other through trystero's public relays (loaded from esm.sh), so the internet is required. If the two sessions don't see each other within about 60 s, mark the peer-dependent tests BLOCKED with the reason. Do not simulate peers.

**Crash (ROLL-3).** OPFS lives in an in-memory profile, so open with `--profile=<dir>`. `playwright-cli kill-all` kills only the daemon and leaves the browser running (and recording). Kill the browser itself (`pkill -9 -f <dir>`), delete `<dir>/Singleton*`, then reopen with the same `--profile` to inspect files.

**Playback (ROLL-2, ED-3).** In `eval`, `(await import('/js/editor.js'))` exposes `edSeek`, `edPlay`, `edPause` and `ed.t`: play across a boundary and sample `#edCanvas` with `getImageData` each animation frame to find dark frames.

## Reporting

Report one line per test ID:

- **PASS**
- **FAIL**, with evidence: console errors (`playwright-cli console`), OPFS file listing, relevant `events.jsonl` lines, and screenshot paths.
- **BLOCKED**, with the reason (no relay connectivity, a capability fake devices lack, etc.).

Then list plan problems: steps that were wrong, labels that changed, or harness commands that no longer work. Include proposed edits to this file so the plan stays current.
