declare namespace Cloudflare {
  // Bindings are added here as the Worker gains them.
  interface Env {}
}

interface Env extends Cloudflare.Env {}
