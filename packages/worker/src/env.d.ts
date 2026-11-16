declare namespace Cloudflare {
  // Types `exports` of cloudflare:workers by the main module.
  interface GlobalProps {
    mainModule: typeof import("./index.ts");
  }

  interface Env {
    DB: D1Database;
    FILES: R2Bucket;
    // OAuth storage (design.md section 11): checked at each request, since a deployment can lack it.
    OAUTH_KV?: KVNamespace;
    // Deployment values (design.md section 11): absent until configured, so parseConfig checks each one.
    APP_HOST?: string;
    API_HOST?: string;
    CONTENT_HOST_SUFFIX?: string;
    PUBLIC_HOST_SUFFIX?: string;
    ARCHIVE_AFTER_DAYS?: string | number;
    ACCESS_TEAM_DOMAIN?: string;
    ACCESS_APP_AUD?: string;
    ACCESS_CONTENT_AUD?: string;
    API_TOKENS?: string;
  }
}

interface Env extends Cloudflare.Env {}
