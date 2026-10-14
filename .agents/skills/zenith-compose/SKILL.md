---
name: zenith-compose
description: Adapt a repository's Dockerfile and zenith-compose.yml for Zenith testing and publishing.
---

# Zenith Compose

Inspect the app's build scripts, runtime entrypoint, port, required services, health checks, environment, and persistent data. Keep the smallest working stack, including a required database or worker. In `zenith-compose.yml`, declare `x-zenith.catalog.name` and one primary `x-zenith.expose` entry pointing to the HTTP service and its container port. Bind the application to `0.0.0.0` inside the container. Use service names for internal database addresses, not `localhost`.

For a preview, the CLI uploads local source and builds the root Dockerfile. `zenith check` reports the active preview policy; fix its errors rather than guessing support from generic Docker Compose. Keep secrets in a gitignored `.env.local` for tests. Do not commit them or place them in listing metadata.

Run `zenith check`, then `zenith up` to confirm the preview. For a public submission, commit and push the Compose file, Dockerfile, and app source to GitHub. Keep `build: .` for the built app. Zenith builds the pinned commit and puts its image in the catalogue proposal. A Compose file with pullable images also works. Preserve required database, volumes, and health checks. Use `x-zenith.env` to map generated values and built-ins to the app's own environment variable names. Publishing checks the pinned GitHub Compose file; `zenith check` validates the local preview form.

For an app and Postgres that need the same password, generate it once and alias it to Postgres. Scope each variable to the service that uses it, and show an administrator password in the deployment credentials panel:

```yaml
x-zenith:
  env:
    APP_DB_PASSWORD:
      generate: '([A-Za-z0-9_-]{16})([A-Za-z0-9_-]{16})'
      services: [app]
    POSTGRES_PASSWORD:
      alias: APP_DB_PASSWORD
      services: [db]
    APP_ADMIN_PASSWORD:
      generate: '([A-Za-z0-9_-]{8})([A-Za-z0-9_-]{8})'
      services: [app]
      input:
        label: Admin password
        secret: true
```

For apps that send mail, Zenith provides SMTP built-ins to deployed products. Map only the variables the app actually consumes. Example for an app that supports STARTTLS on port 587:

```yaml
x-zenith:
  env:
    SMTP_HOST: ZENITH_SMTP_HOST
    SMTP_PORT: ZENITH_SMTP_PORT
    SMTP_USERNAME: ZENITH_SMTP_USER
    SMTP_PASSWORD: ZENITH_SMTP_PASS
    SMTP_FROM: ZENITH_SMTP_FROM
```

Set the app's STARTTLS switch according to its documentation. This mapping is for the published product; for a local preview, supply test SMTP values through `.env.local` only if the preview policy supports the app's environment mapping.

For a Python app, this sends through the Zenith relay using the mapped values and the standard library. Call it from the app with a real recipient address:

```python
import os
import smtplib
import ssl
from email.message import EmailMessage


def send_notice(recipient: str) -> None:
    message = EmailMessage()
    message["From"] = os.environ["SMTP_FROM"]
    message["To"] = recipient
    message["Subject"] = "Your app is ready"
    message.set_content("Your app is ready on Zenith.")

    with smtplib.SMTP(os.environ["SMTP_HOST"], int(os.environ["SMTP_PORT"]), timeout=15) as smtp:
        smtp.starttls(context=ssl.create_default_context())
        smtp.login(os.environ["SMTP_USERNAME"], os.environ["SMTP_PASSWORD"])
        smtp.send_message(message)
```

The relay accepts authenticated STARTTLS on port 587 and permits the sender address supplied by `ZENITH_SMTP_FROM`. It is reachable from Zenith deployments through the internal SMTP hostname; testing locally requires a separately reachable SMTP server and credentials.
