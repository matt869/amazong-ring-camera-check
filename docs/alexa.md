# Alexa voice summary

A caregiver asks "Alexa, ask home check-in how Mom is today" and hears the same daily note the dashboard shows. "How was her week?" reads the weekly family digest. This is optional, and only worth setting up once the core check-in is running.

## How it works

`POST /api/alexa` is a standard Alexa custom-skill HTTPS endpoint, so it works on Alexa+ devices too. It's public, but every request is verified the way Amazon requires for skills hosted outside Lambda ([lib/alexa.ts](../lib/alexa.ts)):

- the `SignatureCertChainUrl` is `https://s3.amazonaws.com/echo.api/...` (port 443 only)
- the certificate chain is in date, chains to a trusted root, and the leaf is issued to `echo-api.amazon.com`
- the `Signature-256` header verifies over the raw body
- the request timestamp is within 150 seconds
- the skill ID matches `ALEXA_SKILL_ID`

With `ALEXA_SKILL_ID` unset, the endpoint returns 404.

## Setup

1. In the [Alexa developer console](https://developer.amazon.com/alexa/console/ask), create a **Custom** skill with your own hosting ("Provision your own").
2. Set the endpoint to `https://<your APP_URL>/api/alexa`. Choose the SSL option that matches your certificate (for a Cloudflare tunnel or another public certificate: "My development endpoint has a certificate from a trusted certificate authority").
3. Paste the interaction model below in **Interaction Model > JSON Editor**, then save and build.
4. Copy the skill ID (`amzn1.ask.skill...`) into `ALEXA_SKILL_ID` in `.env.local` and restart the app.
5. Test it in the console's **Test** tab, or on any device signed in to the same Amazon account (development skills are available to the developer account).

```json
{
  "interactionModel": {
    "languageModel": {
      "invocationName": "home check in",
      "intents": [
        {
          "name": "DailySummaryIntent",
          "samples": ["how is she today", "how is mom today", "how is mom", "how is she doing", "how's today going", "is she okay"]
        },
        {
          "name": "WeeklyDigestIntent",
          "samples": ["how was her week", "how was mom's week", "give me the weekly summary", "how was the week"]
        },
        { "name": "AMAZON.HelpIntent", "samples": [] },
        { "name": "AMAZON.StopIntent", "samples": [] },
        { "name": "AMAZON.CancelIntent", "samples": [] },
        { "name": "AMAZON.NavigateHomeIntent", "samples": [] }
      ]
    }
  }
}
```

## Privacy

Anyone who can talk to that Alexa device can ask, so put the skill on a device in your own home only. It speaks only what the dashboard already shows: the status line, any open alerts, and the note or digest. During a privacy pause it says she has paused sharing.
