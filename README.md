# BotGarden

BotGarden is a no-build PWA for configuring and paper trading condition-driven DCA strategies through Alpaca. It uses the same deployment shape as Mayfly: static ES modules on GitHub Pages plus Supabase Auth, Postgres, RLS, and Edge Functions.

## Included in this first slice

- Email/password sign-up and sign-in
- Authenticated dashboard
- Per-user Alpaca paper-account connection
- Server-side validation and AES-GCM encryption of Alpaca credentials
- DCA bot form with a live averaging-order/capital preview
- `bg_`-prefixed Postgres schema and row-level security
- Draft bot persistence

This version intentionally saves bots as drafts. It does not submit orders yet.

## Setup

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. Copy the project URL and publishable/anon key into `config.js`.
4. In Supabase Authentication, enable Email, turn off **Confirm email**, and add the deployed URL to the redirect allow list.
5. Generate a 32-byte encryption key and save its base64 form as an Edge Function secret named `BG_CREDENTIALS_KEY`.
6. Deploy the function:

   ```sh
   supabase functions deploy alpaca-connection
   supabase functions deploy paper-runner --no-verify-jwt
   ```

7. Serve locally with any static server or publish the repository through GitHub Pages.

Generate the credential key in a browser console or Deno:

```js
const b = crypto.getRandomValues(new Uint8Array(32));
btoa(String.fromCharCode(...b));
```

Never commit the generated key, Supabase service-role key, or any Alpaca credentials.

## Next implementation slice

- Bot detail and edit pages
- Structured start-condition builder
- Paper execution Edge Function and idempotent order submission
- Alpaca order/fill synchronization
- Broker fill reconciliation and richer live position analytics
- Equity curve, P&L, drawdown, and comparison views
