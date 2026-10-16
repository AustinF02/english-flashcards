# Conf English — AWS conference vocabulary flashcards

A small, fast flashcards web app for studying English vocabulary used at AWS conferences
(technical terms and conference small-talk). Study and quiz work in the browser with no account;
an optional invite-only sign-in adds progress sync across devices.

**Live demo:** https://d2ts4pdy7hp7wu.cloudfront.net

> The live demo is a public endpoint. Its URL, the static site, and the runtime `config.json`
> (which contains only non-secret public identifiers) are discoverable by anyone. The demo is not
> a guarantee of availability and may change or go away.

This project is independent and is **not affiliated with, endorsed by, or sponsored by Amazon Web
Services**. "AWS", "Amazon Polly", and related names are trademarks of their respective owners and
are used here only descriptively.

## Features

- Two decks: AWS technical terms and conference conversation.
- Flip cards (term ⇄ Japanese meaning + example sentence).
- Multiple-choice quizzes (meaning, reverse, and listening) with scoring and "retry missed".
- Pronunciation playback from pre-generated MP3s; playback honestly reports "unavailable" rather
  than pretending when a clip is missing.
- Progress tracking. Device-only by default; synced to your account when signed in.

No screenshots are included in this repository.

## Public study vs. invite-only sign-in and sync

This behavior is how the app is built (see `src/app.ts`, `src/config.ts`, `src/auth.ts`):

- **Public study — no sign-in.** Decks, flipping, quizzes, and pronunciation all work with no
  account. Progress is saved in the browser (localStorage) on that device only. When no runtime
  `config.json` is present, the app runs in device-only mode and shows no sign-in at all.
- **Invite-only sign-in and sync.** When a `config.json` is present, a "Sign in" action appears.
  Sign-in uses the Cognito hosted UI (Authorization Code + PKCE; public client, no client secret).
  After sign-in, progress syncs through a Cognito-authorized API. The user pool is configured as
  admin-create-only, so accounts are provisioned by an administrator (invitation) — there is no
  public self-service sign-up.

On the live demo, unauthenticated or invalid-token reads and writes to the progress API are
rejected with HTTP 401 (verified).

## Architecture

- **Frontend:** TypeScript + Vite, no UI framework. Static files only.
- **Hosting:** Amazon S3 (private bucket) behind Amazon CloudFront (HTTPS, security headers).
- **Auth:** Amazon Cognito user pool + hosted UI (admin-invite-only).
- **API:** Amazon API Gateway (Regional REST API) authorized by Cognito, same-origin at `/api`
  via CloudFront.
- **Compute/data:** AWS Lambda (Python) + Amazon DynamoDB for per-user progress.
- **Audio:** pre-generated Amazon Polly MP3s served as static files (see `AUDIO-LICENSE.md`).

Infrastructure as code is in `infra/cloudformation.yaml`. It is **not fully self-contained**: it
requires a pre-existing Lambda artifact and an IAM permissions-boundary policy. See `infra/README.md`.

## Local setup

Requirements: Node.js 18+ and npm.

```sh
npm ci            # reproducible install from package-lock.json
npm run dev       # start the Vite dev server
npm run build     # type-check and build to dist/
npm test          # run the frontend test suite (Vitest)
```

Python tooling (audio generation, Lambda build) uses the standard library plus `boto3` for the
AWS calls:

```sh
python3 -m pip install boto3           # only needed for the AWS-calling scripts
python3 -m unittest discover -s scripts -p 'test_*.py'
python3 -m unittest discover -s backend -p 'test_*.py'
```

Running in dev with no `config.json` gives you the full public study/quiz experience in device-only
mode.

## Configuration

The app reads a runtime `config.json` from the site root. It is **not** committed (it is
account-specific and `.gitignore`d) and contains only non-secret public identifiers. Shape:

```json
{
  "apiBase": "/api",
  "auth": {
    "domain": "https://<your-cognito-prefix>.auth.<region>.amazoncognito.com",
    "clientId": "<your-app-client-id>",
    "redirectUri": "https://<your-site-domain>/",
    "scope": "openid email english-flashcards/progress"
  }
}
```

Generate it from your deployed CloudFormation stack's outputs and the Cognito app client, then
upload it to the site bucket alongside the built assets.

**Content-Security-Policy.** `index.html` ships a complete, valid CSP. Public study works as-is
because the API is same-origin. Hosted-UI sign-in performs an XHR to the Cognito OAuth2 token
endpoint, so to enable sign-in you must append that origin to `connect-src` at deploy time:

```
connect-src 'self' https://<your-cognito-prefix>.auth.<region>.amazoncognito.com
```

Left unchanged, the site is fully usable for public study and sign-in is simply unavailable.

## Deployment outline

1. Build the frontend: `npm ci && npm run build`.
2. Build the Lambda zip: `python3 scripts/build_lambda.py` and upload it to your artifacts bucket.
3. Create the IAM permissions boundary and deploy `infra/cloudformation.yaml` (see `infra/README.md`).
4. Generate `config.json` from stack outputs and upload it with the built assets to the site bucket.
5. Add your Cognito origin to the CSP `connect-src` (above).

## Cost assumptions (bounded, not guaranteed)

Designed to sit near the AWS Free Tier for light personal use:

- **Audio** is a one-time generation. The generator estimates characters × Polly Standard rate and
  refuses to run if the estimate exceeds a built-in **$1** cap. The included deck is well under that.
- **Runtime** is request-driven: S3/CloudFront delivery plus occasional Lambda/DynamoDB/API Gateway
  calls for signed-in sync. There is nothing that scales with study behavior beyond fractions of a
  cent per request.
- Budgets/alarms **notify**; they do **not** cap spending. The hard stops are disabling the API
  stage or the CloudFront distribution. Actual cost depends on your traffic, Region, and account;
  no cost figure here is a guarantee.

## Tests and verification limitations

- **Frontend:** `npm test` (Vitest) covers auth URL/PKCE building, quiz logic, progress merge
  vectors, config parsing, and DOM rendering.
- **Backend:** `python3 -m unittest discover -s backend -p 'test_*.py'` covers the progress handler
  and REST/HTTP event shapes.
- **Scripts:** `python3 -m unittest discover -s scripts -p 'test_*.py'` covers the audio planner
  (cost cap, voice split, reuse) and the deterministic Lambda build.

Known limitations:

- The audio tests verify the voice **requested** from Polly and that each clip is a non-empty, valid
  MP3 — they do **not** verify what the audio actually sounds like.
- The frontend tests run in jsdom, not a real browser; they do not exercise real audio playback,
  the live Cognito hosted UI, or network calls to deployed services.

## License

Source code: MIT (see `LICENSE`). Generated audio: see `AUDIO-LICENSE.md`.
