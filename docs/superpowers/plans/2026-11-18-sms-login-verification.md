# SMS login — isolated offline acceptance

Verification: 2026-11-18–19 (Asia/Shanghai). Branch: `feat/sms-login`.
Base: `e988b4126cca9b7fd946a2f66ecdeeb28b13404b`.
Initial implementation: `a8ac211b32cd15eb5591e6a115143a407dc92912`; review corrections are included with this report.
Status: implementation, both independent reviews and follow-up source checks complete. **Not installed, merged, reloaded or live-verified.**

## Scope

Owner-operated single-account mainland +86 SMS replaces all QR routes, ticket polling, QR renderer/self-check and dedicated lifetime setting. Game/community operations, independent settings, date/scope accounting and scheduler remain. Only sign-in is implemented: no reading/liking/sharing/posting or CAPTCHA bypass.

- Fresh candidate: validate SMS token root, bind aid/UID, exchange ltoken/cookie_token, strict read-only game validation and (when enabled) required strict community mission validation, then final synchronous flow/account/deadline guard before replacing saved auth. Empty legitimate role list is valid; profile is cosmetic. Failures preserve the previous account.
- SMS has no automatic retry. Cooldown at least 60s, even after cancel/uncertain outcome; flow 5m, challenge at most 2m; code submission budget 5; manual continuation bounded per checkpoint.
- Sensitive phone/code/proof remain ephemeral, not persisted/logged/put in URLs or browser storage. Long-term auth still uses the pre-existing plaintext local store, not a keychain. Reference release privacy claims are not a memory-erasure guarantee.

## Verification evidence

On bundled Node24 (`24.21.0`), Task5 initial run was 171/171; after review-driven corrections the final full run was:

```sh
node --test test/*.test.mjs
# tests 180; pass 180; fail/cancelled/skipped/todo 0
```

All production `.js` modules (15), including host/client/protocol/frame, passed `node --check`; manifest JSON parsed; migration tests assert ESM, `node >=22`, zero runtime dependencies, SMS metadata/notice packaging, and absence of active QR dependencies. `git diff --check` passed. Node22 and remote CI were **not** run. Offline fixture tests never fall back to live upstream requests and use temporary DSH_HOME.

Coverage includes SMS request encryption/strict reply parsing, Aigis GT4/GT3 result whitelists, host/client payload bounds, TTL/cooldown/code budgets, one-shot proof/checkpoint, AND-composed HTTP guards, stale start/cancel/logout/dispose/expiry/candidate-validation races, old-account preservation, optional community warning versus required community failure, captured UI cancellation, duplicate synchronous callback lock, GET-only state observation, bound Window+nonce bridge, static no-store HTML/CSP, fixed widget errors, late widget failure fencing, and existing community/scheduler behavior. UI tests are callback/element-description tests; **not DOM/effect/focus simulation or visual acceptance**.

## Real carrier/source inspection and rulings

Read-only DSH installed documentation and HTTP bridge source showed:
- Bridge uses `http://dsh.internal/...` internally, preserving original Host. For this sentinel only, admitted browser Origin is compared to validated retained Host with its HTTP(S) scheme. Normal URL origin matching remains direct. This does not bypass DSH owner registration/admission; missing Origin remains allowed for native owner requests. Foreign/null Origin, cross-site/same-site metadata and malformed payloads are rejected.
- Buffered mode can consume up to 300MiB before the plugin; SMS mutation routes therefore explicitly use streaming mode, enforcing the 16KiB JSON body limit while reading. Login upstream response bodies are bounded to 128KiB. Other routes preserve existing behavior.
- The static owner document is fetched through authenticated fetch then loaded via srcDoc for Desktop IPC compatibility. CSP is in both Response header and meta; frame sandbox is exactly `allow-scripts`, with no same-origin/forms/popups/top navigation. Parent checks exact iframe Window and nonce, not opaque origin `null`.

Official documentation: [GT4](https://docs.geetest.com/gt4/deploy/client/web), [GT3](https://docs.geetest.com/captcha/deploy/client/web). Read-only direct fetch verified HTTP200 for the fixed [GT4 loader](https://static.geetest.com/v4/gt4.js) (15538 bytes) and [GT3 loader](https://static.geetest.com/static/tools/gt.js) (9561 bytes), without executing either. Their code creates JSONP scripts to official API origins; CSP permits the explicit static/API origins required for that pattern, not just connect-src. Other widget resources are limited to geetest/geevisit HTTPS vendor domains. No unsafe-eval, owner origin or arbitrary configured script URL is allowed. Widget-ready clears the 30s load timer, not the challenge expiry timer. Loading error/expiry removes the frame and prevents late continuation or resend until a new user-started flow.

These are source/fixture facts, **not proof of an official widget completing in the installed runtime**.

## History and isolation

The nine SDK/diagnostic commits (`e3d3f72`, `1e7a341`, `1a0f453`, `dd9471e`, `7d666bd`, `7d25763`, `564c141`, `c4d4bc6`, `ad38225`) were each checked with `git merge-base --is-ancestor` and are not ancestors of this branch. Reviewed full diff against the clean community base. Main/previous feature/diagnostics refs remain unchanged:

| Ref | Object |
| --- | --- |
| installed `main` and `feat/community-signin` | `564c1413183b2baa03f254cf6fce9b4118998683` |
| `fix/community-sdk-diagnostics` | `ad38225193cea723b992331cf7114d05cc608402` |
| `backup/pre-sms-installed-20261118` | `564c1413183b2baa03f254cf6fce9b4118998683` |
| `backup/pre-sms-sdk-diagnostics-20261118` | `ad38225193cea723b992331cf7114d05cc608402` |
| `backup/pre-sms-stash-20261118` | `fe5e97439d98490356a3200514d2773989acf579` |

No `refs/stash` currently exists (previously disclosed); its content is preserved by the backup branch. No stash restore/apply/drop performed during implementation. Exact QR deletion paths resolved under this worktree before removal. No installed source/profile/symlink changed and no production credential file read or changed; shared Git metadata was written only to commit the isolated branch after approval. Backups preserve code/Git objects, not production account state.

## Independent reviews

Two fresh read-only passes reviewed the whole branch: engineering/security (`sms-security-review`) and UI/UX/accessibility (`sms-ux-review`). Neither found a Critical issue. Initial engineering review independently ran 171 tests green; initial UI review ran its 9 focused callback tests green. Source-level issues were verified, not treated as runtime observations.

Review-driven corrections (Task5):
1. **Important startup regression:** existing non-ASCII device name/model could throw during eager SMS construction and prevent the whole service mounting. A real temporary saved configuration with `Café`/`本机` reproduced `SmsLoginError` at startup. SMS header handling now preserves safe printable Latin-1, substitutes safe defaults for unsupported Unicode/control/oversized display metadata and leaves saved config/device ID unchanged. Regression now passes.
2. **Nested strict schema gap (engineering Minor):** null/malformed role/task records could pass read-only verification. Three added fixtures reproduced new-credential acceptance before correction; minimum nested record checks now reject them and preserve old auth/runtime. Empty lists remain valid and nonstrict legacy paths are unchanged. This strengthens the approved malformed-success boundary; actual nonempty official schemas still need live compatibility verification.
3. **Important recovery feedback (also engineering Minor):** fixed allowlisted localized categories now distinguish official account action, required game/community validation (old login unchanged), unknown outcome, explicit rejection and transport/response problems. Explicit host `flow: null` clears the client checkpoint and disables further mutations. Five new controller fixtures reproduced generic mapping before correction; all pass afterward. Raw upstream messages remain excluded; specific failure no longer displays a competing generic expired status.
4. **Important focus source gap:** added a focusable modal root, document-level focus containment with cleanup, disabled-control fallback and conditional focus to the actionable code input. Element-description regression proved the missing focus target; hook effects/focus behavior itself are **not browser-tested**. UI follow-up source review found both original Important causes addressed, no new Important blocker, explicitly not runtime accessibility sign-off.
5. **Minor countdown feedback:** persistent sent/code-entry primary status; ticking countdown moved outside the live status with `aria-live="off"`, covered by element-description assertions.

Engineering follow-up confirmed all three reported issues were addressed, found no new Critical/Important issue, and independently reran the full offline suite (180/180), the four corrected production modules’ syntax checks, and the diff check. A nonblocking coverage suggestion is to add positive strict-validation fixtures with nonempty official role/task records; current candidate-success fixtures are mainly empty arrays. No installed environment was changed for either review.

Residual UI Minors intentionally deferred to authorized GUI acceptance: loading feedback disappears after wrapper fetch but before official widget-ready (bounded error still exists); Shift+Tab from the fallback root is redirected back by the document guard rather than explicitly wrapped to Cancel. Forward navigation remains available in source, but no browser/focus claim is made. The vendor iframe has a deliberate white surface rather than a host-adaptive background; actual light/dark usability and vendor accessibility are unverified.

## Explicitly unverified / next authorization boundary

- Actual official SMS dispatch, OTP acceptance, token exchange, minimal community Cookie acceptance and real sign-in/coin settlement.
- GT4/GT3 online behavior under opaque-origin/srcDoc/CSP, third-party policy/availability, Desktop IPC/Web streaming behavior end-to-end, current GUI narrow layouts/light/dark/focus behavior.
- Installation, plugin reload, current profile link update and real scheduler execution.

No browser-control tool was available; no fake renderer or replacement server was used. Integrating installed main, installing/reloading and any live account operation require separate explicit authorization. Retain worktree/backup refs until the user chooses integration/cleanup. Rollback after future integration must consider both code and any later-created credential changes separately.
