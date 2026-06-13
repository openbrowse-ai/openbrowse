---
"openbrowse": patch
---

Keep Attio/Stripe (and other OAuth) connectors authorized across extension
updates.

OAuth connectors were registered for the `authorization_code` grant only, so
providers refused the later `refresh_token` token call — meaning an expired
access token (e.g. after the service worker restarts on an extension update)
could not be renewed silently and the connector fell back to "needs
re-authorization". Now we register for the `refresh_token` grant too and
request `offline_access` when the provider supports it (including providers
like Stripe that publish no scope list but do advertise the refresh grant). An
interactive re-auth also re-registers, repairing connectors stored by older
builds without removing and re-adding them. Connectors whose tokens are
long-lived (e.g. Supabase) are unaffected.
