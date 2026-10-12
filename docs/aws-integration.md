# AWS integration

Ring Check-in uses two AWS services. Both are optional: without them, alerts go to the server log and summaries come from the built-in template.

| Service | Used for | Enabled by |
|---|---|---|
| Amazon SNS | Alerts and the weekly digest to family (topic); check-in texts to the resident and neighbor (direct SMS) | `SNS_TOPIC_ARN` |
| Amazon Bedrock | The daily note and the weekly family digest, written by Claude | `BEDROCK_ENABLED=true` |

Credentials come from the standard AWS chain: environment variables, `~/.aws/credentials` or `AWS_PROFILE`, or an instance or task role. Set `AWS_REGION` to the region that hosts both services.

## SNS alerts

1. Create a standard topic:
   ```bash
   aws sns create-topic --name ring-checkin-alerts
   ```
2. Subscribe each caregiver:
   ```bash
   aws sns subscribe --topic-arn <arn> --protocol sms   --notification-endpoint +15551234567
   aws sns subscribe --topic-arn <arn> --protocol email --notification-endpoint someone@example.com
   ```
   Email subscribers must confirm from the message AWS sends them. SMS in the US needs an origination identity (a toll-free number or 10DLC) set up in AWS End User Messaging.
3. Set `SNS_TOPIC_ARN=<arn>`.

Every topic message carries `severity`, `rule` and `audience` message attributes. `severity` is one of `critical`, `warning`, `resolved` (an all-clear), `notice` (she paused sharing), `digest` (the weekly digest) or `test`. To filter per subscriber, add a subscription filter policy. For example, SMS only for urgent alerts and their all-clears, with the weekly digest by email:

```json
{ "severity": ["critical", "resolved"] }
```
```json
{ "severity": ["digest"] }
```

Info-level alerts (low battery, device offline) are never published. They show only on the dashboard.

### Texts to the resident and the neighbor

The escalation ladder texts two single people directly, rather than through the topic: the resident ("are you OK?") and, as the last rung, a neighbor ("could you knock?"). Their numbers are entered in Settings in E.164 form (`+15551234567`). They're sent with SNS `Publish` to a `PhoneNumber` as `Transactional` SMS, and only when `SNS_TOPIC_ARN` is set (otherwise they're logged). Keep them off the family topic: they'd otherwise receive every family alert.

Each text includes a one-tap reply link, so `APP_URL` must be the public https address. SMS in the US needs an origination identity, as above. Ask the neighbor before adding their number.

## Bedrock daily note

Bedrock writes two things: the daily note, and the weekly family digest (from the week's pre-computed facts: wake times and outings against the week before, who in the family logged calls or visits, alerts and how they were resolved, visitor counts, and drift findings).

1. Make sure your account can use Anthropic's Claude Opus 5.5 on Amazon Bedrock in your region. The default model ID is `anthropic.claude-opus-5-5`. Override it with `BEDROCK_MODEL_ID`.
2. Set `BEDROCK_ENABLED=true`.

The app calls Claude through the Bedrock Mantle endpoint (the Messages API) with `@anthropic-ai/bedrock-sdk`. Only pre-computed facts are sent, never raw event logs or video:

- first and last activity times, and the usual wake-up time
- activity count against the usual count, and the busiest rooms
- outings, the doorbell count, and the day's alerts

Results are cached in the database for 30 minutes for today, and indefinitely for past days unless their alerts change. If Claude declines a request, a client-side fallback retries on `anthropic.claude-opus-4-8`. If that also fails, or any error occurs, the rule-based template is shown instead.

## IAM policy

For SNS, the app needs `sns:Publish` on the alert topic, plus `sns:Publish` with resource `*` for direct SMS to the resident and neighbor (phone numbers have no ARN). Drop the second statement if you don't use the ladder's texts:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "sns:Publish", "Resource": "arn:aws:sns:<region>:<account>:ring-checkin-alerts" },
    { "Effect": "Allow", "Action": "sns:Publish", "Resource": "*" }
  ]
}
```

Because the second statement also covers every topic in the account, prefer a dedicated IAM user or role for this app.

For Bedrock, grant the inference permission that AWS documents for the Claude Messages (Mantle) endpoint. If a call returns `AccessDenied`, the error names the action that is missing.

## Deployment notes

- The app keeps state in SQLite on local disk (`DATA_DIR`). Run it as one long-lived Node process, for example on ECS/Fargate with an EFS volume, on EC2, or on Lightsail. Serverless platforms with ephemeral disks lose data and stop the scheduler.
- The built-in scheduler (`instrumentation.ts`) only runs while the server is up. As a backstop, an EventBridge Scheduler rule can call `GET /api/summary` every 5–10 minutes with the header `Authorization: Bearer <CRON_SECRET>`. The check is idempotent.
- Point an uptime monitor (for example a CloudWatch Synthetics canary) at `GET /api/health`. It returns 503 when checks stop running, which is the failure you most want to hear about. It needs no auth and reveals nothing about the household.
- Set `APP_PASSWORD` and serve over HTTPS. The dashboard shows when the resident is home alone.
- Point the Ring webhook at `https://<your-host>/api/webhooks/ring`, and set `RING_WEBHOOK_SECRET` to the shared secret.
