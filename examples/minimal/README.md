# Minimal Profile override

`cordis.patch.yml` shows the complete Profile override for an installed `dsh-ag-ui` bundle.

1. Install the bundle:

   ```bash
   dsh plugin --profile web add dsh-ag-ui
   ```

2. Copy the rows from `cordis.patch.yml` into `$DSH_HOME/profiles/web/cordis.patch.yml`.

3. Supply a private secret and start the Profile:

   ```bash
   export DSH_AG_UI_SHARED_SECRET="$(openssl rand -hex 32)"
   dsh --profile web
   ```

4. Put an authenticated BFF in front of `http://127.0.0.1:3080/ag-ui`. The BFF must provide `Authorization: Bearer <secret>`, `x-dsh-tenant-id`, and `x-dsh-user-id` headers.

The Gateway is private infrastructure. Do not expose its bearer secret to the browser.
